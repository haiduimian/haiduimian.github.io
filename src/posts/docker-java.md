---
title: Docker 部署 Spring Boot 应用：从 Dockerfile 到 Compose
description: 多阶段构建、精简镜像、环境变量注入与 docker-compose 一键编排 MySQL+Redis+应用
date: 2025-11-02
category: 工程实践
tags: [Docker, Spring Boot, DevOps, Compose]
order: 1
slug: docker-java
---

## 背景：手工部署的日子过不下去了

去年我们项目的部署流程是这样的：开发机 `mvn package` → 打包上传 → 服务器上 `kill` 旧进程 → `nohup java -jar` 启动 → 手动起 MySQL、Redis → 改配置里的 IP。一个月部署三次，每次半小时起步，中间还出过好几次"版本打错""配置忘改"的事故。

后来把部署整体迁到 Docker，用多阶段构建 + docker-compose 编排，把"构建镜像、起数据库、起应用"浓缩成一条命令。这篇文章就把这套东西完整讲一遍，全部基于 Spring Boot 3 + Java 17。

> 本文假设你已经装了 Docker Desktop（Windows/Mac）或 docker-ce（Linux），并且对 `docker build`、`docker run` 有最基础的使用经验。

## 为什么用多阶段构建

先看单阶段方案的典型写法：

```dockerfile
FROM maven:3.9.9-eclipse-temurin-17
WORKDIR /app
COPY . .
RUN mvn package -DskipTests
EXPOSE 8080
CMD ["java", "-jar", "target/demo.jar"]
```

能跑，但问题很明显：**运行镜像里塞了一整套 JDK + Maven + 源码 + 编译中间产物**，镜像体积轻松 700MB+，而且一旦代码泄露风险也大。

多阶段构建的思路是**借鸡生蛋**：第一阶段用带 Maven 的镜像把 jar 编译出来，第二阶段只拿这个 jar 配一个精简的 JRE 运行时。

| 对比项 | 单阶段（maven 镜像运行） | 多阶段（jre 镜像运行） |
| --- | --- | --- |
| 镜像体积 | 700MB+ | ~200MB（JRE + jar） |
| 构建产物纯度 | 含源码、编译缓存 | 只有可运行产物 |
| 安全面 | 大（镜像里有构建工具） | 小 |
| 部署速度 | 慢（大镜像拉取/传输） | 快 |

> 补充一句：Java 17+ 的 JRE 镜像本身就有 180MB 左右的底子（底层是 Ubuntu），真正省掉的是 Maven 和 JDK 编译组件那 500MB。想再压可以用 alpine 变体或 jlink 裁剪 JRE，但那是进阶话题，本文先不展开。

## 分层 Dockerfile：利用构建缓存

Dockerfile 每条指令生成一个层，**层没变就会命中缓存**。如果先 `COPY . .` 再 `RUN mvn package`，那么任何文件改动（包括只改一行代码）都会让依赖下载、编译全部重来。正确姿势是**先固定依赖、后引入源码**：

```dockerfile
# ---- 阶段一：构建 ----
FROM maven:3.9.9-eclipse-temurin-17 AS builder
WORKDIR /build

# 1. 先只拷 pom.xml，触发依赖下载
#    只要 pom.xml 没变，这一层和下一层永远命中缓存
COPY pom.xml .
RUN mvn -B -q dependency:go-offline

# 2. 再拷源码，业务代码改动不会殃及依赖层
COPY src ./src
RUN mvn -B package -DskipTests

# ---- 阶段二：运行 ----
FROM eclipse-temurin:17-jre
WORKDIR /app

# 非 root 用户运行，生产环境的基本素养
RUN useradd --create-home appuser
COPY --from=builder /build/target/demo-0.0.1-SNAPSHOT.jar app.jar
USER appuser

EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
```

如果项目里有多个模块、依赖又多，`dependency:go-offline` 能保证依赖被完整预下载；单模块小项目可以直接 `RUN mvn dependency:resolve`。

> 效果：这套写法下，依赖版本不动时，本地改代码触发重建通常十几秒就完成（依赖层全命中缓存），而不是每次干等 3 分钟下载依赖。

## 更精细的方案：Spring Boot 3 分层镜像

