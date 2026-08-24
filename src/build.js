/**
 * Java Blog Static Site Generator
 * 终端/代码风格个人博客构建脚本
 * 用法: node build.js
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import matter from 'gray-matter'
import { Marked } from 'marked'
import hljs from 'highlight.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = __dirname
const POSTS_DIR = path.join(ROOT, 'posts')
const ASSETS_DIR = path.join(ROOT, 'assets')
const DIST_DIR = path.join(ROOT, 'dist')

// ---------- Markdown 渲染 ----------
function slugifyHeading(text) {
  // 生成标题锚点 id（与 TOC 提取一致）
  const s = text.trim()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
  return s || 'section'
}

const headingIds = new Map()
const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    heading({ tokens, depth }) {
      const text = this.parser.parseInline(tokens)
      const base = slugifyHeading(text)
      const n = headingIds.get(base) || 0
      headingIds.set(base, n + 1)
      const id = n === 0 ? base : `${base}-${n}`
      const lv = Math.min(depth, 6)
      return `<h${lv} id="${id}">${text}</h${lv}>`
    },
    code({ text, lang }) {
      let code = text
      if (lang && hljs.getLanguage(lang)) {
        code = hljs.highlight(code, { language: lang }).value
      } else if (!lang) {
        code = hljs.highlightAuto(code).value
      }
      const cls = lang ? `language-${lang}` : 'language-plaintext'
      return `<pre><code class="${cls}">${code}\n</code></pre>`
    }
  }
})

// ---------- 读取文章 ----------
function readPosts() {
  const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.md'))
  const posts = []
  for (const f of files) {
    headingIds.clear()
    const raw = fs.readFileSync(path.join(POSTS_DIR, f), 'utf-8')
    const { data, content } = matter(raw)
    const slug = data.slug || f.replace(/\.md$/, '')
    // 提取标题(h1)
    const h1 = content.match(/^#\s+(.+)$/m)
    posts.push({
      slug,
      file: f,
      title: data.title || (h1 ? h1[1] : slug),
      description: data.description || '',
      date: data.date instanceof Date
        ? data.date.toISOString().slice(0, 10)
        : (data.date || '2025-01-01'),
      category: data.category || '笔记',
      tags: data.tags || [],
      order: data.order || 99,
      featured: data.featured === true,
      content,
      html: marked.parse(content)
    })
  }
  posts.sort((a, b) => b.date.localeCompare(a.date))
  return posts
}

// ---------- TOC 提取 ----------
function extractToc(html) {
  const toc = []
  const re = /<h([23])[^>]*id="([^"]+)"[^>]*>(.*?)<\/h\1>/g
  let m
  while ((m = re.exec(html)) !== null) {
    toc.push({ level: Number(m[1]), id: m[2], text: m[3].replace(/<[^>]+>/g, '') })
  }
  return toc
}

// ---------- HTML 模板 ----------
const CATEGORY_META = {
  '工业物联网': { icon: '📡', color: '#f89820' },
  '踩坑实战': { icon: '🐞', color: '#f85149' },
  'AI 实战': { icon: '🤖', color: '#58a6ff' },
  'Java 核心': { icon: '☕', color: '#e76f00' },
  '数据库': { icon: '🗄️', color: '#3fb950' },
  '工程实践': { icon: '⚙️', color: '#a371f7' },
  '学习笔记': { icon: '📝', color: '#39c5cf' }
}

// 分类在首页/归档的展示顺序（工业物联网为主方向在最前，AI 实战放在中间位置）
const CATEGORY_ORDER = ['工业物联网', '踩坑实战', 'Java 核心', 'AI 实战', '数据库', '工程实践', '学习笔记']

function orderedCategories(posts) {
  const present = new Set(posts.map(p => p.category))
  return CATEGORY_ORDER.filter(c => present.has(c)).concat(
    [...present].filter(c => !CATEGORY_ORDER.includes(c))
  )
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function pageShell({ title, body, activeNav = '' }) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} · fxy.dev</title>
<meta name="description" content="工业物联网与设备数据采集技术博客：Modbus、MQTT、Netty 采集平台、Spring Boot、MySQL、全栈与 App 开发">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>☕</text></svg>">
<script>/* 主题初始化:默认白天,记住用户选择,避免闪烁 */
(function(){try{var t=localStorage.getItem('theme');if(t==='dark'){document.documentElement.setAttribute('data-theme','dark');}}catch(e){}})();
</script>
<link rel="stylesheet" href="/assets/style.css">
<link rel="stylesheet" href="/assets/highlight.css">
</head>
<body>
<header class="topbar">
  <div class="terminal-dots"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span></div>
  <nav class="nav">
    <a class="brand" href="/index.html"><span class="prompt">$</span> fxy@java:~</a>
    <div class="nav-links">
      <a href="/index.html" class="${activeNav === 'index' ? 'active' : ''}">首页</a>
      <a href="/archive.html" class="${activeNav === 'archive' ? 'active' : ''}">归档</a>
      <a href="/about.html" class="${activeNav === 'about' ? 'active' : ''}">关于</a>
      <a href="https://github.com/haiduimian" target="_blank" rel="noopener">GitHub ↗</a>
    </div>
    <button class="theme-toggle" id="themeToggle" type="button" aria-label="切换主题" title="切换白天/黑夜模式">🌙</button>
  </nav>
