---
title: 线上故障排查：一条慢查询引发的服务雪崩
description: 一个 Spring Boot 服务偶发超时的排查实录：慢 SQL、连接池耗尽、GC 连锁反应
date: 2026-03-16
category: 踩坑实战
tags: [MySQL, 故障排查, 慢查询, 连接池]
order: 2
slug: mysql-slow-query
---
## 故障现象：又是一次「偶发大面积超时」

三月中旬的周一，10:24 分，值班群里炸了：设备采集服务大面积超时，平台侧「设备最新状态」「遥测数据查询」两个接口成功率从 99.9% 掉到 70% 以下，持续了大约 12 分钟后自行恢复。

这已经是这周第三次了，前两次都是 10 分钟左右自愈，当时都归因为「网络抖动」。但问题反复出现，这次必须查到根。于是我从监控大盘开始，一层一层往下挖。

## 排查路径：一层一层往下挖

### 第一步：监控大盘，先看「哪里不正常」

打开 Grafana，先看服务自身的资源：

| 指标 | 表现 |
| ---- | ---- |
| 应用 CPU | 正常波动，峰值 40% |
| 应用内存 | 老年代曲线爬坡，GC 频次上升 |
| HikariCP active | 触顶 50/50，持续 10 分钟 |
| HikariCP pending | 大量线程在等连接 |
| MySQL CPU | 100% 打满 |
| MySQL Threads_running | 峰值 400+ |

一个非常关键的信号：**MySQL CPU 打满，但应用 CPU 不高**。流量没有暴涨（QPS 和平常一样），数据库却满负荷——典型的「某条 SQL 把数据库拖死了」。

### 第二步：连接池指标，确认是「等连接」还是「执行慢」

HikariCP 的监控一眼看出问题：active 连接长期 50/50，pending 队列里排着几百个等待线程，等待时间超过 30 秒（`connectionTimeout` 默认 30s），大量请求在这里直接超时：

```json
{
  "active": 50,
  "idle": 0,
  "pending": 368,
  "max": 50,
  "threadsAwaitingConnection": 368
}
```

这说明不是「应用没拿到连接」这么简单——连接被占着不放，而占着的连接大概率在等一条慢 SQL 返回。这时候如果只看连接池就去加连接数，就掉进坑里了（后面细说）。

### 第三步：慢查询日志，揪出元凶

线上慢查询阈值配置的还是默认 10 秒，查了半天一条都没记录——这也是前两次没查出来的原因之一。先临时调低：

```sql
SET GLOBAL long_query_time = 2;
SET GLOBAL slow_query_log = 'ON';
```

10 分钟后抓到元凶，单条执行 19.4 秒：

```sql
SELECT id, device_no, data_type, temperature, status, report_time
FROM t_device_realtime
WHERE device_no = 202506011234567890
  AND DATE_FORMAT(report_time, '%Y-%m-%d') = '2025-06-01'
ORDER BY id DESC;
```

EXPLAIN 一下：

```sql
EXPLAIN SELECT id, device_no, data_type, temperature, status, report_time
        FROM t_device_realtime
        WHERE device_no = 202506011234567890
          AND DATE_FORMAT(report_time, '%Y-%m-%d') = '2025-06-01'
        ORDER BY id DESC;
```

结果：

| 列 | 值 |
| ---- | ---- |
| type | ALL |
| key | NULL |
| rows | 12,387,411 |
| Extra | Using where; Using filesort |

1200 万行全表扫描，还带着 filesort。

## 根因分析：两个经典的索引失效

### 失效点一：隐式类型转换

`device_no` 字段是 `VARCHAR(32)`，但 SQL 里传的是数字字面量 `202506011234567890`。MySQL 比较时会做隐式类型转换：**把字符串字段 cast 成数字再比较**。一旦对索引列做类型转换，索引就废了。

```sql
-- 等价写法（索引列上做了函数操作 → 失效）
SELECT ... FROM t_device_realtime
WHERE CAST(device_no AS UNSIGNED) = 202506011234567890 ...
```

验证方法：`EXPLAIN` 里 `key` 为 NULL；或者把参数改成字符串 `'202506011234567890'` 再 EXPLAIN，索引立即命中。

### 失效点二：对索引列做函数操作

`DATE_FORMAT(report_time, '%Y-%m-%d') = '2025-06-01'` 看着人畜无害，但它把 `report_time` 包进了函数里，即使有 `report_time` 索引也用不上，必须全表算一遍。

> 这是慢查询里出现频率最高的两类「索引失效」写法。判断口诀：**索引列要单独出现在比较符号的一边，且不要有任何函数、计算或类型转换**。

### 为什么偏偏这个时段爆发

