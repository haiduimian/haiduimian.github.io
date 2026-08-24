---
title: Nginx 实战：反向代理、负载均衡与静态资源
description: 部署 Java 应用必会的 Nginx 配置：location 匹配、upstream 轮询、HTTPS 开启
date: 2026-01-20
category: 工程实践
tags: [Nginx, 反向代理, 负载均衡, HTTPS]
order: 2
slug: nginx
---

## Nginx 是什么，为什么 Java 项目绕不开它

Nginx 是一个高性能的 Web 服务器 / 反向代理 / 负载均衡器。和 Tomcat（应用服务器，负责跑 Java 业务代码）不同，Nginx 站在**架构的最外层**，负责把流量接进来再分发：

```text
用户请求
   │
   ▼
Nginx（入口：静态资源、反向代理、负载均衡、TLS 终结、限流）
   ├──▶ 静态文件（html/js/css 直接返回）
   ├──▶ Spring Boot 实例 1 (10.0.0.11:8080)
   ├──▶ Spring Boot 实例 2 (10.0.0.12:8080)
   └──▶ Spring Boot 实例 3 (10.0.0.13:8080)
```

它在 Java 项目里的典型用途，对应的就是本文的四个部分：

| 用途 | 典型场景 | 本文章节 |
| --- | --- | --- |
| 静态资源服务 | 前端站点、图片、打包后的 SPA | 静态站点配置 |
| 反向代理 | 隐藏后端端口、统一入口 80/443 → 8080 | 反向代理 Spring Boot |
| 负载均衡 | 多实例部署、灰度、容灾 | upstream 负载均衡 |
| TLS 终结 | 统一上 HTTPS、证书集中管理 | 开启 HTTPS |

> 类比理解：Tomcat 负责"干活"（跑 Java 业务），Nginx 负责"看门"（接客、分发、挡流量）。现实中我们常把 Nginx 放在 Tomcat 前面，外面只暴露 80/443。

## 静态站点配置

先来最基础的：给一个静态博客/前端站点做配置（本站就是这种结构——生成好的 HTML，Nginx 直接吐出去）：

```nginx
server {
    listen 80;
    server_name blog.example.com;

    root /var/www/blog;
    index index.html;

    location / {
        # 先找文件，再找目录索引，都没有就 404
        try_files $uri $uri/ =404;
    }

    # 静态资源长缓存：带 hash 的文件名可以 immutable
    location ~* \.(js|css|png|jpg|jpeg|gif|svg|webp|woff2?)$ {
        expires 30d;
        add_header Cache-Control "public, max-age=2592000, immutable";
        access_log off;          # 静态资源不刷访问日志，省磁盘
    }
}
```

两个配置点值得解释：

- `root` vs `alias`：`location /` 下用 `root /var/www/blog` 会把 URL 路径拼到 root 后面（`/foo.html` → `/var/www/blog/foo.html`）；`alias` 则会替换掉匹配的前缀，一般 `location` 精确匹配时才用；
- `try_files $uri $uri/ =404`：先尝试按原路径找文件，找不到试试当成目录，都没有就 404。SPA 项目常把最后一项换成 `index.html` 做前端路由回退。

> 改完配置先 `nginx -t` 检查语法，再 `nginx -s reload` 平滑重载——reload 不会中断现有连接，生产上可以放心用。

## location 匹配规则（背下这张表）

Nginx 的 `location` 匹配是很多新手翻车的地方，规则其实就三条：

| 写法 | 含义 | 优先级 |
| --- | --- | --- |
| `location = /path` | 精确匹配 | 最高，命中即止 |
| `location ^~ /path` | 前缀匹配，且命中后**不再查正则** | 次之 |
| `location /path` | 普通前缀匹配，取最长者 | 再次 |
| `location ~ regex` | 正则匹配（区分大小写） | 最后，按书写顺序 |
| `location ~* regex` | 正则匹配（不区分大小写） | 最后，按书写顺序 |

