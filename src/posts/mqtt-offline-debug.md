---
title: 400 台设备批量掉线排查：ClientID 冲突引发的血案
description: 水表设备频繁掉线的根因分析：ClientID 重复、心跳参数、NAT 映射超时的完整排查实录
date: 2025-12-05
category: 踩坑实战
tags: [MQTT, 设备掉线, 故障排查, EMQX]
order: 1
slug: mqtt-offline-debug
featured: true
---

> 2025 年 11 月底，某水司 NB-IoT 水表项目批量上线 400 台表，第二天开始"规律性
> 掉线"：每 1~2 小时就有一批设备掉线又自动重连，平台日报在线率 95% 上下浮动，
> 运维被骂得抬不起头。我接手排查，从 EMQX 日志到 ClientID 生成代码再到运营商
> NAT 策略，一共挖出两个根因。这篇是完整实录。

## 现象：每 1-2 小时掉一批

现象描述（运维原话整理）：

- 400 台水表分批上线，每天 8:00~22:00 之间，**每 1~2 小时**有 20~60 台掉线；
- 掉线后几秒到几分钟自动重连，平台"掉线-上线"告警刷屏；
- 客户那边 APP 最早发现：抄表任务经常失败，报"设备离线"；
- 设备固件日志里出现了让现场工程师很困惑的一行：**"session 被踢"**。

```text
2025-11-28 10:23:18.512 [WARN ] mqtt: connection lost, reason=session taken over
2025-11-28 10:23:18.514 [INFO ] mqtt: reconnect in 3000ms, attempt=1
```

设备是自己重连回来的，说明不是网络大面积故障——是**连接被对端主动踢掉**。
先看 Broker 侧日志。

## 排查第一步：从 Broker 侧找证据

EMQX 4.4 的日志在 `/var/log/emqx/`（5.x 在 `/var/log/emqx/` 下按节点分目录），
踢会话的关键词是 `taken over` / `takeover`。先统计再按设备聚拢：

```bash
# 统计一天内被顶号的次数
grep -i "taken.over" /var/log/emqx/emqx.log* | wc -l

# 找出被顶号最频繁的 client_id 前 20 名
grep -i "taken.over" /var/log/emqx/emqx.log* \
  | grep -oP 'client_id=[A-Za-z0-9_]+' \
  | sort | uniq -c | sort -rn | head -20
```

结果里 20 个 client_id 全部长这样：

```text
607 wm_00031278
588 wm_00031285
...
```

同一个 client_id 一天被顶 600 次，而且**顶它的和它自己是同一个 ID**。典型的
EMQX 会话接管日志长这样：

```text
2025-11-28T02:31:44.123821+08:00 [warning] emqx_channel:session_takenover:
  client(wm_00031278, v4, clean_start=true, keepalive=300)
  was taken over by client(wm_00031278, v4, ...)
```

即：**新连接顶着相同的 client_id 进来，EMQX 按 MQTT 规范必须把旧连接踢下线**。
问题变成：为什么同一个 client_id 会同时存在两个连接？

## 根因：同 ClientID 被重复连接

现场拆解出三类触发"双连接"的机制：

1. **换卡/重启**：NB-IoT 水表换 SIM 卡或断电重启后，模块重新拨号，网络侧 IP 变了，
   但旧 TCP 连接在运营商 NAT 里还"挂着"，没有 FIN 通知 Broker——于是新旧两个连接
   同时存在；
2. **模块深睡唤醒**：表具深睡后模块和 Broker 的连接实际已断（NAT 映射被回收），
   但模块自己不知道，唤醒后直接重连，照样是同一 client_id；
3. **两次固件连接**：调试期一台表被两台电脑/两套工具各连了一次。

无论哪种，结果都是同一 ID 的两个连接互相顶，顶一次＝掉线一次＝重连一次。
**问题本质不是"谁在顶"，而是 ClientID 本身不是全局唯一的。**

## ClientID 为什么重复：生成规则太粗糙

翻设备端代码（对接的第三方固件，代码片段是从对方手里要来的）：

```java
// 旧逻辑：ClientID = 前缀 + "表号后 8 位"
// 表号是 12 位，前 4 位是地市+区县编码，后 8 位是表具序号
String clientId = String.format("wm_%s", meterNo.substring(4));
```

