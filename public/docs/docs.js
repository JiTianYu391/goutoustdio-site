// GoutouStdio 开放平台文档：三栏导航、本页目录、跨页搜索、代码语言切换。
// 无构建步骤：每个页面只写正文，导航 / 目录 / 搜索索引在这里统一生成。
'use strict';

const NAV = [
  { group: '开始', items: [
    { id: 'index', title: '快速开始', href: '/docs' },
    { id: 'oauth', title: '账号登录（OAuth 2.0）', href: '/docs/oauth' },
    { id: 'tokens', title: '令牌与用户信息', href: '/docs/tokens' },
  ] },
  { group: '充值', items: [
    { id: 'recharge', title: '创建充值订单', href: '/docs/recharge' },
    { id: 'webhooks', title: '回调与验签', href: '/docs/webhooks' },
  ] },
  { group: '参考', items: [
    { id: 'errors', title: '错误码与限流', href: '/docs/errors' },
    { id: 'example', title: '完整示例：小游戏', href: '/docs/example' },
  ] },
];

const flat = NAV.flatMap((g) => g.items.map((item) => ({ ...item, group: g.group })));
const page = document.body.dataset.page || 'index';
const current = flat.find((x) => x.id === page) || flat[0];
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ICON = {
  menu: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
  close: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  search: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  github: '<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49v-1.7c-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.34 1.12 2.91.86.09-.66.35-1.12.63-1.38-2.22-.26-4.56-1.14-4.56-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.7 0 0 .84-.28 2.75 1.05a9.3 9.3 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.4.2 2.44.1 2.7.64.72 1.03 1.63 1.03 2.75 0 3.93-2.34 4.8-4.57 5.05.36.32.68.94.68 1.9v2.82c0 .27.18.6.69.49A10.13 10.13 0 0 0 22 12.25C22 6.58 17.52 2 12 2z"/></svg>',
  sun: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
  chevron: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg>',
  link: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 1 0-5.66-5.66l-1.5 1.5"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 1 0 5.66 5.66l1.5-1.5"/></svg>',
};

const BRAND = '<svg viewBox="0 0 28 28" aria-hidden="true"><rect x="3" y="4" width="22" height="6" rx="2" fill="url(#bg1)"/><rect x="3" y="11" width="22" height="6" rx="2" fill="url(#bg2)"/><rect x="3" y="18" width="22" height="6" rx="2" fill="url(#bg3)"/><defs><linearGradient id="bg1" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#7c6cff"/><stop offset="1" stop-color="#22d3ee"/></linearGradient><linearGradient id="bg2" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#8b7cff"/><stop offset="1" stop-color="#3ec8e6"/></linearGradient><linearGradient id="bg3" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#a094ff"/><stop offset="1" stop-color="#67e3f6"/></linearGradient></defs></svg>';

const searchButton = (cls = '') => `<button class="doc-search-btn js-search ${cls}" type="button" aria-label="搜索文档（快捷键 ⌘K）">${ICON.search}<span>搜索文档</span><span class="kbd"><kbd>⌘</kbd><kbd>K</kbd></span></button>`;

// ---------- 主题 ----------
(function initTheme() {
  const root = document.documentElement;
  let stored = null;
  try { stored = localStorage.getItem('pg-theme'); } catch (_) { /* 隐私模式 */ }
  root.dataset.theme = stored === 'light' ? 'light' : 'dark';
  document.body.classList.toggle('theme-dark', root.dataset.theme === 'dark');
})();

function toast(text) {
  let t = $('.doc-toast');
  if (!t) { t = document.createElement('div'); t.className = 'doc-toast'; document.body.appendChild(t); }
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.remove('show'), 1800);
}

