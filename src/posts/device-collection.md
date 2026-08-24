---
title: 工业设备数据采集平台：从 PLC 到数据库的整条链路
description: 设备层、采集网关、消息队列、时序存储四层架构实战，附 Netty 接入与高并发写入方案
date: 2025-10-08
category: 工业物联网
tags: [数据采集, 架构, Netty, 时序数据库]
order: 2
slug: device-collection
featured: true
---

> 上一篇讲了怎么用 Modbus 读通一台 PLC。这一篇把镜头拉远：一个工厂 100+ 台设备，
> 数据要实时上云做产线监控大屏、报警、历史趋势，整条链路怎么搭、每层怎么防坑。
> 以下架构来自我 2025 年下半年交付的散热器厂「设备上云」项目，有删减。

## 业务背景

现场设备构成（实际盘点结果）：

| 设备类型 | 数量 | 接入方式 | 数据频率 |
| ---- | ---- | ---- | ---- |
| 产线 PLC（S7-200 SMART / 台达） | 30 台 | Modbus TCP，走现场交换机 | 每台 20 个测点，2 秒一轮 |
| 电表/传感器（威胜、安科瑞） | 60 台 | RS485 → 边缘网关 → MQTT | 5 秒一轮 |
| 振动/噪声采集器（自研固件） | 10 台 | 自定义 TCP 二进制协议 | 1 秒一包 |

峰值写入约 **1500~2000 点/秒**，一天约 1.5 亿条测点记录。需求是三条：实时监控
大屏（2 秒内可见）、阈值报警（秒级）、历史趋势查询（月粒度）。

## 四层架构

```text
┌───────────────┐   PLC / 电表 / 传感器 / 自研采集器
│   设备层       │   30×TCP + 60×RS485 + 10×自定义TCP
└──────┬────────┘
       │ Modbus TCP / MQTT / 自定义协议
┌──────┴────────┐
│   采集层       │   边缘网关 + 采集服务（Netty TCP 接入 + MQTT 订阅）
│               │   协议解析 → 统一 DataPoint → 发消息队列
└──────┬────────┘
       │ Kafka（削峰、解耦、缓冲）
┌──────┴────────┐
│   消息层       │   topic: device-point，落库消费组独立部署
└──────┬────────┘
       │ 批量写入（每 2 秒一批，5000 条内）
┌──────┴────────┐
│   存储层       │   TDengine/InfluxDB（原始时序数据）
│               │   + MySQL（设备台账、报警规则、聚合结果）
└───────────────┘
```

各层职责边界就一句话：**采集层只负责"把数据拿到并保证至少一次投递"，业务计算
一律往下游放**。这样哪层挂了都能单独重来，不会互相拖累。

## 采集服务设计

### 统一数据模型

不管底层是 Modbus、MQTT 还是自定义 TCP，进了采集服务先归一化成同一个对象：

```java
public class DataPoint {
    private String deviceId;   // 设备唯一编码，如 "PLC-001"
    private String metric;     // 测点，如 "temperature" / "pressure" / "power"
    private double value;
    private long ts;           // 毫秒时间戳（来源见"踩坑一"）
    // getter/setter 省略
}
```

### 协议解析器接口：可插拔

以后每接一种新设备协议，就加一个实现类，采集框架不用动：

```java
public interface DeviceProtocolDecoder {

    /** 协议名，注册表 key，如 "modbus-tcp"、"mysensor-v2" */
    String protocolName();

    /**
     * 从字节流解析出一批测点。
     * @return false 表示帧不完整，需要继续积累下一个包
     */
    boolean decode(ByteBuf buf, List<DataPoint> out);
}
```

Spring 里把所有实现注入一个 `Map<String, DeviceProtocolDecoder>`，`protocolName()`
做 key；TCP 连接建立后首包带 2 字节协议标识，分发器据此路由。新协议 = 新类 +
一行配置，这是这套平台能持续接入新设备的关键设计。

### Netty 接入：为什么不用阻塞 IO

100+ 设备、上千条并发连接、粘包拆包、编解码，阻塞 IO 的线程模型撑不住也难维护。
Netty 的典型骨架：

```java
EventLoopGroup boss = new NioEventLoopGroup(1);
EventLoopGroup worker = new NioEventLoopGroup(Runtime.getRuntime().availableProcessors());

ServerBootstrap b = new ServerBootstrap();
b.group(boss, worker)
 .channel(NioServerSocketChannel.class)
 .option(ChannelOption.SO_BACKLOG, 1024)
 .childOption(ChannelOption.TCP_NODELAY, true)
 .childOption(ChannelOption.SO_KEEPALIVE, true)
 .childHandler(new ChannelInitializer<SocketChannel>() {
     @Override
     protected void initChannel(SocketChannel ch) {
         // 帧格式统一为 [2字节长度][payload]，避免每个协议手写半包逻辑
         ch.pipeline().addLast(new LengthFieldBasedFrameDecoder(1024, 2, 2, 0, 0));
         ch.pipeline().addLast(new ProtocolDispatcherHandler());
     }
 });
b.bind(9000).sync();
```

