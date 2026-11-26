/* GoutouStdio 智考中心 (/exam)：
   - 紧凑 App Shell 侧栏工作台 + 未登录极简登录 / 自动 4 位考号注册卡片
   - 成绩报告（总分/排名/超越率/双层能力雷达图/历次趋势/小题得分细目）
   - 电子试卷查看器（缩放/旋转/红笔批改图层/智学网双栏 AI 阅卷批改明细/删除单页或清空原卷）
   - 错题本（自动归集/复盘笔记/已掌握标记/删除错题）
   - 考务工作台（考试配置+照片/PDF识卷 / 录分与扫卷+删除成绩&原卷 / 考情分析CSV / 自动考号分配与成员管理） */
(function () {
  "use strict";

  var el = GS.el, icon = GS.icon;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var root = $("#exam-root");
  var idCard = $("#exam-id-card");
  var shell = $("#exam-shell");
  var sidebar = $("#exam-sidebar");
  var adminNav = $("#exam-admin-nav");
  var navBtns = Array.prototype.slice.call(sidebar.querySelectorAll(".exam-nav-item[data-tab]"));
  var mistakeBadge = $("#mistake-count");

  var OFFICIAL_DEPTS = ["管理部", "内核开发部", "自行车动作部", "软件部", "游戏部"];
  var VALID_TABS = ["report", "papers", "mistakes", "admin-exams", "admin-scoring", "admin-analytics", "admin-users"];

  var state = {
    me: null,
    examMe: null,
    exams: [],
    selectedExamId: 0,
    previewUserQuery: null, // { examNo?, userId? }
    activeTab: "report",
    paperFilterExamId: 0,
    paperFilterSubId: 0,
  };

  function fail(err) {
    if (err && !err.cancelled) GS.toast(err.message || "操作失败");
  }
  function label(text, kind) {
    return el("span", { class: "label" + (kind ? " ui-soft-" + kind : ""), text: text });
  }
  function gradeBadge(g) {
    var cls = "grade-badge ";
    if (g === "A+" || g === "A") cls += "grade-a";
    else if (g === "B+" || g === "B") cls += "grade-b";
    else if (g === "C") cls += "grade-c";
    else cls += "grade-d";
    return el("span", { class: cls, text: g || "—" });
  }
  function copyText(txt, okMsg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () {
        GS.toast(okMsg || "已复制到剪贴板");
      }).catch(fallbackCopy);
    } else {
      fallbackCopy();
    }
    function fallbackCopy() {
      var ta = document.createElement("textarea");
      ta.value = txt;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        GS.toast(okMsg || "已复制到剪贴板");
      } catch (_e) {
        GS.toast("请手动复制凭证内容");
      }
      ta.remove();
    }
  }

  function svgEl(tag, attrs, children) {
    var n = document.createElementNS("http://www.w3.org/2000/svg", tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, String(attrs[k])); });
    if (children) children.forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }

  function mapLegacyTab(t) {
    if (t === "admin") return "admin-exams";
    return VALID_TABS.indexOf(t) !== -1 ? t : "report";
  }

  function parseInitialTab() {
    var h = location.hash.replace(/^#/, "").trim();
    if (h) return mapLegacyTab(h);
    var seg = location.pathname.replace(/^\/exam\/?/, "").split("/")[0];
    if (seg) return mapLegacyTab(seg);
    return "report";
  }

  function switchTab(tab, opts) {
    tab = mapLegacyTab(tab);
    if (tab.indexOf("admin-") === 0 && (!state.me || state.me.role !== "admin")) tab = "report";
    state.activeTab = tab;
    if (opts && opts.examId) state.selectedExamId = Number(opts.examId);
    if (opts && opts.paperSubId) state.paperFilterSubId = Number(opts.paperSubId);
    navBtns.forEach(function (b) { b.setAttribute("aria-selected", String(b.dataset.tab === tab)); });
    history.replaceState(null, "", "/exam#" + tab);
    renderActiveTab();
  }
  navBtns.forEach(function (b) {
    b.addEventListener("click", function () { switchTab(b.dataset.tab); });
  });

  /* ---------- 1. 顶部紧凑用户状态条 ---------- */
  function renderIdCard() {
    idCard.textContent = "";
    if (!state.me) {
      idCard.append(el("span", { class: "small muted", text: "未登录 · 支持 4 位考号直登或自动领取考号" }));
      return;
    }
    var u = state.examMe.user;
    var st = state.examMe.stats;
    idCard.append(
      GS.avatar(u.username, "avatar-sm"),
      el("div", { class: "exam-user-meta" },
        el("b", { style: "color:var(--pg-fg-1)", text: u.displayName || u.username }),
        el("span", { class: "exam-no-pill", text: u.examNo ? "考号 " + u.examNo : "未分配考号" }),
        u.department ? el("span", { text: u.department }) : null,
        u.role === "admin" ? label("管理员", "accent") : null,
      ),
      el("span", {
        class: "exam-user-stat",
        text: "参考 " + st.examCount + " 场 · 均率 " + (st.examCount ? st.avgRate + "%" : "—") + " · 待巩固 " + st.mistakePending,
      }),
    );
    if (st.mistakePending > 0) {
      mistakeBadge.textContent = String(st.mistakePending);
      mistakeBadge.hidden = false;
    } else {
      mistakeBadge.hidden = true;
    }
  }

  /* ---------- 1b. 未登录极简居中认证与自动考号领取卡片 ---------- */
  function renderGuestAuth() {
    shell.classList.add("is-guest");
    sidebar.hidden = true;
    root.textContent = "";

    var wrap = el("div", { class: "exam-auth-wrap" });
    var card = el("div", { class: "exam-auth-card" });
    wrap.append(card);
    root.append(wrap);

    GS.api("GET", "/api/exam/public/config").catch(function () {
      return { departments: OFFICIAL_DEPTS, selfRegisterEnabled: true };
    }).then(function (cfg) {
      var depts = (cfg && Array.isArray(cfg.departments) && cfg.departments.length) ? cfg.departments : OFFICIAL_DEPTS;
      var canSelfReg = !cfg || cfg.selfRegisterEnabled !== false;
      var mode = "login"; // login | register

      function draw() {
        card.textContent = "";
        card.append(
          el("div", null,
            el("h2", { style: "margin:0;font-size:1.05rem;font-weight:600", text: "进入智考中心" }),
            el("p", {
              class: "small muted",
              style: "margin:.25rem 0 0",
              text: canSelfReg ? "使用 4 位考号登录，或填写姓名与部门自动领取专属考号" : "请使用成员账号或管理员分配的 4 位考号登录",
            }),
          ),
        );

        if (canSelfReg) {
          card.append(el("div", { class: "exam-seg" },
            el("button", {
              type: "button",
              class: mode === "login" ? "is-active" : "",
              text: "考号 / 账号登录",
              onclick: function () { mode = "login"; draw(); },
            }),
            el("button", {
              type: "button",
              class: mode === "register" ? "is-active" : "",
              text: "自动分配考号注册",
              onclick: function () { mode = "register"; draw(); },
            }),
          ));
        }

        if (mode === "login") {
          var idInp = el("input", { type: "text", placeholder: "输入 4 位考号（如 0413）/ 用户名 / 邮箱", autocomplete: "username", required: true });
          var pwInp = el("input", { type: "password", placeholder: "初始密码默认与 4 位考号相同", autocomplete: "current-password", required: true });
          var subBtn = el("button", { type: "submit", class: "btn btn-primary btn-block", text: "登录智考中心" });
          var form = el("form", { style: "display:grid;gap:.85rem" },
            el("div", { class: "field" }, el("label", { text: "4 位考号 / 用户名 / 邮箱" }), idInp),
            el("div", { class: "field", style: "margin-top:0" }, el("label", { text: "密码" }), pwInp),
            subBtn,
          );
          form.addEventListener("submit", function (e) {
            e.preventDefault();
            var done = GS.busy(subBtn, "登录中…");
            GS.api("POST", "/api/login", { identifier: idInp.value.trim(), password: pwInp.value }).then(function (r) {
              if (r && r.mfa === "totp") {
                location.href = "/login?next=/exam";
              } else {
                location.reload();
              }
            }).catch(function (err) {
              done();
              GS.flash(form, (err && err.message) || "登录失败");
            });
          });
          card.append(
            form,
            el("div", { class: "small muted", style: "text-align:center" },
              el("a", { href: "/login?next=/exam", text: "使用 Passkey / 两步验证完整登录页 →" }),
            ),
          );
          return;
        }

        var nameInp = el("input", { type: "text", maxlength: "32", placeholder: "请输入真实全名（如：马俊宇）", required: true });
        var deptSel = el("select", null,
          depts.map(function (d) { return el("option", { value: d, text: d }); }),
        );
        var regBtn = el("button", { type: "submit", class: "btn btn-primary btn-block", text: "立即分配 4 位考号并注册" });
        var regForm = el("form", { style: "display:grid;gap:.85rem" },
          el("p", {
            class: "small muted",
            style: "margin:0",
            text: "提交后将随机分配一个未占用的 4 位数字考号，并自动注册「用户名 = ID = 密码 = 该 4 位考号」的考生账号。",
          }),
          el("div", { class: "field" }, el("label", { text: "全名" }), nameInp),
          el("div", { class: "field", style: "margin-top:0" }, el("label", { text: "所属部门" }), deptSel),
          regBtn,
        );

        regForm.addEventListener("submit", function (e) {
          e.preventDefault();
          var fullName = nameInp.value.trim();
          if (!fullName) {
            GS.flash(regForm, "请填写全名");
            nameInp.focus();
            return;
          }
          var done = GS.busy(regBtn, "分配考号中…");
          GS.api("POST", "/api/exam/public/auto-register", {
            fullName: fullName,
            department: deptSel.value,
          }).then(function (res) {
            var c = res.credentials;
            var credText = [
              "GoutouStdio 智考中心凭证",
              "姓名：" + c.fullName,
              "部门：" + c.department,
              "4 位考号：" + c.examNo,
              "用户 ID：" + c.id,
              "用户名：" + c.username,
              "初始密码：" + c.password,
            ].join("\n");

            card.textContent = "";
            card.append(
              el("div", null,
                el("h2", { style: "margin:0;font-size:1.05rem;font-weight:600", text: "🎉 已为你分配专属 4 位考号" }),
                el("p", { class: "small muted", style: "margin:.25rem 0 0", text: "账号已自动创建并登录，请妥善保存以下考号凭证。" }),
              ),
              el("div", { class: "exam-cred-box" },
                el("div", { class: "exam-cred-grid" },
                  el("div", null, el("span", { class: "muted", text: "全名" }), el("code", { text: c.fullName })),
                  el("div", null, el("span", { class: "muted", text: "部门" }), el("code", { text: c.department })),
                  el("div", null, el("span", { class: "muted", text: "4 位考号" }), el("code", { text: c.examNo })),
                  el("div", null, el("span", { class: "muted", text: "用户 ID" }), el("code", { text: String(c.id) })),
                  el("div", null, el("span", { class: "muted", text: "登录用户名" }), el("code", { text: c.username })),
                  el("div", null, el("span", { class: "muted", text: "初始密码" }), el("code", { text: c.password })),
                ),
                el("div", { class: "small muted", text: "下次可直接使用考号「" + c.examNo + "」作为用户名与初始密码登录。" }),
              ),
              el("div", { class: "row", style: "justify-content:space-between" },
                el("button", { type: "button", class: "btn", text: "复制考号凭证", onclick: function () { copyText(credText, "考号凭证已复制"); } }),
                el("button", { type: "button", class: "btn btn-primary", text: "进入智考中心 →", onclick: function () { location.reload(); } }),
              ),
            );
          }).catch(function (err) {
            done();
            GS.flash(regForm, (err && err.message) || "自动注册失败");
          });
        });

        card.append(regForm);
      }

      draw();
    });
  }

  /* ---------- 2. Crisp SVG 双层雷达图 & 趋势折线图 ---------- */
  function renderRadarChart(axes, container) {
    container.textContent = "";
    if (!axes || axes.length < 3) {
      if (!axes || !axes.length) {
        container.append(el("p", { class: "muted small", text: "至少配置 3 个科目或 3 类知识点标签即可生成能力雷达图。" }));
        return;
      }
      var list = el("div", { class: "sub-compare-list" });
      axes.forEach(function (a) {
        list.append(el("div", { class: "sub-compare-row" },
          el("div", { class: "sub-compare-head" }, el("b", { text: a.label }),
            el("span", { class: "small muted", text: "个人 " + a.mine + "% · 均分 " + a.avg + "%" })),
          el("div", { class: "sub-bars" },
            el("div", { class: "sub-bar-track" }, el("div", { class: "sub-bar-fill mine", style: "width:" + a.mine + "%" })),
            el("div", { class: "sub-bar-track" }, el("div", { class: "sub-bar-fill avg", style: "width:" + a.avg + "%" })),
          ),
        ));
      });
      container.append(list);
      return;
    }

    var W = 380, H = 290, cx = W / 2, cy = H / 2 + 4, R = 96;
    var n = axes.length;
    var defs = svgEl("defs", null, [
      svgEl("linearGradient", { id: "radarFill", x1: "0", y1: "0", x2: "1", y2: "1" }, [
        svgEl("stop", { offset: "0%", "stop-color": "#7c6cff", "stop-opacity": "0.42" }),
        svgEl("stop", { offset: "100%", "stop-color": "#22d3ee", "stop-opacity": "0.28" }),
      ]),
      svgEl("linearGradient", { id: "radarStroke", x1: "0", y1: "0", x2: "1", y2: "1" }, [
        svgEl("stop", { offset: "0%", "stop-color": "#7c6cff" }),
        svgEl("stop", { offset: "100%", "stop-color": "#22d3ee" }),
      ]),
    ]);
    var svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, class: "chart-svg", role: "img", "aria-label": "能力雷达图" }, [defs]);

    function ptAt(i, pct) {
      var ang = -Math.PI / 2 + (Math.PI * 2 * i) / n;
      var rad = R * (Math.max(0, Math.min(100, pct)) / 100);
      return { x: cx + Math.cos(ang) * rad, y: cy + Math.sin(ang) * rad, ang: ang };
    }

    [20, 40, 60, 80, 100].forEach(function (lv) {
      var pts = axes.map(function (_a, i) { var p = ptAt(i, lv); return p.x.toFixed(1) + "," + p.y.toFixed(1); }).join(" ");
      svg.appendChild(svgEl("polygon", {
        points: pts, fill: "none", stroke: "var(--pg-line-2)", "stroke-width": lv === 100 ? "1.3" : "0.8",
        "stroke-dasharray": lv < 100 ? "3 3" : "",
      }));
    });

    axes.forEach(function (a, i) {
      var edge = ptAt(i, 100);
      svg.appendChild(svgEl("line", { x1: cx, y1: cy, x2: edge.x.toFixed(1), y2: edge.y.toFixed(1), stroke: "var(--pg-line-2)", "stroke-width": "0.9" }));
      var lbl = ptAt(i, 121);
      var anchor = Math.cos(lbl.ang) > 0.2 ? "start" : Math.cos(lbl.ang) < -0.2 ? "end" : "middle";
      var txt = svgEl("text", {
        x: lbl.x.toFixed(1), y: (lbl.y + 4).toFixed(1), "text-anchor": anchor,
        fill: "var(--pg-fg-2)", "font-size": "11.5", "font-weight": "600",
      });
      txt.textContent = a.label.length > 7 ? a.label.slice(0, 7) + "…" : a.label;
      svg.appendChild(txt);
    });

    var avgPts = axes.map(function (a, i) { var p = ptAt(i, a.avg); return p.x.toFixed(1) + "," + p.y.toFixed(1); }).join(" ");
    svg.appendChild(svgEl("polygon", {
      points: avgPts, fill: "color-mix(in srgb, var(--pg-brand-2) 10%, transparent)",
      stroke: "var(--pg-brand-2)", "stroke-width": "1.8", "stroke-dasharray": "5 4",
    }));

    var minePts = axes.map(function (a, i) { var p = ptAt(i, a.mine); return p.x.toFixed(1) + "," + p.y.toFixed(1); }).join(" ");
    svg.appendChild(svgEl("polygon", {
      points: minePts, fill: "url(#radarFill)", stroke: "url(#radarStroke)", "stroke-width": "2.4",
    }));

    var tip = el("div", { class: "chart-tooltip", hidden: true });
    container.append(svg, tip);

    axes.forEach(function (a, i) {
      var p = ptAt(i, a.mine);
      var dot = svgEl("circle", {
        cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: "4.8",
        fill: "var(--pg-brand)", stroke: "#fff", "stroke-width": "1.6", style: "cursor:pointer",
      });
      dot.addEventListener("pointerenter", function () {
        tip.textContent = a.label + "：个人 " + a.mine + "% · 均分 " + a.avg + "%";
        tip.style.left = (p.x / W * 100) + "%";
        tip.style.top = (p.y / H * 100) + "%";
        tip.hidden = false;
      });
      dot.addEventListener("pointerleave", function () { tip.hidden = true; });
      svg.appendChild(dot);
    });
  }

  function renderTrendChart(trends, container) {
    container.textContent = "";
    if (!trends || !trends.length) {
      container.append(el("p", { class: "muted small", text: "暂无历次已发布考试的成绩趋势数据。" }));
      return;
    }
    var W = 400, H = 260, padL = 36, padR = 18, padT = 22, padB = 40;
    var pw = W - padL - padR, ph = H - padT - padB;
    var svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, class: "chart-svg", role: "img", "aria-label": "成绩趋势折线图" });

    [0, 25, 50, 75, 100].forEach(function (v) {
      var y = padT + ph * (1 - v / 100);
      svg.appendChild(svgEl("line", { x1: padL, y1: y, x2: W - padR, y2: y, stroke: "var(--pg-line-2)", "stroke-width": "0.8", "stroke-dasharray": v ? "3 3" : "" }));
      var t = svgEl("text", { x: padL - 6, y: y + 3.5, "text-anchor": "end", fill: "var(--pg-fg-3)", "font-size": "10" });
      t.textContent = v + "%";
      svg.appendChild(t);
    });

    function xAt(i) { return trends.length === 1 ? padL + pw / 2 : padL + (pw * i) / (trends.length - 1); }
    function yAt(rate) { return padT + ph * (1 - Math.max(0, Math.min(100, rate)) / 100); }

    var avgPath = trends.map(function (t, i) {
      var ar = t.fullScore > 0 ? (t.avgScore / t.fullScore) * 100 : 0;
      return (i ? "L" : "M") + xAt(i).toFixed(1) + "," + yAt(ar).toFixed(1);
    }).join(" ");
    svg.appendChild(svgEl("path", { d: avgPath, fill: "none", stroke: "var(--pg-brand-2)", "stroke-width": "1.6", "stroke-dasharray": "5 4" }));

    var minePath = trends.map(function (t, i) {
      return (i ? "L" : "M") + xAt(i).toFixed(1) + "," + yAt(t.rate).toFixed(1);
    }).join(" ");
    svg.appendChild(svgEl("path", { d: minePath, fill: "none", stroke: "var(--pg-brand)", "stroke-width": "2.6", "stroke-linecap": "round", "stroke-linejoin": "round" }));

    var tip = el("div", { class: "chart-tooltip", hidden: true });
    container.append(svg, tip);

    trends.forEach(function (t, i) {
      var x = xAt(i), y = yAt(t.rate);
      var lbl = svgEl("text", { x: x.toFixed(1), y: H - 14, "text-anchor": "middle", fill: "var(--pg-fg-3)", "font-size": "10" });
      lbl.textContent = t.title.length > 6 ? t.title.slice(0, 6) + "…" : t.title;
      svg.appendChild(lbl);

      var c = svgEl("circle", { cx: x.toFixed(1), cy: y.toFixed(1), r: "5", fill: "var(--pg-brand)", stroke: "#fff", "stroke-width": "1.6", style: "cursor:pointer" });
      c.addEventListener("pointerenter", function () {
        tip.textContent = t.title + "：" + t.score + "/" + t.fullScore + " (" + t.rate + "%) · 超越 " + t.beatPct + "%";
        tip.style.left = (x / W * 100) + "%";
        tip.style.top = (y / H * 100) + "%";
        tip.hidden = false;
      });
      c.addEventListener("pointerleave", function () { tip.hidden = true; });
      svg.appendChild(c);
    });
  }

  /* ---------- 3. 成绩报告 ---------- */
  function renderReportTab() {
    root.textContent = "";
    if (!state.exams.length) {
      root.append(el("div", { class: "box" }, el("div", { class: "blankslate" },
        icon("graph"), el("h3", { text: "还没有已发布的考试" }),
        el("p", { text: state.me.role === "admin" ? "请前往左侧「考试管理」创建考试并发布成绩。" : "请等待管理员发布考试成绩。" }),
        state.me.role === "admin" ? el("button", { type: "button", class: "btn btn-primary", text: "前往考试管理", onclick: function () { switchTab("admin-exams"); } }) : null,
      )));
      return;
    }

    if (!state.selectedExamId || !state.exams.some(function (x) { return x.id === state.selectedExamId; })) {
      state.selectedExamId = state.exams[0].id;
    }

    var sel = el("select", { class: "exam-select", "aria-label": "选择考试" },
      state.exams.map(function (ex) {
        return el("option", { value: ex.id, selected: ex.id === state.selectedExamId, text: ex.title + (ex.status === "draft" ? "（草稿）" : "") + (ex.examDate ? " · " + ex.examDate : "") });
      }));
    sel.addEventListener("change", function () {
      state.selectedExamId = Number(sel.value);
      loadAndDraw();
    });

    var barRight = el("div", { class: "exam-bar-right" });
    if (state.me.role === "admin") {
      var noInp = el("input", { type: "text", maxlength: "4", placeholder: "输入4位考号预览（如 0413）", style: "width:13.5rem", value: state.previewUserQuery?.examNo || "" });
      barRight.append(
        noInp,
        el("button", { type: "button", class: "btn btn-sm", text: "切换考生视角", onclick: function () {
          var v = noInp.value.trim();
          state.previewUserQuery = v ? { examNo: v } : null;
          loadAndDraw();
        } }),
      );
      if (state.previewUserQuery) {
        barRight.append(el("button", { type: "button", class: "btn btn-sm", text: "看我自己", onclick: function () {
          state.previewUserQuery = null; noInp.value = ""; loadAndDraw();
        } }));
      }
    }

    var content = el("div", { style: "display:grid;gap:1rem" });
    root.append(el("div", { class: "exam-bar" }, el("div", { class: "exam-bar-left" }, sel), barRight), content);

    function loadAndDraw() {
      content.textContent = "";
      content.append(el("p", { class: "muted", text: "正在生成诊断报告…" }));
      var q = "";
      if (state.previewUserQuery?.examNo) q = "?examNo=" + encodeURIComponent(state.previewUserQuery.examNo);
      else if (state.previewUserQuery?.userId) q = "?userId=" + encodeURIComponent(state.previewUserQuery.userId);

      GS.api("GET", "/api/exam/exams/" + state.selectedExamId + "/report" + q).then(function (rep) {
        content.textContent = "";
        var mine = rep.mine;
        var ov = rep.overview;

        if (state.me.role === "admin" && rep.targetUser.id !== state.me.id) {
          content.append(el("div", { class: "flash flash-info" },
            icon("info"),
            el("div", { text: "当前正在以管理员视角预览考生：" + (rep.targetUser.displayName || rep.targetUser.username) + (rep.targetUser.examNo ? "（考号 " + rep.targetUser.examNo + "）" : "") + " 的报告。" }),
          ));
        }

        var kpiTotal = el("div", { class: "v" },
          el("span", { class: "js-count", text: mine.hasRecord && !mine.absent ? String(mine.totalScore) : (mine.absent ? "缺考" : "—") }),
          mine.hasRecord && !mine.absent ? el("small", { text: " / " + mine.fullScore }) : null,
        );
        var kpiRank = el("div", { class: "v", text: mine.hasRecord && !mine.absent ? (mine.rank ? "第 " + mine.rank + " 名" : "保密") : "—" });
        var kpiDept = el("div", { class: "v", text: mine.hasRecord && !mine.absent && mine.deptRank ? "第 " + mine.deptRank + " / " + mine.deptTotal : (rep.targetUser.department || "未分组") });
        var kpiBench = el("div", { class: "v" }, String(ov.avgTotal), el("small", { text: " / 最高 " + ov.maxTotal }));

        content.append(el("div", { class: "exam-kpi-grid" },
          el("div", { class: "exam-kpi" },
            el("div", { class: "k" }, el("span", { text: "个人总分" }), gradeBadge(mine.grade)),
            kpiTotal,
            el("div", { class: "sub", text: mine.hasRecord && !mine.absent ? "综合得分率 " + mine.rate + "%" : "等待录分" }),
          ),
          el("div", { class: "exam-kpi" },
            el("div", { class: "k" }, el("span", { text: "全员排名 & 超越率" })),
            kpiRank,
            el("div", { class: "sub", text: mine.hasRecord && !mine.absent ? "超越了 " + mine.beatPct + "% 的参考成员（共 " + ov.totalParticipants + " 人）" : "参考总人数 " + ov.totalParticipants + " 人" }),
          ),
          el("div", { class: "exam-kpi" },
            el("div", { class: "k" }, el("span", { text: "部门内位置" })),
            kpiDept,
            el("div", { class: "sub", text: rep.targetUser.department ? "所属部门：" + rep.targetUser.department : "可在成员管理中设置部门" }),
          ),
          el("div", { class: "exam-kpi" },
            el("div", { class: "k" }, el("span", { text: "全员基准（均分 / 最高）" })),
            kpiBench,
            el("div", { class: "sub", text: "及格率 " + ov.passRate + "% · 优秀率 " + ov.excellentRate + "%" }),
          ),
        ));

        var diagTags = el("div", { class: "exam-diag-tags" },
          rep.diagnosis.strong.map(function (d) { return label("优势：" + d.name + " (+" + d.diff + "%)", "success"); }),
          rep.diagnosis.weak.map(function (d) { return label("待提升：" + d.name + " (" + d.diff + "%)", "attention"); }),
        );
        content.append(el("div", { class: "exam-diag-banner" },
          el("p", { text: "诊断建议：" + rep.diagnosis.summary }),
          diagTags,
        ));

        var radarBox = el("div", { class: "chart-svg-wrap" });
        var trendBox = el("div", { class: "chart-svg-wrap" });
        content.append(el("div", { class: "exam-charts-grid" },
          el("div", { class: "exam-card" },
            el("div", { class: "exam-card-head" },
              el("h2", { text: "多维能力雷达图" }),
              el("div", { class: "chart-legend" },
                el("span", null, el("i", { class: "legend-dot mine" }), "个人"),
                el("span", null, el("i", { class: "legend-dot avg" }), "全员均分"),
              ),
            ),
            radarBox,
          ),
          el("div", { class: "exam-card" },
            el("div", { class: "exam-card-head" },
              el("h2", { text: "历次考核趋势" }),
              el("div", { class: "chart-legend" },
                el("span", null, el("i", { class: "legend-dot mine" }), "个人得分率"),
                el("span", null, el("i", { class: "legend-dot avg" }), "全员均分率"),
              ),
            ),
            trendBox,
          ),
        ));
        renderRadarChart(rep.radar, radarBox);
        renderTrendChart(state.examMe.trends, trendBox);

        var cmpList = el("div", { class: "sub-compare-list" });
        rep.subjects.forEach(function (s) {
          var myRate = s.mine && !s.mine.absent ? s.mine.rate : 0;
          var myScoreTxt = s.mine ? (s.mine.absent ? "缺考" : s.mine.score + " / " + s.fullScore + " (" + myRate + "%)") : "未录分";
          cmpList.append(el("div", { class: "sub-compare-row" },
            el("div", { class: "sub-compare-head" },
              el("div", { class: "row" },
                el("b", { text: s.name }),
                s.mine ? gradeBadge(s.mine.grade) : null,
                s.mine && s.mine.rank ? el("span", { class: "small muted", text: "第 " + s.mine.rank + " 名 · 超越 " + s.mine.beatPct + "%" }) : null,
              ),
              el("div", { class: "small muted" },
                "个人 ", el("b", { style: "color:var(--pg-fg-1)", text: myScoreTxt }),
                " · 全员均分 " + s.classStats.avg + " · 最高 " + s.classStats.max,
                s.papers.length ? " · " : null,
                s.papers.length ? el("button", {
                  type: "button", class: "link-btn", text: "查看电子原卷(" + s.papers.length + "页)",
                  onclick: function () { switchTab("papers", { examId: rep.exam.id, paperSubId: s.id }); },
                }) : null,
              ),
            ),
            el("div", { class: "sub-bars" },
              el("div", { class: "sub-bar-track", title: "个人：" + myRate + "%" }, el("div", { class: "sub-bar-fill mine", style: "width:" + myRate + "%" })),
              el("div", { class: "sub-bar-track", title: "全员均分：" + s.classStats.avgRate + "%" }, el("div", { class: "sub-bar-fill avg", style: "width:" + s.classStats.avgRate + "%" })),
            ),
          ));
        });
        content.append(el("div", { class: "exam-card" },
          el("div", { class: "exam-card-head" }, el("h2", { text: "各科得分与群体对照" })),
          cmpList,
        ));

        rep.subjects.forEach(function (s) {
          var card = el("div", { class: "exam-card subject-detail-card" },
            el("div", { class: "exam-card-head" },
              el("h3", { text: s.name + " · 得分细目" }),
              el("span", { class: "small muted", text: "及格线 " + s.passScore + " · 优秀线 " + s.excellentScore + " · 全员及格率 " + s.classStats.passRate + "%" }),
            ),
          );
          if (s.mine && s.mine.items && s.mine.items.length) {
            var tb = el("tbody");
            s.mine.items.forEach(function (it) {
              tb.append(el("tr", null,
                el("td", { style: "font-family:var(--pg-font-mono);font-weight:600", text: "#" + it.no }),
                el("td", { text: it.title || "—" }),
                el("td", null, label(it.tag || "综合能力")),
                el("td", { style: "font-family:var(--pg-font-mono)", text: it.got + " / " + it.full }),
                el("td", { class: it.wrong ? "item-pill-loss" : "item-pill-full", text: it.myRate + "%" }),
                el("td", { class: "muted", text: it.classRate + "%" }),
                el("td", null, it.wrong ? label("失分待巩固", "danger") : label("满分", "success")),
              ));
            });
            card.append(el("div", { class: "table-wrap" }, el("table", { class: "table" },
              el("thead", null, el("tr", null, ["题号", "题目", "知识点", "得分/满分", "个人得分率", "全员均率", "状态"].map(function (h) { return el("th", { text: h }); }))),
              tb,
            )));
          } else {
            card.append(el("p", { class: "muted small", text: s.mine ? "本科目未录入小题细目，仅记录总分。" : "本科目尚未录入成绩。" }));
          }
          if (s.mine && s.mine.teacherComment) {
            card.append(el("div", { class: "teacher-note", text: "教师评语：" + s.mine.teacherComment }));
          }
          content.append(card);
        });

        if (window.gsap && mine.hasRecord && !mine.absent) {
          var targetEl = kpiTotal.querySelector(".js-count");
          var endVal = Number(mine.totalScore);
          if (targetEl && Number.isFinite(endVal)) {
            var obj = { v: 0 };
            window.gsap.to(obj, {
              v: endVal, duration: 0.9, ease: "expo.out",
              onUpdate: function () { targetEl.textContent = String(Math.round(obj.v * 10) / 10); },
              onComplete: function () { targetEl.textContent = String(endVal); },
            });
          }
        }
      }).catch(function (err) {
        content.textContent = "";
        content.append(el("div", { class: "flash flash-error" }, icon("alert"), el("div", { text: err.message })));
      });
    }

    loadAndDraw();
  }

  /* ---------- 4. 电子红笔渲染工具 ---------- */
  function renderAnnotationsToSvg(svg, annotations, interactive, onRemoveIdx) {
    svg.textContent = "";
    (annotations || []).forEach(function (a, idx) {
      var x = a.x * 1000, y = a.y * 1000;
      var col = a.color || "#ef4444";
      var g = svgEl("g", { stroke: col, fill: "none", "stroke-width": "7", "stroke-linecap": "round", "stroke-linejoin": "round", style: interactive ? "cursor:pointer" : "" });
      if (a.type === "check") {
        g.appendChild(svgEl("path", { d: "M" + (x - 16) + " " + y + " L" + (x - 3) + " " + (y + 13) + " L" + (x + 22) + " " + (y - 16) }));
      } else if (a.type === "cross") {
        g.appendChild(svgEl("path", { d: "M" + (x - 13) + " " + (y - 13) + " L" + (x + 13) + " " + (y + 13) + " M" + (x + 13) + " " + (y - 13) + " L" + (x - 13) + " " + (y + 13) }));
      } else if (a.type === "circle") {
        g.appendChild(svgEl("circle", { cx: x, cy: y, r: "22" }));
      } else if (a.type === "line") {
        g.appendChild(svgEl("line", { x1: x, y1: y, x2: (a.x2 || a.x) * 1000, y2: (a.y2 || a.y) * 1000 }));
      } else if (a.type === "text") {
        var t = svgEl("text", {
          x: x, y: y, fill: col,
          stroke: "rgba(255,255,255,0.92)", "stroke-width": "6", "paint-order": "stroke",
          "font-size": "28", "font-weight": "700",
        });
        t.textContent = a.text;
        g.appendChild(t);
      }
      if (interactive && onRemoveIdx) {
        g.addEventListener("click", function (e) { e.stopPropagation(); onRemoveIdx(idx); });
      }
      svg.appendChild(g);
    });
  }

  /* ---------- 5. 答题卡与原卷查看器 ---------- */
  function renderPapersTab() {
    root.textContent = "";
    if (!state.exams.length) {
      root.append(el("div", { class: "box" }, el("div", { class: "blankslate" }, icon("window"), el("h3", { text: "暂无考试记录" }))));
      return;
    }

    var examId = state.paperFilterExamId || state.selectedExamId || state.exams[0].id;
    if (!state.exams.some(function (x) { return x.id === examId; })) examId = state.exams[0].id;
    state.paperFilterExamId = examId;

    var exSel = el("select", { class: "exam-select", "aria-label": "选择考试" },
      state.exams.map(function (ex) { return el("option", { value: ex.id, selected: ex.id === examId, text: ex.title }); }));
    var subSel = el("select", { "aria-label": "选择科目", style: "max-width:12rem" });
    var stageHost = el("div");
    var bar = el("div", { class: "exam-bar" }, el("div", { class: "exam-bar-left" }, exSel, subSel));
    root.append(bar, stageHost);

    var repCache = null;
    var activePageIdx = 0;
    var zoom = 1;
    var rot = 0;
    var showAnn = true;

    function loadExamPapers() {
      var q = "";
      if (state.me.role === "admin" && state.previewUserQuery) {
        if (state.previewUserQuery.examNo) q = "?examNo=" + encodeURIComponent(state.previewUserQuery.examNo);
        else if (state.previewUserQuery.userId) q = "?userId=" + encodeURIComponent(state.previewUserQuery.userId);
      }
      GS.api("GET", "/api/exam/exams/" + state.paperFilterExamId + "/report" + q).then(function (rep) {
        repCache = rep;
        subSel.replaceChildren.apply(subSel, rep.subjects.map(function (s) {
          return el("option", { value: s.id, text: s.name + " (" + s.papers.length + " 页)" });
        }));
        if (state.paperFilterSubId && rep.subjects.some(function (s) { return s.id === state.paperFilterSubId; })) {
          subSel.value = String(state.paperFilterSubId);
        } else {
          var withPaper = rep.subjects.find(function (s) { return s.papers.length > 0; }) || rep.subjects[0];
          if (withPaper) subSel.value = String(withPaper.id);
        }
        activePageIdx = 0;
        drawViewer();
      }).catch(fail);
    }

    function drawViewer() {
      stageHost.textContent = "";
      if (!repCache) return;
      var sid = Number(subSel.value);
      var sub = repCache.subjects.find(function (s) { return s.id === sid; });
      var pages = sub ? sub.papers : [];

      if (!pages.length) {
        stageHost.append(el("div", { class: "box" }, el("div", { class: "blankslate" },
          icon("window"),
          el("h3", { text: "该科目暂未上传电子扫描试卷" }),
          el("p", { text: state.me.role === "admin" ? "可以直接用手机拍照或导入图片，使用内置扫描全能王转换并上传。" : "管理员上传并发布扫描试卷后，可在此高清查看原卷与批改痕迹。" }),
          state.me.role === "admin" && sub ? el("button", {
            type: "button", class: "btn btn-primary", text: "📷 拍卷扫描并提交成绩（管理员）",
            onclick: function () {
              ExamScanner.open({
                isAdmin: true,
                examId: repCache.exam.id,
                subjectId: sub.id,
                subject: sub,
                examStatus: repCache.exam.status,
                student: repCache.targetUser,
                initialScore: sub.mine && !sub.mine.absent ? sub.mine.score : "",
                initialComment: sub.mine ? sub.mine.teacherComment : "",
                nextPageNo: 1,
                onUploaded: function () { loadExamPapers(); },
              });
            },
          }) : null,
        )));
        return;
      }

      if (activePageIdx >= pages.length) activePageIdx = 0;
      var page = pages[activePageIdx];

      var thumbs = el("div", { class: "paper-thumbs" },
        pages.map(function (p, i) {
          return el("button", {
            type: "button",
            class: "paper-thumb" + (i === activePageIdx ? " is-active" : ""),
            onclick: function () { activePageIdx = i; zoom = 1; rot = 0; drawViewer(); },
          }, el("img", { src: p.url, alt: "第 " + p.pageNo + " 页" }), el("span", { text: "第 " + p.pageNo + " 页" }));
        }));

      var img = el("img", { src: page.url, alt: sub.name + " 第 " + page.pageNo + " 页" });
      var svg = svgEl("svg", { class: "paper-ann-svg", viewBox: "0 0 1000 1000", preserveAspectRatio: "none" });
      if (showAnn) renderAnnotationsToSvg(svg, page.annotations, false);
      else svg.style.display = "none";

      var wrap = el("div", { class: "paper-canvas-wrap" }, img, svg);
      function applyTransform() {
        wrap.style.transform = "scale(" + zoom + ") rotate(" + rot + "deg)";
      }
      applyTransform();

      var onlyWrong = false;
      var aiTriggerBtn = state.me.role === "admin" ? el("button", {
        type: "button", class: "btn btn-sm btn-primary",
        text: "🤖 AI 自动批改答题卡",
        onclick: function () {
          var done = GS.busy(aiTriggerBtn, "AI 批改中…");
          ExamScanner.runAiGradeWithConfirm({
            examId: repCache.exam.id,
            subjectId: sub.id,
            userId: repCache.targetUser.id,
            applyAnnotations: true,
            autoSave: true,
          }).then(function (r) {
            if (!r || !r.confirmed) {
              GS.toast("已取消本次成绩入库");
              return;
            }
            if (r.targetUser && r.targetUser.id !== repCache.targetUser.id) {
              state.previewUserQuery = { userId: r.targetUser.id, examNo: r.targetUser.examNo };
            }
            var who = r.targetUser ? (r.targetUser.displayName || r.targetUser.username) : (repCache.targetUser.displayName || repCache.targetUser.username);
            GS.toast("AI 批改已保存至「" + who + "」：" + r.grading.score + " / " + r.grading.fullScore + " 分");
            loadExamPapers();
          }).catch(fail).finally(done);
        },
      }) : null;

      var tools = el("div", { class: "exam-bar", style: "margin-bottom:.2rem" },
        el("div", { class: "exam-bar-left" },
          el("button", { type: "button", class: "btn btn-sm", text: "放大 +", onclick: function () { zoom = Math.min(3, Math.round((zoom + 0.25) * 100) / 100); applyTransform(); } }),
          el("button", { type: "button", class: "btn btn-sm", text: "缩小 -", onclick: function () { zoom = Math.max(0.5, Math.round((zoom - 0.25) * 100) / 100); applyTransform(); } }),
          el("button", { type: "button", class: "btn btn-sm", text: "重置", onclick: function () { zoom = 1; rot = 0; applyTransform(); } }),
          el("button", { type: "button", class: "btn btn-sm", text: "旋转 90°", onclick: function () { rot = (rot + 90) % 360; applyTransform(); } }),
          el("button", {
            type: "button", class: "btn btn-sm " + (showAnn ? "is-on" : ""),
            text: showAnn ? "隐藏批改痕迹" : "显示批改痕迹",
            onclick: function () { showAnn = !showAnn; drawViewer(); },
          }),
          el("a", { class: "btn btn-sm", href: page.url, download: (repCache.targetUser.examNo || "paper") + "-p" + page.pageNo + ".jpg", text: "下载原卷" }),
        ),
        state.me.role === "admin" ? el("div", { class: "exam-bar-right" },
          aiTriggerBtn,
          el("button", {
            type: "button", class: "btn btn-sm", text: "在线红笔批改",
            onclick: function () { openAnnotationDialog(page, drawViewer); },
          }),
          el("button", {
            type: "button", class: "btn btn-sm", text: "📷 继续拍卷",
            onclick: function () {
              ExamScanner.open({
                isAdmin: true,
                examId: repCache.exam.id,
                subjectId: sub.id,
                subject: sub,
                examStatus: repCache.exam.status,
                student: repCache.targetUser,
                initialScore: sub.mine && !sub.mine.absent ? sub.mine.score : "",
                initialComment: sub.mine ? sub.mine.teacherComment : "",
                nextPageNo: pages[pages.length - 1].pageNo + 1,
                onUploaded: function () { loadExamPapers(); },
              });
            },
          }),
          el("button", {
            type: "button", class: "btn btn-sm btn-danger", text: "删除本页",
            onclick: function () {
              GS.dialog({
                title: "删除第 " + page.pageNo + " 页扫描件",
                danger: true,
                confirm: "确认删除",
                text: "删除后不可恢复，确定删除该页答题卡原卷？",
              }).then(function (ok) {
                if (!ok) return;
                return GS.api("DELETE", "/api/exam/admin/papers/" + page.id).then(function () {
                  GS.toast("已删除第 " + page.pageNo + " 页原卷");
                  loadExamPapers();
                });
              }).catch(fail);
            },
          }),
          pages.length > 1 ? el("button", {
            type: "button", class: "btn btn-sm btn-danger", text: "清空本科原卷",
            onclick: function () {
              GS.dialog({
                title: "清空「" + sub.name + "」全部原卷",
                danger: true,
                confirm: "全部删除",
                text: "将永久删除该考生在此科目的全部 " + pages.length + " 页扫描原卷。",
              }).then(function (ok) {
                if (!ok) return;
                return GS.api("DELETE", "/api/exam/admin/papers?examId=" + repCache.exam.id + "&subjectId=" + sub.id + "&userId=" + repCache.targetUser.id).then(function (r) {
                  GS.toast("已清空 " + (r.deleted || pages.length) + " 页原卷");
                  loadExamPapers();
                });
              }).catch(fail);
            },
          }) : null,
        ) : null,
      );

      var items = (sub.mine && Array.isArray(sub.mine.items)) ? sub.mine.items : [];
      var gradeListHost = el("div", { class: "paper-grade-list" });
      var filterAllBtn = el("button", { type: "button", class: "btn btn-sm is-on", text: "全部 (" + items.length + ")" });
      var wrongCount = items.filter(function (x) { return x.wrong; }).length;
      var filterWrongBtn = el("button", { type: "button", class: "btn btn-sm", text: "仅看失分 (" + wrongCount + ")" });

      function drawGradeItems() {
        gradeListHost.textContent = "";
        filterAllBtn.classList.toggle("is-on", !onlyWrong);
        filterWrongBtn.classList.toggle("is-on", onlyWrong);
        var shown = onlyWrong ? items.filter(function (x) { return x.wrong; }) : items;
        if (!shown.length) {
          gradeListHost.append(el("p", { class: "muted small", text: items.length ? "暂无失分题，继续保持！" : "暂未录入小题批改明细（等待教师/AI批改）" }));
          return;
        }
        shown.forEach(function (it) {
          gradeListHost.append(el("div", { class: "paper-grade-item " + (it.wrong ? "is-wrong" : "is-ok") },
            el("div", { class: "paper-grade-head" },
              el("div", { class: "row" },
                el("strong", { text: "#" + it.no }),
                it.section || it.qtype ? label(qtypeLabel(it.qtype, it.section)) : false,
                label(it.tag || "综合"),
              ),
              el("span", {
                class: it.wrong ? "item-pill-loss" : "item-pill-full",
                text: it.wrong ? ("-" + Math.round((it.full - it.got) * 10) / 10 + "（" + it.got + "/" + it.full + "）") : ("✓ " + it.got + "/" + it.full),
              }),
            ),
            it.title ? el("div", { class: "small muted", text: it.title }) : false,
            it.studentAnswer ? el("div", { class: "small", text: "考生作答：" + it.studentAnswer }) : false,
            it.answer ? el("div", { class: "small", style: "color:var(--pg-ok-fg)", text: "参考答案：" + it.answer }) : false,
            it.aiComment ? el("div", { class: "small muted", text: "批改意见：" + it.aiComment }) : false,
          ));
        });
      }
      filterAllBtn.addEventListener("click", function () { onlyWrong = false; drawGradeItems(); });
      filterWrongBtn.addEventListener("click", function () { onlyWrong = true; drawGradeItems(); });
      drawGradeItems();

      var gradeSide = el("aside", { class: "paper-grade-side" },
        el("div", { class: "exam-card-head", style: "margin-bottom:0" },
          el("h3", { text: "小题得分与批改明细" }),
          sub.mine ? label(sub.mine.absent ? "缺考" : (sub.mine.score + " / " + sub.fullScore + " 分 · " + sub.mine.grade), sub.mine.absent ? "danger" : "accent") : label("未出分"),
        ),
        sub.mine && sub.mine.teacherComment ? el("div", { class: "teacher-note", style: "padding:.55rem .75rem;border-radius:var(--ui-r);background:var(--pg-bg-sunken);border-left:3px solid var(--pg-accent);font-size:var(--pg-text-xs)", text: sub.mine.teacherComment }) : false,
        items.length ? el("div", { class: "row" }, filterAllBtn, filterWrongBtn) : false,
        gradeListHost,
      );

      stageHost.append(el("div", { class: "paper-zxw-grid" },
        el("div", { class: "paper-viewer-shell" }, thumbs, tools, el("div", { class: "paper-stage" }, wrap)),
        gradeSide,
      ));
    }

    exSel.addEventListener("change", function () { state.paperFilterExamId = Number(exSel.value); loadExamPapers(); });
    subSel.addEventListener("change", function () { state.paperFilterSubId = Number(subSel.value); activePageIdx = 0; drawViewer(); });
    loadExamPapers();
  }

  function openAnnotationDialog(page, onSaved) {
    var tool = "check";
    var anns = (page.annotations || []).map(function (a) { return Object.assign({}, a); });
    var img = el("img", { src: page.url, alt: "批改试卷", style: "max-width:100%;max-height:60vh;display:block" });
    var svg = svgEl("svg", { class: "paper-ann-svg is-interactive", viewBox: "0 0 1000 1000", preserveAspectRatio: "none" });
    var wrap = el("div", { class: "paper-canvas-wrap" }, img, svg);

    function redraw() {
      renderAnnotationsToSvg(svg, anns, true, function (idx) { anns.splice(idx, 1); redraw(); });
    }
    redraw();

    svg.addEventListener("click", function (e) {
      var r = svg.getBoundingClientRect();
      var x = Math.max(0.02, Math.min(0.98, (e.clientX - r.left) / r.width));
      var y = Math.max(0.02, Math.min(0.98, (e.clientY - r.top) / r.height));
      if (tool === "text") {
        var txt = window.prompt("输入批改文字/扣分标记（如 -3 或 思路清晰）", "-2");
        if (!txt || !txt.trim()) return;
        anns.push({ type: "text", x: x, y: y, text: txt.trim().slice(0, 32), color: "#ef4444" });
      } else {
        anns.push({ type: tool, x: x, y: y, color: "#ef4444" });
      }
      redraw();
    });

    var toolBar = el("div", { class: "scanner-ann-bar", style: "margin-bottom:.75rem" },
      [
        { id: "check", label: "✓ 打勾" },
        { id: "cross", label: "✗ 打叉" },
        { id: "circle", label: "○ 圈画" },
        { id: "text", label: "A 文字批注" },
      ].map(function (t) {
        return el("button", {
          type: "button", class: "btn btn-sm " + (tool === t.id ? "is-on" : ""), text: t.label,
          onclick: function () {
            tool = t.id;
            toolBar.querySelectorAll("button[data-t]").forEach(function (b) { b.classList.toggle("is-on", b.dataset.t === tool); });
          },
          dataset: { t: t.id },
        });
      }),
      el("button", { type: "button", class: "btn btn-sm", text: "撤销上一笔", onclick: function () { anns.pop(); redraw(); } }),
      el("button", { type: "button", class: "btn btn-sm", text: "清空全部", onclick: function () { anns = []; redraw(); } }),
    );

    var dlg = el("dialog", { class: "ui-dialog ui exam-modal", "aria-label": "红笔在线批改" });
    dlg.setAttribute("data-lenis-prevent", "");
    var saveBtn = el("button", { type: "button", class: "btn btn-primary", text: "保存批改" });
    var cancelBtn = el("button", { type: "button", class: "btn", text: "取消" });
    dlg.append(
      el("header", null, icon("pencil"), el("span", { class: "grow", text: "电子红笔批改 · 第 " + page.pageNo + " 页" }),
        el("span", { class: "small muted", text: "点击画布添加，点击已有标记可删除" })),
      el("div", { class: "dialog-body", style: "text-align:center" }, toolBar, el("div", { class: "paper-stage", style: "min-height:16rem" }, wrap)),
      el("footer", null, cancelBtn, saveBtn),
    );
    document.body.appendChild(dlg);
    function close() { dlg.close(); dlg.remove(); }
    cancelBtn.addEventListener("click", close);
    dlg.addEventListener("cancel", function (e) { e.preventDefault(); close(); });
    saveBtn.addEventListener("click", function () {
      var done = GS.busy(saveBtn, "保存中…");
      GS.api("PATCH", "/api/exam/admin/papers/" + page.id, { annotations: anns }).then(function (r) {
        page.annotations = r.page.annotations;
        GS.toast("红笔批改已保存");
        close();
        if (onSaved) onSaved();
      }).catch(function (err) { done(); fail(err); });
    });
    dlg.showModal();
  }

  /* ---------- 6. 自动错题本 ---------- */
  function renderMistakesTab() {
    root.textContent = "";
    var exFilter = el("select", { style: "max-width:16rem", "aria-label": "按考试筛选" },
      el("option", { value: "", text: "全部考试" }),
      state.exams.map(function (e) { return el("option", { value: e.id, text: e.title }); }));
    var statusFilter = el("select", { style: "max-width:10rem", "aria-label": "掌握状态筛选" },
      el("option", { value: "", text: "全部状态" }),
      el("option", { value: "0", text: "待巩固" }),
      el("option", { value: "1", text: "已掌握" }),
    );
    var listHost = el("div", { class: "mistake-grid" });
    root.append(el("div", { class: "exam-bar" }, el("div", { class: "exam-bar-left" }, exFilter, statusFilter)), listHost);

    function load() {
      var qs = [];
      if (exFilter.value) qs.push("examId=" + encodeURIComponent(exFilter.value));
      if (statusFilter.value !== "") qs.push("mastered=" + encodeURIComponent(statusFilter.value));
      GS.api("GET", "/api/exam/mistakes" + (qs.length ? "?" + qs.join("&") : "")).then(function (d) {
        listHost.textContent = "";
        if (!d.mistakes.length) {
          listHost.append(el("div", { class: "box" }, el("div", { class: "blankslate" },
            icon("check"), el("h3", { text: "当前筛选下没有错题" }),
            el("p", { text: "所有在考试中失分的小题都会自动沉淀到这里，方便结合原卷复盘。" }),
          )));
          return;
        }
        d.mistakes.forEach(function (m) {
          var ta = el("textarea", { placeholder: "记录错因、正确思路或下次注意要点…", value: m.reflection });
          ta.value = m.reflection || "";
          var ansBox = el("div", {
            class: "small",
            style: "padding:.55rem .75rem;border-radius:var(--ui-r);background:var(--pg-bg-sunken);border-left:3px solid var(--pg-accent)",
            hidden: true,
            text: "参考解析：" + (m.answer || "管理员暂未填写参考解析"),
          });

          var card = el("article", { class: "mistake-card" + (m.mastered ? " is-mastered" : "") },
            el("div", { class: "mistake-head" },
              el("div", { class: "row" },
                el("strong", { text: m.subjectName + " · 第 " + m.questionNo + " 题" }),
                label(m.tag || "综合能力"),
                label("得分 " + m.gotScore + " / " + m.fullScore, "danger"),
                m.mastered ? label("已掌握", "success") : label("待巩固", "attention"),
              ),
              el("div", { class: "small muted", text: m.examTitle + (m.examDate ? " · " + m.examDate : "") }),
            ),
            m.title ? el("div", { text: m.title }) : null,
            el("div", { class: "row" },
              el("button", { type: "button", class: "btn btn-sm", text: "查看参考解析", onclick: function () { ansBox.hidden = !ansBox.hidden; } }),
              m.papers && m.papers.length ? el("button", {
                type: "button", class: "btn btn-sm", text: "查看对应原卷 (" + m.papers.length + "页)",
                onclick: function () { switchTab("papers", { examId: m.examId, paperSubId: m.subjectId }); },
              }) : null,
              el("button", {
                type: "button", class: "btn btn-sm " + (m.mastered ? "" : "btn-primary"),
                text: m.mastered ? "标回待巩固" : "标记已掌握",
                onclick: function () {
                  GS.api("PATCH", "/api/exam/mistakes/" + m.id, { mastered: !m.mastered }).then(function () {
                    GS.toast(m.mastered ? "已移回待巩固" : "已标记为掌握");
                    refreshIdentityAndLoad();
                  }).catch(fail);
                },
              }),
              el("button", {
                type: "button", class: "btn btn-sm btn-danger", text: "删除错题",
                onclick: function () {
                  GS.dialog({
                    title: "移除错题记录",
                    danger: true,
                    confirm: "删除",
                    text: "确定从错题本中删除这道题的记录吗？",
                  }).then(function (ok) {
                    if (!ok) return;
                    return GS.api("DELETE", "/api/exam/mistakes/" + m.id).then(function () {
                      GS.toast("错题记录已删除");
                      refreshIdentityAndLoad();
                    });
                  }).catch(fail);
                },
              }),
            ),
            ansBox,
            el("div", { class: "mistake-ref" },
              ta,
              el("div", { class: "row", style: "justify-content:flex-end" },
                el("button", { type: "button", class: "btn btn-sm", text: "保存复盘笔记", onclick: function () {
                  GS.api("PATCH", "/api/exam/mistakes/" + m.id, { reflection: ta.value }).then(function () {
                    GS.toast("复盘笔记已保存");
                  }).catch(fail);
                } }),
              ),
            ),
          );
          listHost.append(card);
        });
      }).catch(fail);
    }

    function refreshIdentityAndLoad() {
      GS.api("GET", "/api/exam/me").then(function (em) {
        state.examMe = em;
        renderIdCard();
        load();
      }).catch(fail);
    }

    exFilter.addEventListener("change", load);
    statusFilter.addEventListener("change", load);
    load();
  }

  /* ---------- 7A. 考务：考试管理 ---------- */
  function renderAdminExams(host) {
    host.textContent = "";
    host.append(
      el("div", { class: "exam-bar" },
        el("div", { class: "exam-bar-left" }, el("span", { class: "muted small", text: "共 " + state.exams.length + " 场考试（草稿仅管理员可见，发布后员工可查）" })),
        el("div", { class: "exam-bar-right" },
          el("button", { type: "button", class: "btn btn-primary", onclick: function () { openExamModal(null); } }, icon("plus"), "新建考试"),
        ),
      ),
    );

    if (!state.exams.length) {
      host.append(el("div", { class: "box" }, el("div", { class: "blankslate" }, icon("calendar"),
        el("h3", { text: "还没有创建考试" }),
        el("p", { text: "点击右上角「新建考试」配置科目、满分与小题模板，即可开始录分和扫试卷。" }),
      )));
      return;
    }

    var tb = el("tbody");
    state.exams.forEach(function (ex) {
      tb.append(el("tr", null,
        el("td", null,
          el("div", { style: "font-weight:600", text: ex.title }),
          el("div", { class: "small muted", text: (ex.term || "未填学期") + " · " + (ex.examDate || "—") }),
        ),
        el("td", null, ex.status === "published" ? label("已发布", "success") : label("草稿", "attention"),
          " ", ex.showRank ? label("公开名次") : label("隐藏名次")),
        el("td", { text: ex.subjects.map(function (s) { return s.name + "(" + s.fullScore + ")"; }).join(" / ") }),
        el("td", { style: "font-family:var(--pg-font-mono)", text: ex.totalParticipants + " 人 · 均分 " + ex.avgTotal + " · 试卷 " + ex.paperCount + " 页" }),
        el("td", null, el("div", { class: "row" },
          el("button", { type: "button", class: "btn btn-sm", text: "录分/扫卷", onclick: function () {
            switchTab("admin-scoring", { examId: ex.id });
          } }),
          el("button", { type: "button", class: "btn btn-sm", text: "考情", onclick: function () {
            switchTab("admin-analytics", { examId: ex.id });
          } }),
          el("button", { type: "button", class: "btn btn-sm", text: ex.status === "published" ? "转回草稿" : "发布成绩", onclick: function () {
            var nextStatus = ex.status === "published" ? "draft" : "published";
            GS.api("PATCH", "/api/exam/admin/exams/" + ex.id, { status: nextStatus }).then(function () {
              GS.toast(nextStatus === "published" ? "成绩已发布" : "已撤回为草稿");
              reloadExamsAndStay();
            }).catch(fail);
          } }),
          el("button", { type: "button", class: "btn btn-sm", text: "编辑", onclick: function () { openExamModal(ex); } }),
          el("button", { type: "button", class: "btn btn-sm btn-danger", text: "删除", onclick: function () {
            GS.dialog({ title: "删除考试「" + ex.title + "」", danger: true, confirm: "确认删除", text: "该场考试的科目、全部成绩记录和扫描试卷图片都将永久删除。" })
              .then(function (ok) {
                if (ok) return GS.api("DELETE", "/api/exam/admin/exams/" + ex.id).then(function () {
                  GS.toast("考试已删除"); reloadExamsAndStay();
                });
              }).catch(fail);
          } }),
        )),
      ));
    });
    host.append(el("div", { class: "box table-wrap" }, el("table", { class: "table" },
      el("thead", null, el("tr", null, ["考试", "状态", "科目与满分", "统计", "操作"].map(function (h) { return el("th", { text: h }); }))),
      tb,
    )));
  }

  function reloadExamsAndStay() {
    return Promise.all([GS.api("GET", "/api/exam/me"), GS.api("GET", "/api/exam/list")]).then(function (res) {
      state.examMe = res[0];
      state.exams = res[1].exams;
      renderIdCard();
      renderActiveTab();
    });
  }

  var QTYPE_LABELS = {
    choice: "选择题",
    multi_choice: "多选题",
    judge: "判断题",
    blank: "填空题",
    listening: "听力题",
    essay: "主观题（大题）",
    other: "综合题",
  };

  function qtypeLabel(qtype, section) {
    if (section) return section;
    return QTYPE_LABELS[qtype] || "综合题";
  }

  function buildSubjectsFromParsed(parsed, structMode, splitSub) {
    if (!parsed || !Array.isArray(parsed.questions) || !parsed.questions.length) {
      return [{
        name: (parsed && parsed.subjectName) || "综合试卷",
        fullScore: (parsed && parsed.fullScore) || 100,
        passScore: Math.round(((parsed && parsed.fullScore) || 100) * 0.6 * 10) / 10,
        excellentScore: Math.round(((parsed && parsed.fullScore) || 100) * 0.85 * 10) / 10,
        questions: [],
      }];
    }

    var flatQs = [];
    parsed.questions.forEach(function (q) {
      if (splitSub && Array.isArray(q.subQuestions) && q.subQuestions.length) {
        q.subQuestions.forEach(function (sq) {
          flatQs.push({
            no: sq.no,
            title: sq.title || q.title || "",
            tag: sq.tag || q.tag || q.section || "综合能力",
            full: Number(sq.full) || 1,
            answer: sq.answer || "",
            section: q.section || "",
            qtype: q.qtype || "essay",
          });
        });
      } else {
        flatQs.push({
          no: q.no,
          title: q.title || "",
          tag: q.tag || q.section || "综合能力",
          full: Number(q.full) || 1,
          answer: q.answer || "",
          section: q.section || "",
          qtype: q.qtype || "other",
        });
      }
    });

    if (structMode === "by_section") {
      var groups = [];
      var bySec = {};
      flatQs.forEach(function (q) {
        var key = q.section || qtypeLabel(q.qtype, "");
        if (!bySec[key]) {
          bySec[key] = { name: key.slice(0, 40), questions: [] };
          groups.push(bySec[key]);
        }
        bySec[key].questions.push(q);
      });
      return groups.slice(0, 20).map(function (g) {
        var sum = Math.round(g.questions.reduce(function (s, x) { return s + (Number(x.full) || 0); }, 0) * 10) / 10;
        var fullScore = Math.max(1, sum || 100);
        return {
          name: g.name,
          fullScore: fullScore,
          passScore: Math.round(fullScore * 0.6 * 10) / 10,
          excellentScore: Math.round(fullScore * 0.85 * 10) / 10,
          questions: g.questions.slice(0, 150),
        };
      });
    }

    var total = Math.round(flatQs.reduce(function (s, x) { return s + (Number(x.full) || 0); }, 0) * 10) / 10;
    var finalFull = Math.max(1, Number(parsed.fullScore) || total || 100);
    return [{
      name: (parsed.subjectName || "综合试卷").slice(0, 40),
      fullScore: finalFull,
      passScore: Math.round(finalFull * 0.6 * 10) / 10,
      excellentScore: Math.round(finalFull * 0.85 * 10) / 10,
      questions: flatQs.slice(0, 150),
    }];
  }

  function openExamModal(existing) {
    var subjects = existing
      ? existing.subjects.map(function (s) {
        return {
          id: s.id, name: s.name, fullScore: s.fullScore, passScore: s.passScore, excellentScore: s.excellentScore,
          expanded: (s.questions || []).length <= 45,
          questions: (s.questions || []).map(function (q) { return Object.assign({}, q); }),
        };
      })
      : [{ name: "综合能力测评", fullScore: 100, passScore: 60, excellentScore: 85, expanded: true, questions: [] }];

    var dlg = el("dialog", { class: "ui-dialog ui exam-modal", "aria-label": existing ? "编辑考试" : "新建考试" });
    dlg.setAttribute("data-lenis-prevent", "");

    var titleInp = el("input", { value: existing ? existing.title : "", placeholder: "例如：2026 Q4 内部技术能力考核", required: true });
    var termInp = el("input", { value: existing ? existing.term : "", placeholder: "例如：2026 秋季考核" });
    var dateInp = el("input", { type: "date", value: existing ? existing.examDate : new Date().toISOString().slice(0, 10) });
    var descInp = el("textarea", { rows: "2", placeholder: "考试说明（可选）" });
    descInp.value = existing ? (existing.description || "") : "";
    var statusSel = el("select", null,
      el("option", { value: "draft", selected: !existing || existing.status === "draft", text: "草稿（仅管理员可见）" }),
      el("option", { value: "published", selected: existing && existing.status === "published", text: "立即发布（员工可见）" }),
    );
    var rankChk = el("input", { type: "checkbox", checked: !existing || existing.showRank });
    var subHost = el("div");

    var parseState = {
      parsed: null,
      structMode: "single",
      splitSub: false,
      busy: false,
      aiConfig: null,
    };
    var docInput = el("input", {
      type: "file",
      accept: ".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown",
      hidden: true,
    });
    var photoAlbumInput = el("input", {
      type: "file",
      accept: "image/jpeg,image/png,image/webp,image/*",
      multiple: true,
      hidden: true,
    });

    var pickPhotosBtn = el("button", {
      type: "button",
      class: "btn btn-sm btn-primary",
      onclick: function () { photoAlbumInput.click(); },
    }, icon("plus"), "📷 选试卷/答案照片 (AI)");
    var scanCropAiBtn = el("button", {
      type: "button",
      class: "btn btn-sm",
      onclick: function () {
        if (!window.ExamScanner) return GS.toast("扫描组件未加载");
        ExamScanner.open({
          isAdmin: true,
          mode: "extract",
          onExtract: function (pagesOut) { submitPhotosToAI(pagesOut); },
        });
      },
    }, icon("search"), "切边扫描识卷");
    var pickDocBtn = el("button", {
      type: "button",
      class: "btn btn-sm",
      onclick: function () { docInput.click(); },
    }, icon("layers"), "传 PDF / Word");
    var aiCfgToggleBtn = el("button", {
      type: "button",
      class: "btn btn-sm",
      text: "🔑 DeepSeek API",
      onclick: function () { aiCfgPanel.hidden = !aiCfgPanel.hidden; },
    });

    var aiStatusBadge = label("检测 AI 配置中…");
    var aiKeyInp = el("input", { type: "password", placeholder: "输入 DeepSeek API Key (sk-...)" });
    var aiBaseInp = el("input", { type: "url", value: "https://api.deepseek.com", placeholder: "https://api.deepseek.com" });
    var aiModelInp = el("input", { type: "text", value: "deepseek-flash", placeholder: "deepseek-flash" });
    var aiSaveCfgBtn = el("button", { type: "button", class: "btn btn-sm btn-primary", text: "保存配置" });
    var aiCfgPanel = el("div", { class: "doc-ai-config", hidden: true },
      el("div", { class: "row", style: "justify-content:space-between" },
        el("span", { class: "small", text: "拍照识卷支持手写试卷与独立标准答案页，默认调用 DeepSeek 视觉模型（deepseek-flash）" }),
        aiStatusBadge,
      ),
      el("div", { class: "doc-ai-grid" },
        el("div", { class: "field" }, el("label", { text: "DeepSeek API Key（留空保持已存密钥）" }), aiKeyInp),
        el("div", { class: "field" }, el("label", { text: "API Base URL" }), aiBaseInp),
        el("div", { class: "field" }, el("label", { text: "视觉模型名" }), aiModelInp),
        aiSaveCfgBtn,
      ),
    );

    function refreshAiConfigBadge(cfg) {
      parseState.aiConfig = cfg;
      if (!cfg) return;
      if (cfg.baseUrl) aiBaseInp.value = cfg.baseUrl;
      if (cfg.model) aiModelInp.value = cfg.model;
      aiStatusBadge.textContent = cfg.configured
        ? "已配置 (" + cfg.maskedKey + " · " + cfg.model + ")"
        : "未配置 API Key";
      aiStatusBadge.className = "label " + (cfg.configured ? "ui-soft-success" : "ui-soft-attention");
      aiCfgToggleBtn.textContent = cfg.configured ? "🔑 DeepSeek 已就绪" : "🔑 配置 DeepSeek";
    }

    GS.api("GET", "/api/exam/admin/ai-config").then(function (r) {
      refreshAiConfigBadge(r.config);
    }).catch(function () {});

    aiSaveCfgBtn.addEventListener("click", function () {
      var done = GS.busy(aiSaveCfgBtn, "保存中…");
      var body = { baseUrl: aiBaseInp.value.trim(), model: aiModelInp.value.trim() };
      if (aiKeyInp.value.trim()) body.apiKey = aiKeyInp.value.trim();
      GS.api("PUT", "/api/exam/admin/ai-config", body).then(function (r) {
        aiKeyInp.value = "";
        refreshAiConfigBadge(r.config);
        GS.toast("DeepSeek API 配置已保存");
      }).catch(fail).finally(done);
    });

    var docStatusEl = el("span", {
      class: "small muted",
      text: "支持手写试卷照片 + 独立手写标准答案页（支持多图同时选择合并识别），或拖拽 / 上传 PDF、Word (.docx)、TXT、MD",
    });
    var docResultHost = el("div");
    var docBox = el("div", { class: "doc-import-box" },
      docInput,
      photoAlbumInput,
      el("div", { class: "doc-import-top" },
        el("strong", { class: "small", text: "智能识卷录入（照片 / 扫描件 / PDF / Word）" }),
        el("div", { class: "doc-import-tabs" }, pickPhotosBtn, scanCropAiBtn, pickDocBtn, aiCfgToggleBtn),
      ),
      docStatusEl,
      aiCfgPanel,
      docResultHost,
    );

    function compressImageFileToDataUrl(file) {
      return new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () {
          URL.revokeObjectURL(url);
          var maxSide = 1800;
          var w = img.naturalWidth || img.width;
          var h = img.naturalHeight || img.height;
          if (!w || !h) return reject(new Error("无法读取图片尺寸"));
          var scale = Math.min(1, maxSide / Math.max(w, h));
          var cw = Math.max(1, Math.round(w * scale));
          var ch = Math.max(1, Math.round(h * scale));
          var canvas = document.createElement("canvas");
          canvas.width = cw;
          canvas.height = ch;
          var ctx = canvas.getContext("2d");
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, cw, ch);
          ctx.drawImage(img, 0, 0, cw, ch);
          resolve(canvas.toDataURL("image/jpeg", 0.86));
        };
        img.onerror = function () {
          URL.revokeObjectURL(url);
          reject(new Error("图片解码失败：" + (file.name || "")));
        };
        img.src = url;
      });
    }

    function submitPhotosToAI(imagesArr) {
      if (!imagesArr || !imagesArr.length || parseState.busy) return;
      var hasCfg = (parseState.aiConfig && parseState.aiConfig.configured) || aiKeyInp.value.trim();
      if (!hasCfg) {
        aiCfgPanel.hidden = false;
        aiKeyInp.focus();
        GS.toast("请先填写你的 DeepSeek API Key");
        return;
      }
      parseState.busy = true;
      var done = GS.busy(pickPhotosBtn, "AI 识图中…");
      docStatusEl.textContent = "正在调用 DeepSeek 识别 " + imagesArr.length + " 张试卷/答案照片中的题型、小题分值与参考答案…";

      var payload = { images: imagesArr };
      if (aiKeyInp.value.trim()) payload.apiKey = aiKeyInp.value.trim();
      if (aiBaseInp.value.trim()) payload.baseUrl = aiBaseInp.value.trim();
      if (aiModelInp.value.trim()) payload.model = aiModelInp.value.trim();

      GS.api("POST", "/api/exam/admin/parse-photos", payload).then(function (r) {
        parseState.parsed = r.parsed;
        parseState.structMode = "single";
        parseState.splitSub = false;
        docStatusEl.textContent = "AI 识卷完成：识别到 " + r.parsed.sections.length + " 种题型、共 " + r.parsed.stats.totalQuestions + " 题（总分 " + r.parsed.fullScore + " 分）。请核对下方题目并保存。";
        applyParsedToForm(true);
        renderDocResult();
        GS.toast("已从照片识别并填入 " + r.parsed.stats.totalQuestions + " 道题目");
      }).catch(function (err) {
        docStatusEl.textContent = "AI 识卷失败：" + ((err && err.message) || "请检查 API Key 与网络");
        if (/API Key/i.test(String(err && err.message || ""))) aiCfgPanel.hidden = false;
        fail(err);
      }).finally(function () {
        parseState.busy = false;
        done();
      });
    }

    function handlePhotoFiles(fileList) {
      var files = Array.prototype.slice.call(fileList || []).filter(function (f) {
        return f && (/^image\//.test(f.type) || /\.(?:jpe?g|png|webp|heic|bmp)$/i.test(f.name || ""));
      });
      if (!files.length) return GS.toast("请选择有效的试卷图片（JPEG / PNG / WebP）");
      if (files.length > 16) return GS.toast("单次最多选择 16 张照片");
      docStatusEl.textContent = "正在压缩预处理 " + files.length + " 张试卷照片…";
      Promise.all(files.map(compressImageFileToDataUrl)).then(function (dataUrls) {
        submitPhotosToAI(dataUrls.map(function (d, i) { return { pageNo: i + 1, imageData: d }; }));
      }).catch(function (err) {
        docStatusEl.textContent = "图片预处理失败：" + ((err && err.message) || "");
        fail(err);
      }).finally(function () {
        photoAlbumInput.value = "";
      });
    }

    function applyParsedToForm(fillMeta) {
      var p = parseState.parsed;
      if (!p) return;
      if (fillMeta) {
        if (p.title) titleInp.value = p.title;
        if (p.term) termInp.value = p.term;
        if (p.description) descInp.value = p.description;
      }
      subjects = buildSubjectsFromParsed(p, parseState.structMode, parseState.splitSub).map(function (s) {
        s.expanded = true;
        return s;
      });
      renderSubjects();
    }

    function renderDocResult() {
      docResultHost.textContent = "";
      var p = parseState.parsed;
      if (!p) return;

      var hasSubQs = p.questions.some(function (q) { return Array.isArray(q.subQuestions) && q.subQuestions.length > 0; });
      var pills = [
        label((p.format || "DOC").toUpperCase() + " · " + p.pageCount + " 页", "accent"),
        label("满分 " + p.fullScore + " 分", "success"),
      ];
      if (p.duration) pills.push(label(p.duration + " 分钟"));
      if (p.mode) pills.push(label(p.mode));
      (p.sections || []).forEach(function (sec) {
        pills.push(label(sec.name + " " + sec.questionCount + "题·" + sec.totalScore + "分"));
      });
      if (p.stats.answeredCount > 0) {
        pills.push(label("已匹配答案 " + p.stats.answeredCount + "/" + p.stats.totalQuestions + " 题", "success"));
      }
      if (p.stats.hasSpecTable) pills.push(label("双向细目表 " + p.specChapters.length + " 章", "accent"));
      if (p.stats.skippedAnswerSheet) pills.push(label("已跳过答题卡"));

      var modeSingleBtn = el("button", {
        type: "button",
        class: "btn btn-sm" + (parseState.structMode === "single" ? " btn-primary" : ""),
        text: "单科整卷（" + (p.subjectName || "综合") + "）",
        onclick: function () { parseState.structMode = "single"; applyParsedToForm(false); renderDocResult(); },
      });
      var modeBySecBtn = el("button", {
        type: "button",
        class: "btn btn-sm" + (parseState.structMode === "by_section" ? " btn-primary" : ""),
        text: "按题型分科（" + (p.sections.length || 1) + " 科）",
        onclick: function () { parseState.structMode = "by_section"; applyParsedToForm(false); renderDocResult(); },
      });

      var splitChk = hasSubQs
        ? el("input", {
          type: "checkbox",
          checked: parseState.splitSub,
          onchange: function () { parseState.splitSub = !!this.checked; applyParsedToForm(false); renderDocResult(); },
        })
        : null;

      docResultHost.append(el("div", { class: "doc-import-result" },
        el("div", { class: "row", style: "justify-content:space-between" },
          el("strong", { class: "small", text: "已识别：" + (p.filename || "试卷文档") }),
          el("button", {
            type: "button", class: "btn btn-sm", text: "重新填入标题与说明",
            onclick: function () { applyParsedToForm(true); GS.toast("已重新应用文档识别结果"); },
          }),
        ),
        el("div", { class: "doc-import-pills" }, pills),
        el("div", { class: "doc-import-controls" },
          el("div", { class: "row" }, el("span", { class: "small muted", text: "结构模式：" }), modeSingleBtn, modeBySecBtn),
          splitChk ? el("label", { class: "scanner-check" }, splitChk, "大题按小问拆分（如 36(1)）") : false,
        ),
      ));
    }

    function uploadDocFile(file) {
      if (!file || parseState.busy) return;
      if (file.size > 12 * 1024 * 1024) return GS.toast("文档大小不能超过 12MB");
      parseState.busy = true;
      var done = GS.busy(pickDocBtn, "识别中…");
      docStatusEl.textContent = "正在解析「" + file.name + "」的题型结构与参考答案…";

      var reader = new FileReader();
      reader.onload = function () {
        GS.api("POST", "/api/exam/admin/parse-doc", {
          filename: file.name,
          mimeType: file.type || "",
          fileDataUrl: String(reader.result || ""),
        }).then(function (r) {
          parseState.parsed = r.parsed;
          parseState.structMode = "single";
          parseState.splitSub = false;
          docStatusEl.textContent = "解析完成：识别到 " + r.parsed.sections.length + " 种题型、共 " + r.parsed.stats.totalQuestions + " 题（总分 " + r.parsed.fullScore + " 分）。请核对下方题目并保存。";
          applyParsedToForm(true);
          renderDocResult();
          GS.toast("已自动填入 " + r.parsed.stats.totalQuestions + " 道题目与配置");
        }).catch(function (err) {
          docStatusEl.textContent = "识别失败：" + ((err && err.message) || "请检查文档格式");
          fail(err);
        }).finally(function () {
          parseState.busy = false;
          done();
          docInput.value = "";
        });
      };
      reader.onerror = function () {
        parseState.busy = false;
        done();
        docStatusEl.textContent = "读取本地文件失败，请重试";
        GS.toast("读取本地文件失败");
      };
      reader.readAsDataURL(file);
    }

    docInput.addEventListener("change", function () {
      if (docInput.files && docInput.files[0]) uploadDocFile(docInput.files[0]);
    });
    photoAlbumInput.addEventListener("change", function () {
      if (photoAlbumInput.files && photoAlbumInput.files.length) handlePhotoFiles(photoAlbumInput.files);
    });
    docBox.addEventListener("dragover", function (e) { e.preventDefault(); docBox.classList.add("is-drag"); });
    docBox.addEventListener("dragleave", function () { docBox.classList.remove("is-drag"); });
    docBox.addEventListener("drop", function (e) {
      e.preventDefault();
      docBox.classList.remove("is-drag");
      var files = Array.prototype.slice.call((e.dataTransfer && e.dataTransfer.files) || []);
      if (!files.length) return;
      var imgFiles = files.filter(function (f) { return /^image\//.test(f.type) || /\.(?:jpe?g|png|webp)$/i.test(f.name || ""); });
      if (imgFiles.length) handlePhotoFiles(imgFiles);
      else uploadDocFile(files[0]);
    });

    function renderSubjects() {
      subHost.textContent = "";
      subjects.forEach(function (s, idx) {
        var nameI = el("input", { value: s.name, placeholder: "科目名称", oninput: function () { s.name = this.value; } });
        var fullI = el("input", { type: "number", step: "0.5", min: "1", value: s.fullScore, oninput: function () { s.fullScore = Number(this.value) || 100; } });
        var passI = el("input", { type: "number", step: "0.5", min: "0", value: s.passScore, oninput: function () { s.passScore = Number(this.value) || 0; } });
        var excI = el("input", { type: "number", step: "0.5", min: "0", value: s.excellentScore, oninput: function () { s.excellentScore = Number(this.value) || 0; } });

        var countLabel = el("span", { class: "small muted" });
        var summaryHost = el("div", { class: "q-section-summary" });
        var qHead = el("div", { class: "q-editor-head" },
          el("span", { text: "题号" }),
          el("span", { text: "题目描述" }),
          el("span", { text: "题型" }),
          el("span", { text: "知识点" }),
          el("span", { text: "满分" }),
          el("span", { text: "参考答案 / 评分标准" }),
          el("span", { text: "删" }),
        );
        var qWrap = el("div", { class: "q-editor-list" });
        if (s.expanded === false) qWrap.hidden = true;

        var toggleQsBtn = el("button", {
          type: "button",
          class: "btn btn-sm",
          onclick: function () {
            s.expanded = qWrap.hidden;
            qWrap.hidden = !s.expanded;
            qHead.hidden = qWrap.hidden || !s.questions.length;
            toggleQsBtn.textContent = s.expanded ? "收起小题" : "展开小题 (" + s.questions.length + ")";
          },
        });
        var clearQsBtn = el("button", {
          type: "button",
          class: "btn btn-sm btn-danger",
          text: "清空小题",
          onclick: function () {
            s.questions = [];
            renderQs();
          },
        });

        function updateQSummary() {
          var qSum = Math.round(s.questions.reduce(function (acc, q) { return acc + (Number(q.full) || 0); }, 0) * 10) / 10;
          countLabel.textContent = "小题模板（共 " + s.questions.length + " 题 · 合计 " + qSum + " 分 · 失分自动进错题本）";
          toggleQsBtn.hidden = s.questions.length <= 6;
          toggleQsBtn.textContent = qWrap.hidden ? "展开小题 (" + s.questions.length + ")" : "收起小题";
          clearQsBtn.hidden = !s.questions.length;
          qHead.hidden = qWrap.hidden || !s.questions.length;

          summaryHost.textContent = "";
          var secMap = {};
          var secOrder = [];
          s.questions.forEach(function (q) {
            var lbl = qtypeLabel(q.qtype, q.section);
            if (!secMap[lbl]) { secMap[lbl] = { count: 0, score: 0 }; secOrder.push(lbl); }
            secMap[lbl].count++;
            secMap[lbl].score = Math.round((secMap[lbl].score + (Number(q.full) || 0)) * 10) / 10;
          });
          if (secOrder.length >= 1 && s.questions.length > 0) {
            secOrder.forEach(function (lbl) {
              summaryHost.append(label(lbl + " " + secMap[lbl].count + "题·" + secMap[lbl].score + "分"));
            });
          }
        }

        function renderQs() {
          qWrap.textContent = "";
          s.questions.forEach(function (q, qIdx) {
            var qtSel = el("select", {
              onchange: function () {
                q.qtype = this.value;
                q.section = QTYPE_LABELS[this.value] || "综合题";
                updateQSummary();
              },
            }, Object.keys(QTYPE_LABELS).map(function (k) {
              return el("option", { value: k, selected: (q.qtype || "other") === k, text: QTYPE_LABELS[k] });
            }));
            qWrap.append(el("div", { class: "q-editor-row" },
              el("input", { value: q.no, placeholder: "题号", oninput: function () { q.no = this.value; } }),
              el("input", { value: q.title || "", placeholder: "题目描述", oninput: function () { q.title = this.value; } }),
              qtSel,
              el("input", { value: q.tag || "", placeholder: "知识点", oninput: function () { q.tag = this.value; } }),
              el("input", { type: "number", step: "0.5", min: "0.5", value: q.full, placeholder: "满分", oninput: function () { q.full = Number(this.value) || 1; updateQSummary(); } }),
              el("input", { value: q.answer || "", placeholder: "标准答案/解析", oninput: function () { q.answer = this.value; } }),
              el("button", { type: "button", class: "btn btn-sm btn-danger", text: "删", onclick: function () { s.questions.splice(qIdx, 1); renderQs(); } }),
            ));
          });
          updateQSummary();
        }
        renderQs();

        subHost.append(el("div", { class: "sub-editor-row" },
          el("div", { class: "sub-editor-fields" },
            el("div", { class: "field" }, el("label", { text: "科目名称" }), nameI),
            el("div", { class: "field" }, el("label", { text: "满分" }), fullI),
            el("div", { class: "field" }, el("label", { text: "及格线" }), passI),
            el("div", { class: "field" }, el("label", { text: "优秀线" }), excI),
            subjects.length > 1 ? el("button", { type: "button", class: "btn btn-sm btn-danger", text: "移除科目", onclick: function () { subjects.splice(idx, 1); renderSubjects(); } }) : el("span"),
          ),
          el("div", { class: "row", style: "justify-content:space-between" },
            countLabel,
            el("div", { class: "row" },
              toggleQsBtn,
              clearQsBtn,
              el("button", { type: "button", class: "btn btn-sm", text: "+ 加 1 小题", onclick: function () {
                s.expanded = true;
                qWrap.hidden = false;
                s.questions.push({ no: String(s.questions.length + 1), title: "", qtype: "other", section: "综合题", tag: "核心能力", full: 10, answer: "" });
                renderQs();
              } }),
              el("button", { type: "button", class: "btn btn-sm", text: "批量生成 5 题", onclick: function () {
                s.expanded = true;
                qWrap.hidden = false;
                var each = Math.round((s.fullScore / 5) * 10) / 10;
                for (var k = 0; k < 5; k++) {
                  s.questions.push({ no: String(s.questions.length + 1), title: "第 " + (s.questions.length + 1) + " 题", qtype: "other", section: "综合题", tag: "模块 " + ((k % 3) + 1), full: each, answer: "" });
                }
                renderQs();
              } }),
            ),
          ),
          summaryHost,
          qHead,
          qWrap,
        ));
      });
    }
    renderSubjects();

    var saveBtn = el("button", { type: "button", class: "btn btn-primary", text: "保存考试" });
    var cancelBtn = el("button", { type: "button", class: "btn", text: "取消" });

    dlg.append(
      el("header", null, icon("calendar"), el("span", { class: "grow", text: existing ? "编辑考试配置" : "新建内部考试" })),
      el("div", { class: "dialog-body" },
        docBox,
        el("div", { class: "field" }, el("label", { text: "考试名称" }), titleInp),
        el("div", { style: "display:grid;grid-template-columns:1fr 1fr 1fr;gap:.75rem;margin-top:.75rem" },
          el("div", { class: "field" }, el("label", { text: "期次 / 学期" }), termInp),
          el("div", { class: "field" }, el("label", { text: "考试日期" }), dateInp),
          el("div", { class: "field" }, el("label", { text: "发布状态" }), statusSel),
        ),
        el("div", { class: "field", style: "margin-top:.75rem" }, el("label", { text: "备注说明" }), descInp),
        el("label", { class: "scanner-check", style: "margin:.75rem 0" }, rankChk, "向员工显示具体全员排名与部门排名（关闭则仅显示超越率）"),
        el("div", { class: "subhead", style: "margin-top:1rem" },
          el("h3", { text: "科目与小题模板" }),
          el("button", { type: "button", class: "btn btn-sm", text: "+ 添加科目", onclick: function () {
            subjects.push({ name: "科目 " + (subjects.length + 1), fullScore: 100, passScore: 60, excellentScore: 85, expanded: true, questions: [] });
            renderSubjects();
          } }),
        ),
        subHost,
      ),
      el("footer", null, cancelBtn, saveBtn),
    );
    document.body.appendChild(dlg);
    function close() { dlg.close(); dlg.remove(); }
    cancelBtn.addEventListener("click", close);
    dlg.addEventListener("cancel", function (e) { e.preventDefault(); close(); });
    saveBtn.addEventListener("click", function () {
      var done = GS.busy(saveBtn, "保存中…");
      var payload = {
        title: titleInp.value.trim(),
        term: termInp.value.trim(),
        examDate: dateInp.value,
        description: descInp.value.trim(),
        status: statusSel.value,
        showRank: rankChk.checked,
        subjects: subjects,
      };
      var p = existing
        ? GS.api("PATCH", "/api/exam/admin/exams/" + existing.id, payload)
        : GS.api("POST", "/api/exam/admin/exams", payload);
      p.then(function (r) {
        state.selectedExamId = r.exam.id;
        GS.toast(existing ? "考试配置已更新" : "考试已创建");
        close();
        reloadExamsAndStay();
      }).catch(function (err) { done(); fail(err); });
    });
    dlg.showModal();
  }

  /* ---------- 7B. 考务：成绩录入与拍图扫描 ---------- */
  function renderAdminScoring(host) {
    host.textContent = "";
    if (!state.exams.length) {
      host.append(el("div", { class: "box" }, el("div", { class: "blankslate" }, icon("pencil"), el("h3", { text: "请先在「考试管理」创建一场考试" }))));
      return;
    }
    if (!state.selectedExamId || !state.exams.some(function (x) { return x.id === state.selectedExamId; })) {
      state.selectedExamId = state.exams[0].id;
    }

    var exSel = el("select", { class: "exam-select" },
      state.exams.map(function (e) { return el("option", { value: e.id, selected: e.id === state.selectedExamId, text: e.title + (e.status === "draft" ? "（草稿）" : "") }); }));
    var batchMode = false;
    var modeBtn = el("button", { type: "button", class: "btn btn-sm", text: "切换到：全员批量录分表" });
    var workHost = el("div", { style: "display:grid;gap:1rem" });
    host.append(el("div", { class: "exam-bar" }, el("div", { class: "exam-bar-left" }, exSel, modeBtn)), workHost);

    var usersCache = [];
    var lastDetected = {};
    GS.api("GET", "/api/exam/admin/users").then(function (d) {
      usersCache = d.users;
      draw();
    }).catch(fail);

    exSel.addEventListener("change", function () { state.selectedExamId = Number(exSel.value); draw(); });
    modeBtn.addEventListener("click", function () {
      batchMode = !batchMode;
      modeBtn.textContent = batchMode ? "切换到：单人精录与扫卷" : "切换到：全员批量录分表";
      draw();
    });

    function draw() {
      workHost.textContent = "";
      var exam = state.exams.find(function (e) { return e.id === state.selectedExamId; });
      if (!exam) return;
      if (!usersCache.length) {
        workHost.append(el("div", { class: "box" }, el("div", { class: "blankslate" }, el("h3", { text: "暂无员工账号" }), el("p", { text: "请先在「成员与考号」分配考号或新增成员。" }))));
        return;
      }
      if (batchMode) renderBatchGrid(exam);
      else renderSingleAndScan(exam);
    }

    function renderSingleAndScan(exam) {
      var noInp = el("input", { type: "text", maxlength: "4", placeholder: "输入4位考号如 0413", style: "width:11rem" });
      var userSel = el("select", { style: "max-width:16rem" },
        usersCache.map(function (u) {
          return el("option", { value: u.id, text: (u.examNo ? "[" + u.examNo + "] " : "[无考号] ") + (u.displayName || u.username) + (u.department ? " · " + u.department : "") });
        }));
      var subSel = el("select", { style: "max-width:12rem" },
        exam.subjects.map(function (s) { return el("option", { value: s.id, text: s.name + "（满分 " + s.fullScore + "）" }); }));

      var area = el("div");
      workHost.append(
        el("div", { class: "exam-card" },
          el("div", { class: "exam-bar", style: "margin-bottom:0" },
            el("div", { class: "exam-bar-left" },
              el("span", { class: "small muted", text: "考号直查：" }),
              noInp,
              el("button", { type: "button", class: "btn btn-sm", text: "定位", onclick: lookupNo }),
              el("span", { class: "small muted", text: "或选成员：" }),
              userSel,
              subSel,
            ),
          ),
        ),
        area,
      );

      function lookupNo() {
        var v = noInp.value.trim();
        if (!/^\d{4}$/.test(v)) return GS.toast("请输入 4 位数字考号（如 0413）");
        var hit = usersCache.find(function (u) { return u.examNo === v; });
        if (!hit) return GS.toast("未找到考号 " + v + " 对应的成员");
        userSel.value = String(hit.id);
        loadStudentSubject();
      }
      noInp.addEventListener("input", function () { if (/^\d{4}$/.test(noInp.value.trim())) lookupNo(); });
      userSel.addEventListener("change", loadStudentSubject);
      subSel.addEventListener("change", loadStudentSubject);

      function loadStudentSubject() {
        var uid = Number(userSel.value);
        var sid = Number(subSel.value);
        var student = usersCache.find(function (u) { return u.id === uid; });
        if (!student) return;
        if (student.examNo) noInp.value = student.examNo;

        GS.api("GET", "/api/exam/exams/" + exam.id + "/report?userId=" + uid).then(function (rep) {
          area.textContent = "";
          var sub = rep.subjects.find(function (s) { return s.id === sid; }) || rep.subjects[0];
          if (!sub) return;
          var mine = sub.mine || { score: "", absent: false, items: [], teacherComment: "" };

          var itemsEdited = !!(mine.items && mine.items.length);
          var itemDrafts = (mine.items && mine.items.length)
            ? mine.items.map(function (x) {
              return { no: x.no, title: x.title, tag: x.tag, full: x.full, got: x.got, wrong: x.wrong, section: x.section, qtype: x.qtype, studentAnswer: x.studentAnswer || "", aiComment: x.aiComment || "" };
            })
            : (sub.questions || []).map(function (q) {
              return { no: q.no, title: q.title, tag: q.tag, full: q.full, got: q.full, wrong: false, section: q.section, qtype: q.qtype, studentAnswer: "", aiComment: "" };
            });

          var scoreInp = el("input", { type: "number", step: "0.5", min: "0", max: sub.fullScore, value: mine.score !== "" ? String(mine.score) : "" });
          var absentChk = el("input", { type: "checkbox", checked: !!mine.absent });
          var autoSumChk = el("input", { type: "checkbox", checked: itemsEdited });
          var noteTa = el("textarea", { rows: "2", placeholder: "教师评语（可选）" });
          noteTa.value = mine.teacherComment || "";

          var itemsWrap = el("div", { class: "item-score-list" });
          function recalcSum() {
            if (!autoSumChk.checked || !itemDrafts.length) return;
            var total = itemDrafts.reduce(function (s, it) { return s + (Number(it.got) || 0); }, 0);
            scoreInp.value = String(Math.round(total * 10) / 10);
          }
          function drawItems() {
            itemsWrap.textContent = "";
            itemDrafts.forEach(function (it) {
              var gInp = el("input", {
                type: "number", step: "0.5", min: "0", max: it.full, value: String(it.got),
                oninput: function () {
                  itemsEdited = true;
                  it.got = Math.max(0, Math.min(it.full, Number(this.value) || 0));
                  it.wrong = it.got < it.full;
                  recalcSum();
                },
              });
              var descParts = [(it.title || it.tag || "小题") + "（" + (it.tag || "综合") + "）"];
              if (it.studentAnswer) descParts.push("作答：" + it.studentAnswer);
              if (it.aiComment) descParts.push("AI：" + it.aiComment);
              itemsWrap.append(el("div", { class: "item-score-row" },
                el("strong", { text: "#" + it.no }),
                el("span", { text: descParts.join(" · ") }),
                gInp,
                el("span", { class: "muted", text: "/ " + it.full + " 分" }),
              ));
            });
          }
          drawItems();
          if (itemDrafts.length && mine.score === "" && itemsEdited) recalcSum();

          function refreshSilentAndStay() {
            Promise.all([GS.api("GET", "/api/exam/me"), GS.api("GET", "/api/exam/list")]).then(function (res) {
              state.examMe = res[0];
              state.exams = res[1].exams;
              renderIdCard();
              loadStudentSubject();
            }).catch(fail);
          }

          var saveScoreBtn = el("button", { type: "button", class: "btn btn-primary", text: "提交本科学业成绩" });
          saveScoreBtn.addEventListener("click", function () {
            var done = GS.busy(saveScoreBtn, "保存中…");
            GS.api("PUT", "/api/exam/admin/exams/" + exam.id + "/scores", {
              userId: student.id,
              subjectId: sub.id,
              score: Number(scoreInp.value) || 0,
              absent: absentChk.checked,
              useItemsSum: autoSumChk.checked && itemDrafts.length > 0,
              items: (itemsEdited || autoSumChk.checked) ? itemDrafts : undefined,
              teacherComment: noteTa.value,
            }).then(function () {
              GS.toast("已保存 " + (student.examNo || student.username) + " 的「" + sub.name + "」成绩");
              refreshSilentAndStay();
            }).catch(function (err) { done(); fail(err); });
          });

          var delScoreBtn = sub.mine ? el("button", {
            type: "button", class: "btn btn-sm btn-danger", text: "删除该生成绩",
            onclick: function () {
              GS.dialog({
                title: "删除「" + (student.displayName || student.username) + "」本场成绩",
                danger: true,
                confirm: "确认删除",
                text: "将删除该考生在本场考试的成绩与关联错题记录（保留已传答题卡原卷）。",
              }).then(function (ok) {
                if (!ok) return;
                return GS.api("DELETE", "/api/exam/admin/exams/" + exam.id + "/scores/" + student.id).then(function () {
                  GS.toast("已删除该生成绩记录");
                  refreshSilentAndStay();
                });
              }).catch(fail);
            },
          }) : null;

          var leftCol = el("div", { class: "exam-card" },
            el("div", { class: "exam-card-head" },
              el("h3", { text: (student.displayName || student.username) + " · " + sub.name }),
              el("span", { class: "exam-no-pill", text: student.examNo ? "考号 " + student.examNo : "无考号" }),
            ),
            el("div", { style: "display:grid;grid-template-columns:1fr auto;gap:.75rem;align-items:end" },
              el("div", { class: "field" }, el("label", { text: "总分（满分 " + sub.fullScore + "）" }), scoreInp),
              el("label", { class: "scanner-check", style: "padding-bottom:.45rem" }, absentChk, "标记缺考"),
            ),
            itemDrafts.length ? el("label", { class: "scanner-check", style: "margin-top:.6rem" }, autoSumChk, "按下方小题得分自动求和") : null,
            itemDrafts.length ? itemsWrap : el("p", { class: "muted small", style: "margin-top:.6rem", text: "提示：在「考试管理」中配置小题模板后，失分小题会自动沉淀至成员错题本。" }),
            el("div", { class: "field", style: "margin-top:.85rem" }, el("label", { text: "教师评语" }), noteTa),
            el("div", { class: "form-actions" }, saveScoreBtn, delScoreBtn),
          );

          var nextNo = sub.papers.length ? sub.papers[sub.papers.length - 1].pageNo + 1 : 1;
          var key = student.id + ":" + sub.id;
          var detectedBannerHost = el("div");
          function renderDetectedBanner() {
            detectedBannerHost.textContent = "";
            var det = lastDetected[key];
            if (!det || (!det.examNo && !det.name && !det.department)) return;
            var mismatch = !!(det.examNo && student.examNo && det.examNo !== student.examNo);
            detectedBannerHost.append(el("div", {
              class: "flash " + (mismatch ? "flash-error" : "flash-info"),
              style: "margin-top:.75rem",
            }, icon(mismatch ? "alert" : "info"), el("div", {
              text: (mismatch ? "⚠️ 卷面考号与当前选中成员不一致！" : "")
                + "AI 识别卷面信息：考号 " + (det.examNo || "—")
                + " · 姓名 " + (det.name || "—")
                + (det.department ? " · 部门 " + det.department : ""),
            })));
          }
          renderDetectedBanner();

          var scanBtn = el("button", {
            type: "button", class: "btn btn-sm btn-primary",
            onclick: function () {
              ExamScanner.open({
                isAdmin: true,
                examId: exam.id,
                subjectId: sub.id,
                subject: sub,
                examStatus: exam.status,
                student: student,
                initialScore: scoreInp.value,
                initialComment: noteTa.value,
                items: (itemsEdited || autoSumChk.checked) ? itemDrafts : undefined,
                nextPageNo: nextNo,
                onUploaded: function (_pages, _synced, aiGrading, confirmedUser) {
                  var targetId = confirmedUser && confirmedUser.id ? confirmedUser.id : student.id;
                  if (confirmedUser && confirmedUser.id !== student.id) {
                    userSel.value = String(confirmedUser.id);
                  }
                  if (aiGrading && aiGrading.detectedStudent) {
                    lastDetected[targetId + ":" + sub.id] = aiGrading.detectedStudent;
                  }
                  refreshSilentAndStay();
                },
              });
            },
          }, icon("phone"), "📷 拍答题卡 / 传原卷");

          var aiGradeBtn = sub.papers.length ? el("button", {
            type: "button",
            class: "btn btn-sm",
            text: "🤖 AI 自动批改",
            onclick: function () {
              var done = GS.busy(aiGradeBtn, "AI 阅卷中…");
              ExamScanner.runAiGradeWithConfirm({
                examId: exam.id,
                subjectId: sub.id,
                userId: student.id,
                applyAnnotations: true,
                autoSave: true,
              }).then(function (r) {
                if (!r || !r.confirmed) {
                  GS.toast("已取消本次成绩入库");
                  return;
                }
                var targetId = r.targetUser && r.targetUser.id ? r.targetUser.id : student.id;
                if (r.targetUser && r.targetUser.id !== student.id) {
                  userSel.value = String(r.targetUser.id);
                }
                if (r.grading && r.grading.detectedStudent) {
                  lastDetected[targetId + ":" + sub.id] = r.grading.detectedStudent;
                }
                var who = r.targetUser ? (r.targetUser.displayName || r.targetUser.username) : (student.displayName || student.username);
                GS.toast("AI 批改已保存至「" + who + "」：" + r.grading.score + " / " + r.grading.fullScore + " 分");
                refreshSilentAndStay();
              }).catch(fail).finally(done);
            },
          }) : null;

          var clearPapersBtn = sub.papers.length ? el("button", {
            type: "button",
            class: "btn btn-sm btn-danger",
            text: "清空全部原卷",
            onclick: function () {
              GS.dialog({
                title: "清空该生「" + sub.name + "」全部原卷",
                danger: true,
                confirm: "清空原卷",
                text: "将永久删除该生此科目的全部 " + sub.papers.length + " 页扫描件。",
              }).then(function (ok) {
                if (!ok) return;
                return GS.api("DELETE", "/api/exam/admin/papers?examId=" + exam.id + "&subjectId=" + sub.id + "&userId=" + student.id).then(function (r) {
                  GS.toast("已清空 " + (r.deleted || sub.papers.length) + " 页扫描原卷");
                  refreshSilentAndStay();
                });
              }).catch(fail);
            },
          }) : null;

          var papersList = el("div", { style: "display:grid;gap:.65rem;margin-top:.85rem" });
          if (!sub.papers.length) {
            papersList.append(el("p", { class: "muted small", text: "暂无答题卡扫描件。支持手机拍照或相册选图，自动透视矫正并支持 DeepSeek AI 自动批改手写答题卡。" }));
          } else {
            sub.papers.forEach(function (p) {
              papersList.append(el("div", { class: "box-row", style: "padding:.6rem .75rem;border:1px solid var(--ui-border);border-radius:var(--ui-r)" },
                el("img", { src: p.url, alt: "第 " + p.pageNo + " 页", style: "width:3.6rem;height:4.8rem;object-fit:cover;border-radius:4px;background:#111" }),
                el("div", { class: "grow" },
                  el("div", { class: "title", text: "第 " + p.pageNo + " 页" }),
                  el("div", { class: "meta", text: (p.width || "?") + "×" + (p.height || "?") + " · 滤镜 " + p.filterMode + " · 批注 " + (p.annotations?.length || 0) + " 处" }),
                ),
                el("button", { type: "button", class: "btn btn-sm", text: "红笔批改", onclick: function () { openAnnotationDialog(p, loadStudentSubject); } }),
                el("button", { type: "button", class: "btn btn-sm btn-danger", text: "删", onclick: function () {
                  GS.dialog({
                    title: "删除第 " + p.pageNo + " 页原卷",
                    danger: true,
                    confirm: "删除",
                    text: "确认永久删除该页答题卡扫描件？",
                  }).then(function (ok) {
                    if (!ok) return;
                    return GS.api("DELETE", "/api/exam/admin/papers/" + p.id).then(function () {
                      GS.toast("已删除第 " + p.pageNo + " 页");
                      refreshSilentAndStay();
                    });
                  }).catch(fail);
                } }),
              ));
            });
          }

          var rightCol = el("div", { class: "exam-card" },
            el("div", { class: "exam-card-head" }, el("h3", { text: "答题卡扫描与 AI 批改（" + sub.papers.length + " 页）" })),
            el("div", { class: "row" }, scanBtn, aiGradeBtn, clearPapersBtn),
            detectedBannerHost,
            papersList,
          );

          area.append(el("div", { class: "score-entry-grid" }, leftCol, rightCol));
        }).catch(fail);
      }

      loadStudentSubject();
    }

    function renderBatchGrid(exam) {
      GS.api("GET", "/api/exam/admin/exams/" + exam.id + "/overview").then(function (ov) {
        var existingByUser = new Map(ov.ranking.map(function (r) { return [r.userId, r]; }));
        var inputs = [];
        var tb = el("tbody");

        usersCache.forEach(function (u) {
          var rowRec = existingByUser.get(u.id);
          var tds = [
            el("td", null, el("span", { class: "exam-no-pill", text: u.examNo || "无" })),
            el("td", null, el("b", { text: u.displayName || u.username }), el("div", { class: "small muted", text: u.department || "未分组" })),
          ];
          exam.subjects.forEach(function (sub) {
            var old = rowRec?.subjectScores?.[sub.id];
            var inp = el("input", {
              type: "number", step: "0.5", min: "0", max: sub.fullScore,
              value: old && !old.absent ? String(old.score) : "",
              placeholder: "0–" + sub.fullScore,
              style: "width:5.5rem",
            });
            var abs = el("input", { type: "checkbox", checked: !!(old && old.absent), title: "缺考" });
            inputs.push({ userId: u.id, subjectId: sub.id, inp: inp, abs: abs, had: !!old });
            tds.push(el("td", null, el("div", { class: "row", style: "flex-wrap:nowrap" }, inp, el("label", { class: "scanner-check" }, abs, "缺"))));
          });
          tb.append(el("tr", null, tds));
        });

        var submitBtn = el("button", { type: "button", class: "btn btn-primary", text: "批量提交已填成绩" });
        submitBtn.addEventListener("click", function () {
          var records = inputs.filter(function (x) { return x.inp.value !== "" || x.abs.checked || x.had; })
            .map(function (x) {
              return { userId: x.userId, subjectId: x.subjectId, score: Number(x.inp.value) || 0, absent: x.abs.checked };
            });
          if (!records.length) return GS.toast("请至少填写一条成绩");
          var done = GS.busy(submitBtn, "批量提交中…");
          GS.api("POST", "/api/exam/admin/exams/" + exam.id + "/scores/batch", { records: records }).then(function (r) {
            GS.toast("成功提交 " + r.saved + " 条成绩记录");
            reloadExamsAndStay();
          }).catch(function (err) { done(); fail(err); });
        });

        workHost.append(
          el("div", { class: "exam-bar" }, el("span", { class: "muted small", text: "留空行跳过不改；勾选「缺」标记为缺考" }), submitBtn),
          el("div", { class: "box table-wrap" }, el("table", { class: "table" },
            el("thead", null, el("tr", null, [
              el("th", { text: "考号" }), el("th", { text: "成员" }),
            ].concat(exam.subjects.map(function (s) { return el("th", { text: s.name + " (" + s.fullScore + ")" }); })))),
            tb,
          )),
        );
      }).catch(fail);
    }
  }

  /* ---------- 7C. 考务：考情分析 ---------- */
  function renderAdminAnalytics(host) {
    host.textContent = "";
    if (!state.exams.length) {
      host.append(el("div", { class: "box" }, el("div", { class: "blankslate" }, icon("graph"), el("h3", { text: "暂无考试数据" }))));
      return;
    }
    if (!state.selectedExamId || !state.exams.some(function (x) { return x.id === state.selectedExamId; })) {
      state.selectedExamId = state.exams[0].id;
    }
    var exSel = el("select", { class: "exam-select" },
      state.exams.map(function (e) { return el("option", { value: e.id, selected: e.id === state.selectedExamId, text: e.title }); }));
    var csvBtn = el("button", { type: "button", class: "btn btn-sm", text: "导出 CSV 成绩单" });
    var bodyHost = el("div", { style: "display:grid;gap:1rem" });
    host.append(el("div", { class: "exam-bar" }, el("div", { class: "exam-bar-left" }, exSel), el("div", { class: "exam-bar-right" }, csvBtn)), bodyHost);

    var currentOv = null;
    function load() {
      GS.api("GET", "/api/exam/admin/exams/" + state.selectedExamId + "/overview").then(function (ov) {
        currentOv = ov;
        bodyHost.textContent = "";
        var s = ov.summary;
        bodyHost.append(el("div", { class: "exam-kpi-grid" },
          el("div", { class: "exam-kpi" }, el("div", { class: "k" }, "实考 / 未录"), el("div", { class: "v" }, String(s.totalParticipants), el("small", { text: " / 待录 " + ov.unscoredUsers.length }))),
          el("div", { class: "exam-kpi" }, el("div", { class: "k" }, "全员均分 / 满分"), el("div", { class: "v" }, String(s.avgTotal), el("small", { text: " / " + ov.exam.fullScore }))),
          el("div", { class: "exam-kpi" }, el("div", { class: "k" }, "中位数 / 标准差"), el("div", { class: "v" }, String(s.medianTotal), el("small", { text: " / σ " + s.stdTotal }))),
          el("div", { class: "exam-kpi" }, el("div", { class: "k" }, "及格率 / 优秀率"), el("div", { class: "v" }, s.passRate + "%", el("small", { text: " / 优 " + s.excellentRate + "%" }))),
        ));

        var maxBand = Math.max(1, Math.max.apply(null, s.scoreBands.map(function (b) { return b.count; })));
        var bandChart = el("div", { class: "chart" },
          s.scoreBands.map(function (b) {
            var bar = el("i");
            bar.style.height = (b.count / maxBand * 100) + "%";
            return el("div", { class: "chart-col" }, el("b", { text: String(b.count) }), el("div", { class: "chart-track" }, bar), el("span", { text: b.label }));
          }));
        bodyHost.append(el("div", { class: "exam-card" },
          el("div", { class: "exam-card-head" }, el("h3", { text: "总分得分率分布" })),
          bandChart,
        ));

        var tb = el("tbody");
        ov.ranking.forEach(function (r) {
          var subCells = ov.subjects.map(function (sub) {
            var rec = r.subjectScores[sub.id];
            return el("td", { style: "font-family:var(--pg-font-mono)", text: rec ? (rec.absent ? "缺考" : String(rec.score)) : "—" });
          });
          tb.append(el("tr", null,
            el("td", { style: "font-family:var(--pg-font-mono);font-weight:700", text: r.rank ? "#" + r.rank : "缺考" }),
            el("td", null, el("span", { class: "exam-no-pill", text: r.examNo || "—" })),
            el("td", null, el("b", { text: r.displayName || r.username }), el("div", { class: "small muted", text: r.department || "—" })),
            subCells,
            el("td", { style: "font-family:var(--pg-font-mono);font-weight:700", text: r.absent ? "缺考" : r.totalScore + " (" + r.rate + "%)" }),
            el("td", null, gradeBadge(r.grade)),
            el("td", null, el("div", { class: "row" },
              el("button", {
                type: "button", class: "btn btn-sm", text: "看报告",
                onclick: function () {
                  state.previewUserQuery = { userId: r.userId, examNo: r.examNo };
                  switchTab("report", { examId: ov.exam.id });
                },
              }),
              el("button", {
                type: "button", class: "btn btn-sm btn-danger", text: "删成绩",
                onclick: function () {
                  GS.dialog({
                    title: "删除「" + (r.displayName || r.username) + "」成绩",
                    danger: true,
                    confirm: "确认删除",
                    text: "将删除该成员在「" + ov.exam.title + "」的全部成绩及错题记录。",
                  }).then(function (ok) {
                    if (!ok) return;
                    return GS.api("DELETE", "/api/exam/admin/exams/" + ov.exam.id + "/scores/" + r.userId).then(function () {
                      GS.toast("已删除该成员成绩");
                      reloadExamsAndStay();
                    });
                  }).catch(fail);
                },
              }),
            )),
          ));
        });
        bodyHost.append(el("div", { class: "box table-wrap" }, el("table", { class: "table" },
          el("thead", null, el("tr", null, [
            el("th", { text: "名次" }), el("th", { text: "考号" }), el("th", { text: "成员" }),
          ].concat(ov.subjects.map(function (sub) { return el("th", { text: sub.name }); }))
            .concat([el("th", { text: "总分" }), el("th", { text: "等第" }), el("th", { text: "操作" })]))),
          tb,
        )));
      }).catch(fail);
    }

    csvBtn.addEventListener("click", function () {
      if (!currentOv) return;
      var heads = ["名次", "考号", "姓名", "用户名", "部门"].concat(currentOv.subjects.map(function (s) { return s.name; })).concat(["总分", "得分率%", "等第"]);
      var lines = [heads.join(",")];
      currentOv.ranking.forEach(function (r) {
        var row = [r.rank || "缺考", '="' + (r.examNo || "") + '"', r.displayName || r.username, r.username, r.department || ""]
          .concat(currentOv.subjects.map(function (s) {
            var sr = r.subjectScores[s.id];
            return sr ? (sr.absent ? "缺考" : sr.score) : "";
          }))
          .concat([r.absent ? "缺考" : r.totalScore, r.rate, r.grade]);
        lines.push(row.map(function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(","));
      });
      var blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
      var a = el("a", { href: URL.createObjectURL(blob), download: currentOv.exam.title + "-成绩单.csv" });
      a.click();
      URL.revokeObjectURL(a.href);
    });

    exSel.addEventListener("change", function () { state.selectedExamId = Number(exSel.value); load(); });
    load();
  }

  /* ---------- 7D. 考务：自动考号分配注册 & 成员管理 ---------- */
  function renderAdminUsers(host) {
    host.textContent = "";

    // 1. 自动考号分配注册系统卡片
    var depts = OFFICIAL_DEPTS.slice();
    var selfRegChk = el("input", { type: "checkbox", class: "switch", checked: true });
    var regMode = "single"; // single | batch
    var quickBody = el("div", { style: "display:grid;gap:.65rem" });
    var credOutHost = el("div");

    GS.api("GET", "/api/exam/admin/settings").then(function (cfg) {
      if (cfg) {
        selfRegChk.checked = cfg.selfRegisterEnabled !== false;
        if (Array.isArray(cfg.departments) && cfg.departments.length) depts = cfg.departments;
      }
    }).catch(function () {});

    selfRegChk.addEventListener("change", function () {
      var nextVal = selfRegChk.checked;
      GS.api("PUT", "/api/exam/admin/settings", { selfRegisterEnabled: nextVal }).then(function (r) {
        selfRegChk.checked = r.selfRegisterEnabled !== false;
        GS.toast(selfRegChk.checked ? "已开启未登录访客自助领取考号" : "已关闭自助考号注册");
      }).catch(function (err) {
        selfRegChk.checked = !nextVal;
        fail(err);
      });
    });

    var modeSingleBtn = el("button", { type: "button", class: "btn btn-sm is-on", text: "单人快速分配" });
    var modeBatchBtn = el("button", { type: "button", class: "btn btn-sm", text: "批量名单分配" });

    function showAllocatedCredentials(list) {
      credOutHost.textContent = "";
      if (!list || !list.length) return;
      var copyAllText = list.map(function (c) {
        return c.fullName + " (" + c.department + ") · 考号/ID/用户名/密码：" + c.examNo;
      }).join("\n");

      credOutHost.append(el("div", { class: "exam-cred-box" },
        el("div", { class: "row", style: "justify-content:space-between" },
          el("strong", { class: "small", text: "已成功分配 " + list.length + " 个 4 位考号账号（用户名 = ID = 密码 = 4 位考号）" }),
          el("button", { type: "button", class: "btn btn-sm", text: "一键复制全部凭证", onclick: function () { copyText(copyAllText, "已复制 " + list.length + " 条考号凭证"); } }),
        ),
        el("div", { class: "table-wrap" }, el("table", { class: "table", style: "font-size:var(--pg-text-xs)" },
          el("thead", null, el("tr", null, ["全名", "所属部门", "4位考号", "用户 ID", "用户名", "初始密码"].map(function (h) { return el("th", { text: h }); }))),
          el("tbody", null, list.map(function (c) {
            return el("tr", null,
              el("td", { style: "font-weight:600", text: c.fullName }),
              el("td", { text: c.department }),
              el("td", null, el("span", { class: "exam-no-pill", text: c.examNo })),
              el("td", { style: "font-family:var(--pg-font-mono)", text: String(c.id) }),
              el("td", { style: "font-family:var(--pg-font-mono)", text: c.username }),
              el("td", { style: "font-family:var(--pg-font-mono)", text: c.password }),
            );
          })),
        )),
      ));
    }

    function drawQuickRegBody() {
      quickBody.textContent = "";
      modeSingleBtn.classList.toggle("is-on", regMode === "single");
      modeBatchBtn.classList.toggle("is-on", regMode === "batch");

      if (regMode === "single") {
        var fullNameInp = el("input", { type: "text", maxlength: "32", placeholder: "输入成员全名，如：马俊宇" });
        var deptSel = el("select", null, depts.map(function (d) { return el("option", { value: d, text: d }); }));
        var goBtn = el("button", { type: "button", class: "btn btn-primary", text: "自动分配 4 位考号并注册" });
        goBtn.addEventListener("click", function () {
          var fullName = fullNameInp.value.trim();
          if (!fullName) {
            GS.toast("请输入全名");
            fullNameInp.focus();
            return;
          }
          var done = GS.busy(goBtn, "分配注册中…");
          GS.api("POST", "/api/exam/admin/users/auto-register", {
            fullName: fullName,
            department: deptSel.value,
          }).then(function (r) {
            fullNameInp.value = "";
            showAllocatedCredentials(r.created);
            GS.toast("已分配考号 " + (r.created[0] ? r.created[0].examNo : ""));
            load();
          }).catch(fail).finally(done);
        });
        quickBody.append(el("div", { class: "exam-quick-fields" },
          el("div", { class: "field" }, el("label", { text: "全名" }), fullNameInp),
          el("div", { class: "field" }, el("label", { text: "所属部门" }), deptSel),
          goBtn,
        ));
      } else {
        var defDeptSel = el("select", { style: "max-width:12rem" }, depts.map(function (d) { return el("option", { value: d, text: d }); }));
        var ta = el("textarea", {
          rows: "4",
          placeholder: "每行一人：全名 或 全名 部门（支持空格/制表符/逗号分隔，最多 30 人）\n例如：\n马俊宇 管理部\n林浩 内核开发部\n张伟",
        });
        var batchBtn = el("button", { type: "button", class: "btn btn-primary", text: "批量分配考号并注册" });
        batchBtn.addEventListener("click", function () {
          var lines = ta.value.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
          if (!lines.length) return GS.toast("请至少输入 1 名成员姓名");
          if (lines.length > 30) return GS.toast("单次最多批量分配 30 人");
          var entries = lines.map(function (line) {
            var parts = line.split(/[\s,，\t]+/).filter(Boolean);
            var last = parts.length > 1 ? parts[parts.length - 1] : "";
            if (parts.length > 1 && depts.indexOf(last) !== -1) {
              return { fullName: parts.slice(0, -1).join(" "), department: last };
            }
            return { fullName: line, department: defDeptSel.value };
          });
          var done = GS.busy(batchBtn, "批量分配中…");
          GS.api("POST", "/api/exam/admin/users/auto-register", { entries: entries }).then(function (r) {
            ta.value = "";
            showAllocatedCredentials(r.created);
            GS.toast("批量分配完成：共创建 " + r.created.length + " 个考号账号");
            load();
          }).catch(fail).finally(done);
        });
        quickBody.append(
          el("div", { class: "row", style: "justify-content:space-between" },
            el("div", { class: "row" }, el("span", { class: "small muted", text: "未指定部门时默认分配至：" }), defDeptSel),
            el("div", { class: "row" }, batchBtn),
          ),
          ta,
        );
      }
    }

    modeSingleBtn.addEventListener("click", function () { regMode = "single"; drawQuickRegBody(); });
    modeBatchBtn.addEventListener("click", function () { regMode = "batch"; drawQuickRegBody(); });
    drawQuickRegBody();

    var quickRegCard = el("div", { class: "exam-quick-reg" },
      el("div", { class: "exam-bar", style: "margin-bottom:0" },
        el("div", null,
          el("h3", { style: "margin:0;font-size:.95rem;font-weight:600", text: "自动考号分配注册系统" }),
          el("div", { class: "small muted", text: "输入全名和部门（" + OFFICIAL_DEPTS.join(" / ") + "），自动分配 4 位考号，用户名 = ID = 密码 = 该 4 位考号" }),
        ),
        el("label", { class: "scanner-check" }, selfRegChk, "允许未登录访客在 /exam 自助领取考号"),
      ),
      el("div", { class: "row" }, modeSingleBtn, modeBatchBtn),
      quickBody,
      credOutHost,
    );

    // 2. 成员列表检索与筛选
    var qInp = el("input", { type: "search", placeholder: "搜索 4 位考号、用户名、姓名、邮箱或部门", style: "max-width:20rem" });
    var deptFilter = el("select", { style: "max-width:11rem", "aria-label": "按部门筛选" },
      el("option", { value: "", text: "全部部门" }),
      OFFICIAL_DEPTS.map(function (d) { return el("option", { value: d, text: d }); }),
    );
    var addBtn = el("button", { type: "button", class: "btn btn-sm", onclick: function () { openUserModal(null); } }, icon("plus"), "手动新增账号");
    var wrap = el("div", { class: "box table-wrap" });

    host.append(
      quickRegCard,
      el("div", { class: "exam-bar" }, el("div", { class: "exam-bar-left" }, qInp, deptFilter), el("div", { class: "exam-bar-right" }, addBtn)),
      wrap,
    );

    var timer;
    qInp.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(load, 200); });
    deptFilter.addEventListener("change", load);

    function load() {
      var qs = ["q=" + encodeURIComponent(qInp.value.trim())];
      if (deptFilter.value) qs.push("department=" + encodeURIComponent(deptFilter.value));
      GS.api("GET", "/api/exam/admin/users?" + qs.join("&")).then(function (d) {
        var tb = el("tbody");
        d.users.forEach(function (u) {
          tb.append(el("tr", null,
            el("td", null, u.examNo ? el("span", { class: "exam-no-pill", text: u.examNo }) : el("span", { class: "muted small", text: "未分配" })),
            el("td", null, el("div", { class: "user-cell" }, GS.avatar(u.username),
              el("div", null, el("b", { text: u.displayName || u.username }),
                el("div", { class: "small muted", text: "ID " + u.id + " · @" + u.username + " · " + u.email })))),
            el("td", { text: u.department || "—" }),
            el("td", null, el("div", { class: "row" },
              u.role === "admin" ? label("管理员", "accent") : label("员工"),
              u.banned ? label("已封禁", "danger") : null,
              u.emailVerified ? null : label("未验证", "attention"),
            )),
            el("td", { style: "font-family:var(--pg-font-mono)", text: u.examCount + " 次" + (u.latestRate !== null ? " · 最近 " + u.latestRate + "%" : "") }),
            el("td", null, el("div", { class: "row" },
              el("button", { type: "button", class: "btn btn-sm", text: "修改", onclick: function () { openUserModal(u); } }),
              u.id !== state.me.id ? el("button", { type: "button", class: "btn btn-sm btn-danger", text: "删除", onclick: function () {
                GS.dialog({ title: "删除用户 " + (u.displayName || u.username), danger: true, confirm: "永久删除",
                  text: "将永久删除该账号及其全部考试成绩、错题本和扫描试卷，不可恢复。" })
                  .then(function (ok) {
                    if (ok) return GS.api("DELETE", "/api/exam/admin/users/" + u.id).then(function () { GS.toast("用户已删除"); load(); });
                  }).catch(fail);
              } }) : null,
            )),
          ));
        });
        wrap.replaceChildren(el("table", { class: "table" },
          el("thead", null, el("tr", null, ["4位考号", "成员", "部门", "角色/状态", "考情", "操作"].map(function (h) { return el("th", { text: h }); }))),
          tb,
        ));
        if (!d.users.length) wrap.replaceChildren(el("div", { class: "blankslate" }, icon("search"), el("h3", { text: "没有匹配的成员" })));
      }).catch(fail);
    }

    function openUserModal(u) {
      var isNew = !u;
      var dlg = el("dialog", { class: "ui-dialog ui", style: "width:min(100% - 1.5rem, 30rem)", "aria-label": isNew ? "新增用户" : "修改用户" });
      dlg.setAttribute("data-lenis-prevent", "");

      var usernameI = el("input", { value: u ? u.username : "", placeholder: "2–24 位字母/数字/中文", required: true });
      var nameI = el("input", { value: u ? u.displayName : "", placeholder: "员工真实姓名或显示昵称" });
      var emailI = el("input", { type: "email", value: u ? u.email : "", placeholder: "name@goutoustdio.top", required: true });
      var examNoI = el("input", { value: u ? u.examNo : "", maxlength: "4", inputmode: "numeric", placeholder: "4位数字如 0413（可留空）" });
      var genBtn = el("button", { type: "button", class: "btn btn-sm", text: "随机考号", onclick: function () {
        GS.api("GET", "/api/exam/admin/users/next-exam-no").then(function (r) { examNoI.value = r.examNo; }).catch(fail);
      } });
      var deptList = el("datalist", { id: "exam-dept-list" },
        OFFICIAL_DEPTS.map(function (d) { return el("option", { value: d }); }));
      var deptI = el("input", { value: u ? u.department : "", list: "exam-dept-list", placeholder: "选择或输入部门（如：管理部）" });
      var roleSel = el("select", null,
        el("option", { value: "user", selected: !u || u.role === "user", text: "普通员工" }),
        el("option", { value: "admin", selected: u && u.role === "admin", text: "管理员（可录分/扫卷/管理用户）" }),
      );
      var pwI = el("input", { type: "password", placeholder: isNew ? "4–128 位初始密码（支持 4 位，如 0413）" : "留空则不修改密码（支持 4–128 位）" });
      var sameNoBtn = el("button", { type: "button", class: "btn btn-sm", text: "同考号", onclick: function () {
        var no = examNoI.value.trim();
        if (!/^\d{4}$/.test(no)) return GS.toast("请先填写 4 位考号");
        pwI.value = no;
        GS.toast("已将密码设为考号 " + no);
      } });
      var banChk = el("input", { type: "checkbox", checked: !!(u && u.banned) });
      var verChk = el("input", { type: "checkbox", checked: isNew ? true : !!(u && u.emailVerified) });

      var saveBtn = el("button", { type: "button", class: "btn btn-primary", text: isNew ? "创建账号" : "保存修改" });
      var cancelBtn = el("button", { type: "button", class: "btn", text: "取消" });

      dlg.append(
        el("header", null, icon("people"), el("span", { class: "grow", text: isNew ? "手动新增员工账号" : "编辑成员：" + (u.displayName || u.username) })),
        el("div", { class: "dialog-body" },
          deptList,
          el("div", { class: "field" }, el("label", { text: "4 位考号" }), el("div", { class: "row" }, el("div", { class: "grow" }, examNoI), genBtn)),
          el("div", { class: "field", style: "margin-top:.75rem" }, el("label", { text: "用户名" }), usernameI),
          el("div", { class: "field", style: "margin-top:.75rem" }, el("label", { text: "全名 / 昵称" }), nameI),
          el("div", { class: "field", style: "margin-top:.75rem" }, el("label", { text: "邮箱" }), emailI),
          el("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:.75rem;margin-top:.75rem" },
            el("div", { class: "field" }, el("label", { text: "所属部门" }), deptI),
            el("div", { class: "field" }, el("label", { text: "账号角色" }), roleSel),
          ),
          el("div", { class: "field", style: "margin-top:.75rem" }, el("label", { text: isNew ? "初始密码" : "重置密码（可选）" }),
            el("div", { class: "row" }, el("div", { class: "grow" }, pwI), sameNoBtn)),
          el("div", { class: "row", style: "margin-top:.85rem" },
            el("label", { class: "scanner-check" }, verChk, "邮箱已验证"),
            !isNew && u.id !== state.me.id ? el("label", { class: "scanner-check" }, banChk, "封禁此账号") : null,
          ),
        ),
        el("footer", null, cancelBtn, saveBtn),
      );
      document.body.appendChild(dlg);
      function close() { dlg.close(); dlg.remove(); }
      cancelBtn.addEventListener("click", close);
      dlg.addEventListener("cancel", function (e) { e.preventDefault(); close(); });
      saveBtn.addEventListener("click", function () {
        var done = GS.busy(saveBtn, "保存中…");
        var payload = {
          username: usernameI.value.trim(),
          displayName: nameI.value.trim(),
          email: emailI.value.trim(),
          examNo: examNoI.value.trim(),
          department: deptI.value.trim(),
          role: roleSel.value,
          emailVerified: verChk.checked,
        };
        if (pwI.value) payload.password = pwI.value;
        if (!isNew && u.id !== state.me.id) payload.banned = banChk.checked;

        var req = isNew
          ? GS.api("POST", "/api/exam/admin/users", payload)
          : GS.api("PATCH", "/api/exam/admin/users/" + u.id, payload);
        req.then(function () {
          GS.toast(isNew ? "员工账号已创建" : "账号信息已更新");
          close();
          load();
          if (!isNew && u.id === state.me.id) {
            GS.api("GET", "/api/exam/me").then(function (em) { state.examMe = em; renderIdCard(); }).catch(function () {});
          }
        }).catch(function (err) { done(); fail(err); });
      });
      dlg.showModal();
    }

    load();
  }

  /* ---------- 8. 主渲染入口 ---------- */
  function renderActiveTab() {
    if (!state.me) return;
    if (state.activeTab === "report") renderReportTab();
    else if (state.activeTab === "papers") renderPapersTab();
    else if (state.activeTab === "mistakes") renderMistakesTab();
    else if (state.activeTab === "admin-exams") renderAdminExams(root);
    else if (state.activeTab === "admin-scoring") renderAdminScoring(root);
    else if (state.activeTab === "admin-analytics") renderAdminAnalytics(root);
    else if (state.activeTab === "admin-users") renderAdminUsers(root);
  }

  GS.me().then(function (u) {
    state.me = u;
    if (!u) {
      renderIdCard();
      renderGuestAuth();
      return;
    }

    shell.classList.remove("is-guest");
    sidebar.hidden = false;
    adminNav.hidden = u.role !== "admin";

    Promise.all([GS.api("GET", "/api/exam/me"), GS.api("GET", "/api/exam/list")]).then(function (res) {
      state.examMe = res[0];
      state.exams = res[1].exams;
      renderIdCard();
      switchTab(parseInitialTab());
    }).catch(fail);
  });
})();
