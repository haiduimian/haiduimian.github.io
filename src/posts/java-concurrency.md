---
title: Java 并发编程：多线程与线程池
description: 从 Thread 到 CompletableFuture，线程状态、锁、线程池参数与并发工具类的实战笔记
date: 2025-03-01
category: Java 核心
tags: [并发, 线程池, JUC, 多线程]
order: 2
slug: java-concurrency
---

> 原博客的「多进程，多线程」笔记基于 Python 的 multiprocessing/threading，这篇换成 Java 版本：JUC 工具、线程池原理与并发实战。Java 的并发模型和 Python 差异很大——重点是**共享内存 + 显式锁**，而不是 GIL 下的资源竞争。

## 为什么需要多线程

单线程顺序执行，遇到 IO 只能干等：

```java
// 串行：总耗时 = t1 + t2 + t3
String data1 = httpGet("http://api.a.com");
String data2 = httpGet("http://api.b.com");
String data3 = httpGet("http://api.c.com");
```

如果三个请求互不依赖，用线程池并行，总耗时 ≈ max(t1, t2, t3)：

```java
ExecutorService pool = Executors.newFixedThreadPool(3);
Future<String> f1 = pool.submit(() -> httpGet("http://api.a.com"));
Future<String> f2 = pool.submit(() -> httpGet("http://api.b.com"));
Future<String> f3 = pool.submit(() -> httpGet("http://api.c.com"));
String a = f1.get();
String b = f2.get();
String c = f3.get();
```

## 线程的创建方式

```java
// 方式一：继承 Thread（不推荐，Java 单继承）
class MyThread extends Thread {
    @Override public void run() { /* ... */ }
}

// 方式二：实现 Runnable（无返回值）
Runnable task = () -> System.out.println("hello");

// 方式三：Callable + Future（有返回值）
Callable<Integer> task = () -> 1 + 1;
Future<Integer> future = executor.submit(task);
```

> **禁止直接 new Thread()**：每来一个请求就建一个线程，线程数量不受控，高并发下直接 OOM。务必使用线程池。

## 线程状态与生命周期

```
NEW → RUNNABLE → BLOCKED → WAITING / TIMED_WAITING → TERMINATED
```

| 状态 | 触发条件 |
|---|---|
| NEW | new 出来还没 start() |
| RUNNABLE | 可运行 / 运行中（包含等待 CPU 时间片） |
| BLOCKED | 等 synchronized 锁（没抢到） |
| WAITING | wait()、join()，需要被 notify |
| TIMED_WAITING | sleep()、wait(ms)、join(ms) |
| TERMINATED | run() 执行完或异常退出 |

## 锁：synchronized 与 Lock

`synchronized` 是 JVM 内置锁（偏向锁→轻量级→重量级），`Lock` 是 JDK 提供的接口（如 `ReentrantLock`）。

```java
// synchronized 同步代码块
public synchronized void increment() { count++; }

// ReentrantLock 手动加解锁
private final Lock lock = new ReentrantLock();
public void increment() {
    lock.lock();
    try {
        count++;
    } finally {
        lock.unlock();   // 必须 finally 释放！
    }
}
```

**原子性问题的本质**：`count++` 不是原子操作（读-改-写三步），多线程并发执行时会丢更新。解决思路：加锁、或用原子类。

```java
AtomicInteger count = new AtomicInteger(0);
count.incrementAndGet();   // CAS 无锁实现
```

## 线程池：核心参数

阿里巴巴开发手册要求 **不要用 Executors 快捷方法**（newFixedThreadPool 的队列无界、newSingleThreadExecutor 同理，会堆积任务导致 OOM），手动 new ThreadPoolExecutor：

```java
ThreadPoolExecutor pool = new ThreadPoolExecutor(
    5,                          // corePoolSize 核心线程数
    10,                         // maximumPoolSize 最大线程数
    60L, TimeUnit.SECONDS,      // 空闲线程存活时间
    new ArrayBlockingQueue<>(100),  // 工作队列
    Executors.defaultThreadFactory(),
    new ThreadPoolExecutor.AbortPolicy()  // 拒绝策略
);
```

**执行流程**（必须背下来）：

1. 核心线程未满 → 新建线程执行
2. 核心线程已满 → 任务进工作队列
3. 队列已满 → 扩容到 maximumPoolSize
4. 仍满 → 触发拒绝策略

**拒绝策略四种**：

| 策略 | 行为 |
|---|---|
| AbortPolicy | 抛 RejectedExecutionException（默认） |
| CallerRunsPolicy | 让提交者线程自己执行（常用！利于削峰） |
| DiscardPolicy | 直接丢弃 |
| DiscardOldestPolicy | 丢弃队列最老的任务 |

## volatile：可见性与有序性

```java
public class Flag {
    private volatile boolean running = true;

    public void stop() { running = false; }
    public void loop() {
        while (running) { /* 干活 */ }
    }
}
```

没有 volatile 时，线程可能永远看不到 running 被改（工作内存拷贝）。volatile 保证：

- **可见性**：写操作立即刷新到主内存，读操作从主内存读
- **有序性**：禁止指令重排序（如单例双重检查锁中的 use）
- 但 volatile **不保证原子性**，i++ 这种还是要锁

## CompletableFuture：异步编排

Java 8 之后的异步利器，串行/并行/异常处理都很优雅：

```java
CompletableFuture<String> f1 = CompletableFuture.supplyAsync(() -> httpGet("api.a"));
CompletableFuture<String> f2 = CompletableFuture.supplyAsync(() -> httpGet("api.b"));

// 两个都完成后再处理（并行聚合）
CompletableFuture<String> result = f1.thenCombine(f2, (a, b) -> a + b);

// 任一完成即可
CompletableFuture<Object> any = CompletableFuture.anyOf(f1, f2);

// 异常兜底
CompletableFuture<String> safe = f1.exceptionally(e -> "fallback");
```

默认使用 ForkJoinPool.commonPool()，**IO 密集型任务建议自定义线程池**传进去。

## 并发工具类速查

| 工具 | 用途 |
|---|---|
| CountDownLatch | 倒计时门闩：等 N 个任务都完成后放行 |
| CyclicBarrier | 循环屏障：N 个线程互相等待齐后一起出发 |
| Semaphore | 信号量：限流，最多 N 个并发 |
| ConcurrentHashMap | 并发安全的 HashMap（锁分段/ CAS） |
| CopyOnWriteArrayList | 读多写少场景的线程安全 List |
| ThreadLocal | 线程本地变量（注意内存泄漏，用完 remove） |

## 经验小结

- 线程池参数 = f(CPU 核数、任务类型)：CPU 密集 ≈ N+1 线程，IO 密集 ≈ 2N 甚至更高
- 队列别用无界队列；拒绝策略优先 CallerRunsPolicy
- 锁越小越好：能用原子类不用锁，能用局部变量不用共享变量
- 排查线程问题用 `jstack <pid>`，看 BLOCKED/WAITING 堆栈
- ThreadLocal 务必在 finally 里 remove，否则线程池复用下数据串号