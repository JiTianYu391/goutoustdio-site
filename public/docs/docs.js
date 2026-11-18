// 开放平台文档：侧栏 / 搜索 / 代码语言切换 / 复制 / 主题切换 / 上一页下一页。
// 无构建步骤，页面只写正文，导航在这里统一维护。
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

const flat = NAV.flatMap((g) => g.items);
const page = document.body.dataset.page || 'index';

// 首屏就按 localStorage 定好主题，避免闪一下
(function initTheme() {
  const root = document.documentElement;
  let t = null;
  try { t = localStorage.getItem('pg-theme'); } catch (_) { /* 隐私模式 */ }
  root.dataset.theme = t === 'light' ? 'light' : 'dark';
  document.body.classList.toggle('theme-dark', root.dataset.theme === 'dark');
})();

// ---------- 顶栏 ----------
(function header() {
  const h = document.getElementById('docHeader');
  if (!h) return;
  h.innerHTML = `
    <button class="icon-btn doc-menu-btn" id="menuBtn" aria-label="打开文档目录" aria-controls="docSide" aria-expanded="false">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
    </button>
    <a class="doc-brand" href="/docs">
      <svg viewBox="0 0 28 28" aria-hidden="true"><rect x="3" y="4" width="22" height="6" rx="2" fill="url(#bg1)"/><rect x="3" y="11" width="22" height="6" rx="2" fill="url(#bg2)"/><rect x="3" y="18" width="22" height="6" rx="2" fill="url(#bg3)"/><defs><linearGradient id="bg1" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#7c6cff"/><stop offset="1" stop-color="#22d3ee"/></linearGradient><linearGradient id="bg2" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#8b7cff"/><stop offset="1" stop-color="#3ec8e6"/></linearGradient><linearGradient id="bg3" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#a094ff"/><stop offset="1" stop-color="#67e3f6"/></linearGradient></defs></svg>
      GoutouStdio <span class="sub">开放平台</span>
    </a>
    <span class="spacer"></span>
    <nav class="topnav" aria-label="相关站点">
      <a href="/docs" class="active">文档</a>
      <a href="https://pay.goutoustdio.top/merchant">支付控制台</a>
      <a href="/">主站</a>
    </nav>
    <button class="icon-btn" id="themeBtn" aria-label="切换明暗主题" title="切换主题">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
    </button>`;
})();

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

// ---------- 侧栏 ----------
function buildNav() {
  const nav = document.getElementById('docNav');
  if (!nav) return;
  for (const g of NAV) {
    nav.appendChild(el('div', 'grp', g.group));
    for (const item of g.items) {
      const a = el('a', item.id === page ? 'active' : '', item.title);
      a.href = item.href;
      if (item.id === page) a.setAttribute('aria-current', 'page');
      nav.appendChild(a);
    }
  }
}
buildNav();

// ---------- 搜索 ----------
(function search() {
  const input = document.getElementById('docSearch');
  const nav = document.getElementById('docNav');
  if (!input || !nav) return;
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    nav.querySelectorAll('a').forEach((a) => { a.hidden = !!q && !a.textContent.toLowerCase().includes(q); });
    nav.querySelectorAll('.grp').forEach((g) => {
      let n = g.nextElementSibling;
      let any = false;
      while (n && !n.classList.contains('grp')) { if (n.tagName === 'A' && !n.hidden) any = true; n = n.nextElementSibling; }
      g.hidden = !!q && !any;
    });
    let empty = nav.querySelector('.empty');
    if (q && ![...nav.querySelectorAll('a')].some((a) => !a.hidden)) {
      if (!empty) nav.appendChild(el('div', 'empty', '没有匹配的页面'));
    } else if (empty) empty.remove();
  });
})();

// ---------- 手机目录 ----------
(function drawer() {
  const btn = document.getElementById('menuBtn');
  const scrim = document.getElementById('docScrim');
  const side = document.getElementById('docSide');
  if (!btn || !side) return;
  const close = () => {
    document.body.classList.remove('nav-open');
    btn.setAttribute('aria-expanded', 'false');
  };
  btn.addEventListener('click', () => {
    const open = document.body.classList.toggle('nav-open');
    btn.setAttribute('aria-expanded', String(open));
  });
  if (scrim) scrim.addEventListener('click', close);
  side.addEventListener('click', (e) => { if (e.target.closest('a')) close(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
})();

// ---------- 主题 ----------
(function theme() {
  const KEY = 'pg-theme';
  const root = document.documentElement;
  const btn = document.getElementById('themeBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    document.body.classList.toggle('theme-dark', next === 'dark');
    try { localStorage.setItem(KEY, next); } catch (_) { /* 隐私模式忽略 */ }
  });
})();

// ---------- 代码块：语言标签与复制 ----------
(function codeBlocks() {
  document.querySelectorAll('.codeblock').forEach((block) => {
    const tabs = block.querySelectorAll('.lang-tabs button');
    const panes = block.querySelectorAll('pre[data-lang]');
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        tabs.forEach((t) => t.classList.toggle('active', t === tab));
        panes.forEach((p) => { p.hidden = p.dataset.lang !== tab.dataset.lang; });
      });
    });
    // 默认只显示第一个语言
    if (panes.length) {
      const active = block.querySelector('.lang-tabs button.active');
      const lang = active ? active.dataset.lang : panes[0].dataset.lang;
      panes.forEach((p) => { p.hidden = p.dataset.lang !== lang; });
    }
    const copy = block.querySelector('.copy');
    if (copy) {
      copy.addEventListener('click', async () => {
        const visible = [...panes].find((p) => !p.hidden) || panes[0];
        if (!visible) return;
        const text = visible.textContent;
        try {
          if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
          else {
            const ta = document.createElement('textarea');
            ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
          }
          copy.textContent = '已复制';
          setTimeout(() => { copy.textContent = '复制'; }, 1500);
        } catch (_) { copy.textContent = '复制失败'; }
      });
    }
  });
})();

// ---------- 标题锚点 ----------
(function anchors() {
  document.querySelectorAll('.doc-article h2[id]').forEach((h) => {
    const a = el('a', 'anchor', '#');
    a.href = '#' + h.id;
    a.setAttribute('aria-label', '本节链接');
    a.style.cssText = 'margin-left:.4rem;opacity:0;font-weight:400;text-decoration:none';
    h.appendChild(a);
    h.addEventListener('mouseenter', () => { a.style.opacity = '.55'; });
    h.addEventListener('mouseleave', () => { a.style.opacity = '0'; });
  });
})();

// ---------- 上一页 / 下一页 ----------
(function pager() {
  const host = document.getElementById('docPager');
  if (!host) return;
  const i = flat.findIndex((x) => x.id === page);
  if (i < 0) return;
  const prev = flat[i - 1], next = flat[i + 1];
  host.innerHTML = '';
  if (prev) {
    const a = el('a', 'prev', `<span>上一页</span>${prev.title}`);
    a.href = prev.href;
    host.appendChild(a);
  }
  if (next) {
    const a = el('a', 'next', `<span>下一页</span>${next.title}`);
    a.href = next.href;
    host.appendChild(a);
  }
})();