看起来"后 8 位"应该唯一?但现场表号是 `[地市2位][区县2位][批次4位][序号4位]` 拼的
12 位，**两个不同批次、不同区县的表，序号部分完全相同**——后 8 位从第 5 位开始
截取，恰好把批次位砍掉了。一个批次 1 万台以内序号不会重复，但跨批次、跨区县就
大面积撞车。更隐蔽的是**换表**：新表沿用旧表的设置参数（含 ClientID），等于
两代设备用同一个 ID 上线。

```text
wm_0031 278  ---- 区县31 批次0278 序号...  
wm_0041 278  ---- 区县41 批次0278 序号...  ← 撞了！
```

排查结论一张表说清楚：

| 环节 | 问题 |
| ---- | ---- |
| ClientID 生成 | 按表号子串截取，非全局唯一（跨批次/跨区县冲突） |
| 会话策略 | cleanSession 配置混乱，重连后旧会话和新会话互相顶 |
| 心跳参数 | keepalive=300s，与运营商 NAT 超时不匹配（见第二个坑） |

## 正确方案：ClientID 规范 + 心跳参数

### ClientID 生成规范：稳定 + 全局唯一

原则：**ClientID = 厂商前缀 + 设备唯一编码 + 通信模组实例号，且一次生成终身不变**。
MQTT 3.1.1 规定 ClientID 为 1~23 字节 UTF-8，别超长：

```java
// 表号 12 位（全局唯一）+ 模组 IMEI 后 4 位（区分双卡/双模组场景）
String imei = getImeiViaAtCommand();           // AT+CGSN 或出厂烧录值
String clientId = String.format("wm_%s_%s", meterNo, imei.substring(imei.length() - 4));
// 长度 = 3 + 12 + 1 + 4 = 20 字节，合规且重启不变
```

要点：IMEI 从模组读、随出厂烧录，不能每次随机生成，否则 Broker 无法识别"同一个
设备"，QoS1 重发会重复。

### cleanSession 怎么选

纯数据上报场景（水表就是），选 **cleanSession=true**：Broker 不保存会话状态，
重启连接无残留，省 Broker 内存，也避免"旧会话还没过期、新连接又进来"的窗口。

```java
MqttConnectOptions options = new MqttConnectOptions();
options.setCleanSession(true);               // 上报场景：不保留离线会话
options.setKeepAliveInterval(30);            // 单位秒，配合心跳（见下节）
options.setConnectionTimeout(10);
options.setAutomaticReconnect(true);         // Paho 自动重连
options.setMaxReconnectDelay(60_000);        // 重连退避上限，防止 400 台同时冲击
```

> 如果确实需要"断线期间的消息补发"，也不要依赖 Broker 会话，而是设备端记
> seq 序号、重连后服务端按缺口补采——Broker 会话在 NAT 假在线的场景下本来就
> 不可靠（见下文第二个坑）。

### keepalive 与心跳区间匹配

MQTT 规范：Broker 在 **1.5 × keepalive** 时间内收不到任何报文就主动断开连接。
我们最终参数：**keepalive=30s，服务端监控阈值 60s 判定离线**：

- Broker 层：30s × 1.5 = 45s 无报文即断连，慢速但能兜底；
- 平台层：以 60s（2×）作为"判离线"的展示阈值，给告警留出余量，避免网络抖动
  误报；
- 设备端：Paho 会在空闲达到 keepalive 时自动发 PINGREQ，30s 的心跳同时维持在
  运营商 NAT 映射不超时（见第二个坑）。

```text
keepalive=30s → Broker 45s(1.5×) 断链 → 平台 60s(2×) 标离线
        ↑
设备空闲 30s 自动 PINGREQ，把 NAT 映射续住
```

## 第二个坑：运营商 NAT 映射超时导致的"假在线"

ClientID 修完，掉线次数降了一个数量级，但还剩下零星"在线却收不到数据"的设备。
继续查，发现 Broker 里这些设备**连接是活的**，可数据就是不来。这就是第二个坑：
**运营商 NAT 映射空闲超时**。

水表走 Cat-1/NB-IoT 网络，运营商网关侧 NAT 映射闲置一段时间后回收（常见
60s~5min，各运营商/套餐不同）。旧配置 keepalive=300s：设备 5 分钟才发一次保活，
第 2 分钟 NAT 映射就被回收了——设备端 TCP 还"以为"连着（收不到 RST），Broker 端
也看不到断开（没有 FIN）。于是：

