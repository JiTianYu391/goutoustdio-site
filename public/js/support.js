/* 问题反馈：/support 列表与新建，/support/:id 详情（参照 GitHub Issues） */
(function () {
  "use strict";
  var el = GS.el, icon = GS.icon;
  var root = document.getElementById("support-root");
  var id = Number(location.pathname.split("/")[2]) || null;
  var qs = new URLSearchParams(location.search);
  var me = null;

  function statusIcon(s) { return el("span", { class: "status-icon status-" + s, "aria-hidden": "true" }); }
  function stateBadge(s, label) {
    var c = { open: "var(--ui-success)", in_progress: "var(--ui-attention)", resolved: "var(--ui-done)", closed: "var(--pg-fg-3)" }[s];
    var b = el("span", { class: "state" }, statusIcon(s), label); b.style.setProperty("--c", c); return b;
  }
  function blank(ic, title, text, action) {
    return el("div", { class: "box" }, el("div", { class: "blankslate" }, icon(ic), el("h3", { text: title }), el("p", { text: text }), action || null));
  }

  function header(sub) {
    return el("header", { class: "page-head" },
      el("div", { class: "grow" }, el("h1", { text: "问题反馈" }), el("p", { class: "muted", text: sub || "报告 Bug、提出建议或询问使用问题，GoutouStdio 成员会在这里回复你。" })),
      me && !id && !qs.has("new") ? el("a", { class: "btn btn-primary", href: "/support?new=1" }, icon("plus"), "新建工单") : null);
  }

  /* ---------- 列表 ---------- */
  function list() {
    var all = me.role === "admin" && qs.get("all") === "1";
    var status = qs.get("status") || "";
    var url = "/api/tickets?" + new URLSearchParams({ all: all ? "1" : "0", status: status });
    GS.api("GET", url).then(function (d) {
      root.textContent = "";
      root.append(header());
      var link = function (s) { var p = new URLSearchParams(qs); if (s) p.set("status", s); else p.delete("status"); return "/support?" + p; };
      var total = Object.values(d.counts).reduce(function (a, b) { return a + b; }, 0);
      var tabs = el("nav", { class: "tabnav", "aria-label": "按状态筛选" },
        el("a", { href: link(""), "aria-current": status ? null : "page" }, "全部 ", el("span", { class: "counter", text: String(total) })),
        Object.keys(d.statuses).map(function (s) {
          return el("a", { href: link(s), "aria-current": status === s ? "page" : null }, statusIcon(s), d.statuses[s] + " ", el("span", { class: "counter", text: String(d.counts[s] || 0) }));
        }));
      if (me.role === "admin") {
        var p = new URLSearchParams(qs); if (all) p.delete("all"); else p.set("all", "1");
        tabs.append(el("span", { class: "grow" }), el("a", { href: "/support?" + p }, icon("people"), all ? "只看我的" : "查看全部用户"));
      }
      root.append(tabs);
      if (!d.tickets.length) {
        root.append(blank("issue", status ? "没有这个状态的工单" : "还没有工单", "遇到问题或有想法？新建一个工单告诉我们。",
          el("a", { class: "btn btn-primary", href: "/support?new=1", text: "新建工单" })));
        return;
      }
      var box = el("div", { class: "box" });
      d.tickets.forEach(function (t) {
        box.append(el("div", { class: "box-row box-row-link", style: "align-items:flex-start" }, statusIcon(t.status),
          el("div", { class: "grow" },
            el("a", { class: "title", href: "/support/" + t.id, style: "color:var(--pg-fg-1)", text: t.title }), " ",
            el("span", { class: "label", text: d.categories[t.category] }),
            el("div", { class: "meta" }, "#" + t.id + " · " + (all ? t.author.name + " · " : "") + d.statuses[t.status] + " · 更新于 ", GS.time(t.updatedAt))),
          t.replies > 0 ? el("span", { class: "muted small row" }, icon("comment"), String(t.replies)) : null));
      });
      root.append(box);
    }).catch(fail);
  }

  /* ---------- 新建 ---------- */
  function create() {
    root.textContent = "";
    root.append(header("描述得越具体，我们越能快速定位问题。"));
    if (!me.emailVerified) {
      root.append(blank("mail", "请先验证邮箱", "验证邮箱后才能提交工单，这样我们回复时你能收到邮件。", el("a", { class: "btn", href: "/account#account", text: "去验证" })));
      return;
    }
    var form = el("form", { class: "form-narrow", style: "max-width:46rem" },
      el("div", { class: "field" }, el("label", { for: "t-cat", text: "分类" }),
        el("select", { id: "t-cat", name: "category", required: true, style: "max-width:14rem" },
          el("option", { value: "", text: "请选择" }), el("option", { value: "bug", text: "Bug" }), el("option", { value: "feature", text: "功能建议" }),
          el("option", { value: "question", text: "使用问题" }), el("option", { value: "other", text: "其他" }))),
      el("div", { class: "field" }, el("label", { for: "t-title", text: "标题" }),
        el("input", { id: "t-title", name: "title", maxlength: "120", required: true, placeholder: "一句话概括问题" })),
      el("div", { class: "field" }, el("label", { for: "t-body", text: "详细描述" }),
        el("textarea", { id: "t-body", name: "body", rows: "10", maxlength: "8000", required: true,
          placeholder: "遇到了什么问题？\n\n复现步骤：\n1.\n2.\n\n期望的结果：\n\n系统 / 版本信息：" }),
        el("p", { class: "note", text: "请不要在这里填写密码等敏感信息。" })),
      el("div", { class: "form-actions" }, el("button", { class: "btn btn-primary", type: "submit", text: "提交工单" }), el("a", { class: "btn", href: "/support", text: "取消" })));
    root.append(form);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var done = GS.busy(form.querySelector("[type=submit]"), "提交中…");
      var d = {}; new FormData(form).forEach(function (v, k) { d[k] = v; });
      GS.api("POST", "/api/tickets", d).then(function (r) { location.href = "/support/" + r.id; })
        .catch(function (err) { GS.flash(form, err.message); done(); });
    });
  }

  /* ---------- 详情 ---------- */
  function detail() {
    GS.api("GET", "/api/tickets/" + id).then(function (d) {
      var t = d.ticket;
      document.title = t.title + " · #" + t.id + " · GoutouStdio";
      root.textContent = "";
      root.append(el("div", { class: "row", style: "margin-bottom:.75rem" }, el("a", { class: "small", href: "/support" + (d.viewer.admin && !d.viewer.owner ? "?all=1" : "") }, "← 全部工单")));
      root.append(el("h1", { class: "ticket-title" }, t.title + " ", el("span", { class: "num", text: "#" + t.id })));
      root.append(el("div", { class: "ticket-meta" }, stateBadge(t.status, d.statuses[t.status]),
        el("span", null, el("b", { style: "color:var(--pg-fg-1)", text: t.author.name }), " 于 ", GS.time(t.createdAt), " 提交 · " + d.messages.length + " 条消息")));

      var tl = el("div", { class: "timeline" });
      d.messages.forEach(function (m) {
        tl.append(el("div", { class: "tl-item" + (m.staff ? " is-staff" : "") },
          el("a", { href: "/u/" + encodeURIComponent(m.author.username), "aria-label": m.author.name }, GS.avatar(m.author.username)),
          el("div", { class: "tl-box" },
            el("div", { class: "tl-head" }, el("a", { class: "author", href: "/u/" + encodeURIComponent(m.author.username), text: m.author.name }),
              " · ", GS.time(m.createdAt), el("span", { class: "spacer" }),
              m.staff ? el("span", { class: "label ui-soft-accent", text: "GoutouStdio 成员" }) : (m.author.username === t.author.username ? el("span", { class: "label", text: "提交者" }) : null)),
            el("div", { class: "tl-body", text: m.body }))));
      });

      var main = el("div", null, tl);
      var closed = t.status === "closed";
      if (!closed || d.viewer.admin) {
        var ta = el("textarea", { name: "body", required: true, maxlength: "8000", placeholder: d.viewer.admin && !d.viewer.owner ? "回复用户…" : "补充信息或回复…", "aria-label": "回复内容" });
        var form = el("form", { class: "composer", style: "margin-top:1.5rem" }, GS.avatar(me.username),
          el("div", { class: "box" }, ta, el("div", { class: "composer-foot" },
            el("span", { class: "small muted", text: d.viewer.admin && !d.viewer.owner ? "用户会收到邮件提醒" : "GoutouStdio 成员会收到提醒" }),
            el("button", { class: "btn btn-primary btn-sm", type: "submit", text: "回复" }))));
        form.addEventListener("submit", function (e) {
          e.preventDefault(); var done = GS.busy(form.querySelector("[type=submit]"));
          GS.api("POST", "/api/tickets/" + id + "/messages", { body: ta.value }).then(detail).catch(function (err) { GS.toast(err.message); done(); });
        });
        main.append(form);
      } else {
        main.append(el("div", { class: "flash", style: "margin-top:1.5rem" }, icon("info"), el("div", null, "这个工单已关闭。如问题仍然存在，请", el("a", { href: "/support?new=1", text: "新建工单" }), "。")));
      }

      var side = el("aside", { class: "ticket-side" },
        el("div", null, el("h3", { text: "分类" }), el("span", { class: "label", text: d.categories[t.category] })),
        el("div", null, el("h3", { text: "状态" }), el("span", { class: "row" }, statusIcon(t.status), d.statuses[t.status])));
      if (d.viewer.admin) {
        var sel = el("select", { "aria-label": "修改状态" }, Object.keys(d.statuses).map(function (s) { return el("option", { value: s, text: d.statuses[s], selected: s === t.status }); }));
        sel.addEventListener("change", function () {
          GS.api("PATCH", "/api/tickets/" + id, { status: sel.value }).then(function () { GS.toast("状态已更新"); detail(); }).catch(fail);
        });
        side.append(el("div", null, el("h3", { text: "管理员操作" }), sel));
      } else if (!closed) {
        side.append(el("div", null, el("button", { class: "btn btn-sm btn-block", type: "button", onclick: function () {
          GS.dialog({ title: "关闭工单", confirm: "关闭", text: "关闭后不能再回复。问题已解决或不再需要帮助时可以关闭。" })
            .then(function (ok) { if (ok) return GS.api("PATCH", "/api/tickets/" + id, { status: "closed" }).then(detail); }).catch(fail);
        } }, icon("close"), "关闭工单")));
      }
      root.append(el("div", { class: "ticket-layout" }, main, side));
    }).catch(fail);
  }

  function fail(err) { root.replaceChildren(header(), blank("alert", err.status === 404 ? "工单不存在" : "出错了", err.message, el("a", { class: "btn", href: "/support", text: "返回列表" }))); }

  GS.me().then(function (u) {
    me = u;
    if (!me) {
      root.append(header(), blank("issue", "登录后提交反馈", "工单需要关联账号，这样我们回复时能通知到你。",
        el("a", { class: "btn btn-primary", href: "/login?next=" + encodeURIComponent(location.pathname + location.search), text: "登录" })));
      return;
    }
    if (id) detail(); else if (qs.has("new")) create(); else list();
  });
})();
