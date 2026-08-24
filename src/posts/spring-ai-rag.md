---
title: Spring AI 实战：构建本地 RAG 知识问答
description: 用 Spring AI + Ollama 本地部署 Qwen 模型，结合向量库实现文档 RAG 问答
date: 2026-05-15
category: AI 实战
tags: [Spring AI, RAG, Qwen, Ollama]
order: 1
slug: spring-ai-rag
---

## 为什么突然要写这篇

上个月公司内部要做个"规章制度问答"的小工具：几十份 Word/PDF 制度文档，员工用自然语言提问，系统给出答案并标注出处。数据不能出内网，预算又很紧，方案基本被锁定成两条路：

1. 把文档拿去微调大模型——数据要脱敏、成本高、文档一更新就要重训，直接被否；
2. **本地部署模型 + RAG**——文档更新只动向量库，模型不用动，最合适。

于是就有了这篇文章。技术选型是 Spring AI 1.0.0 + Spring Boot 3.5.0 + Ollama 上的 Qwen 模型 + Redis 向量检索，整套跑在开发机上，除了电费几乎零成本。

> 我把这篇文章写得像自己的实验笔记而不是教程：有能跑的代码，也有踩过的坑。按照这个顺序搭，半天内应该能出第一个可问答的 demo。

## RAG 是什么，为什么需要它

RAG（Retrieval-Augmented Generation，检索增强生成）解决的是大模型两个老毛病：**知识截止**（训练数据有日期边界）和**幻觉**（不知道就编）。

核心流程三步：

```text
离线：文档 → 切分 → 嵌入向量化 → 存入向量库
在线：用户提问 → 向量化 → 向量库检索 topK 相似片段
       → 片段拼进提示词作为上下文 → 大模型基于上下文生成回答
```

> 一句话版本：**不把知识塞进模型里，而是把知识塞进提示词里**。回答时模型"开卷考试"，上下文里没有的它就老实说不知道。

当时我们还对比过三种方案，结论如下：

| 方案 | 数据时效 | 成本 | 维护复杂度 | 幻觉控制 |
| --- | --- | --- | --- | --- |
| 微调（Fine-tuning） | 差，更新要重训 | 高（GPU/标注） | 高 | 中 |
| RAG | 好，更新向量库即可 | 低（本地模型） | 中 | 好（有出处可查） |
| 全文塞提示词 | 好 | 低 | 低 | 差，塞不下 |

## 为什么选 Spring AI 而不是自己拼

团队之前用 Python + LangChain 做过一个 demo，效果不错，但问题很现实：**我们是 Java 团队，一个 Python 工具没人愿意长期维护**。后来调研了 Spring AI：

- 它是 Spring 官方的 AI 框架，2025 年 5 月发布 1.0.0 GA，Spring Boot 3.5.0 起可以直接用 starter 引入；
- 概念和 LangChain 一一对应：`ChatModel`/`ChatClient`（对话）、`VectorStore`（向量库）、`Document` + `TextSplitter`（文档切分）、`EmbeddingModel`（嵌入）；
- 供应商是配置化的：今天用 Ollama 跑本地 Qwen，明天想切 OpenAI 或通义，改几行配置就行，业务代码基本不动。

> 我的观点：只要不是重度自定义流程（复杂 Agent 编排、自研向量检索），Spring AI 对 Java 项目是性价比最高的选择——不用造轮子，也不用养第二个技术栈。

## 环境准备：Ollama 本地模型

Ollama 是个本地模型运行工具，支持 Windows/macOS/Linux，装完默认监听 `11434` 端口，提供 OpenAI 兼容的 HTTP API。拉模型：

```bash
# 对话模型，约 4.7GB，中文效果好
ollama pull qwen2.5:7b

# 中文嵌入模型（生成向量用），约 1.2GB
ollama pull bge-m3
```

验证是否就绪：

```bash
ollama list
curl http://localhost:11434/api/tags
```

> 注意：`qwen2.5:7b` 只支持对话（chat），不支持嵌入（embedding）接口。嵌入要单独用 `bge-m3` 或 `nomic-embed-text` 这类 embedding 模型，别混着用。

模型选型参考：

| 模型 | 用途 | 向量维度 | 说明 |
| --- | --- | --- | --- |
| qwen2.5:7b | 生成回答 | - | 中文效果好，32K 上下文 |
| bge-m3 | 文档/问题嵌入 | 1024 | 中文嵌入效果比 nomic 好 |
| nomic-embed-text | 文档/问题嵌入 | 768 | 英文场景常用 |

