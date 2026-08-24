---
title: JVM 内存泄漏排查实录：一次 Full GC 频发的救火经历
description: 使用 jmap、jstat、MAT 从崩溃的堆转储中找出 ArrayList 静态容器泄漏的完整过程
date: 2026-04-25
category: 踩坑实战
tags: [JVM, 内存泄漏, MAT, 调优]
order: 3
slug: oom-debug
---
## 现象：Full GC 每 5 分钟一次

四月下旬的一个周六，运维发来一张监控截图：**设备数据接入服务老年代占用率从下午的 40% 一路爬到 92%，Full GC 每 5 分钟触发一次，每次 STW 2~3 秒**——设备上报数据出现接收延时和丢失，监控大屏的数据开始滞后，现场反馈曲线对不上。

这服务是个老项目，堆配置 4G（新生代 1G / 老年代 3G），平时 GC 很健康：YGC 每秒几次，Full GC 一周都难得有一次。从「健康」到「每周恶化」的曲线，基本可以断定：**有内存泄漏**，而且泄漏速度在加快。

## 排查工具链：从轻到重，逐层收敛

### 第一步：jstat 看 GC 曲线

先 `top` 确认进程 PID，然后 jstat 盯 30 分钟：

```bash
jstat -gcutil 27481 5000
```

输出（截取关键几行）：

```
  S0     S1     E      O      M     CCS    YGC     YGCT    FGC    FGCT     GCT
  0.00  88.10  71.32  82.14  96.1   ...    3921   55.204     35   39.410    94.614
  0.00  92.35  78.40  85.03  96.1   ...    4123   58.204     37   41.813   100.017
  0.00  89.11  83.22  88.71  96.1   ...    4330   61.103     42   47.260   108.363
```

注意两列：**O（老年代使用率）单调上涨，FGC（Full GC 次数）和 FGCT（Full GC 总耗时）在加速**。30 分钟内 Full GC 从 35 次涨到 42 次——不是回收不掉，而是回收完又被很快填满。

### 第二步：jmap -heap 确认老年代水位

```bash
jmap -heap 27481
```

关键输出：

```
Heap Configuration:
   MaxHeapSize = 4294967296 (4096.0MB)
   ...
Heap Usage:
PS Old Generation
   capacity = 3221225472 (3072.0MB)
   used     = 2838478920 (2707.2MB)
   free     = 322746552 (307.8MB)
   88.1% used
```

老年代已用 88%，还在涨。**Full GC 后老年代只回落 5% 以内**，基本实锤泄漏——如果是大对象临时聚集，Full GC 后应该大幅回落。

### 第三步：jmap -histo 找可疑对象

`jmap -histo` 会触发一次 STW（生产要谨慎），低峰期执行可以接受：

```bash
jmap -histo:live 27481 | head -25
```

输出（简化）：

```
 num     #instances         #bytes  class name
   1:      13048217    1878943248  com.xxx.iot.gateway.ingest.DeviceReportRecord
   2:        415000      21580000  [B
   3:        300000      15450000  java.lang.String
   4:             1            48  java.util.ArrayList
```

一个我们自己的业务对象 `DeviceReportRecord` 有 **1300 万个实例、占用 1.8G**——占了大半个老年代。一个业务对象不该有这么多实例，它必然被某个「根」一直引用着。

### 第四步：打开堆转储

泄漏的对象找到了，但还要知道「谁持有它们」。用 `jmap -dump:live` 现场抓一份堆（生产选择低峰期）：

```bash
jmap -dump:live,format=b,file=/data/dump/devicegw-$(date +%Y%m%d%H%M).hprof 27481
```

> 生产上的标准姿势其实是：**给 JVM 加上 OOM 自动 dump 参数，让它崩溃时自己留下现场**。这次我们一边人工 dump，一边给线上补上下面这行，万一半夜再 OOM 也能抓到第二次现场：
>
> ```bash
> java -Xms4g -Xmx4g \
>      -XX:+HeapDumpOnOutOfMemoryError \
>      -XX:HeapDumpPath=/data/dump \
>      -jar device-gateway.jar
> ```

## MAT 分析：Dominator Tree 揪出 static 容器

hprof 有 2.1G，用 MAT（Memory Analyzer）打开。MAT 默认分析对象的强引用路径，正好够用。

### 第一步：先看 Histogram

`Histogram` 视图里点开 `DeviceReportRecord`，右键 → **List objects → with outgoing references**，能看到这些对象被谁引用。

### 第二步：Path to GC Roots

再右键 → **Merge Shortest Paths to GC Roots → exclude all phantom/weak/soft etc. references**，结果一目了然：

```
com.xxx.iot.gateway.ingest.DeviceReportCollector
  └─ static RECORDS  (java.util.ArrayList)  [1.9 GB retained]
     └─ <Java Local> → 1300 万个 DeviceReportRecord
```

### 第三步：Dominator Tree 定量确认

切到 **Dominator Tree** 视图，顶部赫然一行：

| Object | Shallow Heap | Retained Heap |
| ---- | ---- | ---- |
| `java.util.ArrayList @ 0x7f3c8xxx`（DeviceReportCollector.RECORDS） | 48 B | 1,879,357,040 B（1.75 GB） |

一个 shallow 只有 48 字节的 ArrayList，retained 1.75G——**它支配了整棵引用子树**。泄漏点锁定：`DeviceReportCollector` 的静态集合。

