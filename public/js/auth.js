/* 所有页面：把头部的“登录”入口换成当前用户的头像和名字 */
(function () {
  var a = document.getElementById("auth-link");
  if (!a || !window.fetch) return;
  fetch("/api/me", { credentials: "same-origin" }).then(function (r) { return r.json(); }).then(function (d) {
    if (!d.user) {
      if (!/^\/(login|register|forgot|reset)$/.test(location.pathname)) a.href = "/login?next=" + encodeURIComponent(location.pathname + location.hash);
      return;
    }
    var u = d.user, name = u.displayName || u.username, h = 0;
    for (var i = 0; i < u.username.length; i++) h = (h * 31 + u.username.charCodeAt(i)) % 360;
    var av = document.createElement("span");
    av.className = "avatar"; av.setAttribute("aria-hidden", "true"); av.textContent = u.username.slice(0, 1).toUpperCase(); av.style.setProperty("--h", h);
    var svg = a.querySelector("svg"); if (svg) svg.replaceWith(av);
    a.href = "/account"; a.title = "设置"; a.setAttribute("aria-label", "设置（" + name + "）");
    a.querySelector(".auth-name").textContent = name;
  }).catch(function () {});
})();