## 项目骨架与依赖

新建 Spring Boot 3.5.0 项目，引入 Spring AI 的 BOM 和两个 starter：

```xml
<dependencyManagement>
    <dependencies>
        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-bom</artifactId>
            <version>1.0.0</version>
            <type>pom</type>
            <scope>import</scope>
        </dependency>
    </dependencies>
</dependencyManagement>
```

```xml
<dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-starter-model-ollama</artifactId>
</dependency>
<dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-starter-vector-store-redis</artifactId>
</dependency>
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-web</artifactId>
</dependency>
```

`spring-ai-starter-model-ollama` 会同时带来 ChatModel 和 EmbeddingModel 的自动配置；`spring-ai-starter-vector-store-redis` 提供 Redis 向量存储（基于 RediSearch）。

> 版本提醒：Spring AI 1.0.0 要求 Spring Boot 3.5.x。网上很多教程还是 0.8/1.0.0-M 系列的快照版本，API 变化很大，照着老教程写大概率编译不过。

## 配置 application.yml

```yaml
spring:
  ai:
    ollama:
      base-url: http://localhost:11434
      chat:
        options:
          model: qwen2.5:7b
          temperature: 0.3
      embedding:
        options:
          model: bge-m3
    vectorstore:
      redis:
        index: rag_index          # 向量索引名
        prefix: doc:              # key 前缀，方便和其他数据隔离
        initialize-schema: true   # 首次启动自动建索引
  data:
    redis:
      host: localhost
      port: 6379
```

**一个关键坑**：Redis 必须用 **Redis Stack**（带 RediSearch 模块），普通 Redis 不支持向量检索。本地起一个：

```bash
docker run -d --name redis-stack -p 6379:6379 redis/redis-stack:latest
```

如果只想快速验证流程、不想装 Redis，可以用 Spring AI 自带的 `SimpleVectorStore`（内存实现，重启丢数据，生产别用），把上面的 starter 换成：

```xml
<dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-vector-store</artifactId>
</dependency>
```

## 文档切分与入库

RAG 里最容易被忽视的就是切分：**切太小，语义碎片化；切太大，检索命中率低还浪费 token**。我用 `TokenTextSplitter`，按 token 数切，带 20% 左右的重叠，避免关键句被从中间截断。

```java
@Component
public class DocumentInitializer {

    private static final Logger log = LoggerFactory.getLogger(DocumentInitializer.class);

    private final VectorStore vectorStore;

    // 参数：chunkSize=400（每片约 400 token）
    //       minChunkSize=100（小于这个长度不单独成片）
    //       chunkOverlap=80（相邻片重叠 80 token）
    //       keepSeparator=true（保留标题/分隔符，利于溯源）
    private final TokenTextSplitter splitter = new TokenTextSplitter(400, 100, 80, true);

    public DocumentInitializer(VectorStore vectorStore) {
        this.vectorStore = vectorStore;
    }

    /**
     * 演示用：启动就绪后把 classpath 下 markdown 文档切片入库。
     * 生产环境建议做成独立 Job 或触发式接口，先按 metadata 清理旧切片再写入，避免重复入库。
     */
    @EventListener(ApplicationReadyEvent.class)
    public void ingest() {
        List<Document> docs = new TextReader("classpath:docs/员工手册.md").read();

        // 给每个切好的片段打上来源标记，回答时能给出处
        List<Document> chunks = splitter.apply(docs);
        chunks.forEach(d -> {
            Map<String, Object> meta = new HashMap<>(d.getMetadata());
            meta.put("source", "员工手册.md");
            d.getMetadata().putAll(meta);
        });

        vectorStore.add(chunks);
        log.info("文档切分完成，共 {} 个切片，已写入向量库", chunks.size());
    }
}
```

切分参数直观对照：

| 参数 | 值 | 影响 |
| --- | --- | --- |
| chunkSize | 400 | 越大上下文越完整，但检索粒度越粗 |
| minChunkSize | 100 | 过滤太短的碎片 |
| chunkOverlap | 80 | 重叠越多越不容易断句，但冗余也越多 |
| keepSeparator | true | 保留标题行，方便定位章节 |

> 踩坑记录：最初我用 1000 token 的 chunk，问"年假多少天"这种分布在两节之间的问题经常漏；换成 400 + 80 重叠后命中率明显上升。**切分策略是 RAG 效果的分水岭，值得单独调优。**