```text
设备 ──(Cat-1/NB-IoT)──> 运营商NAT ──> EMQX
     每300s发包，映射早已被回收     ← 连接仍在，显示"在线"
       ↓                              ↓
  数据发不出去（等RST）         下行命令(远程抄表/阀门)全部失败
```

这就是"假在线"：**Broker 有连接 ≠ 设备真在线**。设备以为连着、平台以为在线，只有
抄表任务在报失败。

### 解决方案：短心跳 + 遗嘱消息 + 服务端在线状态核对

1. 把 keepalive 从 300s 降到 30s（数据上报周期不变，PINGREQ 自动发），保证心跳
   间隔小于 NAT 空闲超时；
2. **遗嘱消息（LWT）**：设备异常断开时让 Broker 代发一条离线消息：

```java
// Paho 通用遗嘱设置：异常断线（非正常 DISCONNECT）时 Broker 发布遗嘱
// 主题 devices/{deviceId}/status，QoS1，retained 让新订阅者立刻拿到最后状态
options.setWill("devices/" + deviceId + "/status",
                "{\"online\":false}".getBytes(StandardCharsets.UTF_8),
                1, true);
```

3. **服务端在线状态以 Redis last-seen 为准，不认 Broker 会话**：

```java
// 收到该设备任意消息（含心跳/数据）就续期
redis.setex("online:" + deviceId, 60, String.valueOf(System.currentTimeMillis()));

// 定时任务每分钟扫一遍：会话在但 last-seen 超过 45s → 判定假在线，
// 主动调用 Broker REST API 强制下线并置离线
```

这样"在线"的定义从"连接存在"变成了"**最近 45s 内确实有报文来过**"，假在线从
源头被堵死。

## 修复后的效果

上线观察一周，效果对比：

| 指标 | 修复前 | 修复后 |
| ---- | ---- | ---- |
| 单日掉线次数（400 台合计） | 400~800 次 | < 10 次 |
| 平台在线率 | 95.2% | 99.97% |
| "假在线"引起抄表失败 | 每天十几台 | 0 |
| 掉线后恢复时长 | 最长 30+ 分钟 | 秒级（自动重连 + 指数退避） |
| Broker CPU / 会话数 | 峰值 80% / 大量残留会话 | 稳定 25% / 无残留 |

## 复盘：设备接入规范五条

踩完之后，把这些沉淀成接入规范，新设备上线先过这五条：

1. **ClientID 全局唯一且终身不变**：厂商前缀 + 设备唯一编码 + 模组实例号，长度
   ≤ 23 字节 ASCII，禁止按表号子串截取生成；
2. **明确会话策略**：纯上报用 cleanSession=true；确需离线消息的业务单独申请
   session 队列并限制过期时间；
3. **心跳与网络匹配**：keepalive ≤ 45s 且小于主流运营商 NAT 空闲超时的一半；
   上报周期长不等于可以不开心跳，PINGREQ 由协议栈自动发；
4. **上线必须注册元数据**：设备连上后第一条消息上报 IMEI、固件版本、时间戳，
   服务端登记后才允许业务订阅，防止"僵尸设备"占用 Broker 连接；
5. **遗嘱 + 服务端状态核对**：设备必须配置 LWT；平台在线状态一律以 last-seen
   为准，发现"会话在但心跳过期"的设备自动强制下线并告警。

> 事后看，400 台掉线是个很"土"的问题：ClientID 撞了。但真正值钱的是排查路径——
> 从现象到 Broker 日志、从日志到生成代码、再从代码追到运营商网络，每一步都有
> 证据才下结论。**一切看似玄学的掉线，都能在接入规范里找到答案。**

## 小结

- ClientID 必须全局唯一且稳定，冲突的直接后果就是"session 被踢"式的批量掉线；
- keepalive 要和运营商 NAT 超时匹配，30s 心跳 + 60s 判离线是我们验证过的组合；
- Broker 显示在线不等于真在线，服务端用 LWT + last-seen 核对才可靠；
- 400 台设备的重连必须指数退避 + 随机抖动，否则断网恢复瞬间会把 Broker 打爆。

原文 `mqtt-offline-debug`，Modbus 与采集链路的另外两篇见 `modbus-java` 和
`device-collection`。