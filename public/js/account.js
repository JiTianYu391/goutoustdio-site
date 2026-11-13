/* 设置页（GitHub Primer 风格）：公开资料 / 账号 / 密码与身份验证 / 登录设备 / 邮件订阅 */
(function () {
  "use strict";
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var el = GS.el, icon = GS.icon;
  var user = null, qs = new URLSearchParams(location.search);
  var flashTop = $("#flash-top");

  function fail(err) { if (!err.cancelled) GS.flash(flashTop, err.message, "error"); window.scrollTo({ top: 0, behavior: "smooth" }); }
  function bindForm(form, fn) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var btn = form.querySelector("[type=submit]"), done = GS.busy(btn);
      var d = {}; new FormData(form).forEach(function (v, k) { d[k] = v; });
      GS.flash(flashTop, "");
      Promise.resolve().then(function () { return fn(d); }).catch(fail).finally(done);
    });
  }
  function label(text, kind) { return el("span", { class: "label" + (kind ? " ui-soft-" + kind : ""), text: text }); }

  /* ---------- 导航 ---------- */
  var loaders = {};
  function show(sec) {
    if (!document.querySelector('[data-panel="' + sec + '"]')) sec = "profile";
    document.querySelectorAll("[data-panel]").forEach(function (p) { p.hidden = p.dataset.panel !== sec; });
    document.querySelectorAll(".navlist [data-sec]").forEach(function (a) {
      if (a.dataset.sec === sec) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    if (loaders[sec]) loaders[sec]();
  }
  addEventListener("hashchange", function () { GS.flash(flashTop, ""); show(location.hash.slice(1)); });

  /* ---------- 渲染当前用户 ---------- */
  function render() {
    var name = user.displayName || user.username;
    $("#head-avatar").replaceChildren(GS.avatar(user.username, "avatar-lg"));
    $("#head-name").textContent = name + (user.displayName ? "（" + user.username + "）" : "");
    $("#view-profile").href = "/u/" + encodeURIComponent(user.username);
    $("#nav-admin").hidden = user.role !== "admin";
    $("#displayName").value = user.displayName; $("#bio").value = user.bio; $("#bio-count").textContent = user.bio.length;
    $("#email-now").textContent = user.email;
    $("#email-label").replaceChildren(user.emailVerified ? label("已验证", "success") : label("未验证", "attention"));
    $("#email-unverified").hidden = user.emailVerified;
    $("#uname").textContent = user.username;
    var url = location.origin + "/u/" + encodeURIComponent(user.username);
    $("#profile-url").textContent = url; $("#profile-url").href = url;
  }

  /* ---------- 公开资料 ---------- */
  $("#bio").addEventListener("input", function () { $("#bio-count").textContent = this.value.length; });
  bindForm($("#f-profile"), function (d) {
    return GS.api("PATCH", "/api/profile", d).then(function (r) { user = r.user; render(); GS.toast("资料已更新"); });
  });

  /* ---------- 账号 ---------- */
  $("#resend").addEventListener("click", function () {
    var b = this, done = GS.busy(b, "发送中…");
    GS.api("POST", "/api/verify/resend").then(function () { done(); b.textContent = "已发送，请查收"; b.disabled = true; }).catch(function (e) { done(); fail(e); });
  });
  bindForm($("#f-email"), function (d) {
    return GS.api("POST", "/api/email", d).then(function (r) {
      user = r.user; render(); $("#f-email").reset();
      GS.flash(flashTop, "邮箱已更换为 " + user.email + "，请到新邮箱查收验证邮件。", "success");
    });
  });
  $("#delete-account").addEventListener("click", function () {
    GS.dialog({
      title: "注销账号", icon: "alert", danger: true, confirm: "我明白后果，永久注销",
      text: "账号、评论、工单和通行密钥都会被永久删除，无法恢复。请输入用户名 " + user.username + " 确认。",
      fields: [{ name: "confirm", label: "用户名", autocomplete: "off" }],
      validate: function (d) {
        if (d.confirm.trim().toLowerCase() !== user.username.toLowerCase()) throw new Error("用户名不一致");
      },
    }).then(function (d) {
      if (d) return GS.api("DELETE", "/api/account", d).then(function () { location.href = "/"; });
    }).catch(fail);
  });

  /* ---------- 密码与身份验证 ---------- */
  bindForm($("#f-password"), function (d) {
    if (d.next !== d.next2) throw new Error("两次输入的新密码不一致");
    return GS.api("POST", "/api/password", d).then(function () {
      $("#f-password").reset(); GS.flash(flashTop, "密码已更新，其他设备已退出登录。", "success");
    });
  });

  var W = window.SimpleWebAuthnBrowser;
  function renderPasskeys(list) {
    var box = $("#passkeys"); box.textContent = "";
    var supported = W && W.browserSupportsWebAuthn();
    var add = el("button", { class: "btn", type: "button", disabled: !supported, onclick: addPasskey }, icon("plus"), "添加通行密钥");
    if (!list.length) {
      box.append(el("div", { class: "box" }, el("div", { class: "blankslate" }, icon("key"),
        el("h3", { text: "还没有通行密钥" }),
        el("p", { text: supported ? "添加后，就可以在这台设备（或同步了密钥的设备）上一键登录。" : "当前浏览器不支持通行密钥。" }), add)));
      return;
    }
    var b = el("div", { class: "box" }, el("div", { class: "box-header" }, el("span", { class: "grow", text: "你的通行密钥" }), add));
    list.forEach(function (p) {
      b.append(el("div", { class: "box-row" }, icon("key"),
        el("div", { class: "grow" }, el("div", { class: "title", text: p.name }),
          el("div", { class: "meta", text: "添加于 " + GS.date(p.createdAt) + " · " + (p.lastUsed ? "最近使用 " + GS.ago(p.lastUsed) : "从未使用") })),
        el("button", { class: "btn btn-sm", type: "button", text: "重命名", onclick: function () {
          GS.dialog({ title: "重命名通行密钥", confirm: "保存", fields: [{ name: "name", label: "名称", value: p.name }] })
            .then(function (d) { if (d) return GS.api("PATCH", "/api/passkeys/" + encodeURIComponent(p.id), d).then(function (r) { renderPasskeys(r.passkeys); }); }).catch(fail);
        } }),
        el("button", { class: "btn btn-sm btn-danger", type: "button", text: "删除", onclick: function () {
          GS.dialog({ title: "删除通行密钥", danger: true, confirm: "删除", text: "删除「" + p.name + "」后，无法再用它登录。设备上保存的密钥需要在系统设置里另行删除。" })
            .then(function (d) { if (d) return GS.api("DELETE", "/api/passkeys/" + encodeURIComponent(p.id)).then(function (r) { renderPasskeys(r.passkeys); GS.toast("已删除"); }); }).catch(fail);
        } })));
    });
    box.append(b);
  }
  function addPasskey() {
    GS.api("POST", "/api/passkeys/options")
      .then(function (opts) { return W.startRegistration({ optionsJSON: opts }); })
      .then(function (resp) {
        return GS.dialog({ title: "给通行密钥起个名字", confirm: "保存", text: "方便以后辨认，比如“我的手机”“工作电脑”。",
          fields: [{ name: "name", label: "名称", placeholder: "我的设备", required: false }] })
          .then(function (d) { return GS.api("POST", "/api/passkeys", { response: resp, name: d ? d.name : "" }); });
      })
      .then(function (r) { renderPasskeys(r.passkeys); GS.toast("通行密钥已添加"); })
      .catch(function (err) {
        if (err.name === "NotAllowedError" || err.name === "AbortError") return GS.toast("已取消");
        if (err.name === "InvalidStateError") return fail(new Error("这台设备上已经有这个账号的通行密钥了"));
        fail(err);
      });
  }

  function recoveryPanel(codes, title) {
    var text = codes.join("\n");
    return el("div", { class: "box", style: "margin-top:1rem" },
      el("div", { class: "box-header" }, icon("key"), el("span", { class: "grow", text: title || "恢复码" })),
      el("div", { class: "box-body", style: "padding-bottom:0" }, el("div", { class: "flash flash-warn" }, icon("alert"),
        el("div", { text: "请把这些恢复码保存在安全的地方（如密码管理器）。手机丢失时，可以用其中任意一个登录，每个只能用一次。关闭此页面后将无法再次查看。" }))),
      el("div", { class: "recovery-grid" }, codes.map(function (c) { return el("span", { text: c }); })),
      el("div", { class: "box-row" },
        el("button", { class: "btn btn-sm", type: "button", onclick: function () {
          var a = el("a", { href: URL.createObjectURL(new Blob(["GoutouStdio 恢复码\n\n" + text + "\n"], { type: "text/plain" })), download: "goutoustdio-recovery-codes.txt" });
          a.click(); URL.revokeObjectURL(a.href);
        } }, icon("download"), "下载"),
        el("button", { class: "btn btn-sm", type: "button", onclick: function () {
          navigator.clipboard.writeText(text).then(function () { GS.toast("已复制"); });
        } }, icon("copy"), "复制"),
        el("span", { class: "grow" }),
        el("button", { class: "btn btn-sm btn-primary", type: "button", text: "我已保存", onclick: loadSecurity })));
  }

  function renderTfa(s) {
    var box = $("#tfa"); box.textContent = "";
    $("#tfa-label").replaceChildren(s.totp ? label("已开启", "success") : label("未开启"));
    if (!s.totp) {
      box.append(el("div", { class: "box" }, el("div", { class: "box-row" }, icon("phone"),
        el("div", { class: "grow" }, el("div", { class: "title", text: "身份验证器应用" }), el("div", { class: "meta", text: "扫码绑定后，登录时输入应用生成的 6 位验证码。" })),
        el("button", { class: "btn btn-primary btn-sm", type: "button", text: "开启两步验证", onclick: startTotp }))));
      return;
    }
    box.append(el("div", { class: "box" },
      el("div", { class: "box-row" }, icon("phone"),
        el("div", { class: "grow" }, el("div", { class: "title" }, "身份验证器应用 ", label("已配置", "success")), el("div", { class: "meta", text: "登录时需要输入验证码。" })),
        el("button", { class: "btn btn-sm btn-danger", type: "button", text: "关闭", onclick: function () {
          GS.dialog({ title: "关闭两步验证", danger: true, confirm: "关闭两步验证", text: "关闭后只需密码即可登录，账号安全性会降低。恢复码也会失效。" })
            .then(function (d) { if (d) return GS.api("POST", "/api/2fa/totp/disable").then(function () { GS.toast("已关闭两步验证"); loadSecurity(); }); }).catch(fail);
        } })),
      el("div", { class: "box-row" }, icon("key"),
        el("div", { class: "grow" }, el("div", { class: "title", text: "恢复码" }),
          el("div", { class: "meta", text: "剩余 " + s.recoveryLeft + " 个可用。" + (s.recoveryLeft <= 3 ? "数量不多了，建议重新生成。" : "") })),
        el("button", { class: "btn btn-sm", type: "button", text: "重新生成", onclick: function () {
          GS.dialog({ title: "重新生成恢复码", confirm: "重新生成", text: "旧的恢复码会立即失效。" })
            .then(function (d) {
              if (d) return GS.api("POST", "/api/2fa/recovery").then(function (r) { box.append(recoveryPanel(r.recoveryCodes, "新的恢复码")); });
            }).catch(fail);
        } }))));
  }

  function startTotp() {
    GS.api("POST", "/api/2fa/totp/setup").then(function (r) {
      var box = $("#tfa"); box.textContent = "";
      var code = el("input", { name: "code", class: "code-input", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", placeholder: "XXXXXX", required: true, id: "totp-code" });
      var form = el("form", { class: "form-narrow" },
        el("div", { class: "field" }, el("label", { for: "totp-code", text: "输入应用显示的 6 位验证码" }), code),
        el("div", { class: "form-actions" }, el("button", { class: "btn btn-primary", type: "submit", text: "验证并开启" }),
          el("button", { class: "btn", type: "button", text: "取消", onclick: loadSecurity })));
      box.append(el("div", { class: "box" },
        el("div", { class: "box-header", text: "设置身份验证器应用" }),
        el("div", { class: "box-body setup-grid" },
          el("img", { class: "qr", src: r.qr, alt: "两步验证二维码", width: "168", height: "168" }),
          el("div", { class: "stack" },
            el("div", null, el("div", { class: "title", style: "font-weight:600", text: "1. 扫描二维码" }),
              el("p", { class: "muted small", style: "margin:.25rem 0 0", text: "用身份验证器应用扫描左侧二维码。无法扫码时，可以手动输入下面的密钥：" }),
              el("code", { class: "secret", style: "margin-top:.5rem", text: r.secret.replace(/(.{4})/g, "$1 ").trim() })),
            el("div", null, el("div", { class: "title", style: "font-weight:600;margin-bottom:.5rem", text: "2. 验证" }), form)))));
      code.focus();
      form.addEventListener("submit", function (e) {
        e.preventDefault(); var done = GS.busy(form.querySelector("[type=submit]"));
        GS.api("POST", "/api/2fa/totp/enable", { code: code.value }).then(function (res) {
          box.textContent = "";
          box.append(el("div", { class: "flash flash-success" }, icon("check"), el("div", { text: "两步验证已开启。下次登录时需要输入验证码。" })),
            recoveryPanel(res.recoveryCodes, "保存你的恢复码"));
          $("#tfa-label").replaceChildren(label("已开启", "success"));
        }).catch(function (err) { fail(err); code.select(); }).finally(done);
      });
    }).catch(fail);
  }

  function loadSecurity() {
    GS.api("GET", "/api/2fa").then(function (s) { renderPasskeys(s.passkeys); renderTfa(s); }).catch(fail);
  }
  loaders.security = loadSecurity;

  /* ---------- 登录设备 ---------- */
  function loadSessions() {
    GS.api("GET", "/api/sessions").then(function (d) {
      var box = $("#sessions"); box.textContent = "";
      d.sessions.forEach(function (s) {
        var mobile = /Android|iOS/.test(s.device);
        box.append(el("div", { class: "box-row" + (s.current ? " is-unread" : "") }, icon(mobile ? "phone" : "device"),
          el("div", { class: "grow" },
            el("div", { class: "title" }, s.device, " ", s.current ? label("当前设备", "success") : null),
            el("div", { class: "meta", text: (s.ip || "未知 IP") + " · 最近活动 " + GS.ago(s.lastSeen) + " · 登录于 " + GS.date(s.createdAt) })),
          s.current ? null : el("button", { class: "btn btn-sm btn-danger", type: "button", text: "退出", onclick: function () {
            GS.api("DELETE", "/api/sessions/" + s.handle).then(function () { GS.toast("该设备已退出"); loadSessions(); }).catch(fail);
          } })));
      });
      $("#revoke-others").disabled = d.sessions.length < 2;
    }).catch(fail);
  }
  loaders.sessions = loadSessions;
  $("#revoke-others").addEventListener("click", function () {
    GS.api("POST", "/api/sessions/revoke-others").then(function () { GS.toast("其他设备已全部退出"); loadSessions(); }).catch(fail);
  });

  /* ---------- 邮件订阅 ---------- */
  var DESC = { pyspos: "PySpOS 发布新版本或 OTA 更新包时通知我。", spaceos: "SpaceOS 发布新镜像时通知我。",
    announce: "GoutouStdio 的重要公告，很少发送。", replies: "有人回复我的评论时通知我。" };
  function renderSubs(topics) {
    var box = $("#subs"); box.textContent = "";
    topics.forEach(function (t) {
      var id = "sub-" + t.topic;
      var sw = el("input", { type: "checkbox", class: "switch", id: id, role: "switch", checked: t.on, disabled: !user.emailVerified });
      sw.addEventListener("change", function () {
        sw.disabled = true;
        GS.api("PUT", "/api/subscriptions/" + t.topic, { on: sw.checked })
          .then(function () { GS.toast(sw.checked ? "已订阅「" + t.label + "」" : "已退订「" + t.label + "」"); })
          .catch(function (e) { sw.checked = !sw.checked; fail(e); }).finally(function () { sw.disabled = false; });
      });
      box.append(el("label", { class: "box-row", for: id, style: "cursor:pointer" },
        el("div", { class: "grow" }, el("div", { class: "title", text: t.label }), el("div", { class: "meta", text: DESC[t.topic] || "" })), sw));
    });
    if (!user.emailVerified) box.before(el("div", { class: "flash flash-warn", style: "margin-bottom:1rem" }, icon("alert"), el("div", { text: "验证邮箱后才能订阅邮件通知。" })));
  }
  loaders.notifications = function () {
    if (qs.get("unsubscribed")) GS.flash(flashTop, "已退订该类邮件。你可以随时在这里重新订阅。", "success");
    GS.api("GET", "/api/subscriptions").then(function (d) { renderSubs(d.topics); }).catch(fail);
  };

  /* ---------- 启动 ---------- */
  GS.api("GET", "/api/me").then(function (d) {
    if (!d.user) { location.href = "/login?next=" + encodeURIComponent(location.pathname + location.hash); return; }
    user = d.user; render();
    if (qs.get("welcome")) GS.flash(flashTop, "欢迎加入！验证邮件已发送到 " + user.email + "，验证后即可发表评论和提交工单。", "success");
    show(location.hash.slice(1) || "profile");
  }).catch(fail);
})();