// ---------- 顶栏 ----------
(function header() {
  const h = document.getElementById('docHeader');
  if (!h) return;
  const root = document.documentElement;
  h.innerHTML = `
    <button class="icon-btn doc-menu-btn" id="menuBtn" type="button" aria-label="打开文档目录" aria-controls="docSide" aria-expanded="false">${ICON.menu}</button>
    <a class="doc-brand" href="/docs">${BRAND}GoutouStdio<span class="sub">开放平台</span></a>
    <span class="spacer"></span>
    ${searchButton()}
    <nav class="doc-topnav" aria-label="相关站点">
      <a href="/docs" aria-current="page">文档</a>
      <a href="https://pay.goutoustdio.top/merchant" rel="noopener">控制台</a>
      <a href="/">主站</a>
    </nav>
    <a class="icon-btn" href="https://github.com/JiTianYu391/goutoustdio-site" target="_blank" rel="noopener" aria-label="GitHub 仓库" title="GitHub 仓库">${ICON.github}</a>
    <button class="icon-btn" id="themeBtn" type="button" aria-label="切换明暗主题" title="切换主题">${root.dataset.theme === 'dark' ? ICON.sun : ICON.moon}</button>
    <a class="cta" href="/docs/index">接入指南</a>`;

  $('#themeBtn').addEventListener('click', () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    document.body.classList.toggle('theme-dark', next === 'dark');
    $('#themeBtn').innerHTML = next === 'dark' ? ICON.sun : ICON.moon;
    try { localStorage.setItem('pg-theme', next); } catch (_) { /* 忽略 */ }
  });
})();

// ---------- 侧栏 ----------
(function sidebar() {
  const side = document.getElementById('docSide');
  const nav = document.getElementById('docNav');
  if (!side || !nav) return;

  // 页面里旧的搜索框换成按钮（手机抽屉里用，桌面用顶栏搜索）
  const old = $('.doc-search', side);
  if (old) old.outerHTML = searchButton('side-search');

  nav.innerHTML = '';
  for (const g of NAV) {
    const label = document.createElement('div');
    label.className = 'grp';
    label.textContent = g.group;
    nav.appendChild(label);
    for (const item of g.items) {
      const a = document.createElement('a');
      a.href = item.href;
      a.textContent = item.title;
      if (item.id === page) { a.classList.add('active'); a.setAttribute('aria-current', 'page'); }
      nav.appendChild(a);
    }
  }

  const foot = document.createElement('div');
  foot.className = 'doc-side-foot';
  foot.innerHTML = `<b>需要帮助？</b>接入遇到问题可以提交工单，或直接看示例代码。
    <div class="links"><a href="/support">提交工单</a><a href="/docs/example">示例代码</a><a href="/docs/errors">错误码</a></div>`;
  side.appendChild(foot);
})();

// ---------- 抽屉 ----------
(function drawer() {
  const btn = document.getElementById('menuBtn');
  const scrim = document.getElementById('docScrim');
  const side = document.getElementById('docSide');
  if (!btn || !side) return;

  const setOpen = (open) => {
    document.body.classList.toggle('nav-open', open);
    btn.setAttribute('aria-expanded', String(open));
    btn.setAttribute('aria-label', open ? '关闭文档目录' : '打开文档目录');
    btn.innerHTML = open ? ICON.close : ICON.menu;
    if (open) { const first = side.querySelector('a'); if (first) first.focus({ preventScroll: true }); }
    else btn.focus({ preventScroll: true });
  };
  btn.addEventListener('click', () => setOpen(!document.body.classList.contains('nav-open')));
  if (scrim) scrim.addEventListener('click', () => setOpen(false));
  side.addEventListener('click', (e) => { if (e.target.closest('a')) setOpen(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('nav-open')) setOpen(false); });
  addEventListener('resize', () => { if (innerWidth > 960 && document.body.classList.contains('nav-open')) setOpen(false); });
})();

