    (function () {
      function fmtSize(bytes) {
        if (typeof bytes !== "number" || bytes < 0) return "未知";
        if (bytes === 0) return "0 B";
        var units = ["B", "KB", "MB", "GB"];
        var i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
        return (bytes / Math.pow(1024, i)).toFixed(1) + " " + units[i];
      }
      function stageOf(s) { return (s || "").toLowerCase(); }
      function badgeFor(stage) {
        if (/(^|[^a-z])(rc|beta|pre|alpha|dev|nightly)([^a-z]|$)/.test(stage)) {
          if (stage.indexOf("rc") !== -1) return ["候选发布版", "badge-warn"];
          if (stage.indexOf("beta") !== -1) return ["测试版", "badge-warn"];
          return ["预发布版", "badge-warn"];
        }
        return ["正式版", "badge-ok"];
      }
      function set(id, text) {
        var el = document.getElementById(id);
        if (el) el.textContent = text;
      }
      async function load() {
        var res;
        try {
          res = await fetch("version.json", { cache: "no-store" });
        } catch (e) { return; }
        if (!res.ok) return;
        var d;
        try { d = await res.json(); } catch (e) { return; }
        if (d.version) set("f-version", d.version);
        if (d.release_date) set("f-date", d.release_date);
        var sizeNum = Number(d.file_size);
        if (d.file_size != null && isFinite(sizeNum)) set("f-size", fmtSize(sizeNum));
        if (d.sha256) set("f-sha", d.sha256);
        var badge = document.getElementById("stage-badge");
        if (badge) {
          var t = badgeFor(stageOf(d.develop_stage));
          badge.textContent = t[0];
          badge.className = "badge " + t[1];
        }
        var dl = document.getElementById("dl-primary");
        if (dl) {
          if (d.download_url) dl.setAttribute("href", d.download_url);
          var label = dl.querySelector(".btn-label") || dl;
          if (d.version) label.textContent = "下载 v" + d.version + " 更新包";
        }
        var log = document.getElementById("changelog-body");
        if (log && typeof d.release_notes === "string" && d.release_notes.trim()) {
          log.textContent = "";
          var ul = document.createElement("ul");
          d.release_notes.split("\n").forEach(function (line) {
            line = line.trim();
            if (!line) return;
            var li = document.createElement("li");
            li.textContent = line;
            ul.appendChild(li);
          });
          log.appendChild(ul);
        }
      }
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", load);
      } else {
        load();
      }
    })();
