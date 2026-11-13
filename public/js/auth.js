/* 所有页面：把头部的“登录”入口换成当前用户名 */
(function () {
  var a = document.getElementById("auth-link");
  if (!a || !window.fetch) return;
  fetch("/api/me", { credentials: "same-origin" }).then(function (r) { return r.json(); }).then(function (d) {
    if (!d.user) return;
    a.href = "/account"; a.title = "账号";
    a.querySelector(".auth-name").textContent = d.user.username;
  }).catch(function () {});
})();
