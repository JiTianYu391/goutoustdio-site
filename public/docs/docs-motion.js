/* 开放平台文档动画（与主站 motion.js 同源：GSAP + ScrollTrigger + SplitText + Lenis）。
   渐进增强：访客减少动态效果或脚本未加载时，页面保持完整静止可见。 */
(function () {
  "use strict";

  var root = document.documentElement;
  var gsap = window.gsap;
  var ScrollTrigger = window.ScrollTrigger;
  var SplitText = window.SplitText;
  var mm = window.matchMedia ? function (q) { return window.matchMedia(q).matches; } : function () { return false; };

  if (!gsap || !ScrollTrigger || mm("(prefers-reduced-motion: reduce)")) {
    root.classList.remove("motion");
    return;
  }
  gsap.registerPlugin(ScrollTrigger);
  if (SplitText) gsap.registerPlugin(SplitText);

  var finePointer = mm("(hover: hover) and (pointer: fine)");
  var $ = function (sel, ctx) { return (ctx || document).querySelector(sel); };
  var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); };

  gsap.defaults({ ease: "power3.out", duration: 0.85 });

  /* ---------- 平滑滚动 ---------- */
  var lenis = null;
  function initLenis() {
    if (!window.Lenis) return;
    lenis = new window.Lenis({ lerp: 0.1, wheelMultiplier: 1, anchors: true });
    window.docLenis = lenis;
    lenis.on("scroll", ScrollTrigger.update);
    gsap.ticker.add(function (time) { lenis.raf(time * 1000); });
    gsap.ticker.lagSmoothing(0);
  }

  /* ---------- 顶栏滚动投影 & 导航滑动指示器 ---------- */
  function initHeader() {
    var header = $("#docHeader");
    if (!header) return;
    ScrollTrigger.create({
      start: 0, end: "max",
      onUpdate: function (self) {
        header.classList.toggle("is-scrolled", self.scroll() > 8);
      },
    });

    var nav = $(".doc-topnav", header);
    if (!nav) return;
    var items = $$("a", nav);
    var media = gsap.matchMedia();
    media.add("(min-width: 60.01rem) and (hover: hover)", function () {
      var pill = document.createElement("span");
      pill.className = "nav-indicator";
      pill.setAttribute("aria-hidden", "true");
      nav.prepend(pill);
      nav.classList.add("has-indicator");
      var shown = false;
      function moveTo(el) {
        var vars = { x: el.offsetLeft, y: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight };
        if (!shown) { gsap.set(pill, vars); shown = true; }
        gsap.to(pill, Object.assign({ autoAlpha: 1, duration: 0.42, ease: "expo.out", overwrite: true }, vars));
      }
      function hide() { shown = false; gsap.to(pill, { autoAlpha: 0, duration: 0.24, overwrite: true }); }
      items.forEach(function (el) {
        el.addEventListener("mouseenter", function () { moveTo(el); });
        el.addEventListener("focus", function () { moveTo(el); });
      });
      nav.addEventListener("mouseleave", hide);
      return function () { pill.remove(); nav.classList.remove("has-indicator"); };
    });
  }

  /* ---------- 极光鼠标视差 ---------- */
  function initBackdrop() {
    var backdrop = $(".doc-backdrop");
    if (!backdrop || !finePointer) return;
    var ax = gsap.quickTo(backdrop, "--ax", { duration: 1.6, ease: "power3" });
    var ay = gsap.quickTo(backdrop, "--ay", { duration: 1.6, ease: "power3" });
    window.addEventListener("pointermove", function (e) {
      ax(e.clientX / Math.max(1, window.innerWidth) - 0.5);
      ay(e.clientY / Math.max(1, window.innerHeight) - 0.5);
    }, { passive: true });
  }

  /* ---------- 插画：分层拼装、连线描边、虚线流动（与主站 artTimeline 同源） ---------- */
  function prepStroke(path) {
    var len = 0;
    try { len = path.getTotalLength(); } catch (e) { len = 0; }
    if (!len) return 0;
    gsap.set(path, { strokeDasharray: len, strokeDashoffset: len });
    return len;
  }

  function artTimeline(svg) {
    var tl = gsap.timeline({ paused: true });
    var blocks = $$("rect", svg);
    var texts = $$("text", svg);
    var strokes = $$(".art-brand, .art-line", svg);
    var icons = $$(".art-ico", svg);
    tl.from(blocks, { y: -26, autoAlpha: 0, scale: 0.94, transformOrigin: "50% 50%", duration: 0.85, stagger: 0.13, ease: "back.out(1.4)" }, 0)
      .from(texts, { x: -12, autoAlpha: 0, duration: 0.55, stagger: 0.04 }, 0.22)
      .from(icons, { scale: 0, autoAlpha: 0, transformOrigin: "50% 50%", duration: 0.65, stagger: 0.11, ease: "back.out(2)" }, 0.42);
    strokes.forEach(function (p, i) {
      if (!prepStroke(p)) return;
      tl.to(p, { strokeDashoffset: 0, duration: 0.75, ease: "power2.inOut" }, 0.5 + i * 0.12);
    });
    tl.call(function () {
      strokes.forEach(function (p) {
        gsap.set(p, { strokeDasharray: "6 7", strokeDashoffset: 0 });
        gsap.to(p, { strokeDashoffset: -26, duration: 1.4, ease: "none", repeat: -1 });
      });
      icons.forEach(function (g, i) {
        gsap.to(g, { y: -3, duration: 1.8 + i * 0.3, ease: "sine.inOut", yoyo: true, repeat: -1 });
      });
    });
    return tl;
  }

  /* ---------- 首屏入场 ---------- */
  function initHero() {
    var article = $(".doc-article");
    if (!article) return;
    var tl = gsap.timeline({ defaults: { ease: "expo.out", duration: 0.95 }, delay: 0.04 });

    var crumbs = $(".doc-crumbs", article);
    if (crumbs) tl.from(crumbs, { y: 12, autoAlpha: 0, duration: 0.65 }, 0);
    var badge = $(".doc-hero-badge", article);
    if (badge) tl.from(badge, { y: 14, autoAlpha: 0, duration: 0.7 }, 0.05);

    var h1 = $("h1", article);
    if (h1) {
      if (SplitText) {
        var split = SplitText.create(h1, { type: "words,chars", wordsClass: "pg-word", charsClass: "pg-char" });
        if (split && split.chars && split.chars.length) {
          h1.classList.add("is-split");
          tl.from(split.chars, {
            yPercent: 80, rotationX: -65, autoAlpha: 0, transformOrigin: "50% 100% -0.4em",
            duration: 0.85, stagger: { each: 0.024, from: "start" },
          }, 0.08);
        } else {
          tl.from(h1, { y: 24, autoAlpha: 0 }, 0.08);
        }
      } else {
        tl.from(h1, { y: 24, autoAlpha: 0 }, 0.08);
      }
    }

    var lede = $(".lede", article);
    if (lede) tl.from(lede, { y: 18, autoAlpha: 0 }, 0.3);
    var acts = $$(".doc-hero .actions > *", article);
    if (acts.length) tl.from(acts, { y: 16, autoAlpha: 0, stagger: 0.07 }, 0.42);
    var meta = $(".doc-meta", article);
    if (meta) tl.from(meta, { y: 12, autoAlpha: 0, duration: 0.7 }, 0.46);

    var fig = $(".doc-hero figure", article);
    if (fig) {
      var svg = $("svg.art", fig);
      if (svg) {
        var art = artTimeline(svg);
        tl.from(fig, { autoAlpha: 0, duration: 0.35 }, 0.16);
        tl.add(function () { art.play(); }, 0.22);
        var cap = $("figcaption", fig);
        if (cap) tl.from(cap, { y: 10, autoAlpha: 0, duration: 0.7 }, 1.05);
      }
    }
  }

  /* ---------- 滚动入场 ---------- */
  function reveal(targets, from, opts) {
    targets = targets.filter(Boolean);
    if (!targets.length) return;
    opts = opts || {};
    gsap.set(targets, Object.assign({ autoAlpha: 0 }, from));
    ScrollTrigger.batch(targets, {
      start: opts.start || "top 90%",
      once: true,
      onEnter: function (batch) {
        gsap.to(batch, {
          autoAlpha: 1, x: 0, y: 0, scale: 1, rotationX: 0,
          stagger: opts.stagger || 0.07,
          duration: opts.duration || 0.85,
          ease: opts.ease || "expo.out",
          overwrite: true,
          clearProps: "transform,opacity,visibility",
        });
        if (opts.onEnter) opts.onEnter(batch);
      },
    });
  }

  function popIcons(batch) {
    var icons = batch.map(function (el) { return $(".icon-box", el); }).filter(Boolean);
    if (icons.length) {
      gsap.fromTo(icons, { scale: 0.55, rotation: -18 },
        { scale: 1, rotation: 0, duration: 0.85, stagger: 0.08, ease: "back.out(2.2)", delay: 0.12, clearProps: "transform" });
    }
  }

  function initReveals() {
    var article = $(".doc-article");
    if (!article) return;

    $$("h2", article).forEach(function (h) {
      reveal([h], { y: 22 }, { duration: 0.8 });
    });

    reveal($$(".cards .card", article), { y: 52, rotationX: -12, transformOrigin: "50% 100%" },
      { stagger: 0.1, duration: 1.0, onEnter: popIcons });
    reveal($$(".steps > li", article), { x: -24 }, { stagger: 0.08 });
    reveal($$(".codeblock", article), { y: 30 }, { stagger: 0.06 });
    reveal($$(".table-wrap", article), { y: 28 }, { stagger: 0.06 });
    reveal($$(".callout, .endpoint", article), { y: 20 }, { stagger: 0.05 });
    reveal($$(".doc-feedback, .prev-next a", article), { y: 24 }, { stagger: 0.07, start: "top 94%" });

    var mark = $(".doc-footer-mark");
    if (mark) {
      gsap.from(mark, {
        yPercent: 40, autoAlpha: 0, ease: "none",
        scrollTrigger: { trigger: mark, start: "top bottom", end: "bottom bottom", scrub: 0.6 },
      });
    }
  }

  /* ---------- 精细指针交互：光斑、3D 倾斜、磁吸按钮 ---------- */
  function initPointer() {
    if (!finePointer) return;
    function track(el) {
      el.classList.add("spot");
      el.addEventListener("pointermove", function (e) {
        var r = el.getBoundingClientRect();
        el.style.setProperty("--mx", (e.clientX - r.left) + "px");
        el.style.setProperty("--my", (e.clientY - r.top) + "px");
      });
    }
    $$(".cards .card, .codeblock, .table-wrap, .doc-feedback, .prev-next a, .doc-side-foot").forEach(track);

    $$(".cards .card").forEach(function (card) {
      var rx = gsap.quickTo(card, "rotationX", { duration: 0.55, ease: "power3" });
      var ry = gsap.quickTo(card, "rotationY", { duration: 0.55, ease: "power3" });
      gsap.set(card, { transformPerspective: 900 });
      card.addEventListener("pointermove", function (e) {
        var r = card.getBoundingClientRect();
        ry(((e.clientX - r.left) / r.width - 0.5) * 8);
        rx(-((e.clientY - r.top) / r.height - 0.5) * 8);
      });
      card.addEventListener("pointerleave", function () { rx(0); ry(0); });
    });

    $$(".button, .doc-header .cta").forEach(function (btn) {
      var mx = gsap.quickTo(btn, "x", { duration: 0.45, ease: "power3" });
      var my = gsap.quickTo(btn, "y", { duration: 0.45, ease: "power3" });
      btn.addEventListener("pointermove", function (e) {
        var r = btn.getBoundingClientRect();
        mx((e.clientX - r.left - r.width / 2) * 0.2);
        my((e.clientY - r.top - r.height / 2) * 0.3);
      });
      btn.addEventListener("pointerleave", function () {
        gsap.to(btn, { x: 0, y: 0, duration: 0.85, ease: "elastic.out(1, 0.4)", overwrite: true });
      });
    });
  }

  function init() {
    initLenis();
    initHeader();
    initBackdrop();
    initHero();
    root.classList.add("motion-ready");
    initReveals();
    initPointer();
    window.addEventListener("load", function () { ScrollTrigger.refresh(); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { ScrollTrigger.refresh(); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
