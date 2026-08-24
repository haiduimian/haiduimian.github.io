---
title: MySQL 锁机制：从行锁到死锁实战
description: InnoDB 行锁、间隙锁、临键锁原理，以及一个 UPDATE 死锁的完整案例
date: 2025-07-20
category: 数据库
tags: [MySQL, 锁, InnoDB, 死锁]
order: 2
slug: mysql-lock
---

## 从一次设备参数批量下发事故说起

七月下旬的周日凌晨两点，监控告警：设备档案批量更新接口失败率飙到 40%。

日志里躺着一行刺眼的异常：

```text
Deadlock found when trying to get lock; try restarting transaction
```

一看代码，两段 UPDATE 更新设备校准配置：一个下发任务先更新设备 A 的配置再更新设备 B，另一个下发任务刚好反过来。两个事务各持一把锁互不相让，死锁了。

这篇文章把 MySQL 的锁机制讲透：锁的分类、InnoDB 行锁的三种形态、和 Java 业务里的锁怎么配合，最后复盘这个死锁案例。

## 锁的分类：从全局到行

MySQL 的锁按粒度从小到大分三层：

| 锁 | 命令/时机 | 影响 | 使用场景 |
| --- | --- | --- | --- |
| 全局锁 | `FLUSH TABLES WITH READ LOCK` | 整个库只读 | 全库备份（现在一般用 `--single-transaction` 代替） |
| 表锁 | `LOCK TABLES ... READ/WRITE` | 整张表阻塞 | MyISAM 时代；InnoDB 下基本不用 |
| 行锁 | InnoDB 自动加 | 只锁命中行 | OLTP 默认选择 |

还有个容易被忽略的**元数据锁（MDL）**：任何 DDL（ALTER TABLE）都要先拿 MDL 写锁，而一个未提交的长事务会一直占着 MDL 读锁——线上"DDL 卡死"十有八九是它。

## InnoDB 行锁的三种形态

InnoDB 的行锁不是简单锁一行，它有三种形态：

| 形态 | 全称 | 锁什么 |
| --- | --- | --- |
| Record Lock | 记录锁 | 锁住索引上的一条记录 |
| Gap Lock | 间隙锁 | 锁住两条索引记录之间的**空隙**，阻止插入 |
| Next-Key Lock | 临键锁 | 记录锁 + 左侧间隙锁，**左开右闭**区间 |

举个具体的例子。表里有 id = 10、20、30 三条记录：

```sql
SELECT * FROM t WHERE id BETWEEN 15 AND 25 FOR UPDATE;
```

这条 SQL 会锁住 (10, 20] 和 (20, 30] 的临键锁区间。效果是：想插入 `id = 15`？不行，击中了 (10, 20) 的间隙锁，只能阻塞等待。

为什么要这么设计？为了**防幻读**——RR（可重复读）隔离级别下，同一事务两次范围查询，不允许第二次多出"幻影行"。

> 注意：间隙锁只在 RR 隔离级别下默认开启。如果业务不在乎可重复读，把隔离级别降到 RC（读已提交），间隙锁没了，死锁和锁等待的概率也会小很多，代价是 binlog 必须设成 ROW 模式才能保证主从安全。

## 幻读与 MVCC：一对互补的机制

很多人把 MVCC 和加锁混在一起，其实它们各管一段：

- **MVCC（多版本并发控制）**：解决**快照读**的隔离。普通 `SELECT` 走的是快照，看到的是事务开始时的数据，不加锁、不阻塞。
- **行锁/间隙锁**：解决**当前读**的并发。`SELECT ... FOR UPDATE`、`UPDATE`、`DELETE` 都是当前读，必须加锁防止别人修改。

一句话总结：**快照读靠版本号，当前读靠锁**。这也是为什么 RR 下普通 SELECT 永远不会幻读，而两个 `FOR UPDATE` 会互相阻塞。

## Java 业务里的悲观锁与乐观锁

**悲观锁：SELECT ... FOR UPDATE**

适合冲突概率高的场景，比如下发设备校准参数：

```java
@Transactional
public boolean pushCalibration(Long devId, BigDecimal value) {
    // 直接锁住这行，别的下发任务想改得先等
    DeviceConfig config = configMapper.selectByDevIdForUpdate(devId);
    if (config == null) {
        throw new BizException("设备档案不存在");
    }
    config.setCalibration(value);
    configMapper.updateById(config);
    return true;
}
```

对应的 SQL 是 `SELECT * FROM t_device_config WHERE dev_id = ? FOR UPDATE`。

注意两点：一是**WHERE 条件必须走索引**，否则 InnoDB 只能把扫描到的所有行都锁上（等于表锁）；二是事务要尽快提交，锁的持有时间 = 事务存活时间。

**乐观锁：版本号 CAS**

适合冲突概率低的场景，比如设备固件版本/配置版本号更新：

```java
@Transactional
public boolean upgradeFirmware(Long devId, Integer expectVersion) {
    int affected = configMapper.casUpdateConfigVersion(
        devId,                // dev_id
        "V1.0.0", "V1.0.1",   // 旧版本 -> 新版本
        expectVersion         // 期望版本号
    );
    if (affected == 0) {
        // 被别人改过了，重试或者提醒值班同事
        throw new BizException("设备固件版本已更新，请刷新后重试");
    }
    return true;
}
```

```sql
UPDATE t_device_config
SET firmware_version = 'V1.0.1', config_version = config_version + 1
WHERE id = #{devId}
  AND firmware_version = 'V1.0.0'
  AND config_version = #{expectVersion};
```

受影响行数为 1 说明 CAS 成功，为 0 说明并发冲突，业务层选择重试或报错。