Spring Boot 3 的 jar 内部结构是分层的，`BOOT-INF/lib` 是依赖、`BOOT-INF/classes` 是业务代码，插件还会生成 `layers.idx`（application / spring-boot-loader / dependencies / snapshot-dependencies 四层）。用官方提供的 `layertools` 把 jar 拆开，每一层单独 COPY，**依赖层就能独立缓存**：

```dockerfile
# ---- 阶段一：构建 ----
FROM maven:3.9.9-eclipse-temurin-17 AS builder
WORKDIR /build
COPY pom.xml .
RUN mvn -B -q dependency:go-offline
COPY src ./src
RUN mvn -B package -DskipTests

# ---- 阶段二：提取分层 ----
FROM eclipse-temurin:17-jre AS extractor
WORKDIR /app
COPY --from=builder /build/target/*.jar app.jar
RUN java -Djarmode=layertools -jar app.jar extract

# ---- 阶段三：运行（分层 COPY）----
FROM eclipse-temurin:17-jre
WORKDIR /app

COPY --from=extractor /app/dependencies/ ./
COPY --from=extractor /app/spring-boot-loader/ ./
COPY --from=extractor /app/snapshot-dependencies/ ./
COPY --from=extractor /app/application/ ./

RUN useradd --create-home appuser
USER appuser
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
```

顺序很讲究：`dependencies` 在最前面、`application`（业务代码）在最后面——**业务代码改动时只有 application 层需要重建**，CI 里镜像构建从 40 秒降到 8 秒是常有的事。

> 如果你没耐心搞 layertools，就用上一节"简单 `COPY --from=builder`"的写法，正确性完全没问题，只是每次业务改动都要重新传输整个 jar。**分层是缓存优化，不是功能需求**，按团队规模取舍。

## .dockerignore：别把垃圾带进构建上下文

`docker build` 会把目录整个打包发给 Docker 守护进程，没有 `.dockerignore` 时，`target/`（几百 MB 的构建产物）、`.git/` 全都会被传过去，又慢又没必要：

```dockerignore
target/
.git/
.gitignore
.idea/
*.iml
*.log
Dockerfile
docker-compose.yml
.env
```

> 排查技巧：如果 `docker build` 卡在 `Sending build context` 很久，十有八九是 `.dockerignore` 没配好。命令 `docker build -f Dockerfile -t demo:latest .` 末尾的 `.` 就是上下文根目录。

## JVM 参数与健康检查

容器里的 JVM 有个经典坑：**默认按宿主机的内存算堆大小**。宿主机 32G 内存、容器限 1G，JVM 却可能给你开 8G 堆，直接 OOM 被杀。正确做法是用 `MaxRAMPercentage` 按比例分配：

```dockerfile
ENV JAVA_OPTS="-XX:MaxRAMPercentage=75 -XX:+UseG1GC -Djava.security.egd=file:/dev/./urandom -Dfile.encoding=UTF-8"

ENTRYPOINT ["sh", "-c", "java $JAVA_OPTS -jar app.jar"]
```

`75%` 的意思是给 JVM 留 25% 给堆外内存（Metaspace、线程栈、直接内存）。如果容器限制 `768m`，堆大概是 576m，配合 G1 在服务场景下表现稳定。

健康检查配合 Spring Boot Actuator：

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-actuator</artifactId>
</dependency>
```

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,info
```

