---
title: Java 设计模式实战：单例、策略与模板方法
description: 工作中高频使用的 6 个设计模式，附真实业务场景与完整 Java 代码
date: 2025-08-01
category: 学习笔记
tags: [设计模式, Java, 架构]
order: 1
slug: design-patterns
---

## 为什么还要学设计模式

很多人说设计模式"过时了"，是面试八股。我的看法是：**设计模式是代码坏味道的解药**——你不需要记住二十三种模式的 UML 图，但你需要认识那些反复出现的代码问题，以及对应的成熟解法。

这篇文章只讲我在真实业务里高频用到的 6 个模式，每个都配完整可跑的 Java 代码。

## 单例：双重检查锁、静态内部类、枚举

**场景**：全局唯一的配置读取器、ID 生成器、线程池包装类。在 Spring 项目里 `@Component` 默认就是单例，但有些工具类不进 Spring 容器，我们就得自己保证单例。

**双重检查锁（DCL）**——懒加载 + 线程安全：

```java
public class IdGenerator {

    private static volatile IdGenerator instance;

    private IdGenerator() { }

    public static IdGenerator getInstance() {
        if (instance == null) {                 // 第一次检查，避免无谓加锁
            synchronized (IdGenerator.class) {
                if (instance == null) {         // 第二次检查，防止重复创建
                    instance = new IdGenerator();
                }
            }
        }
        return instance;
    }
}
```

> 为什么 `instance` 必须是 `volatile`？因为 `new IdGenerator()` 不是原子操作：分配内存 → 初始化对象 → 把引用赋值给 instance。没有 volatile，指令重排可能让其他线程拿到"半初始化"的对象。

**静态内部类**——利用类加载机制天然实现懒加载 + 线程安全，代码更简洁：

```java
public class IdGenerator {

    private IdGenerator() { }

    private static class Holder {
        private static final IdGenerator INSTANCE = new IdGenerator();
    }

    public static IdGenerator getInstance() {
        return Holder.INSTANCE;
    }
}
```

**枚举单例**——《Effective Java》作者推荐的方式，连反射和序列化都能防：

```java
public enum IdGenerator {
    INSTANCE;

    public long nextId() {
        // 实现略
        return System.currentTimeMillis();
    }
}
```

**怎么选？** 99% 的业务场景静态内部类就够了；要防反序列化破坏单例、或者想写得最"安全"，用枚举。DCL 现在更多出现在面试题里——不是它不好，而是有更简单的替代。

## 工厂模式：设备协议工厂

**场景**：对接 Modbus-TCP、MQTT、自定义二进制协议……每种协议的连接建立、报文解析、心跳处理逻辑完全不同，接入层不能写一坨 if-else 去区分。

**第一步：定义统一接口**

```java
public interface DeviceProtocolParser {

    String protocolType();                       // 协议编码

    DeviceSession connect(String endpoint);      // 连接建立

    DeviceFrame parseFrame(byte[] rawData);      // 报文解析

    void handleHeartbeat(DeviceFrame frame);     // 心跳处理
}
```

**第二步：实现各种协议**

```java
@Component
public class ModbusTcpParser implements DeviceProtocolParser {

    @Override
    public String protocolType() { return "MODBUS_TCP"; }

    @Override
    public DeviceSession connect(String endpoint) {
        // 建立 TCP 会话，读寄存器，返回会话对象
        return null;
    }

    @Override
    public DeviceFrame parseFrame(byte[] rawData) {
        // 按功能码 + 寄存器地址解析 Modbus 报文
        return null;
    }

    @Override
    public void handleHeartbeat(DeviceFrame frame) {
        // 更新设备在线时间，断链自动重连
    }
}

@Component
public class MqttParser implements DeviceProtocolParser {
    // 类似实现，略
}
```

**第三步：工厂负责分发**

```java
@Component
public class DeviceProtocolFactory {

    // Spring 会自动把所有 DeviceProtocolParser 实现注入到这个 Map 里
    private final Map<String, DeviceProtocolParser> parserMap;

    public DeviceProtocolFactory(List<DeviceProtocolParser> parsers) {
        parserMap = parsers.stream()
                .collect(Collectors.toMap(DeviceProtocolParser::protocolType, p -> p));
    }

    public DeviceProtocolParser createProtocolParser(String protocol) {
        DeviceProtocolParser parser = parserMap.get(protocol);
        if (parser == null) {
            throw new BizException("不支持的设备协议: " + protocol);
        }
        return parser;
    }
}
```

接入侧只需要一行：`deviceProtocolFactory.createProtocolParser(frame.getProtocol()).parseFrame(frame.getRaw());`。以后新增一种协议，写一个实现类就完事——**开闭原则**的教科书案例。

