/* 公开个人主页 /u/:username */
(function () {
  "use strict";
  var el = GS.el, icon = GS.icon;
  var name = decodeURIComponent(location.pathname.split("/")[2] || "");
  var card = document.getElementById("card"), act = document.getElementById("activity");

  GS.api("GET", "/api/users/" + encodeURIComponent(name)).then(function (d) {
    var u = d.user, shown = u.displayName || u.username;
    document.title = shown + "（" + u.username + "）· GoutouStdio";
    card.append.apply(card, [
      GS.avatar(u.username, "avatar-xl"),
      el("div", { class: "profile-name" }, el("h1", { text: shown }), el("div", { class: "handle", text: u.username })),
      d.me ? el("a", { class: "btn btn-block", href: "/account#profile", style: "margin-top:1rem" }, icon("pencil"), "编辑资料") : null,
      u.bio ? el("p", { class: "bio", text: u.bio }) : null,
      el("div", { class: "stat-row" },
        el("span", null, icon("comment"), " ", el("b", { text: String(d.stats.comments) }), " 条评论"),
        el("span", null, icon("heart"), " ", el("b", { text: String(d.stats.likes) }), " 次被赞")),
      el("ul", { class: "profile-facts" },
        u.admin ? el("li", null, icon("shield"), el("span", { class: "label ui-soft-accent", text: "GoutouStdio 成员" })) : null,
        el("li", null, icon("calendar"), "加入于 " + GS.date(u.createdAt)))].filter(Boolean));
    document.getElementById("c-count").textContent = d.stats.comments;
    if (!d.recent.length) {
      act.append(el("div", { class: "box" }, el("div", { class: "blankslate" }, icon("comment"),
        el("h3", { text: d.me ? "你还没有发表过评论" : shown + " 还没有发表过评论" }),
        el("p", { text: "评论会显示在这里。" }), d.me ? el("a", { class: "btn", href: "/pyspos.html#comments", text: "去 PySpOS 页面看看" }) : null)));
      return;
    }
    var box = el("div", { class: "box" });
    d.recent.forEach(function (c) {
      box.append(el("a", { class: "box-row box-row-link", href: "/" + c.page + ".html#c" + c.id, style: "color:inherit;text-decoration:none;align-items:flex-start" },
        icon("comment"),
        el("div", { class: "grow" },
          el("div", { class: "meta", style: "margin:0 0 .25rem" }, "在 ", el("b", { style: "color:var(--pg-fg-1)", text: GS.pageTitle(c.page) }), " 发表评论 · ", GS.time(c.createdAt)),
          el("div", { style: "white-space:pre-wrap;overflow-wrap:anywhere", text: c.excerpt + (c.excerpt.length >= 160 ? "…" : "") }))));
    });
    act.append(box);
  }).catch(function (err) {
    document.getElementById("profile-root").replaceChildren(el("div", { class: "box" }, el("div", { class: "blankslate" }, icon("person"),
      el("h3", { text: err.status === 404 ? "找不到这个用户" : "加载失败" }), el("p", { text: err.message }), el("a", { class: "btn", href: "/", text: "返回首页" }))));
  });
})();