</header>
${body}
<footer class="footer">
  <div class="footer-inner">
    <p>☕ Built with plain HTML &amp; Java passion · <a href="https://github.com/haiduimian" target="_blank" rel="noopener">@fxy</a></p>
    <p class="muted">cd /blog &amp;&amp; echo "Have a nice day!"</p>
  </div>
</footer>
<script src="/assets/main.js"></script>
</body>
</html>`
}

function postCard(post) {
  const cat = CATEGORY_META[post.category] || { icon: '📄', color: '#8b949e' }
  const date = post.date
  return `<article class="post-card" style="--accent:${cat.color}">
  <div class="card-top">
    <span class="card-cat">${cat.icon} ${post.category}</span>
    <span class="card-date">${date}</span>
  </div>
  <h3 class="card-title"><a href="/post/${post.slug}.html">${post.title}</a></h3>
  ${post.description ? `<p class="card-desc">${post.description}</p>` : ''}
  <div class="card-tags">${post.tags.map(t => `<code>#${escapeHtml(t)}</code>`).join('')}</div>
  <a class="card-link" href="/post/${post.slug}.html">java ${post.slug}.java --run →</a>
</article>`
}

// ---------- 页面生成 ----------
function buildHome(posts) {
  const categories = orderedCategories(posts)
  const recent = posts.slice(0, 6)
  const featured = posts.filter(p => p.featured)
  const featuredHtml = featured.length ? featured.slice(0, 3).map(postCard).join('') : ''

  const sections = categories.map(cat => {
    const list = posts.filter(p => p.category === cat)
      .sort((a, b) => b.date.localeCompare(a.date))
    return `<section class="cat-section">
  <h2 class="cat-title">${CATEGORY_META[cat]?.icon || '📄'} ${cat} <span class="count">(${list.length})</span></h2>
  <div class="card-grid">${list.map(postCard).join('')}</div>
