// fxy.dev — 前端增强脚本
(function () {
  'use strict';

  // 0. 白天/黑夜主题切换（默认白天，记忆用户选择）
  var toggle = document.getElementById('themeToggle');
  if (toggle) {
    function applyIcon() {
      var dark = document.documentElement.getAttribute('data-theme') === 'dark';
      toggle.textContent = dark ? '☀️' : '🌙';
      toggle.setAttribute('aria-label', dark ? '切换到白天模式' : '切换到黑夜模式');
    }
    applyIcon();
    toggle.addEventListener('click', function () {
      var dark = document.documentElement.getAttribute('data-theme') === 'dark';
      if (dark) {
        document.documentElement.removeAttribute('data-theme');
        try { localStorage.setItem('theme', 'light'); } catch (e) {}
      } else {
        document.documentElement.setAttribute('data-theme', 'dark');
        try { localStorage.setItem('theme', 'dark'); } catch (e) {}
      }
      applyIcon();
    });
  }

  // 1. 代码块右上角复制按钮
  document.querySelectorAll('.markdown-body pre').forEach(function (pre) {
    var btn = document.createElement('button');
    btn.className = 'code-copy';
    btn.textContent = 'copy';
    btn.addEventListener('click', function () {
      var code = pre.querySelector('code');
      var text = code ? code.innerText : pre.innerText;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(function () {
          btn.textContent = 'copied!';
          setTimeout(function () { btn.textContent = 'copy'; }, 1500);
        });
      } else {
        btn.textContent = 'unsupported';
      }
    });
    pre.style.position = 'relative';
    pre.appendChild(btn);
  });

  // 2. 目录滚动高亮
  var tocLinks = document.querySelectorAll('.toc a');
  if (tocLinks.length) {
    var headings = Array.prototype.map.call(tocLinks, function (a) {
      return document.querySelector(a.getAttribute('href'));
    }).filter(Boolean);

    function onScroll() {
      var pos = window.scrollY + 140;
      var current = 0;
      headings.forEach(function (h, i) {
        if (h.offsetTop <= pos) current = i;
      });
      tocLinks.forEach(function (a, i) {
        if (i === current) {
          a.style.color = 'var(--accent)';
          a.style.fontWeight = '600';
        } else {
          a.style.color = '';
          a.style.fontWeight = '';
        }
      });
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  // 3. 返回顶部小按钮(长文章页)
  var btn = document.createElement('button');
  btn.id = 'back-top';
  btn.textContent = '↑';
  btn.style.cssText =
    'position:fixed;right:22px;bottom:22px;width:42px;height:42px;border-radius:10px;' +
    'background:var(--accent);color:#0d1117;font-size:18px;font-weight:800;border:none;' +
    'cursor:pointer;opacity:0;transition:opacity .25s;z-index:99;box-shadow:0 6px 18px rgba(0,0,0,.35)';
  btn.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });
  document.body.appendChild(btn);
  window.addEventListener('scroll', function () {
    btn.style.opacity = window.scrollY > 600 ? '1' : '0';
  }, { passive: true });
})();