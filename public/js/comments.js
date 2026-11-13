/* 页面底部讨论区。所有用户内容只用 textContent 渲染。 */
(function () {
  var box = document.getElementById("comments"); if (!box) return;
  var page = box.dataset.page, body = document.getElementById("comments-body");
  function api(method, url, data) {
    return fetch(url, { method: method, credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: data ? JSON.stringify(data) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || "请求失败"); return d; }); });
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; }
  function ago(ts) {
    var s = Math.max(0, (Date.now() - ts) / 1000);
    return s < 60 ? "刚刚" : s < 3600 ? Math.floor(s / 60) + " 分钟前" : s < 86400 ? Math.floor(s / 3600) + " 小时前" : s < 2592000 ? Math.floor(s / 86400) + " 天前" : new Date(ts).toLocaleDateString("zh-CN");
  }
  function load() {
    api("GET", "/api/comments?page=" + encodeURIComponent(page)).then(function (d) {
      body.textContent = "";
      if (!d.loggedIn) {
        var p = el("p", "cm-hint"); p.append("登录后可以发表评论：");
        var a = el("a", "", "登录"); a.href = "/login"; var b = el("a", "", "注册"); b.href = "/register"; p.append(a, " / ", b); body.append(p);
      } else if (!d.canPost) {
        var q = el("p", "cm-hint"); q.append("验证邮箱后才能发言，请到 "); var a2 = el("a", "", "账号页"); a2.href = "/account"; q.append(a2, " 查看。"); body.append(q);
      } else {
        var f = el("form", "cm-form"), t = el("textarea"), m = el("p", "auth-msg"), s = el("button", "button", "发表评论");
        t.maxLength = 1000; t.rows = 3; t.required = true; t.placeholder = "写点什么……（最多 1000 字）"; s.type = "submit";
        f.append(t, m, s);
        f.addEventListener("submit", function (e) {
          e.preventDefault(); s.disabled = true;
          api("POST", "/api/comments", { page: page, body: t.value }).then(load).catch(function (err) { m.textContent = err.message; s.disabled = false; });
        });
        body.append(f);
      }
      var ul = el("ul", "cm-list");
      if (!d.comments.length) ul.append(el("li", "cm-empty", "还没有评论。"));
      d.comments.forEach(function (c) {
        var li = el("li"), h = el("div", "cm-head"), n = el("strong", "", c.author);
        li.append(el("span", "cm-avatar", c.author.slice(0, 1).toUpperCase()));
        h.append(n); if (c.admin) h.append(el("span", "cm-badge", "管理员"));
        var tm = el("time", "", ago(c.createdAt)); tm.dateTime = new Date(c.createdAt).toISOString(); tm.title = new Date(c.createdAt).toLocaleString("zh-CN");
        h.append(tm);
        if (c.mine || d.isAdmin) {
          var x = el("button", "linklike danger", "删除");
          x.addEventListener("click", function () { if (confirm("删除这条评论？")) api("DELETE", "/api/comments/" + c.id).then(load); });
          h.append(x);
        }
        li.append(h); li.append(el("p", "cm-body", c.body)); ul.append(li);
      });
      body.append(ul);
    }).catch(function () { body.textContent = "评论加载失败。"; });
  }
  load();
})();
