/* 认证页背景：随鼠标轻微吸引的粒子星网；减少动态效果时不启用 */
(function () {
  var c = document.getElementById("auth-fx");
  if (!c || (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches)) return;
  var ctx = c.getContext("2d"), dpr = Math.min(window.devicePixelRatio || 1, 2), W, H, pts = [], mx = -999, my = -999, raf, col;
  function size() {
    var r = c.getBoundingClientRect(); W = r.width; H = r.height;
    c.width = W * dpr; c.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var n = Math.min(80, Math.round(W * H / 16000));
    while (pts.length < n) pts.push({ x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - .5) * .3, vy: (Math.random() - .5) * .3 });
    pts.length = n;
    col = getComputedStyle(document.body).getPropertyValue("--pg-accent").trim() || "#7c6cff";
  }
  function frame() {
    ctx.clearRect(0, 0, W, H); ctx.fillStyle = col; ctx.strokeStyle = col;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i], dx = mx - p.x, dy = my - p.y, d = Math.hypot(dx, dy);
      if (d < 160 && d > 0) { p.vx += dx / d * .01; p.vy += dy / d * .01; }
      p.vx *= .99; p.vy *= .99; p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > W) p.vx *= -1; if (p.y < 0 || p.y > H) p.vy *= -1;
      ctx.globalAlpha = .7; ctx.beginPath(); ctx.arc(p.x, p.y, 1.4, 0, 6.283); ctx.fill();
      for (var j = i + 1; j < pts.length; j++) {
        var q = pts[j], l = Math.hypot(p.x - q.x, p.y - q.y);
        if (l < 120) { ctx.globalAlpha = (1 - l / 120) * .3; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke(); }
      }
    }
    raf = requestAnimationFrame(frame);
  }
  addEventListener("resize", size);
  new MutationObserver(size).observe(document.body, { attributes: true, attributeFilter: ["class"] }); // 切换主题时换色
  c.parentNode.addEventListener("pointermove", function (e) { var r = c.getBoundingClientRect(); mx = e.clientX - r.left; my = e.clientY - r.top; });
  c.parentNode.addEventListener("pointerleave", function () { mx = my = -999; });
  document.addEventListener("visibilitychange", function () { cancelAnimationFrame(raf); if (!document.hidden) frame(); });
  size(); frame();
})();