</section>`
  }).join('')

  const recentHtml = recent.map(postCard).join('')

  const body = `<main class="home">
  <section class="hero">
    <div class="hero-content">
      <p class="hero-kicker">// 工业物联网 · 设备数据采集 · 全栈 · since 2025</p>
      <h1 class="hero-title"><span class="kw">public</span> <span class="kw">class</span> <span class="cls">Fxy</span> {</h1>
      <p class="hero-sub">工业物联网与设备数据采集实战笔记 — Modbus/MQTT 协议对接、Netty 采集平台、Spring Boot 后端、App 与全栈开发</p>
      <div class="hero-actions">
        <a class="btn primary" href="#posts">开局读文章</a>
        <a class="btn ghost" href="/about.html">关于我</a>
      </div>
    </div>
    <div class="hero-terminal">
      <div class="term-head"><span class="tdots"><i></i><i></i><i></i></span><span class="term-title">fxy@java: ~</span></div>
      <pre class="term-body"><code><span class="t-cmd">$ java BlogApplication.java</span>
<span class="t-out">  .   ____          _            __ _ _</span>
<span class="t-out"> /\\\\ / ___'_ __ _ _(_)_ __  __ _ \\ \\ \\ \\</span>
<span class="t-out">( ( )\\___ | '_ | '_| | '_ \\/ _\` | \\ \\ \\ \\</span>
<span class="t-out"> \\\\/  ___)| |_)| | | | | || (_| |  ) ) ) )</span>
<span class="t-out">  '  |____| .__|_| |_|_| |_\\__, | / / / /</span>
<span class="t-out"> =========|_|==============|___/=/_/_/_/</span>
<span class="t-out"> :: Spring Boot ::                (v3.4.1)</span>

<span class="t-cmd">$ curl localhost:8080/api/devices/plc-01/data</span>
<span class="t-out">[{ "deviceId": "plc-01", "temp": 36.5, "pressure": 0.72, "ts": 1754371200 }]</span>
<span class="t-cursor">█</span></code></pre>
    </div>
  </section>

  ${featuredHtml ? `<section class="home-section"><h2 class="cat-title">⭐ 精选文章</h2><div class="card-grid">${featuredHtml}</div></section>` : ''}

  <section class="home-section" id="posts">
    <h2 class="cat-title">🔥 最近更新</h2>
    <div class="card-grid">${recentHtml}</div>
  </section>

  ${sections}
</main>`
  return pageShell({ title: 'fxy.dev | 工业物联网技术博客', body, activeNav: 'index' })
}

function buildPost(post, prev, next) {
  const toc = extractToc(post.html)
  const cat = CATEGORY_META[post.category] || { icon: '📄', color: '#8b949e' }
  const tocHtml = toc.length ? `<nav class="toc"><h4>页面导航</h4><ul>${toc.map(t => `<li class="toc-l${t.level}"><a href="#${t.id}">${t.text}</a></li>`).join('')}</ul></nav>` : ''
  const prevNext = `<div class="pn">
    ${prev ? `<a class="pn-btn" href="/post/${prev.slug}.html"><span>← 上一篇</span><b>${prev.title}</b></a>` : '<span></span>'}
    ${next ? `<a class="pn-btn next" href="/post/${next.slug}.html"><span>下一篇 →</span><b>${next.title}</b></a>` : '<span></span>'}
  </div>`
  const body = `<main class="post-page">
  <div class="post-side">${tocHtml}</div>
  <article class="post-body">
    <header class="post-header">
      <p class="breadcrumb"><a href="/index.html">~/</a> <span class="crumb-cat">${cat.icon} ${post.category}</span></p>
      <h1>${post.title}</h1>
      <p class="post-meta">
        <span class="meta-date">📅 ${post.date}</span>
        <span class="meta-read">☕ 预计阅读 ${Math.max(1, Math.round(post.content.length / 500))} 分钟</span>
        <span class="meta-tags">${post.tags.map(t => `<code>#${escapeHtml(t)}</code>`).join(' ')}</span>
      </p>
    </header>
    <div class="markdown-body">
${post.html}
    </div>
    ${prevNext}
  </article>
</main>`
  return pageShell({ title: post.title, body, activeNav: 'archive' })
}

function buildArchive(posts) {
  const categories = orderedCategories(posts)
  const years = [...new Set(posts.map(p => p.date.slice(0, 4)))].sort().reverse()
  const byYear = years.map(y => {
    const list = posts.filter(p => p.date.startsWith(y))
    return `<div class="year-block"><h2 class="year-title">${y}</h2><ul class="year-list">${list.map(p =>
      `<li><a href="/post/${p.slug}.html">${p.title}</a><span class="year-date">${p.date}</span><span class="year-cat">${p.category}</span></li>`
    ).join('')}</ul></div>`
  }).join('')
  const catList = categories.map(c => {
    const list = posts.filter(p => p.category === c)
    return `<div class="cat-block"><h3>${CATEGORY_META[c]?.icon || '📄'} ${c}</h3><span class="count">${list.length} 篇</span></div>`
  }).join('')
  const body = `<main class="archive">
  <header class="page-head"><h1>📚 文章归档</h1><p class="page-sub">共 ${posts.length} 篇文章 · ${categories.length} 个分类</p></header>
  <div class="cat-stats">${catList}</div>
  ${byYear}