Dockerfile 里加 `HEALTHCHECK`，让容器本身知道自己是否可用：

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:8080/actuator/health || exit 1
```

> 注意：`eclipse-temurin` 基于 Ubuntu，自带 `wget`。如果换 alpine 基础镜像，`wget`（busybox 版）也有；但别默认有 `curl`，很多精简镜像没装，healthcheck 会一直失败。

## docker-compose 一键编排

单机部署场景，docker-compose 就是最顺手的编排工具。下面这份 `docker-compose.yml` 编排 MySQL 8.4 + Redis 7 + Spring Boot 应用，**环境变量全部注入**，应用和数据卷分离：

```yaml
services:
  mysql:
    image: mysql:8.4
    restart: unless-stopped
    environment:
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD:-root123}
      MYSQL_DATABASE: appdb
      MYSQL_USER: app
      MYSQL_PASSWORD: ${MYSQL_PASSWORD:-app123}
    volumes:
      - mysql-data:/var/lib/mysql
      - ./sql/init.sql:/docker-entrypoint-initdb.d/init.sql:ro   # 首次启动自动执行建表脚本
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1", "-uroot", "-p${MYSQL_ROOT_PASSWORD:-root123}"]
      interval: 10s
      timeout: 5s
      retries: 5
    ports:
      - "3306:3306"

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - redis-data:/data

  app:
    build:
      context: .
      dockerfile: Dockerfile
    restart: unless-stopped
    depends_on:
      mysql:
        condition: service_healthy   # 等 MySQL 健康检查通过再启动
      redis:
        condition: service_started
    environment:
      SPRING_PROFILES_ACTIVE: prod
      SPRING_DATASOURCE_URL: jdbc:mysql://mysql:3306/appdb?useUnicode=true&characterEncoding=utf8&serverTimezone=Asia/Shanghai&useSSL=false
      SPRING_DATASOURCE_USERNAME: app
      SPRING_DATASOURCE_PASSWORD: ${MYSQL_PASSWORD:-app123}
      SPRING_DATA_REDIS_HOST: redis
      SPRING_DATA_REDIS_PORT: 6379
    ports:
      - "8080:8080"
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://localhost:8080/actuator/health"]
      interval: 30s
      timeout: 5s
      start_period: 60s
      retries: 3

volumes:
  mysql-data:
  redis-data:
```

两个关键点说明：

- **环境变量注入**：Spring Boot 的 `Environment` 支持宽松绑定，`SPRING_DATASOURCE_URL` 自动映射到 `spring.datasource.url`，比 `application-prod.yml` 里写死 IP 灵活得多；
- **启动顺序**：`depends_on` 加 `condition: service_healthy`，确保应用启动时 MySQL 已经接受连接（MySQL 首次初始化要 30~60 秒，不加这个条件应用必炸）。

> 密码别硬编码进 compose 文件提交到 git：把 `MYSQL_PASSWORD` 放进 `.env` 文件（compose 自动读取），`.env` 加进 `.gitignore`。上面 `${VAR:-默认值}` 的写法就是在无 `.env` 时给默认值兜底。

启动：

```bash
docker compose up -d --build
```

## 常用运维命令

记几个高频命令，够日常用了：

| 操作 | 命令 | 说明 |
| --- | --- | --- |
| 构建并启动 | `docker compose up -d --build` | 改代码后重建 |
| 查看状态 | `docker compose ps` | 各服务状态、端口映射 |
| 跟随日志 | `docker compose logs -f app` | 只看 app 服务日志 |
| 滚动重启 | `docker compose up -d --no-deps --build app` | 只重建 app，不动数据库 |
| 进入容器 | `docker exec -it app sh` | 排查问题 |
| 全部停止 | `docker compose down` | 加 `-v` 会连数据卷一起删，慎用 |
| 清理垃圾 | `docker system prune -af` | 清理悬空镜像和卷，小心误删 |

日志规范单独强调一句：**容器里日志只写 stdout/stderr，不要写文件**。Spring Boot 默认的 logback 就是输出到控制台，正好满足 `docker compose logs` 的采集方式；一旦把日志写到容器内文件，`docker logs` 啥也看不到，还得进容器翻文件，得不偿失。

## 常见坑总结

1. **时区错乱**：JVM 默认 UTC，时间字段全差 8 小时。要么 compose 里给 app 加 `TZ: Asia/Shanghai`，要么启动参数加 `-Duser.timezone=Asia/Shanghai`，MySQL 连接串里也加 `serverTimezone`；
2. **应用比数据库先起**：MySQL 容器启动 ≠ MySQL 可用，首次初始化很慢。必须用 `depends_on: condition: service_healthy` 而不是裸 `depends_on`；
3. **JVM 不认容器限额**：老版本 JDK 按宿主机内存算堆，容器内 `free -m` 卡得住，JVM 照样超。新镜像 + `MaxRAMPercentage` 解决；
4. **构建缓存失效**：`COPY . .` 放在 `RUN mvn` 前面会让依赖层每次重建，顺序要从不变的到易变的；
5. **密码进 git**：`.env`、compose 里的明文密码要防泄漏，必要时用 secret 机制。

> 总结：从"手搓部署"到"一条 compose 命令起全套"，省下的不只是半小时的部署时间，更是**环境一致性**——开发、测试、生产跑同一份配置，很多"在我机器上明明是好的"从此消失。下一步如果服务多起来、要扩副本，就该上 K8s 了，那是另一个世界。