// ---------- 面包屑 / 阅读时长 / 复制链接 ----------
(function meta() {
  const article = $('.doc-article');
  if (!article) return;
  const h1 = article.querySelector('h1');
  const lede = article.querySelector('.lede');

  const crumbs = document.createElement('div');
  crumbs.className = 'doc-crumbs';
  crumbs.setAttribute('aria-label', '当前位置');
  crumbs.innerHTML = `<a href="/docs">文档</a><span class="sep">/</span><span>${current.group}</span><span class="sep">/</span><span class="here">${current.title}</span>`;
  article.insertBefore(crumbs, h1);

  const clone = article.cloneNode(true);
  clone.querySelectorAll('pre, .codeblock, .doc-table, .doc-meta, .doc-crumbs, .toc-mobile, .anchor').forEach((n) => n.remove());
  const minutes = Math.max(1, Math.round((clone.textContent || '').length / 450));
  const info = document.createElement('div');
  info.className = 'doc-meta';
  info.innerHTML = `<span>阅读约 ${minutes} 分钟</span><button type="button" class="copy-link">${ICON.link} 复制本页链接</button>`;
  if (lede) lede.insertAdjacentElement('afterend', info); else h1.insertAdjacentElement('afterend', info);
  info.querySelector('.copy-link').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); toast('本页链接已复制'); }
    catch { prompt('复制本页链接', location.href); }
  });
})();

// ---------- 右栏目录 + 手机目录 ----------
const tocLinks = [];
(function toc() {
  const article = $('.doc-article');
  const shell = $('.doc-shell');
  if (!article || !shell) return;

  const heads = $$('h2[id], h3[id]', article);
  const items = heads.map((h) => ({ id: h.id, text: h.textContent.trim(), level: h.tagName === 'H2' ? 2 : 3 }));
  if (!items.length) return;

  const aside = document.createElement('aside');
  aside.className = 'doc-toc';
  aside.id = 'docToc';
  aside.setAttribute('aria-label', '本页目录');
  aside.innerHTML = `<p class="toc-title">本页目录</p><nav>${items.map((i) => `<a href="#${i.id}" class="lv${i.level}" data-id="${i.id}">${i.text}</a>`).join('')}</nav>`;
  shell.appendChild(aside);
  tocLinks.push(...$$('a[data-id]', aside));

  // 手机：正文顶部的折叠目录
  const mobile = document.createElement('details');
  mobile.className = 'toc-mobile';
  mobile.innerHTML = `<summary>本页目录${ICON.chevron}</summary><nav>${items.map((i) => `<a href="#${i.id}" class="lv${i.level}">${i.text}</a>`).join('')}</nav>`;
  const anchorEl = article.querySelector('.doc-meta') || article.querySelector('.doc-crumbs') || article.querySelector('h1');
  anchorEl.insertAdjacentElement('afterend', mobile);
  mobile.addEventListener('click', (e) => { if (e.target.closest('a')) mobile.open = false; });

  // 滚动高亮
  let ticking = false;
  const spy = () => {
    ticking = false;
    let active = items[0].id;
    for (const h of heads) {
      if (h.getBoundingClientRect().top <= 120) active = h.id;
    }
    tocLinks.forEach((a) => a.classList.toggle('active', a.dataset.id === active));
  };
  addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(spy); } }, { passive: true });
  spy();
})();

// ---------- 进度条 ----------
(function progress() {
  const header = document.getElementById('docHeader');
  if (!header) return;
  let ticking = false;
  const update = () => {
    ticking = false;
    const h = document.documentElement;
    const max = h.scrollHeight - innerHeight;
    const p = max > 0 ? Math.min(1, Math.max(0, scrollY / max)) : 0;
    header.style.setProperty('--doc-progress', p.toFixed(4));
  };
  addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
  update();
})();

// ---------- 标题锚点 ----------
(function anchors() {
  $$('.doc-article h2[id], .doc-article h3[id]').forEach((h) => {
    const a = document.createElement('a');
    a.className = 'anchor';
    a.href = '#' + h.id;
    a.setAttribute('aria-label', '链接到本节');
    a.innerHTML = ICON.link;
    h.appendChild(a);
  });
})();

