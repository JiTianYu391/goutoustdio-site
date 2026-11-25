/* 管理后台：概览 / 用户 / 评论 / 工单 / 群发通知 */
(function () {
  "use strict";
  var el = GS.el, icon = GS.icon;
  var root = document.getElementById("admin-root");
  var tabs = Array.prototype.slice.call(document.querySelectorAll("[role=tab]"));
  var views = {};

  function fail(err) { if (!err.cancelled) GS.toast(err.message); }
  function label(t, k) { return el("span", { class: "label" + (k ? " ui-soft-" + k : ""), text: t }); }
  function show(name) {
    if (!views[name]) name = "overview";
    tabs.forEach(function (t) { t.setAttribute("aria-selected", String(t.dataset.tab === name)); });
    history.replaceState(null, "", "#" + name);
    root.textContent = "";
    views[name]();
  }
  tabs.forEach(function (t) { t.addEventListener("click", function () { show(t.dataset.tab); }); });
  function searchBar(placeholder, onSearch) {
    var input = el("input", { type: "search", placeholder: placeholder, "aria-label": placeholder });
    var timer; input.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(function () { onSearch(input.value); }, 250); });
    return el("div", { class: "toolbar" }, input);
  }

  /* ---------- 概览 ---------- */
  views.overview = function () {
    GS.api("GET", "/api/admin/stats").then(function (s) {
      var stat = function (k, v, sub) { return el("div", { class: "box stat" }, el("div", { class: "k", text: k }), el("div", { class: "v", text: String(v) }), sub ? el("div", { class: "sub", text: sub }) : null); };
      root.append(el("div", { class: "stats" },
        stat("用户", s.users, s.verified + " 已验证邮箱"),
        stat("两步验证", s.twoFactor, "通行密钥 " + s.passkeys + " 个"),
        stat("评论", s.comments, "近 7 天 " + s.commentsWeek),
        stat("待处理工单", s.ticketsOpen, "含处理中"),
        stat("封禁", s.banned)));
      var max = Math.max(1, Math.max.apply(null, s.registrations.map(function (d) { return d.users; })));
      root.append(el("div", { class: "subhead" }, el("h2", { text: "近 14 天注册" })),
        el("div", { class: "box" }, el("div", { class: "chart", role: "img", "aria-label": "近 14 天每日注册人数" },
          s.registrations.map(function (d) {
            var bar = el("i"); bar.style.height = (d.users / max * 100) + "%";
            return el("div", { class: "chart-col", title: d.date + "：" + d.users + " 人" }, el("b", { text: d.users ? String(d.users) : "" }), el("div", { class: "chart-track" }, bar), el("span", { text: d.date.slice(3) }));
          }))));
      var subs = el("div", { class: "box" });
      Object.keys(s.topics).forEach(function (t) {
        subs.append(el("div", { class: "box-row" }, icon(t === "replies" ? "reply" : "bell"), el("div", { class: "grow title", text: s.topics[t] }),
          el("span", { class: "counter", text: String(s.subscribers[t]) })));
      });
      root.append(el("div", { class: "subhead spacious" }, el("h2", { text: "邮件订阅人数" })), subs);
      var oc = document.getElementById("open-count"); oc.textContent = s.ticketsOpen; oc.hidden = !s.ticketsOpen;
    }).catch(fail);
  };

  /* ---------- 用户 ---------- */
  views.users = function () {
    var wrap = el("div", { class: "box table-wrap" });
    root.append(searchBar("搜索用户名、昵称、邮箱或 4 位考号", load), wrap);
    function load(q) {
      GS.api("GET", "/api/admin/users?q=" + encodeURIComponent(q || "")).then(function (d) {
        var tb = el("tbody");
        d.users.forEach(function (u) {
          var flags = el("div", { class: "row" },
            u.examNo ? label("考号 " + u.examNo, "accent") : null,
            u.role === "admin" ? label("管理员", "accent") : null,
            u.banned ? label("已封禁", "danger") : null,
            u.emailVerified ? null : label("未验证", "attention"),
            u.twoFactor ? label("2FA", "success") : null);
          var act = u.role === "admin" ? el("span", { class: "muted small", text: "—" }) : u.banned
            ? el("button", { class: "btn btn-sm", type: "button", text: "解封", onclick: function () {
              GS.api("POST", "/api/admin/users/" + u.id + "/ban", { banned: false }).then(function () { GS.toast("已解封"); load(q); }).catch(fail);
            } })
            : el("button", { class: "btn btn-sm btn-danger", type: "button", onclick: function () {
              GS.dialog({ title: "封禁 " + u.username, icon: "ban", danger: true, confirm: "封禁", text: "封禁后该用户立即退出所有设备、无法登录，评论将被隐藏。",
                fields: [{ name: "reason", label: "原因（会告知用户）", required: false, placeholder: "例如：发布垃圾信息" }] })
                .then(function (r) { if (r) return GS.api("POST", "/api/admin/users/" + u.id + "/ban", { banned: true, reason: r.reason }).then(function () { GS.toast("已封禁"); load(q); }); }).catch(fail);
            } }, icon("ban"), "封禁");
          tb.append(el("tr", null,
            el("td", null, el("div", { class: "user-cell" }, GS.avatar(u.username),
              el("div", null, el("a", { href: "/u/" + encodeURIComponent(u.username), style: "font-weight:600", text: u.displayName || u.username }),
                el("div", { class: "small muted", text: "@" + u.username + " · " + u.email + (u.department ? " · " + u.department : "") })))),
            el("td", null, flags, u.banned && u.banReason ? el("div", { class: "small muted", text: u.banReason }) : null),
            el("td", { text: String(u.comments) }),
            el("td", { class: "small muted", text: u.lastSeen ? GS.ago(u.lastSeen) : "—" }),
            el("td", { class: "small muted", text: GS.date(u.createdAt) }),
            el("td", null, act)));
        });
        wrap.replaceChildren(el("table", { class: "table" },
          el("thead", null, el("tr", null, ["用户", "状态", "评论", "最近活动", "注册", ""].map(function (h) { return el("th", { text: h }); }))), tb));
        if (!d.users.length) wrap.replaceChildren(el("div", { class: "blankslate" }, icon("search"), el("h3", { text: "没有匹配的用户" })));
      }).catch(fail);
    }
    load("");
  };

  /* ---------- 评论 ---------- */
  views.comments = function () {
    var box = el("div");
    root.append(searchBar("搜索评论内容、用户名或页面", load), box);
    function load(q) {
      GS.api("GET", "/api/admin/comments?q=" + encodeURIComponent(q || "")).then(function (d) {
        if (!d.comments.length) { box.replaceChildren(el("div", { class: "box" }, el("div", { class: "blankslate" }, icon("comment"), el("h3", { text: "没有评论" })))); return; }
        var b = el("div", { class: "box" });
        d.comments.forEach(function (c) {
          b.append(el("div", { class: "box-row", style: "align-items:flex-start" }, GS.avatar(c.author.username),
            el("div", { class: "grow" },
              el("div", { class: "meta", style: "margin:0 0 .25rem" },
                el("a", { href: "/u/" + encodeURIComponent(c.author.username), style: "font-weight:600", text: c.author.name }),
                c.author.banned ? " " : null, c.author.banned ? label("已封禁", "danger") : null,
                c.reply ? " 回复于 " : " 评论于 ", el("a", { href: "/" + c.page + ".html#c" + c.id, text: GS.pageTitle(c.page) }), " · ", GS.time(c.createdAt),
                c.likes ? " · ♥ " + c.likes : ""),
              el("div", { style: "white-space:pre-wrap;overflow-wrap:anywhere", text: c.body })),
            el("button", { class: "btn btn-sm btn-danger", type: "button", "aria-label": "删除评论", onclick: function () {
              GS.dialog({ title: "删除评论", danger: true, confirm: "删除", text: "删除后不可恢复，该评论下的回复也会一起删除。" })
                .then(function (ok) { if (ok) return GS.api("DELETE", "/api/comments/" + c.id).then(function () { GS.toast("已删除"); load(q); }); }).catch(fail);
            } }, icon("trash"))));
        });
        box.replaceChildren(b);
      }).catch(fail);
    }
    load("");
  };

  /* ---------- 工单 ---------- */
  views.tickets = function () {
    GS.api("GET", "/api/tickets?all=1").then(function (d) {
      var open = d.tickets.filter(function (t) { return t.status === "open" || t.status === "in_progress"; });
      root.append(el("div", { class: "toolbar" }, el("span", { class: "grow muted", text: "未结工单 " + open.length + " 个，共 " + d.tickets.length + " 个" }),
        el("a", { class: "btn btn-sm", href: "/support?all=1" }, "在工单页中打开")));
      if (!d.tickets.length) { root.append(el("div", { class: "box" }, el("div", { class: "blankslate" }, icon("issue"), el("h3", { text: "还没有工单" })))); return; }
      var b = el("div", { class: "box" });
      d.tickets.forEach(function (t) {
        b.append(el("div", { class: "box-row box-row-link" }, el("span", { class: "status-icon status-" + t.status }),
          el("div", { class: "grow" }, el("a", { class: "title", href: "/support/" + t.id, style: "color:var(--pg-fg-1)", text: t.title }), " ", label(d.categories[t.category]),
            el("div", { class: "meta" }, "#" + t.id + " · " + t.author.name + " · " + d.statuses[t.status] + " · 更新于 ", GS.time(t.updatedAt))),
          t.replies > 0 ? el("span", { class: "muted small row" }, icon("comment"), String(t.replies)) : null));
      });
      root.append(b);
    }).catch(fail);
  };

  /* ---------- 群发通知 ---------- */
  views.broadcast = function () {
    GS.api("GET", "/api/admin/stats").then(function (s) {
      var topic = el("select", { name: "topic", id: "b-topic", required: true },
        ["pyspos", "spaceos", "announce"].map(function (t) { return el("option", { value: t, text: s.topics[t] + "（" + s.subscribers[t] + " 人订阅）" }); }));
      var form = el("form", { class: "form-narrow", style: "max-width:40rem" },
        el("div", { class: "field" }, el("label", { for: "b-topic", text: "发送给" }), topic,
          el("p", { class: "note", text: "只发给订阅了该主题、已验证邮箱且未被封禁的用户。每封邮件附带一键退订链接。" })),
        el("div", { class: "field" }, el("label", { for: "b-subject", text: "邮件标题" }), el("input", { id: "b-subject", name: "subject", required: true, maxlength: "120", placeholder: "PySpOS 2.1 发布" })),
        el("div", { class: "field" }, el("label", { for: "b-body", text: "正文" }),
          el("textarea", { id: "b-body", name: "body", required: true, rows: "8", maxlength: "5000", placeholder: "更新内容……\n\n空一行分段。" })),
        el("div", { class: "field" }, el("label", { for: "b-link", text: "链接（可选）" }), el("input", { id: "b-link", name: "link", type: "url", placeholder: "https://goutoustdio.top/ota/" })),
        el("div", { class: "form-actions" }, el("button", { class: "btn btn-primary", type: "submit" }, icon("megaphone"), "发送")));
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var d = {}; new FormData(form).forEach(function (v, k) { d[k] = v; });
        GS.api("POST", "/api/admin/broadcasts", Object.assign({ dryRun: true }, d)).then(function (r) {
          if (!r.recipients) throw new Error("这个主题还没有订阅者");
          return GS.dialog({ title: "确认群发", confirm: "发送给 " + r.recipients + " 人", text: "「" + d.subject + "」将发送给 " + r.recipients + " 位订阅者，发出后无法撤回。邮件会在后台逐封发送。" })
            .then(function (ok) { if (ok) return GS.api("POST", "/api/admin/broadcasts", d).then(function () { GS.toast("已开始发送"); form.reset(); loadHistory(); }); });
        }).catch(fail);
      });
      var hist = el("div");
      root.append(el("div", { class: "subhead" }, el("h2", { text: "新通知" })), form, el("div", { class: "subhead spacious" }, el("h2", { text: "发送记录" })), hist);
      function loadHistory() {
        GS.api("GET", "/api/admin/broadcasts").then(function (d) {
          if (!d.broadcasts.length) { hist.replaceChildren(el("p", { class: "muted", text: "还没有发送过通知。" })); return; }
          var b = el("div", { class: "box" });
          d.broadcasts.forEach(function (x) {
            var bar = el("i"); bar.style.width = (x.recipients ? x.sent / x.recipients * 100 : 100) + "%";
            b.append(el("div", { class: "box-row" }, icon("mail"),
              el("div", { class: "grow" }, el("div", { class: "title", text: x.subject }), el("div", { class: "meta" }, d.topics[x.topic] + " · ", GS.time(x.createdAt))),
              el("div", { class: "progress", title: x.sent + " / " + x.recipients }, bar), el("span", { class: "small muted", text: x.sent + "/" + x.recipients })));
          });
          hist.replaceChildren(b);
        }).catch(fail);
      }
      loadHistory();
    }).catch(fail);
  };

  GS.me().then(function (u) {
    if (!u) { location.href = "/login?next=/admin"; return; }
    if (u.role !== "admin") {
      document.querySelector(".tabnav").hidden = true;
      root.append(el("div", { class: "box" }, el("div", { class: "blankslate" }, icon("lock"), el("h3", { text: "没有访问权限" }),
        el("p", { text: "管理后台仅对 GoutouStdio 管理员开放。" }), el("a", { class: "btn", href: "/", text: "返回首页" }))));
      return;
    }
    show(location.hash.slice(1));
  });
})();
