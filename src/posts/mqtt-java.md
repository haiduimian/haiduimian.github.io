---
title: MQTT 协议与 Java 实战：物联网设备接入
description: MQTT 核心概念（QoS、Topic、遗嘱消息）+ Eclipse Paho 客户端收发消息完整示例
date: 2025-09-07
category: 工业物联网
tags: [MQTT, 物联网, Paho, 协议]
order: 3
slug: mqtt-java
---

## 背景：一个真实的设备接入项目

去年公司做智能水表项目，几万台设备散布在全市各个小区。设备侧是 MCU + 4G 模组，功耗敏感、网络不稳定，服务端要同时维护几万条长连接。

最开始想用 HTTP 轮询：设备每 30 秒上报一次数据。结果发现两个问题：一是几万台设备同时请求，网关压力巨大；二是服务端想给设备下发指令（比如远程关阀），HTTP 根本做不到主动推送，只能靠设备频繁轮询，延迟高达分钟级。

后来换成了 MQTT，问题迎刃而解。这篇文章讲清楚 MQTT 的核心概念，再给出 Eclipse Paho Java 客户端的完整实践。

## MQTT 是什么，凭什么比 HTTP 适合 IoT

MQTT（Message Queuing Telemetry Transport）是专为**受限网络环境**设计的轻量级消息协议，基于发布/订阅模型，运行在 TCP 之上。

| 对比项 | HTTP | MQTT |
| --- | --- | --- |
| 通信模型 | 请求/响应，1 对 1 | 发布/订阅，1 对 N |
| 报文开销 | 头部动辄几百字节 | 固定头最小仅 2 字节 |
| 主动推送 | 不支持，只能轮询 | 天然支持 |
| 弱网表现 | 断线要重发整个请求 | QoS + 会话恢复机制 |
| 客户端状态 | 无状态 | Broker 维护会话与遗嘱消息 |

> MQTT 报文头最小 2 个字节（固定头）——对农村水表这种"一次上报都恨不得算流量费"的场景，这个差异是决定性的。

## 五个必须搞懂的核心概念

**1. Broker（消息代理）**

MQTT 是中心化的：所有消息都经过 Broker 中转，客户端只和 Broker 通信。常用的开源 Broker 有 EMQX（功能全、管理界面好）和 Mosquitto（轻量）。

**2. Topic（主题）与通配符**

Topic 是 UTF-8 字符串，用 `/` 分层，是发布/订阅的"地址"：

```text
water-meter/community-a/building-1/device-001/temp
                └────────┬────────┘    └───┬───┘
                    层级定位            具体指标
```

两个通配符必须记住：

| 通配符 | 含义 | 示例 |
| --- | --- | --- |
| `+` | 匹配**一层** | 订阅 `water-meter/+/building-1/#` |
| `#` | 匹配**任意多层**，只能放末尾 | 订阅 `water-meter/#` 收所有水表消息 |

**3. QoS（服务质量）**

消息送达的可靠程度，三个等级：

| QoS | 名称 | 语义 | 适用 |
| --- | --- | --- | --- |
| 0 | 至多一次 | 发了就不管，可能丢 | 温湿度等时序数据，丢一帧无所谓 |
| 1 | 至少一次 | 保证到达，可能**重复** | 默认选择，数据上报 |
| 2 | 恰好一次 | 四次握手保证不重不丢 | 计费、控制指令等强一致场景 |

**4. KeepAlive（心跳保活）**

客户端在空闲时按 KeepAlive 周期发送 PINGREQ，Broker 如果在 1.5 倍时间内没收到任何报文，就判定连接断开，清理会话。

**5. 遗嘱消息（LWT，Last Will and Testament）**

设备连接时登记一份"遗嘱"（topic + 消息），当它**异常掉线**（网络断、设备崩溃）时，Broker 替它把遗嘱发出去；正常断开（DISCONNECT）则不发送。这是物联网做**掉线检测**的基石。

## 本地搭一个 Broker：Docker 一条命令

用 EMQX，一条命令搞定，自带 Web 管理台：

```bash
docker run -d --name emqx \
  -p 1883:1883 \      # MQTT 端口
  -p 18083:18083 \    # Dashboard 端口
  emqx/emqx:5.6.0
```

启动后浏览器打开 `http://localhost:18083`（默认账号 admin/public）就能看到连接数和消息统计。

想更轻量也可以用 Mosquitto：

```bash
docker run -d --name mosquitto -p 1883:1883 eclipse-mosquitto:2
```

## Eclipse Paho Java 客户端实战

Paho 是 Eclipse 基金会维护的 MQTT 客户端库，Java 版 Maven 依赖：

```xml
<dependency>
    <groupId>org.eclipse.paho</groupId>
    <artifactId>org.eclipse.paho.client.mqttv3</artifactId>
    <version>1.2.5</version>
</dependency>
```

**连接 Broker，参数逐个注释：**