// ---------- 表格：包一层 + 手机端行标签 ----------
(function tables() {
  $$('.doc-table').forEach((table) => {
    const heads = $$('thead th', table).map((th) => th.textContent.trim());
    $$('tbody tr', table).forEach((tr) => {
      [...tr.children].forEach((td, i) => {
        if (heads[i]) td.dataset.label = heads[i];
        // 把单元格内容包一层，手机端才能「标签 | 内容」两栏排，不会被文字节点拆散
        if (!td.querySelector('.td-body')) {
          const body = document.createElement('span');
          body.className = 'td-body';
          while (td.firstChild) body.appendChild(td.firstChild);
          td.appendChild(body);
        }
      });
    });
    if (!table.parentElement.classList.contains('table-wrap')) {
      const wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      table.parentNode.insertBefore(wrap, table);
      wrap.appendChild(table);
    }
  });
})();

// ---------- 代码块：语言切换（跨页记忆）+ 复制 ----------
(function codeBlocks() {
  const LANGS = { shell: 'Shell', bash: 'Shell', text: '文本', json: 'JSON', node: 'Node.js', js: 'JavaScript', client: '客户端', server: '服务端', python: 'Python', curl: 'curl', html: 'HTML', express: 'Express', url: 'URL' };
  let preferred = null;
  try { preferred = localStorage.getItem('pg-doc-lang'); } catch (_) { /* 忽略 */ }

  const applyLang = (block, lang) => {
    const tabs = $$('.lang-tabs button', block);
    const panes = $$('pre[data-lang]', block);
    if (!panes.some((p) => p.dataset.lang === lang)) return;
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.lang === lang));
    panes.forEach((p) => { p.hidden = p.dataset.lang !== lang; });
    const copy = $('.copy', block);
    if (copy) copy.textContent = '复制';
  };

  $$('.codeblock').forEach((block) => {
    const tabs = $$('.lang-tabs button', block);
    const panes = $$('pre[data-lang]', block);
    panes.forEach((p) => { p.hidden = true; });
    if (!tabs.length && panes.length) {
      const lang = panes[0].dataset.lang;
      const head = $('.lang-tabs', block);
      if (head) {
        const b = document.createElement('button');
        b.className = 'active'; b.dataset.lang = lang; b.textContent = LANGS[lang] || lang;
        head.appendChild(b); tabs.push(b);
      }
    }
    const initial = preferred && panes.some((p) => p.dataset.lang === preferred)
      ? preferred
      : (tabs.find((t) => t.classList.contains('active'))?.dataset.lang || panes[0]?.dataset.lang);
    if (initial) applyLang(block, initial);

    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        preferred = tab.dataset.lang;
        try { localStorage.setItem('pg-doc-lang', preferred); } catch (_) { /* 忽略 */ }
        applyLang(block, preferred);
      });
    });

    const copy = $('.copy', block);
    if (copy) {
      copy.addEventListener('click', async () => {
        const visible = panes.find((p) => !p.hidden) || panes[0];
        if (!visible) return;
        const text = visible.textContent.replace(/\n$/, '');
        try {
          if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
          else {
            const ta = document.createElement('textarea');
            ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
          }
          copy.textContent = '已复制';
          setTimeout(() => { copy.textContent = '复制'; }, 1600);
        } catch (_) { toast('复制失败，请手动选择'); }
      });
    }
  });
})();

