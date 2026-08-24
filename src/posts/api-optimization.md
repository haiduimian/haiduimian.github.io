---
title: 接口性能优化：从 2 秒到 200 毫秒
description: 一个设备数据查询接口从 2s 优化到 200ms 的完整过程：索引、N+1、连接池、缓存
date: 2026-02-05
category: 踩坑实战
tags: [Spring Boot, MySQL, 性能优化, 缓存]
order: 1
slug: api-optimization
---

## 背景：一次常规需求背后的性能债

一月底我们上线了「设备数据平台」的一个新版本，核心改动是把设备列表页从「每页查库」改成了「服务端聚合」：值班同事点开设备历史数据查询页，后端一次性返回设备概要、最新遥测数据（温度/压力/电量）、在线状态。

需求评审时大家觉得这接口逻辑简单，无非是查几张表拼一个 VO，预估 QPS 也就几百，没做任何性能设计。结果上线第三天，线上开始出现零星超时告警，群里截图一张接一张。我把问题接口拉出来压了一把，数据相当难看——于是有了这篇「从 2 秒到 200 毫秒」的完整记录。

## 现象：压测数据不会骗人

先用 JMeter 在测试环境压一下 `GET /api/v1/devices/data/list`，参数固定 deviceId + 在线状态筛选 + 时间范围 + 分页，200 并发、持续 5 分钟：

| 指标 | 压测结果 |
| ---- | ---- |
| 平均响应时间 | 1.87 s |
| P95 | 2.34 s |
| P99 | 2.61 s |
| QPS | 118 |
| 错误率 | 0.42%（超时） |

这个接口是给设备数据平台的监控大屏和值班同事用的，P99 2.6 秒基本等于「转圈加载」，平台负责人已经在催了。而且 QPS 118 就到顶，说明瓶颈不在网络，在我们的代码和数据库。

> 压测基线条件：应用 2C4G 单实例、MySQL 8.0 单库、设备上报数据表 800 万行。

## 定位：先别急着改代码

### 第一步：开慢查询日志

第一反应是看 SQL。线上 MySQL 慢查询阈值默认 10 秒，太钝了，先把它调成 1 秒，观察半小时：

```sql
-- 全局设置（生产建议写进 my.cnf 持久化）
SET GLOBAL slow_query_log = 'ON';
SET GLOBAL long_query_time = 1;
SET GLOBAL log_queries_not_using_indexes = 'ON';
```

半小时后拉日志，一条 SQL 反复出现，单次执行 1.8~2.1 秒：

```sql
SELECT id, device_id, device_no, status, temperature, report_time
FROM t_device_data
WHERE device_id = 123456
  AND status = 1
  AND report_time BETWEEN '2025-04-01 00:00:00' AND '2025-05-01 00:00:00'
ORDER BY report_time DESC
LIMIT 0, 20;
```

`EXPLAIN` 一看，`type = ALL`，全表扫描，`rows = 7,860,321`，Extra 里还有个 `Using filesort`。

### 第二步：Arthas 火焰图确认时间去向

慢 SQL 找到了，但我想确认整个请求的时间分布——也许还有别的地方在拖。用 Arthas 挂到测试环境实例上采样：

```bash
# 挂载到目标进程
java -jar arthas-boot.jar 28930

# 生成 CPU 火焰图，采样 30 秒
profiler start --duration 30
profiler stop --format html --file /tmp/flame.html
```

火焰图上看，`com.xxx.device.service.DeviceDataQueryService.list()` 内部的时间几乎全压在 `JdbcTemplate.execute` → mysql-connector 的 `executeQuery` 上，占调用树总宽的 89%。也就是说：瓶颈就一个，SQL 本身。

### 第三步：链路追踪确认外部依赖

顺手用 SkyWalking 看了一眼这个接口的 trace，span 明细如下：

| Span | 耗时占比 |
| ---- | ---- |
| DB 查询（设备主查询） | 62% |
| DB 查询（遥测明细循环 20 次） | 27% |
| 其他（序列化、日志等） | 11% |

主查询 62%，加上循环明细 27%——两个问题都实锤了：**一条慢 SQL + 一个 N+1**。

## 优化一：给 SQL 建对索引

### 联合索引

原表只有主键索引和一个 `idx_device_id`。查询条件是 `device_id + status + report_time`（等值 + 范围），排序又要 `report_time DESC`。按最左前缀原则建联合索引：

