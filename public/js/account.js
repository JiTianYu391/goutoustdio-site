/* 账号管理页：资料 / 安全 / 登录设备 / 危险操作 */
(function () {
  var $ = function (s, r) { return (r || document).querySelector(s); };
  function api(method, url, body) {
    return fetch(url, { method: method, credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || "请求失败"); return d; }); });
  }
  var user = null;
  function say(form, t, ok) { var m = $(".auth-msg", form); m.textContent = t; m.className = "auth-msg" + (ok ? " ok" : ""); }
  function ago(ts) {
    var s = Math.max(0, (Date.now() - ts) / 1000);
    return s < 90 ? "刚刚" : s < 3600 ? Math.round(s / 60) + " 分钟前" : s < 86400 ? Math.round(s / 3600) + " 小时前" : Math.round(s / 86400) + " 天前";
  }

  /* 标签页：支持 #hash 与键盘左右切换 */
  var tabs = Array.prototype.slice.call(document.querySelectorAll("[role=tab]"));
  function show(name) {
    tabs.forEach(function (t) { t.setAttribute("aria-selected", t.dataset.tab === name); t.tabIndex = t.dataset.tab === name ? 0 : -1; });
    document.querySelectorAll("[data-panel]").forEach(function (p) { p.hidden = p.dataset.panel !== name; });
    if (name === "sessions") loadSessions();
    history.replaceState(null, "", "#" + name);
  }
  tabs.forEach(function (t, i) {
    t.addEventListener("click", function () { show(t.dataset.tab); });
    t.addEventListener("keydown", function (e) {
      var n = e.key === "ArrowRight" || e.key === "ArrowDown" ? i + 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? i - 1 : null;
      if (n === null) return; e.preventDefault();
      var nt = tabs[(n + tabs.length) % tabs.length]; nt.focus(); show(nt.dataset.tab);
    });
  });

  /* 设置行：点按钮在行内展开表单 */
  document.querySelectorAll("[data-toggle]").forEach(function (b) {
    var f = $("#f-" + b.dataset.toggle);
    function set(open) { f.hidden = !open; b.setAttribute("aria-expanded", open); b.textContent = open ? "收起" : (b.dataset.toggle === "email" ? "更换" : "修改"); if (open) f.querySelector("input").focus(); }
    b.addEventListener("click", function () { set(f.hidden); });
    f.querySelector("[data-cancel]").addEventListener("click", function () { f.reset(); set(false); });
  });
  document.querySelectorAll("[data-goto]").forEach(function (b) { b.addEventListener("click", function () { show(b.dataset.goto); }); });

  function render() {
    $("#who").textContent = user.displayName || user.username;
    $("#who-sub").textContent = "@" + user.username + " · " + user.email + (user.emailVerified ? "（已验证）" : "（未验证）") +
      (user.role === "admin" ? " · 管理员" : "") + " · 注册于 " + new Date(user.createdAt).toLocaleDateString("zh-CN");
    $("#avatar").textContent = (user.displayName || user.username).slice(0, 1).toUpperCase();
    $("#verify-banner").hidden = user.emailVerified;
    $("#f-profile [name=displayName]").value = user.displayName;
    $("#f-profile [name=bio]").value = user.bio;
    $("#del-name").textContent = user.username;
    $("#em-sub").textContent = user.email + (user.emailVerified ? " · 已验证" : " · 未验证");
    $("#em-sub").className = user.emailVerified ? "ok" : "warn";
  }

  function loadSessions() {
    api("GET", "/api/sessions").then(function (d) {
      var ul = $("#sessions"); ul.textContent = "";
      d.sessions.forEach(function (s) {
        var li = document.createElement("li"), info = document.createElement("div"), b = document.createElement("strong"), sub = document.createElement("div");
        b.textContent = s.device + (s.current ? "（当前设备）" : ""); sub.className = "acct-sub";
        sub.textContent = "IP " + (s.ip || "未知") + " · 最后活跃 " + ago(s.lastSeen) + " · 登录于 " + new Date(s.createdAt).toLocaleDateString("zh-CN");
        info.append(b, sub); li.append(info);
        if (!s.current) {
          var btn = document.createElement("button"); btn.className = "linklike danger"; btn.textContent = "下线";
          btn.addEventListener("click", function () { api("DELETE", "/api/sessions/" + s.handle).then(loadSessions); });
          li.append(btn);
        }
        ul.append(li);
      });
    });
  }

  function bind(id, fn) {
    var f = $(id);
    f.addEventListener("submit", function (e) {
      e.preventDefault(); var data = {}; new FormData(f).forEach(function (v, k) { data[k] = v; });
      say(f, "请稍候……", true);
      fn(data, f).catch(function (err) { say(f, err.message); });
    });
  }
  bind("#f-profile", function (d, f) { return api("PATCH", "/api/profile", d).then(function (r) { user = r.user; render(); say(f, "已保存", true); }); });
  bind("#f-password", function (d, f) { return api("POST", "/api/password", d).then(function () { f.reset(); say(f, "密码已修改，其他设备已退出。", true); }); });
  bind("#f-email", function (d, f) { return api("POST", "/api/email", d).then(function (r) { user = r.user; render(); f.reset(); say(f, "已更换，请查收验证邮件。", true); }); });
  bind("#f-delete", function (d) { return api("DELETE", "/api/account", d).then(function () { location.href = "/"; }); });

  $("#resend").addEventListener("click", function () { api("POST", "/api/verify/resend").then(function () { $("#resend").textContent = "已发送，请查收"; }); });
  $("#logout").addEventListener("click", function () { api("POST", "/api/logout").then(function () { location.href = "/"; }); });
  $("#revoke-others").addEventListener("click", function () { api("POST", "/api/sessions/revoke-others").then(loadSessions); });

  api("GET", "/api/me").then(function (d) {
    if (!d.user) { location.href = "/login"; return; }
    user = d.user; render();
    var h = location.hash.slice(1); show(tabs.some(function (t) { return t.dataset.tab === h; }) ? h : "profile");
  });
})();
