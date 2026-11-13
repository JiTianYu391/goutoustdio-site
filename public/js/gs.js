/* GoutouStdio 账号系统前端公共工具：window.GS
   - api(): JSON 请求；遇到 {sudo:true} 自动弹出"确认访问"输入密码后重试（参照 GitHub sudo mode）
   - el(): 构造 DOM，所有用户内容一律走 textContent
   - avatar() / icon() / ago() / toast() / dialog() */
(function () {
  "use strict";

  /* 补充图标（Octicons 风格的简单线条），与站点 sprite 并存 */
  var ICONS = {
    person: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20c.8-4 3.8-6 7.5-6s6.7 2 7.5 6"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2.5 2.5M14 9l2 2"/>',
    lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
    device: '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16.5V20"/>',
    phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
    bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 21h4"/>',
    comment: '<path d="M4 5.5h16v10H9.5L5 19.5v-4H4z"/>',
    reply: '<path d="M10 7L5 12l5 5"/><path d="M5 12h9a5 5 0 0 1 5 5v1"/>',
    heart: '<path d="M12 20s-7.5-4.6-7.5-10A4.5 4.5 0 0 1 12 7.2 4.5 4.5 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z"/>',
    trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
    issue: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="1.5"/>',
    people: '<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 19.5c.6-3.3 3.2-5 6.5-5s5.9 1.7 6.5 5"/><circle cx="17" cy="9.5" r="2.5"/><path d="M17.5 14.5c2.2.3 3.6 1.9 4 4"/>',
    megaphone: '<path d="M4 10v4h3l7 4V6L7 10z"/><path d="M17.5 9a4 4 0 0 1 0 6"/>',
    graph: '<path d="M4 20V4M4 20h16"/><path d="M8 16v-4M12 16V8M16 16v-6"/>',
    pencil: '<path d="M15.5 4.5l4 4L9 19H5v-4z"/><path d="M13 7l4 4"/>',
    calendar: '<rect x="4" y="5.5" width="16" height="15" rx="2"/><path d="M4 10h16M8.5 3v4M15.5 3v4"/>',
    signout: '<path d="M14 4.5h4.5v15H14"/><path d="M10 8l-4 4 4 4M6 12h10"/>',
    copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V5.5a1 1 0 0 0-1-1h-9a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
    ban: '<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>',
  };
  function injectSprite() {
    if (document.getElementById("gs-sprite")) return;
    var s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.id = "gs-sprite"; s.setAttribute("aria-hidden", "true"); s.style.display = "none";
    s.innerHTML = Object.keys(ICONS).map(function (k) { return '<symbol id="u-' + k + '" viewBox="0 0 24 24">' + ICONS[k] + "</symbol>"; }).join("");
    document.body.appendChild(s);
  }
  injectSprite();

  function icon(name) {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon"); svg.setAttribute("aria-hidden", "true");
    var use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", (ICONS[name] ? "#u-" : "#i-") + name);
    svg.appendChild(use); return svg;
  }

  /* el("a", {class:"x", href:"/"}, "文本", child) */
  function el(tag, attrs) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2), v);
      else if (k === "dataset") Object.assign(e.dataset, v);
      else if (v === true) e.setAttribute(k, "");
      else e.setAttribute(k, v);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null || c === false) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x != null && x !== false) e.append(x); });
      else e.append(c);
    }
    return e;
  }

  function hue(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; }
  function avatar(name, cls) {
    var a = el("span", { class: "avatar" + (cls ? " " + cls : ""), "aria-hidden": "true", text: (name || "?").slice(0, 1).toUpperCase() });
    a.style.setProperty("--h", hue(name || "?"));
    return a;
  }

  function ago(ts) {
    var s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return "刚刚";
    if (s < 3600) return Math.floor(s / 60) + " 分钟前";
    if (s < 86400) return Math.floor(s / 3600) + " 小时前";
    if (s < 30 * 86400) return Math.floor(s / 86400) + " 天前";
    return date(ts);
  }
  function date(ts) { return new Date(ts).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" }); }
  function time(ts) {
    return el("time", { datetime: new Date(ts).toISOString(), title: new Date(ts).toLocaleString("zh-CN"), text: ago(ts) });
  }

  var toastTimer;
  function toast(msg) {
    var t = document.querySelector(".toast") || document.body.appendChild(el("div", { class: "toast", role: "status" }));
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.remove(); }, 2600);
  }

  function flash(container, msg, kind) {
    container.querySelectorAll(":scope > .flash").forEach(function (f) { f.remove(); });
    if (!msg) return;
    var f = el("div", { class: "flash flash-" + (kind || "error"), role: kind === "success" ? "status" : "alert" },
      icon(kind === "success" ? "check" : kind === "info" ? "info" : "alert"), el("div", { text: msg }));
    container.prepend(f);
    return f;
  }

  /* 通用对话框：fields = [{name,label,type,autocomplete,placeholder}]；返回 Promise<表单数据|null> */
  function dialog(o) {
    return new Promise(function (resolve) {
      var form = el("form", { method: "dialog" });
      var body = el("div", { class: "dialog-body" });
      if (o.text) body.append(el("p", { class: "muted", style: "margin:0 0 1rem", text: o.text }));
      (o.fields || []).forEach(function (f) {
        body.append(el("div", { class: "field" }, el("label", { for: "dlg-" + f.name, text: f.label }),
          f.type === "textarea" ? el("textarea", { id: "dlg-" + f.name, name: f.name, placeholder: f.placeholder || "" })
            : el("input", { id: "dlg-" + f.name, name: f.name, type: f.type || "text", autocomplete: f.autocomplete || "off", placeholder: f.placeholder || "", value: f.value || "", required: f.required !== false })));
      });
      var err = el("div");
      body.prepend(err);
      var ok = el("button", { class: "btn " + (o.danger ? "btn-danger-fill" : "btn-primary"), type: "submit", text: o.confirm || "确定" });
      var cancel = el("button", { class: "btn", type: "button", text: "取消" });
      var d = el("dialog", { class: "ui-dialog ui", "aria-label": o.title },
        el("header", null, o.icon ? icon(o.icon) : null, o.title), form);
      form.append(body, el("footer", null, cancel, ok));
      document.body.appendChild(d);
      var done = false;
      function finish(v) { if (done) return; done = true; d.close(); d.remove(); resolve(v); }
      cancel.addEventListener("click", function () { finish(null); });
      d.addEventListener("cancel", function (e) { e.preventDefault(); finish(null); });
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var data = {}; new FormData(form).forEach(function (v, k) { data[k] = v; });
        if (!o.validate) return finish(data);
        ok.disabled = true;
        Promise.resolve(o.validate(data)).then(function () { finish(data); })
          .catch(function (ex) { ok.disabled = false; flash(err, ex.message); });
      });
      d.showModal();
      var first = d.querySelector("input, textarea"); if (first) first.focus();
    });
  }

  function raw(method, url, body) {
    return fetch(url, { method: method, credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); });
  }
  function confirmAccess() {
    return dialog({
      title: "确认访问", icon: "lock", confirm: "确认",
      text: "这是一项敏感操作。请输入密码确认是你本人，之后 10 分钟内不会再次询问。",
      fields: [{ name: "password", label: "密码", type: "password", autocomplete: "current-password" }],
      validate: function (d) { return raw("POST", "/api/sudo", { password: d.password }).then(function (r) { if (!r.ok) throw new Error(r.data.error || "密码错误"); }); },
    });
  }
  function api(method, url, body) {
    return raw(method, url, body).then(function (r) {
      if (r.ok) return r.data;
      if (r.status === 403 && r.data.sudo) {
        return confirmAccess().then(function (ok) {
          if (!ok) { var e = new Error("已取消"); e.cancelled = true; throw e; }
          return api(method, url, body);
        });
      }
      var err = new Error(r.data.error || "请求失败（" + r.status + "）"); err.status = r.status; err.data = r.data; throw err;
    });
  }

  var meP;
  function me() { return meP || (meP = api("GET", "/api/me").then(function (d) { return d.user; }).catch(function () { return null; })); }

  var PAGES = { pyspos: "PySpOS", spaceos9: "SpaceOS 9", spaceos8: "SpaceOS 8", "spaceos9-download": "SpaceOS 9 镜像下载",
    "spaceos8-download": "SpaceOS 8 镜像下载", requirements: "配置要求", spaceos7: "SpaceOS 7", spaceos6: "SpaceOS 6" };
  function pageTitle(slug) { return PAGES[slug] || slug; }

  /* 按钮 loading：返回恢复函数 */
  function busy(btn, text) { var t = btn.textContent; btn.disabled = true; if (text) btn.textContent = text; return function () { btn.disabled = false; btn.textContent = t; }; }

  window.GS = { api: api, el: el, icon: icon, avatar: avatar, ago: ago, date: date, time: time, toast: toast, flash: flash,
    dialog: dialog, confirmAccess: confirmAccess, me: me, pageTitle: pageTitle, busy: busy };
})();