```sql
ALTER TABLE t_device_data
    ADD INDEX idx_device_id_status_time (device_id, status, report_time);
```

再 EXPLAIN：`type = ref`，`rows` 从 786 万降到 2400，`Using filesort` 消失（联合索引天然有序，排序直接走索引）。

### 覆盖索引

业务上列表只需要 7 个字段，但 `SELECT *` 风格的写法会回表。干脆把查询涉及的列全部塞进索引，变成覆盖索引，省掉回表的随机 IO：

```sql
ALTER TABLE t_device_data
    ADD INDEX idx_device_status_time_cover (device_id, status, report_time, id, device_no, temperature);
```

> 覆盖索引的本质：索引 B+ 树叶子节点已经包含所需列，InnoDB 不需要再走聚簇索引回表。代价是索引体积变大、写入变慢，所以只对「高频且结果列少」的查询做。

这次之后，慢查询日志里这条 SQL 彻底消失了，单次执行稳定在 18ms 左右。

## 优化二：干掉 N+1 查询

### 问题复现

主查询快了，但火焰图里那 27% 还在。看代码，典型的 N+1：

```java
// 改造前：循环 20 次，每次查一次该设备的遥测明细
List<DeviceDataVO> devices = deviceDataMapper.selectPage(deviceId, status, begin, end);
for (DeviceDataVO device : devices) {
    List<DeviceTelemetryVO> items = telemetryMapper.selectByDeviceId(device.getId()); // 20 次查询！
    device.setItems(items);
}
```

一次列表请求 = 1 次主查询 + 20 次明细查询 = 21 个数据库 round trip。主查询本身又慢，整个接口直接 2 秒。

### 批量改造

MyBatis 用 `foreach` 拼 IN 是最直接的改法：

```xml
<select id="selectByDeviceIds" resultType="DeviceTelemetry">
    SELECT id, device_id, data_type, data_value, report_time
    FROM t_device_telemetry
    WHERE device_id IN
    <foreach collection="deviceIds" item="did" open="(" separator="," close=")">
        #{did}
    </foreach>
</select>
```

Service 层配套改成「先查主列表、再一次性批量查明细、最后在内存里按 deviceId 分组回填」：

```java
public List<DeviceDataVO> list(DeviceDataQuery query) {
    List<DeviceDataVO> devices = deviceDataMapper.selectPage(
            query.getDeviceId(), query.getStatus(), query.getBegin(), query.getEnd());

    if (devices.isEmpty()) {
        return devices;
    }
    // 1 次批量查询，替代 N 次单个查询
    List<Long> deviceIds = devices.stream().map(DeviceDataVO::getId).toList();
    List<DeviceTelemetryVO> allItems = telemetryMapper.selectByDeviceIds(deviceIds);

    Map<Long, List<DeviceTelemetryVO>> itemMap =
            allItems.stream().collect(Collectors.groupingBy(DeviceTelemetryVO::getDeviceId));
    devices.forEach(d -> d.setItems(itemMap.getOrDefault(d.getId(), List.of())));
    return devices;
}
```

注意 IN 列表别太长：MySQL 对 IN 是顺序扫描语义，超过几百个值收益下降，业务上每页 20 条完全没问题。真有大 IN 场景，按 500 一组 split 后多次查询再合并。

压测看这轮效果：P99 从 2.6s 掉到 680ms，主要耗时变成「主查询 18ms + 批量明细 30ms」。但还是不算快，因为每页请求都直接打 MySQL——下一步上缓存。

## 优化三：Redis 缓存 + 分布式锁防击穿

### 为什么需要缓存

设备数据查询有很强的「热点属性」：同一批设备每 5 秒上报一批遥测数据，值班同事的查询又集中在最近时段（最新遥测和在线状态变化少）。直接缓存接口结果，P99 可以压到 250ms 左右——但缓存有个经典坑：**热点 key 过期瞬间，全部流量直穿 DB**。

我们白天峰值 QPS 2000+，一旦 key 过期，一个请求的 2 次查询乘以 2000 并发，DB 立刻被打穿，这就是「缓存击穿」。

### 缓存击穿的标准解法：互斥锁 + 双检

用 Redisson 的 `RLock` 做互斥重建，避免并发重建缓存：

