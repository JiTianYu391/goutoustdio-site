/* 登录 / 注册 / 找回 / 重置 / 验证 / 账号 页面逻辑 */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var qs = new URLSearchParams(location.search);
  function api(method, url, body) {
    return fetch(url, { method: method, credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || "请求失败"); return d; }); });
  }
  function msg(t, ok) { var m = $("auth-msg"); if (m) { m.textContent = t; m.className = "auth-msg" + (ok ? " ok" : ""); } }
  var form = $("auth-form"), page = location.pathname.replace(/\/|\.html$/g, "");

  if (form) form.addEventListener("submit", function (e) {
    e.preventDefault();
    var data = {}; new FormData(form).forEach(function (v, k) { data[k] = v; });
    if (page === "reset") data.token = qs.get("token");
    msg("请稍候……", true);
    api("POST", "/api/" + form.dataset.action, data).then(function () {
      switch (page) {
        case "login": case "register": location.href = "/account"; break;
        case "forgot": msg("如果该邮箱已注册，重置邮件已发出。", true); break;
        case "reset": location.href = "/login"; break;
        case "account": form.reset(); msg("密码已修改，其他设备已退出。", true); break;
      }
    }).catch(function (err) { msg(err.message); });
  });

  if (page === "verify") {
    api("POST", "/api/verify", { token: qs.get("token") })
      .then(function () { $("verify-status").textContent = "邮箱已验证。"; })
      .catch(function (err) { $("verify-status").textContent = err.message; });
  }

  if (page === "account") {
    api("GET", "/api/me").then(function (d) {
      if (!d.user) { location.href = "/login"; return; }
      var u = d.user, p = $("profile");
      [["用户名", u.username], ["邮箱", u.email + (u.emailVerified ? "（已验证）" : "")], ["角色", u.role === "admin" ? "管理员" : "用户"],
       ["注册时间", new Date(u.createdAt).toLocaleDateString("zh-CN")]].forEach(function (r) {
        var dt = document.createElement("dt"), dd = document.createElement("dd");
        dt.textContent = r[0]; dd.textContent = r[1]; p.append(dt, dd);
      });
      $("verify-banner").hidden = u.emailVerified;
    });
    $("resend").addEventListener("click", function () {
      api("POST", "/api/verify/resend").then(function () { $("resend").textContent = "已发送，请查收"; });
    });
    $("logout").addEventListener("click", function () { api("POST", "/api/logout").then(function () { location.href = "/"; }); });
    $("delete").addEventListener("click", function () {
      var pw = prompt("注销后账号数据将被永久删除。请输入密码确认：");
      if (pw) api("DELETE", "/api/account", { password: pw }).then(function () { location.href = "/"; }).catch(function (e) { alert(e.message); });
    });
  }
})();
