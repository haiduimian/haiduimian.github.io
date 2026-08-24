# ☕ fxy.dev — 工业物联网技术博客

个人技术博客，主攻**工业物联网与设备数据采集**：Modbus/MQTT 协议对接、PLC/传感器数据采集、Netty 采集网关、Spring Boot 后端、全栈与 App 开发。

## ✨ 特性

- 纯静态生成：`node build.js` 从 `posts/*.md` 生成 HTML，无框架依赖
- 终端/代码风格 UI（macOS 窗口点 + Spring Boot ASCII 横幅 + Java 橙主题色）
- **白天/黑夜双模式**切换（默认白天，localStorage 记忆选择）
- 分类文章卡片（工业物联网为首方向）、文章归档（按年份）、关于页面
- 文章页：TOC 目录、代码高亮（本地双主题）、复制按钮、上一篇/下一篇
- 响应式布局，移动端友好

## 📁 项目结构

```
java-blog/
├── build.js            # 静态站点生成器
├── assets/
│   ├── style.css       # 主题样式（白天/黑夜双变量主题）
│   ├── highlight.css   # 代码高亮（GitHub Light/Dark 双主题）
│   └── main.js         # 前端增强（主题切换、复制代码、TOC 高亮）
├── posts/              # Markdown 文章（带 YAML frontmatter）
├── dist/               # 构建产物（部署目录）
└── .github/workflows/  # GitHub Pages 自动部署
```

## 🚀 本地开发

```bash
npm install
npm run build      # 生成 dist/
npx serve dist     # 本地预览
```

## 📝 写新文章

在 `posts/` 下新建 `.md` 文件，头部 YAML 指定元信息：

```yaml
---
title: 文章标题
description: 摘要
date: 2026-01-01
category: 工业物联网        # 工业物联网 / 踩坑实战 / Java 核心 / AI 实战 / 数据库 / 工程实践 / 学习笔记
tags: [Modbus, 数据采集]
order: 1
slug: my-post
featured: true            # 可选，首页精选
---
```

注意：正文中若提到具体时间（月份/星期），需要与 frontmatter 的 date 一致。

## 🌐 部署

推送到 `main` 分支后即自动发布到 GitHub Pages：https://haiduimian.github.io/