对照监控发现：每次故障都发生在「批量导入设备档案 + 批量补采数据任务」跑完后 30 分钟内。这个任务每补采完一批设备就要刷新一次最新遥测，并发调用了上千次这个查询 SQL，把慢查询从「零散几条」放大成「压垮数据库的洪流」。

## 当时的激进方案：加连接数，为什么无效

第一次值班的人（包括我）第一反应都是：连接池满了，加连接数呗。

```yaml
spring:
  datasource:
    hikari:
      maximum-pool-size: 200   # 50 → 200
      connection-timeout: 30000
```

MySQL 侧也加了 `max_connections`。结果：**更糟**。

- 慢 SQL 还在查全表，200 条连接照样被 19 秒的查询占满，只是从「50 条慢」变成「200 条慢」；
- 200 个线程同时打满 MySQL，`Threads_running` 再创新高，InnoDB 锁等待加剧，连正常的快查询也开始排队；
- 数据库 CPU 从 100% 变成长期 100%，应用侧等待线程把 Tomcat 线程池也占满，新请求直接 503；
- 大量持有未消费结果集的线程对象晋升老年代，Full GC 开始密集触发——这就是大盘上 GC 曲线爬坡的原因，STW 让本就拥挤的请求雪上加霜——**雪崩的连锁反应**。

> 连接池的本质是「流量调节阀」，不是「慢查询加速器」。慢 SQL 不解决，加多少连接都是借高利贷，最后连本带利还回去。

后来把配置改回去，用下面的方案根治。

## 正确解法：拆 SQL、改索引、加兜底

### 第一步：SQL 拆分 + 范围查询

把「函数比较」改成「范围查询」，让索引可用；同时按天分批，避免单次扫描全表：

```sql
-- 改造后：走 report_time 范围，配合联合索引
SELECT id, device_no, data_type, temperature, status, report_time
FROM t_device_realtime
WHERE device_no = '202506011234567890'
  AND report_time >= '2025-06-01 00:00:00'
  AND report_time <  '2025-06-02 00:00:00'
ORDER BY id DESC
LIMIT 1000;
```

数据量还大的话，用 id 游标分页代替 OFFSET 分页，每批 1000 条：

```sql
-- 游标式分批：拿上一批最大 id 继续
SELECT id, device_no, data_type, temperature, status, report_time
FROM t_device_realtime
WHERE device_no = '202506011234567890'
  AND report_time >= '2025-06-01 00:00:00'
  AND report_time <  '2025-06-02 00:00:00'
  AND id > :lastId
ORDER BY id
LIMIT 1000;
```

### 第二步：索引改造

```sql
-- 最新遥测查询高频，建联合索引
ALTER TABLE t_device_realtime
    ADD INDEX idx_device_no_report_time (device_no, report_time);
```

同时应用层保证类型一致，参数传 String，从源头避免隐式转换：

```java
// 改造前：deviceNo 是 Long，MyBatis 拼出数字字面量，触发隐式转换
List<DeviceRealtime> list = deviceRealtimeMapper.selectByDeviceNo(deviceNo, date);

// 改造后：统一 String 参数
List<DeviceRealtime> list = deviceRealtimeMapper.selectByDeviceNo(String.valueOf(deviceNo), date);
```

### 第三步：限流兜底 + 快速失败

哪怕上面都做了，也要假设「下一次还会出幺蛾子」：

```yaml
spring:
  datasource:
    hikari:
      maximum-pool-size: 50
      connection-timeout: 3000   # 30s → 3s，宁可快速失败也不无限排队
      minimum-idle: 10
```

配合 Sentinel 给最新遥测/批量补采类接口加流控规则，超过阈值直接快速失败，保护设备采集主链路：

```java
@SentinelResource(value = "device-realtime-query", blockHandler = "deviceRealtimeBlock")
public List<DeviceRealtime> realtimeQuery(...) { ... }

public List<DeviceRealtime> deviceRealtimeBlock(..., BlockException e) {
    log.warn("最新遥测查询触发限流，降级返回空");
    return List.of();
}
```

## 复盘总结

1. **慢查询阈值默认 10s 太迟钝**：上线第一天就该调到 1~2s 并配告警。这次前两次故障没定位到，一半原因是日志根本没记录。
2. **加连接数是「应激反应」**：凡是连接池打满，先问「连接在等什么」而不是「连接够不够」。看 `information_schema.processlist`、慢查询日志、`Threads_running`，再决定怎么动。
3. **两类索引失效写法要写进规范**：隐式类型转换、对列做函数运算。Code Review 时先扫一遍。
4. **变更要有链路压测**：批量补采任务上线前没有压测，是这次故障的导火索。大流量任务上线前必须在测试环境按峰值 1.5 倍压。
5. **兜底永远要有**：快速失败优于无限等待；熔断降级保护核心链路；告警要双通道（指标 + 日志关键词）。