**什么时候选哪个？** 冲突多、写多读少 → 悲观锁；冲突少、读多写少 → 乐观锁。乐观锁在设备固件集中升级这种超高并发场景下反而容易大量失败重试，这时候很多人会改用 Redis 原子操作，又是另一个话题了。

## 死锁实战：两个 UPDATE 的顺序问题

回到开头的下发事故。表结构很简单：

```sql
CREATE TABLE t_device_config (
  id            BIGINT PRIMARY KEY,
  dev_id        BIGINT,
  calibration   DECIMAL(10,2),
  KEY idx_dev_id (dev_id)
);
```

下发业务抽象成「给设备 A 下发配置，给设备 B 下发配置」：

```sql
-- 下发任务 1
UPDATE t_device_config SET calibration = calibration + 100 WHERE dev_id = 'A';
UPDATE t_device_config SET calibration = calibration + 100 WHERE dev_id = 'B';

-- 下发任务 2
UPDATE t_device_config SET calibration = calibration + 100 WHERE dev_id = 'B';
UPDATE t_device_config SET calibration = calibration + 100 WHERE dev_id = 'A';
```

两个事务并发时的执行过程：

1. 任务 1 锁住 A 的配置行，任务 2 锁住 B 的配置行；
2. 任务 1 要锁 B，被任务 2 占着，进入等待；
3. 任务 2 要锁 A，被任务 1 占着，进入等待；
4. **环形等待，死锁形成**。InnoDB 的死锁检测发现后，回滚代价较小的一方（任务 2），应用层收到 `Deadlock found when trying to get lock`。

用 `SHOW ENGINE INNODB STATUS` 看死锁现场，关键段落长这样：

```text
------------------------
LATEST DETECTED DEADLOCK
------------------------
2025-04-20 02:13:45 0x7f8c
*** (1) TRANSACTION:
TRANSACTION 520934, ACTIVE 12 sec starting index read
mysql tables in use 1, locked 1
LOCK WAIT 2 lock struct(s), heap size 1136, 1 row lock(s)
MySQL thread id 88321, OS thread handle 14024, query id 7349211
UPDATE t_device_config SET calibration = calibration + 100 WHERE dev_id = 'A'
*** (1) WAITING FOR THIS LOCK TO BE GRANTED:
RECORD LOCKS space id 58 page no 3 n bits 72
index idx_dev_id of table `iot`.`t_device_config` trx id 520934
lock_mode X locks rec but not gap waiting
*** (2) TRANSACTION:
TRANSACTION 520935, ACTIVE 8 sec starting index read
mysql tables in use 1, locked 1
3 lock struct(s), heap size 1136, 2 row lock(s)
MySQL thread id 88322, OS handle 14025, query id 7349312
UPDATE t_device_config SET calibration = calibration + 100 WHERE dev_id = 'B'
*** (2) HOLDS THE LOCK(S):
RECORD LOCKS space id 58 page no 3 n bits 72
index idx_dev_id of table `iot`.`t_device_config` trx id 520935
lock_mode X locks rec but not gap
*** (2) WAITING FOR THIS LOCK TO BE GRANTED:
RECORD LOCKS space id 58 page no 3 n bits 72
index idx_dev_id ... lock_mode X locks rec but not gap waiting
*** WE ROLL BACK TRANSACTION (2)
```

怎么读这份报告？三步：

1. 看 `(1) WAITING FOR THIS LOCK` 和 `(2) HOLDS THE LOCK(S)`——谁在等、锁被谁拿着，构成环路；
2. 看 `LATEST DETECTED DEADLOCK` 的时间戳和事务 id，回代码里定位是哪个事务；
3. 看最后一行的 `WE ROLL BACK TRANSACTION (2)`——MySQL 选择了回滚代价小的事务。

## 规避死锁的实践

踩过一次坑之后，我们定了四条铁律：

**1. 统一加锁顺序**

所有涉及多行更新的业务，按固定的键排序后再加锁：

```java
public void pushConfig(String devA, String devB) {
    // 按 dev_id 字典序排序，两个方向的下发任务最终加锁顺序一致
    String lockFirst  = devA.compareTo(devB) < 0 ? devA : devB;
    String lockSecond = devA.compareTo(devB) < 0 ? devB : devA;
    // 先锁 lockFirst 设备的配置行，再锁 lockSecond
    // ...
}
```

只要两个任务以相同的顺序拿锁，就不会出现环形等待。

**2. 让 UPDATE 走上索引**

`WHERE dev_id = 'A'` 若不命中索引，InnoDB 会把扫描到的所有行都加锁。上面死锁日志里锁的是 `idx_dev_id` 上的记录（`locks rec but not gap`），如果这里走了全表扫描，锁面会大得多，死锁概率成倍上升。

**3. 缩短事务**

事务里只放必要的 SQL，远程调用、文件操作一律挪出事务。锁持有时间越短，和别人撞车的窗口越小。

**4. 保留重试机制**

死锁是 InnoDB 主动检测并回滚的，应用层必须捕获 1213 错误码并重试：

```java
try {
    pushConfig(devA, devB);
} catch (CannotAcquireLockException e) {
    if (isDeadlock(e)) {
        return retry(3); // 最多重试 3 次
    }
    throw e;
}
```

最后说句题外话：**死锁不一定全是坏事**——它说明 InnoDB 的检测机制在工作，把"锁等待超时"这种更隐蔽的问题提前暴露出来。真正要警惕的是日志里没报错、但接口集体变慢的锁等待。

锁到这里先告一段落，下一篇聊聊 MQTT 和物联网设备接入，换换口味。