// ---------- 页尾：反馈 + 翻页 ----------
(function footer() {
  const article = $('.doc-article');
  if (!article) return;

  const key = 'gs_doc_feedback:' + page;
  let saved = null;
  try { saved = localStorage.getItem(key); } catch (_) { /* 忽略 */ }
  const fb = document.createElement('div');
  fb.className = 'doc-feedback';
  fb.innerHTML = saved
    ? `<p>谢谢反馈，我们会继续改进这一页。</p>`
    : `<p>这一页对你有帮助吗？</p><div class="btns"><button type="button" data-v="yes">有帮助</button><button type="button" data-v="no">没帮助</button></div>`;
  if (!saved) {
    fb.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      try { localStorage.setItem(key, b.dataset.v); } catch (_) { /* 忽略 */ }
      fb.innerHTML = `<p class="thanks">谢谢反馈，我们会继续改进这一页。</p>`;
    }));
  }
  article.appendChild(fb);

  const i = flat.findIndex((x) => x.id === page);
  const prev = flat[i - 1], next = flat[i + 1];
  if (prev || next) {
    const pager = document.createElement('div');
    pager.className = 'prev-next';
    pager.innerHTML = [
      prev ? `<a class="prev" href="${prev.href}"><span>上一页</span>${prev.title}</a>` : '',
      next ? `<a class="next" href="${next.href}"><span>下一页</span>${next.title}</a>` : '',
    ].join('');
    article.appendChild(pager);
  }
})();

