/* 页面底部讨论区：时间线样式、一层回复、点赞、订阅版本更新。用户内容只用 textContent 渲染 */
(function () {
  "use strict";
  var box = document.getElementById("comments"); if (!box || !window.GS) return;
  var el = GS.el, icon = GS.icon;
  var page = box.dataset.page, topic = box.dataset.topic, body = document.getElementById("comments-body");
  var viewer = { loggedIn: false };
  var TOPIC_LABEL = { pyspos: "PySpOS", spaceos: "SpaceOS" };

  function fail(err) { if (!err.cancelled) GS.toast(err.message); }
  function needLogin() { location.href = "/login?next=" + encodeURIComponent(location.pathname + "#comments"); }

  function composer(parentId, onDone) {
    var ta = el("textarea", { required: true, maxlength: "2000", placeholder: parentId ? "写下你的回复…" : "参与讨论…（最多 2000 字）", "aria-label": "评论内容" });
    var btn = el("button", { class: "btn btn-primary btn-sm", type: "submit", text: parentId ? "回复" : "发表评论" });
    var cancel = parentId ? el("button", { class: "btn btn-sm", type: "button", text: "取消", onclick: function () { form.remove(); } }) : null;
    var inner = el("div", { class: "box" }, ta, el("div", { class: "composer-foot" },
      el("span", { class: "small muted", text: parentId ? "" : "请友善交流，管理员会删除不当内容" }), el("span", { class: "row" }, cancel, btn)));
    var form = parentId ? el("form", { class: "reply-form" }, inner) : el("form", { class: "composer" }, GS.avatar(viewer.username || "?"), inner);
    form.addEventListener("submit", function (e) {
      e.preventDefault(); var done = GS.busy(btn, "发送中…");
      GS.api("POST", "/api/comments", { page: page, body: ta.value, parentId: parentId || undefined })
        .then(function (r) { onDone(r.id); }).catch(function (err) { fail(err); done(); });
    });
    return form;
  }

  function item(c, isReply, rootId) {
    var like = el("button", { class: "btn btn-sm btn-invisible" + (c.liked ? " is-on" : ""), type: "button", "aria-pressed": String(c.liked), "aria-label": "赞" },
      icon("heart"), el("span", { text: c.likes ? String(c.likes) : "赞" }));
    like.addEventListener("click", function () {
      if (!viewer.loggedIn) return needLogin();
      if (!viewer.canPost) return GS.toast("验证邮箱后才能点赞");
      GS.api("POST", "/api/comments/" + c.id + "/like").then(function (r) {
        like.classList.toggle("is-on", r.liked); like.setAttribute("aria-pressed", String(r.liked));
        like.lastChild.textContent = r.likes ? String(r.likes) : "赞";
      }).catch(fail);
    });
    var boxEl = el("div", { class: "tl-box" });
    var foot = el("div", { class: "tl-foot" }, like);
    if (viewer.canPost) foot.append(el("button", { class: "btn btn-sm btn-invisible", type: "button", onclick: function () {
      var existing = boxEl.parentNode.querySelector(".reply-form");
      if (existing) { existing.querySelector("textarea").focus(); return; }
      var f = composer(rootId, function (id) { load(id); });
      (isReply ? boxEl : boxEl).after(f); f.querySelector("textarea").focus();
    } }, icon("reply"), "回复"));
    if (c.mine || viewer.admin) foot.append(el("button", { class: "btn btn-sm btn-invisible", type: "button", "aria-label": "删除", onclick: function () {
      GS.dialog({ title: "删除评论", danger: true, confirm: "删除", text: isReply ? "确定删除这条回复吗？" : "确定删除这条评论吗？它下面的回复也会一起删除。" })
        .then(function (ok) { if (ok) return GS.api("DELETE", "/api/comments/" + c.id).then(function () { load(); }); }).catch(fail);
    } }, icon("trash")));
    var profile = "/u/" + encodeURIComponent(c.author.username);
    boxEl.append(
      el("div", { class: "tl-head" }, el("a", { class: "author", href: profile, text: c.author.name }),
        c.author.name !== c.author.username ? el("span", { class: "small", text: "@" + c.author.username }) : null,
        " · ", el("a", { href: "#c" + c.id, style: "color:inherit" }, GS.time(c.createdAt)), el("span", { class: "spacer" }),
        c.author.admin ? el("span", { class: "label ui-soft-accent", text: "GoutouStdio 成员" }) : null,
        c.mine ? el("span", { class: "label", text: "我" }) : null),
      el("div", { class: "tl-body", text: c.body }), foot);
    return el("div", { class: "tl-item", id: "c" + c.id }, el("a", { href: profile, "aria-label": c.author.name }, GS.avatar(c.author.username)), boxEl);
  }

  function subscribeButton() {
    if (!topic || !TOPIC_LABEL[topic]) return null;
    var b = el("button", { class: "btn btn-sm", type: "button" }, icon("bell"), el("span", { text: "订阅 " + TOPIC_LABEL[topic] + " 更新" }));
    var on = false;
    function set(v) { on = v; b.classList.toggle("is-on", on); b.lastChild.textContent = on ? "已订阅 " + TOPIC_LABEL[topic] + " 更新" : "订阅 " + TOPIC_LABEL[topic] + " 更新"; }
    if (viewer.loggedIn) GS.api("GET", "/api/subscriptions").then(function (d) { d.topics.forEach(function (t) { if (t.topic === topic) set(t.on); }); }).catch(function () {});
    b.addEventListener("click", function () {
      if (!viewer.loggedIn) return needLogin();
      if (!viewer.canPost) return GS.toast("验证邮箱后才能订阅");
      GS.api("PUT", "/api/subscriptions/" + topic, { on: !on }).then(function () { set(!on); GS.toast(on ? "新版本发布时会邮件通知你" : "已退订"); }).catch(fail);
    });
    return b;
  }

  function load(focusId) {
    GS.api("GET", "/api/comments?page=" + encodeURIComponent(page)).then(function (d) {
      viewer = d.viewer;
      return (viewer.loggedIn ? GS.me() : Promise.resolve(null)).then(function (u) { if (u) viewer.username = u.username; return d; });
    }).then(function (d) {
      var head = box.querySelector(".comments-head");
      head.replaceChildren(el("h2", { id: "comments-title" }, icon("comment"), "讨论 ", el("span", { class: "counter", text: String(d.total) })));
      var sub = subscribeButton(); if (sub) head.append(sub);
      body.textContent = "";
      if (!viewer.loggedIn) {
        body.append(el("div", { class: "flash", style: "margin-bottom:1.5rem" }, icon("info"),
          el("div", null, el("a", { href: "/login?next=" + encodeURIComponent(location.pathname + "#comments"), text: "登录" }), " 或 ",
            el("a", { href: "/register", text: "注册" }), " 后参与讨论、点赞和订阅更新。")));
      } else if (!viewer.canPost) {
        body.append(el("div", { class: "flash flash-warn", style: "margin-bottom:1.5rem" }, icon("alert"),
          el("div", null, "验证邮箱后才能发言。", el("a", { href: "/account#account", text: "去验证" }))));
      }
      var tl = el("div", { class: "timeline" });
      if (!d.comments.length) tl.append(el("div", { class: "box" }, el("div", { class: "blankslate" }, icon("comment"),
        el("h3", { text: "还没有讨论" }), el("p", { text: "来发表第一条评论吧。" }))));
      d.comments.forEach(function (c) {
        var group = el("div", { class: "stack", style: "gap:.75rem" }, item(c, false, c.id));
        if (c.replies.length) group.append(el("div", { class: "tl-replies" }, c.replies.map(function (r) { return item(r, true, c.id); })));
        tl.append(group);
      });
      body.append(tl);
      if (viewer.canPost) body.append(el("div", { style: "margin-top:1.5rem" }, composer(null, function (id) { load(id); })));
      var target = focusId ? "c" + focusId : location.hash.slice(1);
      var t = target && document.getElementById(target);
      if (t && /^c\d+$/.test(target)) { t.classList.add("flash-target"); t.scrollIntoView({ block: "center", behavior: focusId ? "smooth" : "auto" }); setTimeout(function () { t.classList.remove("flash-target"); }, 2500); }
    }).catch(function () { body.textContent = "评论加载失败。"; });
  }
  load();
})();