`ProtocolDispatcherHandler` 里做的事：从帧头取出协议标识 → 查注册表拿到 decoder →
`decode()` 出 `List<DataPoint>` → 同步发送到 Kafka。**注意不要在 Netty 线程里做
任何 IO 或重活**，只做解析和投递，否则背压一来整条链路延迟全涨。

### MQTT 那一侧

60 台 RS485 电表挂边缘网关，网关上行走 MQTT，topic 规则 `iot/{deviceId}/data`，
payload 是 JSON。采集服务自己就是 Paho 客户端，订阅 `iot/+/data`，解析后走同一
条 Kafka 管道。设备直接连 EMQX 的也类似——EMQX 规则引擎可以直接转发到 Kafka，
但为了排查方便，我倾向在采集服务里统一收口，日志只留一处。

## 高并发写入：为什么不能同步写 MySQL

第一版图省事，消费线程直接单条 INSERT 写 MySQL，实测（8 核 16G，2000 点/秒）：

- MySQL CPU 干到 70%+，P99 写入延迟 400ms+；
- 连接池 50 个连接打满，监控查询开始抢连接；
- 主从延迟拉到几十秒，报警查询读到旧数据。

原因很简单：单条 INSERT 的来回开销、InnoDB 页分裂、二级索引维护成本，都扛不住
海量高频写入。所以**让 MySQL 干它擅长的事（台账、规则、聚合），时序数据交给
时序库 + 消息队列削峰**。采集服务到 Kafka 这段用批量发送（linger + batch）：

```yaml
spring:
  kafka:
    bootstrap-servers: 10.0.0.31:9092,10.0.0.32:9092
    producer:
      key-serializer: org.apache.kafka.common.serialization.StringSerializer
      value-serializer: org.apache.kafka.common.serialization.StringSerializer
      acks: 1                       # 测点数据可接受 at-most-once 边缘，追求吞吐
      compression-type: lz4
      linger.ms: 50                 # 攒 50ms 一批发送
      batch-size: 65536
    consumer:
      group-id: point-ingest
      enable-auto-commit: false     # 落库成功才提交，失败可重试
      max-poll-records: 5000
```

## 消息队列削峰 + 批量落库

消费侧每攒 2 秒（或 5000 条）跑一次批量 INSERT，JDBC 原生 batch：

```java
public void batchInsert(List<DataPoint> points) {
    String sql = "INSERT INTO metric_point(device_id, metric, value, ts) VALUES (?,?,?,?)";
    try (Connection conn = dataSource.getConnection();
         PreparedStatement ps = conn.prepareStatement(sql)) {
        for (DataPoint p : points) {
            ps.setString(1, p.getDeviceId());
            ps.setString(2, p.getMetric());
            ps.setDouble(3, p.getValue());
            ps.setTimestamp(4, new Timestamp(p.getTs()));
            ps.addBatch();
        }
        ps.executeBatch();            // 一次网络往返写完一批
    } catch (SQLException e) {
        throw new RetriableException(e);   // 交给上层：不提交 offset，下轮重试
    }
}
```

两个容易忽略的配置：

- JDBC URL 必须加 `rewriteBatchedStatements=true`，否则 MySQL 驱动会把 batch
  退化成逐条执行，性能回到解放前；
- 消费提交策略：**落库成功才手动 commit**。配合下面的幂等键，重试不会产生重复
  数据，这是"至少一次"语义能成立的保证。

## 数据完整性：断线补采与幂等去重

### 断线补采

网关断网期间在本地环形缓存里攒数据（能存 1 万条），恢复后把积压数据按原时间戳
补发上来——这批数据是**乱序到达**的。处理原则：**时序库按"写入时间"和"数据时间"
两个维度分别处理，乱序数据照常入库**（TDengine 支持乱序写入，InfluxDB 同样），
曲线缺口自然补上。服务端同时按设备记录 `lastTs`，发现连续缺口超过阈值就告警，
让现场去查网关。

### 消费幂等去重

Kafka 重试 + 网络抖动都可能导致同一条数据落两次，唯一键兜底：

```sql
CREATE TABLE metric_point (
  id BIGINT NOT NULL AUTO_INCREMENT,
  device_id VARCHAR(64) NOT NULL,
  metric VARCHAR(64) NOT NULL,
  value DOUBLE NOT NULL,
  ts DATETIME(3) NOT NULL,
  PRIMARY KEY (id, ts),
  UNIQUE KEY uk_device_metric_ts (device_id, metric, ts),
  KEY idx_device_ts (device_id, ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  PARTITION BY RANGE COLUMNS (ts) (
    PARTITION p202510 VALUES LESS THAN ('2025-11-01'),
    PARTITION p202511 VALUES LESS THAN ('2025-12-01'),
    PARTITION p202512 VALUES LESS THAN ('2026-01-01'),
    PARTITION pMax VALUES LESS THAN (MAXVALUE)
  );
```