// ---------- 搜索 ----------
(function search() {
  let index = null, loading = null, active = 0, results = [], lastQuery = '';
  const KEY = 'gs_docs_index_v2';

  const overlay = document.createElement('div');
  overlay.className = 'search-overlay';
  overlay.innerHTML = `
    <div class="search-panel" role="dialog" aria-modal="true" aria-label="搜索文档">
      <div class="search-field">
        ${ICON.search}
        <input id="searchInput" type="search" placeholder="搜索接口、参数或概念…" autocomplete="off" spellcheck="false" aria-controls="searchResults">
        <button class="icon-btn search-close" type="button" aria-label="关闭搜索">${ICON.close}</button>
      </div>
      <div class="search-results" id="searchResults"></div>
      <div class="search-foot">
        <span class="k"><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
        <span class="k"><kbd>Enter</kbd> 打开</span>
        <span class="k"><kbd>Esc</kbd> 关闭</span>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const input = $('#searchInput', overlay);
  const list = $('#searchResults', overlay);

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hl = (text, q) => {
    const t = esc(text);
    if (!q) return t;
    const terms = [...new Set(q.split(/\s+/).filter(Boolean))].sort((a, b) => b.length - a.length);
    return terms.reduce((out, term) => out.replace(new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>'), t);
  };

  async function buildIndex() {
    if (index) return index;
    try {
      const cached = sessionStorage.getItem(KEY);
      if (cached) { index = JSON.parse(cached); return index; }
    } catch (_) { /* 忽略 */ }
    const entries = [];
    await Promise.all(flat.map(async (item) => {
      try {
        const html = await (await fetch(item.href)).text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const article = doc.querySelector('.doc-article');
        if (!article) return;
        const h1 = article.querySelector('h1')?.textContent.trim() || item.title;
        const lede = article.querySelector('.lede')?.textContent.trim() || '';
        entries.push({ href: item.href, title: h1, page: h1, group: item.group, snippet: lede.slice(0, 120), level: 1 });
        article.querySelectorAll('h2[id], h3[id]').forEach((h) => {
          const level = h.tagName === 'H2' ? 2 : 3;
          const sib = h.nextElementSibling;
          const snippet = sib && /^(P|UL|OL)$/i.test(sib.tagName) ? sib.textContent.trim().slice(0, 120) : '';
          entries.push({ href: `${item.href}#${h.id}`, title: h.textContent.trim(), page: h1, group: item.group, snippet, level });
        });
      } catch (_) { /* 单页失败不影响其它页 */ }
    }));
    index = entries;
    try { sessionStorage.setItem(KEY, JSON.stringify(entries)); } catch (_) { /* 忽略 */ }
    return index;
  }

  function score(e, q) {
    const title = e.title.toLowerCase(), pageName = e.page.toLowerCase(), snip = (e.snippet || '').toLowerCase();
    let s = 0;
    for (const term of q.split(/\s+/).filter(Boolean)) {
      if (title === term) s += 24;
      else if (title.startsWith(term)) s += 14;
      else if (title.includes(term)) s += 8;
      else if (pageName.includes(term)) s += 3;
      else if (snip.includes(term)) s += 2;
      else return -1;
    }
    return s + (e.level === 1 ? 4 : 0) - (e.level === 3 ? 1 : 0);
  }

  function render(q) {
    lastQuery = q;
    const query = q.trim().toLowerCase();
    let items;
    if (!query) {
      items = flat.map((item) => ({ href: item.href, title: item.title, page: '文档', group: '快速跳转', snippet: '', level: 1 }));
    } else if (!index) {
      list.innerHTML = `<div class="search-empty">正在建立索引…</div>`;
      return;
    } else {
      items = index.map((e) => ({ e, s: score(e, query) })).filter((x) => x.s >= 0)
        .sort((a, b) => b.s - a.s).slice(0, 18).map((x) => x.e);
    }
    results = items;
    active = 0;
    if (!items.length) {
      list.innerHTML = `<div class="search-empty">没有找到「${esc(q)}」<br>试试「充值」「Webhook」「PKCE」</div>`;
      return;
    }
    const head = query ? '' : '<div class="search-group">快速跳转</div>';
    list.innerHTML = head + items.map((it) => {
      const idx = results.indexOf(it);
      const ctx = query ? `<small>${esc(it.level === 1 ? it.group : it.page)}</small>` : '';
      return `<a class="search-hit${idx === active ? ' active' : ''}" href="${it.href}" data-i="${idx}">
        <span class="t">${hl(it.title, q.trim())}${ctx}</span>
        ${it.snippet ? `<span class="s">${hl(it.snippet, q.trim())}</span>` : ''}
      </a>`;
    }).join('');
    bindHits();
    moveActive(0);
  }

  function bindHits() {
    $$('.search-hit', list).forEach((a) => {
      a.addEventListener('mouseenter', () => moveActive(Number(a.dataset.i)));
      a.addEventListener('click', () => close());
    });
  }

  function moveActive(i) {
    const hits = $$('.search-hit', list);
    if (!hits.length) return;
    active = (i + hits.length) % hits.length;
    hits.forEach((h, n) => h.classList.toggle('active', n === active));
    if (hits[active].scrollIntoView) hits[active].scrollIntoView({ block: 'nearest' });
  }

  function open() {
    document.body.classList.remove('nav-open');
    const menuBtn = document.getElementById('menuBtn');
    if (menuBtn) menuBtn.setAttribute('aria-expanded', 'false');
    overlay.classList.add('open');
    document.body.classList.add('search-open');
    input.value = '';
    render('');
    input.focus();
    if (!index && !loading) {
      loading = buildIndex().then(() => {
        if (!overlay.classList.contains('open')) return;
        render(input.value);
      }).catch(() => {});
    }
  }
  function close() {
    overlay.classList.remove('open');
    document.body.classList.remove('search-open');
  }

  $$('.js-search').forEach((btn) => btn.addEventListener('click', open));
  $('.search-close', overlay).addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => render(input.value), 90);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(active - 1); }
    else if (e.key === 'Enter') {
      const hit = $$('.search-hit', list)[active];
      if (hit) { e.preventDefault(); const href = hit.getAttribute('href'); close(); location.href = href; }
    }
  });

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); overlay.classList.contains('open') ? close() : open(); }
    else if (e.key === '/' && !typing) { e.preventDefault(); open(); }
    else if (e.key === 'Escape' && overlay.classList.contains('open')) close();
  });
})();

// ---------- 跳到正文 ----------
(function skip() {
  const main = $('.doc-main');
  if (!main) return;
  main.id = 'docContent';
  const a = document.createElement('a');
  a.className = 'skip-link';
  a.href = '#docContent';
  a.textContent = '跳到正文';
  document.body.insertBefore(a, document.body.firstChild);
})();