> 排查泄漏的标准动作就三步：`jstat` 看趋势确认泄漏 → `jmap -histo` 找谁多 → MAT 看 GC Roots 找谁持有。后两步能精确到「字段级别」。

## 泄漏代码示例与修复

### 元凶代码

泄漏点是设备上报记录的一个「顺手实现」。当时为了采集统计需求，把每一条上报记录先攒在内存里，每分钟用定时任务批量落库一次，**落库成功后忘了清空容器**：

```java
public class DeviceReportCollector {

    /** 内存里攒着待落库的设备上报记录 —— static + ArrayList + 无界增长 */
    private static final List<DeviceReportRecord> RECORDS = new ArrayList<>();

    // 设备上报时调用，接入高峰期每秒几十万条
    public static void record(DeviceReportRecord record) {
        RECORDS.add(record);
    }

    @Scheduled(fixedRate = 60_000)
    public void flush() {
        List<DeviceReportRecord> batch = new ArrayList<>(RECORDS);
        try {
            reportStore.persist(batch);
            // BUG：落库成功后没有 RECORDS.clear()
            // 正常情况：每分钟清一次，容器基本是空的
            // 异常情况：reportStore 一直抛异常，batch 永远发不出去，
            //          但 record() 还在不断 add —— 于是无限增长
        } catch (Exception e) {
            log.error("设备上报记录落库失败，下轮重试", e);
        }
    }
}
```

为什么漏掉？因为之前上线时 `reportStore.persist` 一直返回成功，测试环境流量小，容器每分钟都能清空，**问题只在「落库持续失败 + 流量大」两个条件同时成立时爆发**——线上正好赶上报障期，数据链路下游的时序存储服务挂了 40 分钟。

### 修复方案

```java
public class DeviceReportCollector {

    // 1. 有界队列，从源头限制内存占用
    private static final ArrayBlockingQueue<DeviceReportRecord> QUEUE = new ArrayBlockingQueue<>(100_000);

    public static boolean record(DeviceReportRecord record) {
        return QUEUE.offer(record);   // 满了直接丢弃并计数，绝不阻塞主流程
    }

    @Scheduled(fixedRate = 60_000)
    public void flush() {
        List<DeviceReportRecord> batch = new ArrayList<>(QUEUE.size());
        QUEUE.drainTo(batch, 100_000);   // 2. drain 原子取出并清空，不需要手动 clear
        if (batch.isEmpty()) {
            return;
        }
        try {
            reportStore.persist(batch);
        } catch (Exception e) {
            // 3. 失败走 MQ 补偿，而不是留在 JVM 内存里
            mqTemplate.convertAndSend("device-report.retry", batch);
            log.error("落库失败，已转 MQ 补偿，数量={}", batch.size(), e);
        }
    }
}
```

### 为什么这样改

- **去掉「static + 无界 ArrayList」的组合**：static 意味着生命周期 = 类生命周期 = 进程生命周期，GC 永远回收不掉；无界意味着没有上限保护。
- 改成**有界队列 + drainTo**：`drainTo` 是原子的「取出并清空」，天然不会重复消费也不会残留；
- 失败数据**转移出 JVM**（MQ / 落库），让内存只做「瞬时缓冲」，不做「持久存储」。

如果业务上就是要「带过期时间的本地缓存」，优先用 Caffeine 这类带容量和过期策略的组件，而不是手写 static Map/List。

## 预防：三道防线

### 防线一：代码评审与静态检查

把「static 字段持有 Collection」写进团队规范，最好做成机器检查，比如 Checkstyle：

```xml
<!-- checkstyle: 禁止 static 字段持有集合类型 -->
<module name="RegexpSinglelineJava">
    <property name="format"
              value="static\s+(final\s+)?(List|Map|Set|Queue|Collection)&lt;"/>
    <property name="message"
              value="禁止 static 字段持有集合，请使用 Spring 单例 + 有界容器"/>
</module>
```

### 防线二：监控告警

老年代监控不能只看「会不会 OOM」，要看**趋势**：

- 老年代使用率 > 80% 持续 15 分钟 → P1 告警；
- Full GC 频率 > 1 次/10 分钟，或单次 STW > 2s → P1 告警；
- 堆内大对象分布（通过 JMX 暴露 histo 快照）每周对比一次。

### 防线三：上线前小堆压测

泄漏的可怕之处在于「上线时看不出来」。可以在预发环境把堆压到 512M 跑一晚上流量，第二天看老年代曲线——**泄漏的服务在小堆下几小时就 OOM，健康服务会平稳运行**。这次教训足够深刻，后续凡是涉及「内存里攒数据」的代码一律过这道关。

## 总结

| 环节 | 动作 |
| ---- | ---- |
| 发现 | jstat 看 O/FGC 趋势，Full GC 后老年代不回落 = 泄漏 |
| 定位 | jmap -histo 找实例数异常的业务对象 |
| 取证 | -XX:+HeapDumpOnOutOfMemoryError 自动抓现场 |
| 分析 | MAT Dominator Tree + Path to GC Roots，精确到字段 |
| 修复 | 去 static 无界集合，改有界队列 + drainTo，失败转 MQ |
| 预防 | 规范禁 static 集合、老年代/GC 告警、小堆压测 |

内存泄漏不会自己消失，它只会在某个深夜把服务拖死。把工具链和规范刻进习惯里，救火才能变成防火。