配合 `INSERT IGNORE`，重复写入直接跳过：

```java
String sql = "INSERT IGNORE INTO metric_point(device_id, metric, value, ts) VALUES (?,?,?,?)";
```

> 注意唯一键为什么是 (device_id, metric, ts) 而不是 (device_id, ts)：同一时刻一台
> 设备会同时上报温度、压力、功率多个测点，用后者会把同批次不同测点误判为重复。

## 时序数据分层：热数据、聚合、冷数据

| 时间范围 | 数据形态 | 存储 | 用途 |
| ---- | ---- | ---- | ---- |
| 最近 7 天 | 原始 2s 粒度 | TDengine（keep=7 天自动清理） | 实时监控、短周期分析 |
| 7 ~ 90 天 | 5 分钟聚合（AVG/MAX/MIN） | MySQL 聚合表 | 报表、月报、趋势 |
| 90 天以上 | 压缩后的行存文件 | 对象存储 / 离线库 | 审计、追溯 |

聚合任务每小时跑一次，SQL 直接对原始表算（5 分钟粒度）：

```sql
INSERT INTO agg_point_5m(device_id, metric, ts, avg_val, max_val, min_val)
SELECT device_id,
       metric,
       FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(ts) / 300) * 300) AS bucket,
       AVG(value), MAX(value), MIN(value)
FROM metric_point
WHERE ts >= ? AND ts < ?
GROUP BY device_id, metric, bucket
ON DUPLICATE KEY UPDATE avg_val = VALUES(avg_val);   -- 补采乱序数据重跑覆盖
```

时序库侧，TDengine 建超级表统一设备测点：

```sql
CREATE STABLE meter_data (
  ts TIMESTAMP,
  v FLOAT
) TAGS (device_id NCHAR(64), metric NCHAR(32));

-- 写入：每台设备/每个测点一个子表
INSERT INTO t_plc001_temp USING meter_data TAGS('PLC-001','temperature')
  VALUES (NOW, 235.5);
```

冷数据在 TTL 前用离线任务导出成 Parquet/CSV 分设备分月归档，MySQL 里只保留聚合
结果和归档索引，查询走"先聚合表、再归档文件"的路径。

## 踩坑记录

### 坑一：时钟不同步导致时间戳错乱

上线第三天，趋势图出现一堆"未来数据"：某网关系统时钟快了 2 小时。原因：设备侧
直接拿本机时间当 `ts`，网关没做 NTP。处理原则：

- **服务端接收时间为主，设备时间为辅**：消费端校验 `ts` 与当前时间偏差，超过
  阈值（比如 ±5 分钟）就改用接收时间并打 `ts_marked=true` 标记；
- 网关和设备侧统一部署 NTP 同步，偏差超过 30 秒的网关直接置为"时钟异常"告警；
- 不要用设备时间做 Kafka 分区键（本例不用），但用设备时间做查询排序一定会踩坑。

### 坑二：批量插入索引碎片

高频批量插入后 `uk_device_metric_ts` 和 `idx_device_ts` 索引碎片涨得很快，
`information_schema` 里碎片率一度 60%+，查询变慢。对策：

- 主键设计成自增 id 开头（append-only），物理顺序尽量贴着时间写；
- 表按月分区（见上文建表），分区修剪 + 定期 `ALTER TABLE ... REBUILD PARTITION`
  或 `OPTIMIZE TABLE`；
- 只保留必要索引：这个表查询只有「设备+时间范围」和「唯一键去重」两种模式，
  多一个没用的索引就是多一份写入成本。

### 坑三：消费组重平衡导致的重复消费

Kafka 消费端扩容或故障重启会造成重平衡，已消费未提交的 offset 会重复投递。
这属于"至少一次"的必然代价，靠幂等键兜底，不要试图用"恰好一次"配置去消除——
配置复杂且吞吐损失大，生产环境不划算。

## 小结

整条链路的骨架是：**设备层 → 采集层（Netty + 协议解析）→ 消息层（Kafka 削峰）
→ 存储层（时序库原始数据 + MySQL 聚合/台账）**。每个环节的关键决策：归一化
DataPoint 让协议可插拔；批量写入 + rewriteBatchedStatements 撑住 2000 点/秒；
(device_id, metric, ts) 唯一键让"至少一次"变得可接受；时间戳以服务端为准。
下一期写采集上线后最刺激的事：400 台设备批量掉线，最后查出是 ClientID 冲突。
原文 `device-collection`。