> 这种"接口 + Spring 自动装配 + Map 分发"的写法，实际项目中比传统手写 `new` 工厂更常用，因为实例的生命周期交给容器管了。

## 策略模式：用枚举 + Map 干掉 if-else

**场景**：监控系统里阈值告警、变化率告警、离线告警，判定逻辑各不相同。最常见的烂代码长这样：

```java
if ("THRESHOLD".equals(alertType)) {
    result = sample.getValue() >= rule.getThreshold() ? "ALARM" : "NORMAL";
} else if ("RATE".equals(alertType)) {
    result = (sample.getValue() - sample.getPrevValue()) / sample.getPrevValue()
            >= rule.getRate() ? "ALARM" : "NORMAL";
} else if ("OFFLINE".equals(alertType)) {
    // ...
}
```

每加一种告警类型，这个 if-else 就长一截。用策略模式重构：

**第一步：抽象策略**

```java
public interface AlertStrategy {

    /** 判定设备当前是否需要告警 */
    AlertResult evaluate(DeviceSample sample, AlertRule rule);
}
```

**第二步：每种告警一个实现**

```java
@Component
public class ThresholdStrategy implements AlertStrategy {

    @Override
    public AlertResult evaluate(DeviceSample sample, AlertRule rule) {
        return sample.getValue() >= rule.getThreshold()
                ? AlertResult.alarm(rule.getCode())
                : AlertResult.normal();
    }
}

@Component
public class RateChangeStrategy implements AlertStrategy {

    @Override
    public AlertResult evaluate(DeviceSample sample, AlertRule rule) {
        // 变化率告警：与上一周期相比增幅超过阈值即告警
        double rate = (sample.getValue() - sample.getPrevValue()) / sample.getPrevValue();
        return rate >= rule.getRate()
                ? AlertResult.alarm(rule.getCode())
                : AlertResult.normal();
    }
}
```

**第三步：枚举关联类型 + Map 注册**

```java
public enum AlertType {
    THRESHOLD, RATE, OFFLINE
}

@Component
public class AlertStrategyRegistry {

    private final Map<AlertType, AlertStrategy> registry;

    public AlertStrategyRegistry(Map<AlertType, AlertStrategy> registry) {
        this.registry = registry;
    }

    public AlertResult apply(DeviceSample sample, AlertRule rule) {
        AlertStrategy strategy = registry.get(rule.getType());
        if (strategy == null) {
            throw new BizException("未知的告警类型");
        }
        return strategy.evaluate(sample, rule);
    }
}
```

告警判定处从一段 if-else 变成一行调用，新增告警类型时零改动既有代码。

> 什么时候不值得用策略模式？判断条件固定且只有两三个分支时，简单 if-else 反而更直白。设计模式是工具，不是 KPI。

## 模板方法：上报处理流程的骨架

**场景**：温度采集上报、振动采集上报、液位采集上报，流程都是"校验 → 入库 → 触发告警 → 通知"，但每一步的具体逻辑不同。把不变的部分写在父类，把变化的部分留给子类实现：

```java
public abstract class ReportHandleTemplate {

    /** 骨架方法：定义流程，加 final 防止子类改写 */
    public final void process(ReportContext ctx) {
        preValidate(ctx);         // 1. 前置校验（报文合法性）
        if (needAlert(ctx)) {     // 2. 是否需要触发告警
            persist(ctx);         // 3. 入库
            triggerAlert(ctx);    // 4. 触发告警
        }
        postProcess(ctx);         // 5. 后置处理（推送实时大屏等）
    }

    /** 钩子方法：默认实现，子类可按需覆盖 */
    protected boolean needAlert(ReportContext ctx) { return true; }

    protected abstract void preValidate(ReportContext ctx);
    protected abstract void persist(ReportContext ctx);
    protected abstract void triggerAlert(ReportContext ctx);
    protected abstract void postProcess(ReportContext ctx);
}
```

子类只关心自己的业务差异：

```java
public class TemperatureReportHandler extends ReportHandleTemplate {

    @Override
    protected void preValidate(ReportContext ctx) {
        if (ctx.getFrame().getTemperature() > 150) {
            throw new BizException("温度报文超出合理范围");
        }
    }

    @Override
    protected void persist(ReportContext ctx) {
        deviceRecordMapper.insert(ctx.getFrame().toRecord());
    }

    @Override
    protected void triggerAlert(ReportContext ctx) {
        alertEngine.trigger(new TemperatureAlert(ctx.getFrame().getDeviceNo(),
                ctx.getFrame().getTemperature()));
    }

    @Override
    protected void postProcess(ReportContext ctx) {
        realtimeScreenSender.push(ctx.getFrame().getDeviceNo(), ctx.getFrame());
    }
}
```

