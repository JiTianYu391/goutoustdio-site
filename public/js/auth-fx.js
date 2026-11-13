/* 登录页背景：随鼠标轻微吸引的粒子星网；减少动态效果时不启用 */
(function () {
  var c = document.getElementById("auth-fx");
  if (!c || (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches)) return;
  var ctx = c.getContext("2d"), dpr = Math.min(window.devicePixelRatio || 1, 2), W, H, pts = [], mx = -999, my = -999, raf;
  function css(n, f) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f; }
  function size() {
    var r = c.getBoundingClientRect(); W = r.width; H = r.height;
    c.width = W * dpr; c.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var n = Math.min(90, Math.round(W * H / 14000));
    while (pts.length < n) pts.push({ x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - .5) * .35, vy: (Math.random() - .5) * .35 });
    pts.length = n;
  }
  function frame() {
    ctx.clearRect(0, 0, W, H);
    var col = css("--pg-accent", "#7c6cff"), col2 = css("--pg-accent", "#7c6cff");
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i], dx = mx - p.x, dy = my - p.y, d = Math.hypot(dx, dy);
      if (d < 160) { p.vx += dx / d * .012; p.vy += dy / d * .012; }
      p.vx *= .99; p.vy *= .99; p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > W) p.vx *= -1; if (p.y < 0 || p.y > H) p.vy *= -1;
      ctx.fillStyle = col2; ctx.globalAlpha = .8; ctx.beginPath(); ctx.arc(p.x, p.y, 1.6, 0, 6.283); ctx.fill();
      for (var j = i + 1; j < pts.length; j++) {
        var q = pts[j], l = Math.hypot(p.x - q.x, p.y - q.y);
        if (l < 120) { ctx.strokeStyle = col; ctx.globalAlpha = (1 - l / 120) * .35; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke(); }
      }
    }
    raf = requestAnimationFrame(frame);
  }
  addEventListener("resize", size);
  c.parentNode.addEventListener("pointermove", function (e) { var r = c.getBoundingClientRect(); mx = e.clientX - r.left; my = e.clientY - r.top; });
  c.parentNode.addEventListener("pointerleave", function () { mx = my = -999; });
  document.addEventListener("visibilitychange", function () { if (document.hidden) cancelAnimationFrame(raf); else frame(); });
  size(); frame();
  /* 提交失败时卡片抖一下 */
  var card = document.querySelector(".auth-card"), msg = document.getElementById("auth-msg");
  if (card && msg) new MutationObserver(function () {
    if (msg.textContent && !msg.classList.contains("ok")) { card.classList.remove("shake"); void card.offsetWidth; card.classList.add("shake"); }
  }).observe(msg, { childList: true, characterData: true, subtree: true });
})();