```java
import org.eclipse.paho.client.mqttv3.*;

public class DeviceClient {

    public static void main(String[] args) throws Exception {
        String broker   = "tcp://127.0.0.1:1883";
        String clientId = "water-meter-001";   // 客户端唯一 ID，重复会被互踢！

        MqttClient client = new MqttClient(broker, clientId);

        MqttConnectOptions options = new MqttConnectOptions();
        // 清理会话：true = 每次重连都从零开始；false = Broker 保存离线消息
        options.setCleanSession(true);
        // TCP 连接超时（秒）
        options.setConnectionTimeout(10);
        // 心跳间隔（秒）：空闲时每 60s 发一次 PINGREQ
        options.setKeepAliveInterval(60);
        // 断线自动重连（要求回调实现 MqttCallbackExtended）
        options.setAutomaticReconnect(true);
        options.setMaxReconnectDelay(30000); // 重连最大间隔 30s
        // 遗嘱消息：异常掉线时，Broker 替设备发布这条消息
        options.setWill("water-meter/device-001/status",
                "offline".getBytes(), 1, true);

        client.setCallback(new MqttCallbackExtended() {
            @Override
            public void connectComplete(boolean reconnect, String serverURI) {
                // 自动重连完成后必须重新订阅！Broker 不记得你之前的订阅
                System.out.println("连接成功: " + serverURI);
                resubscribe(client);
            }

            @Override
            public void connectionLost(Throwable cause) {
                System.out.println("连接断开: " + cause.getMessage());
            }

            @Override
            public void messageArrived(String topic, MqttMessage message) throws Exception {
                System.out.printf("收到 [%s]: %s%n", topic, new String(message.getPayload()));
            }

            @Override
            public void deliveryComplete(IMqttDeliveryToken token) {
                // QoS > 0 的消息送达回调
            }
        });

        client.connect(options);
    }
}
```

**订阅与发布：**

```java
// 订阅：收某个小区所有水表的温度数据（QoS 用 1，至少一次）
client.subscribe("water-meter/+/temperature", 1);

// 发布：上报本设备数据（QoS 1 + retained 保留）
String payload = "{\"deviceId\":\"001\",\"temp\":23.5,\"battery\":86}";
MqttMessage msg = new MqttMessage(payload.getBytes());
msg.setQos(1);
msg.setRetained(true); // 保留：新订阅者立刻能收到最近一条，设备"上线即有值"
client.publish("water-meter/device-001/temperature", msg);

// 发布 QoS 2 的控制指令（不重不丢）
MqttMessage cmd = new MqttMessage("CLOSE_VALVE".getBytes());
cmd.setQos(2);
client.publish("water-meter/device-001/command", cmd);
```

> 三个发布相关的设置要分清：`setQos` 控制可靠性；`setRetained(true)` 让 Broker 保存最近一条消息并给后来的订阅者补发；`setWill` 是掉线时自动发布的遗嘱消息。

## 设备掉线检测：遗嘱消息 + 心跳

水表被砸了、电池耗尽、信号进隧道——设备"死"的方式千奇百怪，服务端怎么知道？

**方案一：遗嘱消息（被动检测）**

设备连接时登记遗嘱：

```java
options.setWill("water-meter/device-001/status", "offline".getBytes(), 1, true);
```

服务端订阅 `water-meter/+/status`，收到 `offline` 就标记设备掉线。但注意：**遗嘱只在 TCP 连接异常断开时触发**，而且 Broker 感知断线需要等 1.5 个 KeepAlive 周期（比如 90 秒）。

**方案二：主动心跳（兜底）**

设备每 30 秒上报一次心跳到固定 Topic：

```java
// 设备侧：定时线程
ScheduledExecutorService timer = Executors.newScheduledThreadPool(1);
timer.scheduleAtFixedRate(() -> {
    try {
        client.publish("water-meter/device-001/heartbeat", "1".getBytes(), 0, false);
    } catch (MqttException e) {
        // 网络断了，交给 AutomaticReconnect 处理
    }
}, 0, 30, TimeUnit.SECONDS);
```

服务端记录每个设备的最后心跳时间，超过 60 秒没收到就判定离线——比遗嘱更快、更可控。

> 生产上两个配合用：**心跳做主检测，遗嘱做快速通知**。服务端还可以在收到遗嘱的瞬间主动发一条指令验证设备是否真的"死"了，防止误判。

## 常见坑：我亲自踩过的几个

**坑 1：ClientID 重复导致互踢**

MQTT 协议规定 ClientID 唯一。两台设备用了同一个 ID（比如出厂配置错误），后连的会把先连的挤下线，然后先连的重连又把后连的挤掉——形成"互踢抖动"，日志里全是 `Connection lost`。

```java
// 错误示范：所有设备硬编码同一个 clientId
String clientId = "water-meter"; // ❌ 千万不能这样

// 正确：设备唯一标识作为 ClientID
String clientId = "water-meter-" + device.getImei(); // ✅
```

**坑 2：QoS 0 丢消息，且毫无感知**

QoS 0 的消息发出即焚，Broker 崩了、网络闪断，消息就悄悄没了。**上报数据丢不可怕，可怕的是你不知道丢了**。对策：重要数据用 QoS 1，实时性要求高的时序数据（温湿度）才用 QoS 0。

**坑 3：自动重连后忘记重新订阅**

`setAutomaticReconnect(true)` 只管 TCP 重连，**不会恢复订阅**（cleanSession=true 时尤其如此）。断线重连后经常收不到第一条消息，排查半天发现是回调里没有重新 subscribe。上面的代码里我把重订阅写进了 `connectComplete`，就是为这个。

**坑 4：retained 消息带来过期数据**

有些设备端想当然地设了 retained，结果新设备上线看到的"最近温度"其实是三天前的。retained 适合配置类、状态类消息，纯传感器数据慎用。

## 小结

| 知识点 | 一句话记住 |
| --- | --- |
| Topic | 用 `/` 分层，`+` 匹配一层，`#` 匹配多层 |
| QoS | 0 可能丢，1 保证到但可能重复，2 不重不丢 |
| KeepAlive | 设备还活着的最直接证据 |
| 遗嘱 LWT | 异常掉线时 Broker 代替设备"喊一嗓子" |
| ClientID | 全局唯一，否则互踢 |

MQTT 最难的地方不在协议本身，而在把"弱网 + 海量设备 + 掉线检测"这套组合拳设计好。下一篇聊聊位运算——一道算法题，把异或、与、移位讲透。