好处：流程骨架只有一份，加新的上报类型 = 新增一个子类，不用碰已有的上报处理逻辑。

## 观察者模式：Spring 事件监听

**场景**：设备上报成功后要触发告警推送、刷新实时大屏、写历史库——如果全写在 `handleReport()` 方法里，方法就成了一条"上帝函数"，而且每加一个动作都要改上报主流程。

Spring 的事件机制就是观察者模式的最佳实践：

```java
// 1. 定义事件
public class DeviceReportedEvent extends ApplicationEvent {

    private final DeviceReport report;

    public DeviceReportedEvent(Object source, DeviceReport report) {
        super(source);
        this.report = report;
    }

    public DeviceReport getReport() { return report; }
}
```

```java
// 2. 发布事件（上报主流程）
@Service
public class ReportService {

    @Autowired
    private ApplicationEventPublisher publisher;

    @Transactional
    public DeviceReport handleReport(ReportDTO dto) {
        DeviceReport report = reportMapper.insert(dto.toEntity());
        publisher.publishEvent(new DeviceReportedEvent(this, report));
        return report;
    }
}
```

```java
// 3. 观察者：各自监听，互不影响
@Component
public class AlertPushListener {

    @EventListener
    public void onDeviceReported(DeviceReportedEvent event) {
        alertNotifier.send(event.getReport().getDeviceNo(), event.getReport().getStatus());
    }
}

@Component
public class RealtimeScreenListener {

    @EventListener
    public void onDeviceReported(DeviceReportedEvent event) {
        realtimeScreen.refresh(event.getReport().getDeviceNo(), event.getReport().getTemperature());
    }
}
```

后续想加"上报后写历史库"，新增一个 `@EventListener` 方法就行，主流程一行不改。

> 两个提醒：一是事件监听器默认是**同步**执行的，耗时操作记得加 `@Async`；二是事务内发布的事件处理失败会让整个事务回滚，可以在事务提交后再发布（`@TransactionalEventListener`）。

## 建造者模式：Lombok @Builder 与手写

**场景**：参数特别多的"大对象"，比如一个设备配置对象，十几个字段，用 setter 一个个 set 写到手酸，还容易漏。建造者模式把构造过程拆成链式调用：

**Lombok 版本（日常首选）**：

```java
@Data
@Builder
public class DeviceConfig {
    private Long deviceId;
    private String deviceNo;
    private String protocol;           // MODBUS_TCP / MQTT / CUSTOM_BINARY
    private String endpoint;           // 设备连接地址
    private Integer collectInterval;   // 采集周期（秒）
    private Double alarmThreshold;     // 告警阈值
    private Integer offlineSeconds;    // 离线判定秒数
}

// 使用
DeviceConfig config = DeviceConfig.builder()
        .deviceNo("PRD-LINE-02-CNC-07")
        .protocol("MODBUS_TCP")
        .endpoint("192.168.10.21:502")
        .collectInterval(5)
        .alarmThreshold(85.0)
        .build();
```

**手写版本（理解原理）**：

```java
public class DeviceConfig {

    private final Long deviceId;
    private final String protocol;

    private DeviceConfig(Builder builder) {
        this.deviceId = builder.deviceId;
        this.protocol = builder.protocol;
    }

    public static Builder builder() { return new Builder(); }

    public static class Builder {
        private Long deviceId;
        private String protocol;

        public Builder deviceId(Long deviceId) { this.deviceId = deviceId; return this; }
        public Builder protocol(String protocol) { this.protocol = protocol; return this; }

        public DeviceConfig build() {
            // 可以在 build 里做参数校验
            if (deviceId == null) {
                throw new IllegalArgumentException("deviceId 不能为空");
            }
            return new DeviceConfig(this);
        }
    }
}
```

手写的优势是能在 `build()` 里加校验，Lombok 则胜在省事。生产环境我一般直接用 `@Builder`，参数校验交给 Bean Validation 注解。

## 一点总结

| 模式 | 解决什么问题 | 我的高频应用 |
| ---- | ------------ | ------------ |
| 单例 | 全局唯一实例 | 工具类、无状态服务 |
| 工厂 | 创建逻辑集中、按类型分发 | 设备协议解析、配置构造 |
| 策略 | 消灭条件分支、算法可替换 | 告警策略、协议差异化处理 |
| 模板方法 | 固定流程 + 局部变化 | 上报处理、批量导入导出 |
| 观察者 | 解耦事件与处理方 | Spring 事件、消息消费 |
| 建造者 | 复杂对象构造 | 配置对象、DTO 拼接 |

设计模式的核心就一句话：**把变化的和不变的分离**。能做到这一点，模式叫什么名字反而不重要。