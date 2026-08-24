---
title: MySQL 索引优化实战：从全表扫描到索引覆盖
description: 最左前缀、回表与覆盖索引、索引失效场景，附 EXPLAIN 实战分析
date: 2025-05-05
category: 数据库
tags: [MySQL, 索引, EXPLAIN, 性能]
order: 1
slug: mysql-index
---

## 一个让人失眠的下午

周一下午四点，值班同事在群里 @我："设备数据查询页面转圈超过两秒，平台侧的同事都在催。"

我拉了一下慢查询日志，果然有条 SQL 稳稳地挂在最前面：

```sql
SELECT * FROM t_device_record
WHERE device_id = 10086
  AND report_time >= '2025-03-01'
  AND data_type = 1
ORDER BY report_time DESC
LIMIT 20;
```

EXPLAIN 一看，type 是 ALL，rows 一千多万，Extra 里还挂着 Using filesort——全表扫描 + 文件排序，1.2 秒一点不冤。

这篇文章就从这个案例展开，把索引相关的知识点串一遍。**结论先行**：改造后这条 SQL 稳定在 30ms 左右，办法就是三个字——加索引，加对索引。

## 索引为什么能快：B+Tree

先问一个问题：为什么 MySQL 的默认存储引擎 InnoDB 用 B+Tree 而不是二叉树、B-Tree 或者哈希表？

> 磁盘 IO 是按页（默认 16KB）读取的，树的高度决定了查询要走几次 IO。B+Tree 的"矮胖"结构让三层的树就能存下千万级的数据。

三个候选结构对比一下：

| 结构 | 特点 |
| ---- | ---- |
| 二叉树 | 数据量大时树太高，极端情况退化成链表更糟 |
| B-Tree | 每个节点既存 key 又存 data，节点能容纳的 key 变少，树变高 |
| **B+Tree** | 非叶子节点只存 key，一个节点能容纳更多 key，树更矮；叶子节点用链表串联，天然支持范围查询 |

InnoDB 中索引和数据是"聚簇"的：主键索引（聚簇索引）的叶子节点直接存整行数据；二级索引（普通索引）的叶子节点存**主键值**。这一点是理解"回表"的关键。

## 联合索引与最左前缀

回到设备历史数据表。设备最常见的数据查询姿势是「按设备 + 时间 + 数据类型」，于是我们建了联合索引：

```sql
ALTER TABLE t_device_record ADD INDEX idx_device_time_type (device_id, report_time, data_type);
```

联合索引的本质是：先按第一个字段排序，第一个字段相同的再按第二个字段排序，以此类推。所以它到底能命中哪部分，遵守**最左前缀原则**：

| 查询条件 | 能否走 idx_device_time_type |
| -------- | --------------------------- |
| `device_id = 10086` | ✅ 用到 device_id |
| `device_id = 10086 AND report_time > '2025-03-01'` | ✅ 用到 device_id + report_time |
| `device_id = 10086 AND data_type = 1` | ⚠️ 只用 device_id（跳过了 report_time，data_type 用不上） |
| `report_time > '2025-03-01'` | ❌ 没带最左边的 device_id，整个索引失效 |

> 面试高频题：联合索引 (a, b, c)，`WHERE a = 1 AND c = 3` 能用几个字段？答案是只有 a。因为 b 被跳过后，c 无法确定位置，只能靠回表逐行过滤。

## 回表与覆盖索引

二级索引的叶子节点存的是主键值，所以 `SELECT *` 走二级索引查到记录时，还需要再根据主键去聚簇索引拿整行数据——这就是**回表**，一次回表就是一次随机 IO。

怎么避免？**覆盖索引**：让查询用到的所有列都在索引里。

我们最终的优化方案是"拆列"，把真正需要展示的字段写进 SELECT：

```sql
-- 优化后
SELECT device_id, report_time, data_type, device_no
FROM t_device_record
WHERE device_id = 10086
  AND report_time >= '2025-03-01'
  AND data_type = 1
ORDER BY report_time DESC
LIMIT 20;
```

配合 `idx_device_time_type`，Extra 变成了 `Using index`——数据全在索引里，连回表都省了。

> 注意：覆盖索引不是无脑把列都塞进索引。索引越多，写入时的维护成本越大、占用空间也越涨，一般只在热点查询上做。

## 读懂 EXPLAIN

调 SQL 之前先把 EXPLAIN 读利索。我常用这几列：

