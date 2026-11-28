/* 全站主导航单一配置文件（Single Source of Truth）：
   所有页面（主站 / OTA / 账号 / 内部考试 / 开放平台）的顶部主菜单都在此处维护。
   新增、修改或分组调整页面入口时，只需改动本文件即可全站同步生效。 */
(function () {
  "use strict";

  var NAV_ITEMS = [
    {
      id: "products",
      label: "产品",
      cols: 2,
      groups: [
        {
          title: "核心项目",
          items: [
            { label: "SpaceOS 9", href: "/spaceos9.html", desc: "Rust 内核 · 兼容 Linux ABI", icon: "#i-chip" },
            { label: "PySpOS", href: "/pyspos.html", desc: "Python 编写的模拟操作系统", icon: "#i-terminal" },
            { label: "SpaceOS 8", href: "/spaceos8.html", desc: "早期图形桌面迭代版本", icon: "#i-window" },
          ],
        },
        {
          title: "规格与存档",
          items: [
            { label: "配置要求", href: "/requirements.html", desc: "硬件与虚拟机运行环境说明", icon: "#i-layers" },
            { label: "SpaceOS 7", href: "/spaceos7.html", desc: "历史架构归档版本", icon: "#i-archive" },
            { label: "SpaceOS 6", href: "/spaceos6.html", desc: "早期原型归档版本", icon: "#i-archive" },
          ],
        },
      ],
    },
    {
      id: "downloads",
      label: "下载",
      cols: 2,
      groups: [
        {
          title: "SpaceOS",
          items: [
            { label: "SpaceOS 9 镜像", href: "/spaceos9-download.html", desc: "x86_64 ISO 镜像与校验", icon: "#i-download" },
            { label: "SpaceOS 9 软件源", href: "/spaceos/repo/", desc: "SPK 在线软件仓库索引", icon: "#i-server" },
            { label: "SpaceOS 8 镜像", href: "/spaceos8-download.html", desc: "经典桌面版历史镜像", icon: "#i-window" },
          ],
        },
        {
          title: "PySpOS",
          items: [
            { label: "PySpOS 更新包", href: "/ota/index.html", desc: "最新版 OTA 增量更新", icon: "#i-terminal" },
            { label: "PySpOS 版本历史", href: "/ota/releases.html", desc: "全部发布记录与变更日志", icon: "#i-clock" },
          ],
        },
      ],
    },
    {
      id: "docs",
      label: "开放平台",
      href: "/docs",
      match: ["/docs"],
    },
    {
      id: "game",
      label: "游戏",
      href: "/game",
      match: ["/game"],
    },
    {
      id: "exam",
      label: "内部考试",
      href: "/exam",
      match: ["/exam"],
    },
    {
      id: "more",
      label: "更多",
      align: "right",
      groups: [
        {
          title: "支持与社区",
          items: [
            { label: "问题反馈", href: "/support", match: ["/support"], desc: "提交工单与 Bug 报告", icon: "#i-mail" },
            { label: "GitHub", href: "https://github.com/ViudiraTech", external: true, desc: "查看全部开源仓库代码", icon: "#i-code" },
            { label: "联系我们", href: "/#contact", desc: "小组介绍与邮件联系方式", icon: "#i-info" },
          ],
        },
      ],
    },
  ];

  // 开放平台文档页（/docs/*）顶部关联链接，同样统一从此处维护
  var DOCS_TOP_NAV = [
    { label: "文档", href: "/docs", current: true },
    { label: "控制台", href: "https://pay.goutoustdio.top/merchant", rel: "noopener" },
    { label: "内部考试", href: "/exam" },
    { label: "问题反馈", href: "/support" },
    { label: "主站", href: "/" },
  ];

  function normalizePath(p) {
    if (!p) return "/";
    var s = String(p).split("#")[0].split("?")[0];
    if (s === "/index.html") return "/";
    if (s.length > 1 && s.slice(-1) === "/") return s.slice(0, -1);
    return s;
  }

  function isMatch(item, curPath) {
    if (item.external) return false;
    var href = item.href || "";
    if (href.indexOf("#") !== -1) return false;
    var target = normalizePath(href);
    if (curPath === target) return true;
    if (Array.isArray(item.match)) {
      for (var i = 0; i < item.match.length; i++) {
        var prefix = normalizePath(item.match[i]);
        if (curPath === prefix || curPath.indexOf(prefix + "/") === 0) return true;
      }
    }
    return false;
  }

  function svgIcon(cls, href) {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", cls);
    svg.setAttribute("aria-hidden", "true");
    var use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", href);
    svg.appendChild(use);
    return svg;
  }

  function buildLink(item, curPath, inDropdown) {
    var a = document.createElement("a");
    a.href = item.href;
    if (item.external) {
      a.rel = "noopener";
      a.target = "_blank";
    }
    var active = isMatch(item, curPath);
    if (active) a.setAttribute("aria-current", "page");

    if (inDropdown) {
      a.className = "menu-item";
      if (item.icon) {
        var ico = document.createElement("span");
        ico.className = "menu-ico";
        ico.setAttribute("aria-hidden", "true");
        ico.appendChild(svgIcon("icon", item.icon));
        a.appendChild(ico);
      }
      var textWrap = document.createElement("span");
      textWrap.className = "menu-text";
      var title = document.createElement("span");
      title.className = "menu-title";
      title.textContent = item.label;
      if (item.external) title.appendChild(svgIcon("icon ext", "#i-external"));
      textWrap.appendChild(title);
      if (item.desc) {
        var desc = document.createElement("span");
        desc.className = "menu-desc";
        desc.textContent = item.desc;
        textWrap.appendChild(desc);
      }
      a.appendChild(textWrap);
    } else {
      a.textContent = item.label;
      if (item.external) a.appendChild(svgIcon("icon ext", "#i-external"));
    }
    return { el: a, active: active };
  }

  function renderSiteNav(target) {
    var nav = target || document.getElementById("site-nav");
    if (!nav) return;

    var curPath = normalizePath(typeof location !== "undefined" ? location.pathname : "/");
    var ul = document.createElement("ul");

    NAV_ITEMS.forEach(function (entry) {
      var li = document.createElement("li");

      if (!entry.groups) {
        var direct = buildLink(entry, curPath, false);
        li.appendChild(direct.el);
        ul.appendChild(li);
        return;
      }

      var details = document.createElement("details");
      details.className = "menu";

      var summary = document.createElement("summary");
      summary.appendChild(document.createTextNode(entry.label));
      summary.appendChild(svgIcon("icon chev", "#i-chevron"));
      details.appendChild(summary);

      var panel = document.createElement("div");
      panel.className = "menu-panel"
        + (entry.cols === 2 ? " menu-panel-cols" : "")
        + (entry.align === "right" ? " menu-panel-right" : "");

      var hasActiveChild = false;
      entry.groups.forEach(function (grp) {
        var grpEl = document.createElement("div");
        grpEl.className = "menu-group";
        if (grp.title) {
          var gTitle = document.createElement("div");
          gTitle.className = "menu-group-title";
          gTitle.textContent = grp.title;
          grpEl.appendChild(gTitle);
        }
        var subUl = document.createElement("ul");
        grp.items.forEach(function (subItem) {
          var subLi = document.createElement("li");
          var built = buildLink(subItem, curPath, true);
          if (built.active) hasActiveChild = true;
          subLi.appendChild(built.el);
          subUl.appendChild(subLi);
        });
        grpEl.appendChild(subUl);
        panel.appendChild(grpEl);
      });

      if (hasActiveChild) details.classList.add("is-current");
      details.appendChild(panel);
      li.appendChild(details);
      ul.appendChild(li);
    });

    nav.replaceChildren(ul);
  }

  window.GS_NAV = {
    items: NAV_ITEMS,
    docsTopNav: DOCS_TOP_NAV,
    render: renderSiteNav,
  };

  renderSiteNav();
})();