</main>`
  return pageShell({ title: '归档', body, activeNav: 'archive' })
}

function buildAbout() {
  const body = `<main class="about-page">
  <header class="page-head"><h1>👋 关于我</h1></header>
  <div class="about-card">
    <div class="about-avatar">☕</div>
    <div>
      <h2>fxy</h2>
      <p class="about-role">全栈开发工程师 · 主攻工业物联网与设备数据采集</p>
      <p>前后端、App 都会做，目前在工业物联网方向投入最多：设备数据采集、协议对接、数据平台建设。这里记录我的实战笔记与踩坑经验，主要关注：</p>
      <ul class="about-list">
        <li><b>工业物联网</b>：Modbus / MQTT 协议对接、PLC / 传感器 / 水电气表数据采集、Netty 采集网关</li>
        <li><b>后端开发</b>：Spring Boot、MyBatis、RESTful API、高并发写入与消息队列</li>
        <li><b>前端 / App</b>：Vue / React 管理端、uni-app 移动端、小程序</li>
        <li><b>数据库</b>：MySQL 索引优化、SQL 调优、Redis 缓存、时序数据库</li>
        <li><b>工程化</b>：Git、Maven/Gradle、Docker、Linux 部署</li>
      </ul>
      <p class="about-contact"><b>📮 邮箱</b>：<a href="mailto:2456941531@qq.com">2456941531@qq.com</a></p>
      <blockquote class="about-quote">“Talk is cheap, show me the code.” — Linus Torvalds</blockquote>
    </div>
  </div>
  <div class="about-links">
    <a class="btn ghost" href="https://github.com/haiduimian" target="_blank" rel="noopener">GitHub: fxy</a>
    <a class="btn ghost" href="/index.html">← 返回首页</a>
  </div>
</main>`
  return pageShell({ title: '关于', body, activeNav: 'about' })
}

// ---------- 主流程 ----------
fs.rmSync(DIST_DIR, { recursive: true, force: true })
fs.mkdirSync(path.join(DIST_DIR, 'post'), { recursive: true })
fs.mkdirSync(path.join(DIST_DIR, 'assets'), { recursive: true })
fs.cpSync(ASSETS_DIR, path.join(DIST_DIR, 'assets'), { recursive: true })

const posts = readPosts()
console.log(`[build] 读取 ${posts.length} 篇文章`)

// 索引 slug -> post
const bySlug = Object.fromEntries(posts.map((p, i) => [p.slug, { ...p, index: i }]))

fs.writeFileSync(path.join(DIST_DIR, 'index.html'), buildHome(posts))
for (const p of posts) {
  const idx = bySlug[p.slug].index
  const prev = idx > 0 ? posts[idx - 1] : null
  const next = idx < posts.length - 1 ? posts[idx + 1] : null
  fs.writeFileSync(path.join(DIST_DIR, 'post', `${p.slug}.html`), buildPost(p, prev, next))
}
fs.writeFileSync(path.join(DIST_DIR, 'archive.html'), buildArchive(posts))
fs.writeFileSync(path.join(DIST_DIR, 'about.html'), buildAbout())

// 404
fs.writeFileSync(path.join(DIST_DIR, '404.html'), pageShell({
  title: '404',
  body: `<main class="notfound">
    <pre class="nf-code"><code>Exception in thread "main" java.io.FileNotFoundException:
    <span class="nf-err">404: 页面不存在</span>
    at Blog.visit(Blog.java:42)</code></pre>
    <a class="btn primary" href="/index.html">← cd ~ 回首页</a>
  </main>`
}))

console.log('[build] 构建完成 → dist/')