```nginx
# 示例：/api 走代理，其余走静态
location /api/ {
    proxy_pass http://app_backend;
}

# 精确匹配健康检查路径，避免被上面 /api 规则误伤
location = /api/health {
    proxy_pass http://app_backend;
    access_log off;
}
```

> 一句话记忆：**精确 > 前缀（^~ 阻断正则）> 最长前缀 > 正则（按顺序）**。实际使用中最常见的坑是"正则规则写在普通前缀前面，匹配到了却被前缀规则拦住"，所以正则尽量放最后。

## 反向代理 Spring Boot

Spring Boot 默认监听 8080，我们不想让用户直接看到 8080，也不想让业务代码感知 IP 变化，于是用 Nginx 代理：

```nginx
server {
    listen 80;
    server_name api.example.com;

    location / {
        proxy_pass http://127.0.0.1:8080;

        # 转发协议头：后端才能拿到真实客户端信息
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

转发头的作用不能被忽略，没有它们后端拿到的全是 Nginx 的地址：

| 请求头 | 含义 | 后端不设置会怎样 |
| --- | --- | --- |
| `X-Real-IP` | 客户端真实 IP | 日志里全是 Nginx 的 IP |
| `X-Forwarded-For` | 代理链路 IP 列表 | 审计、封禁无从谈起 |
| `X-Forwarded-Proto` | 原始协议 http/https | 重定向生成 http，HTTPS 跳转死循环 |
| `Host` | 原始域名 | 虚拟主机、多域名全部错乱 |

Spring Boot 端也必须配合——默认情况下它**忽略**这些转发头（防伪造）。在 `application.yml` 里打开：

```yaml
server:
  port: 8080
  forward-headers-strategy: framework
```

> 血泪教训：没开 `forward-headers-strategy` 时，`request.getRemoteAddr()` 永远拿不到用户真实 IP，Spring Security 的 HTTPS 强制检查也会因为拿不到 `X-Forwarded-Proto` 而把请求误判为 http 直接重定向成死循环。上了代理，转发头和这个配置必须成对出现。

## upstream 负载均衡

多实例部署时用 `upstream` 定义后端集群，`proxy_pass` 指向集群名：

```nginx
upstream app_backend {
    # 默认就是轮询；可选 least_conn / ip_hash
    least_conn;

    # weight 越大分配越多；max_fails + fail_timeout 是 passive 健康检查
    server 10.0.0.11:8080 weight=2 max_fails=3 fail_timeout=30s;
    server 10.0.0.12:8080 weight=1;
    server 10.0.0.13:8080 backup;      # 备机：前两台都挂才启用

    keepalive 32;                       # 复用后端连接，减少握手开销
}

server {
    listen 80;
    server_name api.example.com;

    location / {
        proxy_pass http://app_backend;
        proxy_http_version 1.1;         # 配合 keepalive 必须开
        proxy_set_header Connection "";
    }
}
```

分配策略对比：

| 策略 | 写法 | 适用场景 |
| --- | --- | --- |
| 轮询 | 默认 | 各实例性能均衡 |
| 加权轮询 | `weight=2` | 新旧机器混跑、按机器性能分配 |
| ip_hash | `ip_hash;` | 需要会话保持（用户固定打到同一台） |
| 最少连接 | `least_conn;` | 请求耗时差异大 |
| 备机 | `backup` | 主动降级、容灾 |

一个澄清：OSS 版 Nginx 的 `max_fails`/`fail_timeout` 属于 **passive（被动）健康检查**——只有请求失败才摘除节点；没有免费的主动探活（那是 Nginx Plus 或第三方模块的能力）。简单场景下被动检查够用，要主动检查可以用 consul 动态更新 upstream，或者让 Spring Boot 挂掉时直接 `exit 1` 让容器重启。

## 开启 HTTPS

先有证书。最省事的是 Let's Encrypt + certbot，一条命令自动签发并改好 Nginx 配置：

```bash
sudo certbot --nginx -d api.example.com
```

手动配置的话，核心就是 `ssl` 监听 + 证书路径 + HTTP 跳转三件套：

```nginx
# HTTPS 服务
server {
    listen 443 ssl;
    http2 on;
    server_name api.example.com;

    ssl_certificate     /etc/letsencrypt/live/api.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.example.com/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;              # 禁用老协议
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;

    location / {
        proxy_pass http://app_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;   # 明确告诉后端是 https
    }
}