```java
@Component
public class DeviceDataListCache {

    private static final String CACHE_KEY = "device:data:list:%s:%s:%d:%d";
    private static final long CACHE_TTL_MS = 5 * 60 * 1000L;

    @Resource
    private StringRedisTemplate redis;
    @Resource
    private RedissonClient redisson;

    public List<DeviceDataVO> get(DeviceDataQuery query) {
        String key = buildKey(query);
        // 1. 先读缓存
        String json = redis.opsForValue().get(key);
        if (json != null) {
            return JSON.parseArray(json, DeviceDataVO.class);
        }
        // 2. 缓存没有，抢分布式锁，防止多个线程同时重建（击穿）
        String lockKey = "lock:" + key;
        RLock lock = redisson.getLock(lockKey);
        boolean locked = false;
        try {
            locked = lock.tryLock(2, 10, TimeUnit.SECONDS);
            if (!locked) {
                Thread.sleep(50); // 拿不到锁的请求短暂等待后重试读缓存
                return get(query);
            }
            // 3. 双检：拿到锁后可能别的线程已经重建完了
            json = redis.opsForValue().get(key);
            if (json != null) {
                return JSON.parseArray(json, DeviceDataVO.class);
            }
            // 4. 真正查库并回填缓存
            List<DeviceDataVO> devices = queryFromDb(query);
            redis.opsForValue().set(
                    key, JSON.toJSONString(devices), CACHE_TTL_MS, TimeUnit.MILLISECONDS);
            return devices;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return queryFromDb(query); // 兜底：直接查库，保证可用性
        } finally {
            if (locked) {
                lock.unlock();
            }
        }
    }
}
```

> 注意三点：① 缓存和 DB 的一致性用 Cache Aside，设备数据入库时主动删缓存而不是更新缓存；② TTL 加随机抖动，避免大批 key 同时过期（缓存雪崩）；③ 分布式锁解决的是「单 key 热点被击穿」，流量侧还得靠限流兜底，见下文。

### 更新侧：删除缓存而非更新缓存

设备数据入库后主动删 key，下次读时重建：

```java
@Transactional
public void saveDeviceData(Long deviceId, List<DeviceTelemetry> telemetryList) {
    deviceDataMapper.insertBatch(deviceId, telemetryList);
    // 删除相关列表缓存
    Set<String> keys = redis.keys("device:data:list:*");
    if (!keys.isEmpty()) {
        redis.delete(keys);
    }
}
```

`keys` 命令生产环境慎用（全量扫描），量大时换成缓存版本号或按 deviceId 维度删单个 key，这里只是示意图。

## 优化前后对比

| 指标 | 优化前 | 索引优化后 | + 批量后 | + 缓存后 |
| ---- | ---- | ---- | ---- | ---- |
| P99 | 2610 ms | 1180 ms | 680 ms | 198 ms |
| P95 | 2340 ms | 1050 ms | 610 ms | 172 ms |
| QPS | 118 | 320 | 540 | 2100 |
| DB CPU | ~45% | ~28% | ~19% | ~6% |
| 慢查询/小时 | 40+ | 2 | 0 | 0 |

最终结果：P99 稳定在 200ms 以内，达标（平台要求 <300ms），DB 压力降到原来的 1/7，压测 30 分钟无超时。

## 总结：一份可复用的性能优化 Checklist

这次从 2s 到 200ms，本质是「先定位、再对症、后兜底」：

1. **先量化再动手**：压测拿到 P95/P99/QPS 基线，优化后才有对比依据。
2. **定位优先级**：慢查询日志（SQL 层）→ Arthas 火焰图（代码层）→ 链路追踪（跨服务层），三步就能把瓶颈钉死。
3. **SQL 优先建索引**：联合索引按最左前缀；高频小结果集考虑覆盖索引；`EXPLAIN` 里出现 `ALL` / `Using filesort` 就是警告信号。
4. **消灭 N+1**：MyBatis 用 IN 批量查 + 内存分组，注意 IN 上限。
5. **缓存要防穿透/击穿/雪崩**：互斥锁重建 + TTL 随机抖动 + 空值缓存（防穿透，本文未展开）。
6. **兜底限流**：缓存和 DB 之间永远留最后一道闸，Sentinel / Guava RateLimiter 都行。
7. **留好观测**：慢查询阈值调到 1s 并落库，火焰图和 trace 都要能随时开。

性能优化没有银弹，但套路是可以复制的：**数据说话 → 定位瓶颈 → 最小改动 → 验证对比**。