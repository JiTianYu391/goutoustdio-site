/* 登录 / 注册 / 找回 / 重置 / 验证 */
(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };
  var shell = $(".auth-shell"), page = shell.dataset.page, flashBox = $("#flash");
  var qs = new URLSearchParams(location.search);
  var next = (function () { var n = qs.get("next") || ""; return /^\/(?!\/)/.test(n) ? n : "/account"; })(); // 只允许站内跳转

  function fail(msg) {
    GS.flash(flashBox, msg, "error");
    shell.classList.remove("shake"); void shell.offsetWidth; shell.classList.add("shake");
  }
  function ok(msg) { GS.flash(flashBox, msg, "success"); }
  function data(form) { var d = {}; new FormData(form).forEach(function (v, k) { d[k] = v; }); return d; }
  function submit(form, fn) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!form.checkValidity()) { var bad = form.querySelector(":invalid"); bad.focus(); fail(bad.validationMessage); return; }
      var btn = form.querySelector("[type=submit]"), done = GS.busy(btn, "请稍候…");
      GS.flash(flashBox, "");
      Promise.resolve(fn(data(form))).catch(function (err) { if (!err.cancelled) fail(err.message); }).finally(done);
    });
  }

  if (page === "login") {
    if (qs.get("reset") === "1") ok("密码已更新，请用新密码登录。");
    var title = $("#title");
    submit($("#f-login"), function (d) {
      return GS.api("POST", "/api/login", d).then(function (r) {
        if (r.mfa) {
          $("#step-password").hidden = true; $("#callout").hidden = true; $("#step-2fa").hidden = false;
          title.textContent = "两步验证"; $("#code").focus();
          return;
        }
        location.href = next;
      });
    });
    var recovery = false;
    $("#use-recovery").addEventListener("click", function () {
      recovery = !recovery;
      var c = $("#code");
      c.value = ""; c.maxLength = recovery ? 11 : 6; c.inputMode = recovery ? "text" : "numeric";
      c.placeholder = recovery ? "xxxxx-xxxxx" : "XXXXXX"; c.autocomplete = recovery ? "off" : "one-time-code";
      $("#code-label").textContent = recovery ? "恢复码" : "验证码";
      $("#code-note").textContent = recovery ? "输入开启两步验证时保存的任意一个恢复码，每个只能用一次。" : "打开身份验证器应用，输入其中显示的 6 位验证码。";
      this.textContent = recovery ? "改用身份验证器应用" : "无法使用手机？改用恢复码";
      c.focus();
    });
    $("#code").addEventListener("input", function () { if (!recovery && /^\d{6}$/.test(this.value)) $("#f-2fa").requestSubmit(); });
    submit($("#f-2fa"), function (d) {
      return GS.api("POST", "/api/login/2fa", d).then(function () { location.href = next; }).catch(function (err) {
        if (err.data && err.data.restart) setTimeout(function () { location.reload(); }, 1500);
        $("#code").select(); throw err;
      });
    });

    // 通行密钥
    var W = window.SimpleWebAuthnBrowser, pk = $("#passkey-login");
    if (!W || !W.browserSupportsWebAuthn()) { pk.hidden = true; document.querySelector(".auth-divider").hidden = true; }
    else pk.addEventListener("click", function () {
      var done = GS.busy(pk, "等待验证…");
      GS.api("POST", "/api/passkey/login/options")
        .then(function (opts) { return W.startAuthentication({ optionsJSON: opts }); })
        .then(function (resp) { return GS.api("POST", "/api/passkey/login", { response: resp }); })
        .then(function () { location.href = next; })
        .catch(function (err) { if (err.name !== "NotAllowedError" && err.name !== "AbortError") fail(err.message); else fail("已取消通行密钥验证"); })
        .finally(done);
    });
  }

  if (page === "register") submit($("#f-register"), function (d) {
    return GS.api("POST", "/api/register", d).then(function () { location.href = "/account?welcome=1#account"; });
  });

  if (page === "forgot") submit($("#f-forgot"), function (d) {
    return GS.api("POST", "/api/forgot", d).then(function () {
      ok("如果这个邮箱已注册，重置邮件马上就到，请检查收件箱（包括垃圾邮件）。"); $("#f-forgot").reset();
    });
  });

  if (page === "reset") {
    if (!qs.get("token")) fail("重置链接不完整，请从邮件中重新打开。");
    submit($("#f-reset"), function (d) {
      if (d.password !== d.password2) throw new Error("两次输入的密码不一致");
      return GS.api("POST", "/api/reset", { token: qs.get("token"), password: d.password }).then(function () { location.href = "/login?reset=1"; });
    });
  }

  if (page === "verify") {
    var s = $("#verify-status");
    GS.api("POST", "/api/verify", { token: qs.get("token") })
      .then(function () { s.textContent = "邮箱已验证，现在可以发表评论和提交工单了。"; })
      .catch(function (err) { s.textContent = err.message + "。可以在账号设置里重新发送验证邮件。"; });
  }
})();