| 列 | 含义 | 怎么判断好坏 |
| --- | --- | --- |
| `type` | 访问类型 | 好的方向：system > const > eq_ref > ref > range > index > ALL，ALL 最差 |
| `key` | 实际用到的索引 | NULL 代表没走索引，大概率有问题 |
| `rows` | 预估扫描行数 | 越小越好（注意只是估计值，不一定精确） |
| `Extra` | 附加信息 | 出现 `Using filesort` / `Using temporary` 是强烈信号 |
| `filtered` | 过滤比例 | 和 rows 一起估算实际返回的行数 |

优化前后对比：

```sql
-- 优化前
mysql> EXPLAIN SELECT * FROM t_device_record WHERE device_id = 10086 AND report_time >= '2025-03-01' AND data_type = 1 ORDER BY report_time DESC LIMIT 20\G
...
type: ALL
rows: 10372450
Extra: Using where; Using filesort

-- 优化后（覆盖索引版本）
type: ref
key: idx_device_time_type
rows: 482
Extra: Using index
```

`Using filesort` 有多疼？意味着 MySQL 要把结果集搬进 sort buffer 排一遍，数据量大时还会落到临时文件。而联合索引本身就是按 (device_id, report_time) 排好序的，`ORDER BY report_time DESC` 直接顺着索引倒着读就行，排序开销直接归零。

## 五个常见的索引失效场景

光会加索引不够，还得会躲坑。下面五个场景我都踩过：

**1. 隐式类型转换**

```sql
-- device_no 是 varchar 类型
SELECT * FROM t_device_record WHERE device_no = 20250401001;   -- ❌ 失效
SELECT * FROM t_device_record WHERE device_no = '20250401001'; -- ✅ 正常
```

MySQL 会把 varchar 列转成数字再比较，相当于对列做了函数运算，索引直接废掉。**参数类型必须和列类型一致**。

**2. 对索引列使用函数**

```sql
SELECT * FROM t_device_record WHERE DATE(report_time) = '2025-04-01'; -- ❌ 失效
SELECT * FROM t_device_record WHERE report_time >= '2025-04-01'
                                AND report_time <  '2025-04-02';      -- ✅ 范围查询
```

**3. 前缀模糊匹配**

```sql
SELECT * FROM t_device WHERE device_name LIKE '%一号%'; -- ❌ 开头通配符，用不上索引
SELECT * FROM t_device WHERE device_name LIKE '一号%';  -- ✅ 后缀通配，可走 range
```

**4. OR 条件中有一边没索引**

```sql
SELECT * FROM t_device_record WHERE device_id = 1 OR data_type = 0; -- ❌ data_type 无索引，整条失效
-- 改成 UNION ALL，两边各走各的索引
SELECT * FROM t_device_record WHERE device_id = 1
UNION ALL
SELECT * FROM t_device_record WHERE data_type = 0;
```

**5. 否定条件**

```sql
SELECT * FROM t_device_record WHERE data_type != 1; -- 多数情况下用不上索引（覆盖索引除外）
```

> 顺带一提：优化器不是傻子，当 `rows` 占比太高、回表代价高于全表扫描时，它会主动放弃索引。所以索引有没有生效，永远以 EXPLAIN 为准，别靠猜。

## 实战复盘：1.2s → 30ms

最后把整个改造串一遍：

**Step 1**：确认业务需求。这个接口固定按 device_id 进，时间区间 + 数据类型过滤，按时间倒序取前 20 条。

**Step 2**：建联合索引，顺序按「等值条件在前，范围条件在后」排。

```sql
ALTER TABLE t_device_record ADD INDEX idx_device_time_type (device_id, report_time, data_type);
```

**Step 3**：把 `SELECT *` 改成只选需要的列，让查询列全部落在索引里，Extra 达到 `Using index`。

**Step 4**：上线前用线上库的 EXPLAIN 复验，rows 从一千多万掉到几百。

**Step 5**：上线后盯慢查询日志，确认这条 SQL 从列表里消失。

改造前后对比：

| 指标 | 优化前 | 优化后 |
| ---- | ------ | ------ |
| 扫描行数 | 10,372,450 | 482 |
| 访问类型 | ALL | ref |
| 排序方式 | filesort | 索引有序 |
| 耗时 | ~1.2s | ~30ms |

几个经验，写在这里供参考：

1. **等值条件放联合索引左边，范围条件放右边**——最左前缀原则的直接应用。
2. **设备上报场景里单表索引别超过 5 个左右**，写多读少的表更要克制。
3. **监控三件套**：慢查询日志、EXPLAIN、`SHOW INDEX` 看区分度。
4. 索引不是银弹，`SELECT *` + 无脑加索引的组合拳解决不了所有问题，先把 SQL 写对，再谈优化。

这篇文章是「MySQL 优化」系列的第一篇，下一篇聊聊锁：行锁、间隙锁，还有我线上遇到的那个 UPDATE 死锁。