# HTTP 全部 301 跳转 HTTPS
server {
    listen 80;
    server_name api.example.com;
    return 301 https://$host$request_uri;
}
```

两个注意点：

- 证书过期是 HTTPS 事故的头号来源，certbot 记得配 `systemctl enable certbot.timer` 自动续期；
- 想彻底一点可以加 HSTS 头（`add_header Strict-Transport-Security "max-age=31536000; includeSubDomains"`），但**先确认全站已经是 HTTPS**，否则 HSTS 会让用户无法降级访问。

## 常见坑：timeout、上传大小、其他

最后列几个生产里天天遇到的坑：

### 1. 代理超时（proxy_timeout 三件套）

Nginx 默认 `proxy_read_timeout` 是 60 秒，**超过 60 秒没收到后端响应就 504**。导出报表、跑查询这类慢接口很容易中招：

```nginx
location / {
    proxy_pass http://app_backend;
    proxy_connect_timeout 5s;      # 建立连接超时，短一点
    proxy_read_timeout 120s;       # 读响应超时，按业务调整
    proxy_send_timeout 120s;       # 发请求超时
}
```

> 治本思路：真正慢的任务（分钟级报表）别让 HTTP 请求一直挂着，改成"提交任务 → 轮询/回调拿结果"的异步模式，一来 Nginx 不用调大超时，二来用户体验更好。

### 2. 上传大小限制（client_max_body_size）

Nginx 默认只允许 1MB 的请求体，上传文件超过直接 `413 Request Entity Too Large`：

```nginx
client_max_body_size 50m;      # 放在 server 或 location 中
```

Spring Boot 侧还要同步放开：

```yaml
spring:
  servlet:
    multipart:
      max-file-size: 50MB
      max-request-size: 60MB
```

> 调大之前先想清楚有没有必要：大文件上传更推荐走对象存储（OSS/MinIO），应用只拿 URL，别把流量全压 Nginx 上。

### 3. SSE / 流式接口被缓冲

Spring AI 这类流式输出（SSE）经过 Nginx 会被默认缓冲，导致客户端看到的是"攒一批吐一批"而不是逐 token 打印。关掉缓冲：

```nginx
location /api/stream {
    proxy_pass http://app_backend;
    proxy_buffering off;
    proxy_read_timeout 3600s;      # 长连接按业务设置
    proxy_set_header Connection "";
    proxy_http_version 1.1;
}

# WebSocket 额外需要升级头
location /ws/ {
    proxy_pass http://app_backend;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

### 4. gzip 忘了开，带宽白烧

```nginx
gzip on;
gzip_min_length 1k;
gzip_types text/plain text/css application/json application/javascript application/xml image/svg+xml;
gzip_vary on;
```

> 调优顺序建议：先查 `nginx -t` 语法、`nginx -s reload` 平滑生效、`tail -f /var/log/nginx/access.log` 看真实请求，再动手改。Nginx 的坑大多是"配置没生效/顺序不对/忘了 reload"，排查时先排除这三项。

> 总结：Nginx 是 Java 后端部署的必修课。静态资源、反向代理、负载均衡、HTTPS 这四件事，配上 location 匹配规则和超时/上传两个高频坑，基本能覆盖 90% 的日常场景。配置不难，难点在懂得**每一条指令为什么要这么写**——转发头、超时、缓冲这些细节，才是生产环境里真正的分水岭。