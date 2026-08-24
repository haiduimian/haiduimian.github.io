---
title: JVM 内存模型与垃圾回收
description: 运行时数据区、对象分配、GC 算法与常用调优参数，理解 Java 内存世界的必修课
date: 2025-04-20
category: Java 核心
tags: [JVM, 内存模型, GC, 调优]
order: 3
slug: jvm-memory
---

> 原博客「pytorch」笔记讲 Python 的深度学习框架，这篇对应的 Java「底层必修课」是 JVM：内存分区、GC 与调优。Python 的 GIL 与引用计数和 JVM 的 Stop The World + 分代回收完全是两个世界。

## 运行时数据区

```
┌─────────────────────────────────────┐
│  线程共享                          │
│  ┌──────────┬────────────────────┐  │
│  │ 堆 Heap   │ 方法区 Method Area │  │
│  │ (对象)    │ (类信息/常量池)     │  │
│  └──────────┴────────────────────┘  │
│  线程私有                          │
│  ┌─────┬─────┬──────┬───────────┐   │
│  │ VM  │本地 │程序  │ 栈帧      │   │
│  │栈   │方法栈│计数器│ (局部变量表│   │
│  │     │     │      │  操作数栈) │  │
│  └─────┴─────┴──────┴───────────┘   │
└─────────────────────────────────────┘
```

| 区域 | 作用 | 异常 |
|---|---|---|
| 堆 | 存放对象实例，垃圾回收主战场 | OutOfMemoryError: Java heap space |
| 方法区（元空间） | 类信息、常量、静态变量（JDK8 后用本地内存） | OutOfMemoryError: Metaspace |
| 虚拟机栈 | 每个方法一个栈帧（局部变量表、操作数栈） | StackOverflowError |
| 程序计数器 | 当前线程执行字节码的行号 | 无 |
| 本地方法栈 | native 方法调用 | StackOverflowError |

JDK8 起方法区改为**元空间（Metaspace）**，使用本地内存，默认不设上限，类加载过多时才会 OOM。

## 对象创建与分配

```java
User u = new User("fxy");
```

1. **类加载检查**：类是否已加载、链接、初始化
2. **分配内存**：优先在 Eden 区（TLAB 线程本地分配缓冲）
3. **初始化零值**：字段设默认值
4. **设置对象头**：Mark Word、类型指针
5. **执行构造方法**

## 对象晋升流程

```
Eden → (Minor GC 存活) → Survivor S0 → S1 → ... → (年龄 ≥ 15) → 老年代
```

- 对象先分配在 Eden，Minor GC 后存活对象进入 Survivor 区
- 每熬过一次 Minor GC 年龄 +1，默认 15 岁晋升老年代（-XX:MaxTenuringThreshold）
- 大对象（-XX:PretenureSizeThreshold）直接进老年代，避免复制开销

## GC 算法

| 算法 | 思路 | 缺点 |
|---|---|---|
| 标记-清除 | 标记可达对象，清除不可达 | 内存碎片 |
| 标记-复制 | 存活对象复制到另一半 | 浪费一半空间 |
| 标记-整理 | 标记后把所有存活对象向一端移动 | 移动成本高 |

**分代收集策略**：

- 新生代（Eden + 2 个 Survivor，默认 8:1:1）：存活率低 → **复制算法**
- 老年代：存活率高 → **标记-整理 / 标记-清除**

## 常用垃圾收集器

| 收集器 | 特点 | 适用 |
|---|---|---|
| Serial / Serial Old | 单线程，暂停整个应用 | 客户端、小内存 |
| Parallel Scavenge / Parallel Old | 多线程吞吐优先 | JDK8 默认 |
| CMS | 并发标记清除，低停顿 | 老年代，JDK9 起废弃 |
| G1 | 分区化，可预测停顿 | JDK9+ 默认，大堆推荐 |
| ZGC / Shenandoah | 极低停顿（毫秒级） | 超大堆、低延迟场景 |

G1 把堆分成 2048 个 Region，可动态选择回收价值最高的区域（Garbage First），通过 -XX:MaxGCPauseMillis 设定停顿目标。

## STW 与安全点

GC 需要**Stop The World**：暂停所有业务线程再回收。停顿时间来源：

- 枚举根节点（GC Roots）
- SafePoint：线程跑到安全点才响应暂停请求
- 编译代码中的安全点

ZGC 通过染色指针 + 读屏障把停顿压到毫秒级，但代价是 CPU 开销。

## 常用调优参数

```bash
# 堆大小
-Xms512m -Xmx512m        # 初始/最大堆，生产建议相等避免扩容抖动
-Xmn256m                 # 新生代大小
-XX:MetaspaceSize=128m   # 元空间初始

# 日志（JDK8）
-XX:+PrintGCDetails -XX:+PrintGCDateStamps -Xloggc:/logs/gc.log

# 日志（JDK9+，推荐）
-Xlog:gc*:file=/logs/gc.log:time,uptime,level,tags

# OOM 时自动 dump
-XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/logs/heap.hprof
```

## 一个线上调优案例

现象：服务每 5 分钟一次 Full GC，Full GC 耗时 800ms+，接口 P99 抖动。

排查步骤：

```bash
# 1. 看 GC 频率和耗时
jstat -gcutil <pid> 1000

# 2. 看堆分布
jmap -heap <pid>

# 3. 看大对象
jmap -histo:live <pid> | head -20
```

结论：老年代对象快速增长，`byte[]` 占大头 → 某一处把大数据全部加载进内存（如 List 查询无分页，导出功能一次性 load 全表）。

修复：分页/流式处理代替全量加载；临时大对象提前置 null 并确保可回收。

## 小结

- 堆分新生代/老年代，对象按年龄晋升
- 新生代复制算法、老年代整理算法，G1 分区化回收
- STW 不可避免，调优目标是**减少 Full GC 频率与单次停顿**
- 参数不是越多越好：先量（堆大小）再配（GC 器选择），结合监控数据调整