## 问答接口

问答侧的核心是一个 `ChatClient`（Spring AI 1.0 的主 API，替代老版本的 `ChatModel` 直调），流程是：**检索 → 拼上下文 → 生成**。

```java
@RestController
@RequestMapping("/api/rag")
public class RagController {

    private final ChatClient chatClient;
    private final VectorStore vectorStore;

    public RagController(ChatClient.Builder builder, VectorStore vectorStore) {
        this.chatClient = builder.build();
        this.vectorStore = vectorStore;
    }

    @GetMapping("/ask")
    public String ask(@RequestParam String question) {
        // 1. 检索：把问题向量化，在向量库找最相似的 4 个片段
        List<Document> docs = vectorStore.similaritySearch(
                SearchRequest.builder().query(question).topK(4).build());

        // 带出处拼接，方便模型引用
        String context = docs.stream()
                .map(d -> "【来源：" + d.getMetadata().getOrDefault("source", "unknown") + "】\n" + d.getContent())
                .collect(Collectors.joining("\n\n---\n\n"));

        // 2. 生成：系统提示词约束行为 + 用户消息里带上下文和问题
        return chatClient.prompt()
                .system("你是一个严谨的文档问答助手。" +
                        "只能依据给定的上下文回答，禁止编造。" +
                        "上下文里没有答案时，明确回复'根据现有文档无法回答该问题'。" +
                        "回答末尾列出引用的文档来源。")
                .user(u -> u.text("上下文：\n{context}\n\n问题：{question}")
                        .param("context", context)
                        .param("question", question))
                .call()
                .content();
    }
}
```

两个容易忽略的点：

- `topK` 不是越大越好：4~5 个片段就够填满小模型的上下文了，多了反而稀释注意力、还可能把不相关的内容带进来；
- 想流式输出（打字的视觉效果），把 `.call().content()` 换成就 `.stream().content()`，前端可以 SSEReactive 接。

## 效果测试

随便找几个问题跑了一下，记录如下：

```
问：年假有几天，怎么折算？
答：根据《员工手册》第四章休假制度：工作满 1 年不满 10 年的，年休假 5 天；
    满 10 年不满 20 年的，年休假 10 天。已休天数按当年实际在岗时间折算。
    （来源：员工手册.md）
```

| 问题类型 | 示例 | 效果 | 备注 |
| --- | --- | --- | --- |
| 原文直接有 | 年假几天 | 准确，带出处 | 最理想的情况 |
| 跨章节综合 | 离职时年假怎么结算 | 一般 | chunk 切分后信息分散，偶尔漏条款 |
| 文档没有 | 有没有期权政策 | 正确拒绝 | 靠系统提示词约束 |
| 口语化 | 请假扣钱不 | 一般 | bge-m3 对口语/缩写理解有限 |

整体可用，但和"爽文效果"还差得远，尤其跨章节综合类问题经常答不全。

## 局限性与下一步

老实说局限不少，逐个记下来：

1. **切分粒度**：400 token 对跨章节问题容易漏，本质是"检索粒度 vs 上下文完整度"的平衡，没有银弹；
2. **上下文截断**：Qwen 7b 上下文 32K，但多个片段拼起来很容易超——尤其是每条带出处和原文时。控制手段是 `topK` 调小、chunk 调小、片段按相似度排序后只取前几条；
3. **中文嵌入质量**：`bge-m3` 对业务黑话、缩写效果一般。后续可以加**关键词召回兜底**（BM25 全文检索 + 向量检索混合，再融合打分）；
4. **重复入库**：`ApplicationReadyEvent` 每次启动都跑一遍，同一份文档会重复进库。生产要按 metadata（文档名/版本号）先删旧再写，或者干脆用独立入口手动触发；
5. **单轮对话**：目前是无记忆的，追问"那满 20 年呢"会丢上下文，需要引入会话记忆。

下一步计划：加一个 bge-reranker 重排（先粗召回 20 条再精排 5 条）、支持 PDF/Word 解析、把答案里的来源变成可点击链接。等做完再写一篇实战续集。

> 总结：这套组合（Spring AI + Ollama + Redis）在没有预算、数据不出内网的场景下足够落地。别指望它一次到位，RAG 的效果是**切分、检索、提示词三者反复调优**调出来的，不是搭完就完事。