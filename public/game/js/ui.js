// DOM HUD / 菜单 / 房间 / 结算面板。所有用户名字都通过 textContent 写入。

export class UI {
  constructor() {
    const $ = (id) => document.getElementById(id);
    this.$ = $;
    this.el = {
      boot: $("boot"),
      bootStatus: $("boot-status"),
      bootRetry: $("boot-retry"),
      menu: $("menu"),
      nameInput: $("name-input"),
      joinForm: $("join-form"),
      joinCode: $("join-code"),
      room: $("room"),
      roomCode: $("room-code"),
      roomStatus: $("room-status"),
      roomSeats: $("room-seats"),
      roomCountdown: $("room-countdown"),
      hud: $("hud"),
      minimap: $("minimap"),
      scope: $("scope"),
      adsDot: $("ads-dot"),
      damageDir: $("damage-dir"),
      damageNumbers: $("damage-numbers"),
      scoreYou: $("score-you"),
      scoreThem: $("score-them"),
      nameYou: $("name-you"),
      nameThem: $("name-them"),
      scoreTarget: $("score-target"),
      scoreFillYou: $("score-fill-you"),
      scoreFillThem: $("score-fill-them"),
      pingLabel: $("ping-label"),
      qualityLabel: $("quality-label"),
      killfeed: $("killfeed"),
      crosshair: $("crosshair"),
      hitmarker: $("hitmarker"),
      hpValue: $("hp-value"),
      hpFill: $("hp-fill"),
      weaponName: $("weapon-name"),
      ammoMag: $("ammo-mag"),
      ammoReserve: $("ammo-reserve"),
      ammoFill: $("ammo-fill"),
      reloadLabel: $("reload-label"),
      centerStatus: $("center-status"),
      damageFlash: $("damage-flash"),
      lowHp: $("low-hp"),
      scoreboard: $("scoreboard"),
      scoreboardRows: $("scoreboard-rows"),
      scoreboardTarget: $("scoreboard-target"),
      hintBar: $("hint-bar"),
      overlay: $("overlay"),
      overlayPanel: $("overlay-panel"),
      overlayEyebrow: $("overlay-eyebrow"),
      overlayTitle: $("overlay-title"),
      overlayText: $("overlay-text"),
      overlayScore: $("overlay-score"),
      overlayPrimary: $("btn-overlay-primary"),
      overlaySecondary: $("btn-overlay-secondary"),
      toastStack: $("toast-stack"),
      menuButtons: [ $("btn-quick"), $("btn-create"), $("btn-practice") ],
    };
    this.centerTimer = 0;
    this.damageTimer = 0;
    this.hitTimer = 0;
    this.settings = { sens: 1, fov: 82, quality: "auto", volume: 0.6, assist: "standard" };
    this.onSetting = null;
    this._bindSettings();
  }

  _bindSettings() {
    const pairs = {
      sens: ["set-sens", "set-sens-2"],
      fov: ["set-fov", "set-fov-2"],
      quality: ["set-quality", "set-quality-2"],
      volume: ["set-volume", "set-volume-2"],
      assist: ["set-assist", "set-assist-2"],
    };
    this._settingsPairs = pairs;
    for (const [key, ids] of Object.entries(pairs)) {
      for (const id of ids) {
        const el = this.$(id);
        if (!el) continue;
        const handler = () => {
          const value = (key === "quality" || key === "assist") ? el.value : Number(el.value);
          this._applySetting(key, value);
          if (this.onSetting) this.onSetting(key, this.settings[key]);
        };
        el.addEventListener("input", handler);
        el.addEventListener("change", handler);
      }
    }
  }

  _applySetting(key, value) {
    this.settings[key] = value;
    for (const id of this._settingsPairs[key] || []) {
      const el = this.$(id);
      if (!el) continue;
      if (String(el.value) !== String(value)) el.value = value;
    }
  }

  setSettings(values) {
    for (const key of ["sens", "fov", "quality", "volume", "assist"]) {
      if (values[key] !== undefined) this._applySetting(key, values[key]);
    }
  }

  onSettingChange(fn) {
    this.onSetting = fn;
  }

  // ---------- 屏幕 ----------
  showBoot(message) {
    this.el.boot.classList.remove("hidden");
    this.el.menu.classList.add("hidden");
    this.el.room.classList.add("hidden");
    this.el.bootRetry.classList.add("hidden");
    if (message) this.el.bootStatus.textContent = message;
  }

  bootError(message) {
    this.el.boot.classList.remove("hidden");
    this.el.menu.classList.add("hidden");
    this.el.room.classList.add("hidden");
    this.el.bootStatus.textContent = message;
    this.el.bootRetry.classList.remove("hidden");
  }

  onRetry(fn) {
    this.el.bootRetry.addEventListener("click", fn);
  }

  hideBoot() {
    this.el.boot.classList.add("hidden");
    this.el.menu.classList.add("hidden");
  }

  showMenu() {
    this.el.boot.classList.add("hidden");
    this.el.room.classList.add("hidden");
    this.el.menu.classList.remove("hidden");
    this.hideHud();
    this.hideOverlay();
    this._clearKillfeed();
  }

  showRoom(info) {
    this.el.boot.classList.add("hidden");
    this.el.menu.classList.add("hidden");
    this.el.room.classList.remove("hidden");
    this.hideHud();
    this.hideOverlay();
    this.setRoom(info);
  }

  hideRoom() {
    this.el.room.classList.add("hidden");
  }

  setRoom(info) {
    if (!info) return;
    this.el.roomCode.textContent = info.code || "-----";
    const humans = (info.seats || []).filter((s) => s && !s.bot).length;
    let status = "正在准备房间…";
    if (info.state === "countdown") status = "对手已就位，准备开始";
    else if (info.state === "live") status = "对局进行中";
    else if (info.state === "ended") status = "对局已结束";
    else if (info.practice) status = "单人练习 · 机器人陪练";
    else if (humans >= 2) status = "双方已就位";
    else if (humans === 1) status = "等待对手加入…";
    this.el.roomStatus.textContent = status;

    this.el.roomSeats.replaceChildren();
    for (let i = 0; i < 2; i++) {
      const seat = (info.seats || [])[i];
      const card = document.createElement("div");
      const isYou = info.youSlot === i;
      card.className = "seat" + (isYou ? " you" : "") + (!seat ? " empty" : "");
      const name = document.createElement("span");
      name.className = "seat-name";
      name.textContent = seat ? seat.name : "等待加入";
      const tag = document.createElement("span");
      tag.className = "seat-tag";
      if (!seat) tag.textContent = "空位";
      else if (seat.bot) tag.textContent = "机器人";
      else if (seat.connected === false) tag.textContent = "断线重连中…";
      else tag.textContent = isYou ? "你 · 已就位" : "已就位";
      if (seat && seat.connected !== false && !seat.bot) tag.classList.add("seat-ready");
      card.appendChild(name);
      card.appendChild(tag);
      this.el.roomSeats.appendChild(card);
      if (i === 0) {
        const vs = document.createElement("div");
        vs.className = "vs";
        vs.textContent = "VS";
        this.el.roomSeats.appendChild(vs);
      }
    }

    if (info.state === "countdown") {
      const n = Math.max(0, Math.ceil(info.countdown || 0));
      this.el.roomCountdown.textContent = `${n} 秒后进入战场`;
    } else if (info.state === "waiting") {
      this.el.roomCountdown.textContent = info.practice ? "" : "把房间码发给对手";
    } else {
      this.el.roomCountdown.textContent = "";
    }
  }

  // ---------- HUD ----------
  showHud() {
    this.el.hud.classList.remove("hidden");
    this.el.hud.setAttribute("aria-hidden", "false");
  }

  hideHud() {
    this.el.hud.classList.add("hidden");
    this.el.hud.setAttribute("aria-hidden", "true");
    this.el.scope.classList.remove("on", "assist");
    this.el.adsDot.classList.remove("on", "assist");
    this.el.crosshair.classList.remove("assist");
    this.el.damageDir.classList.remove("on");
    this.el.damageNumbers.replaceChildren();
    this.el.scoreboard.classList.add("hidden");
    this.el.centerStatus.classList.remove("on", "big", "danger");
    this.el.lowHp.classList.remove("on");
    this.el.damageFlash.classList.remove("on");
  }

  setScore(score, mySlot, names, target) {
    const a = score?.[mySlot] || 0;
    const b = score?.[1 - mySlot] || 0;
    this.el.scoreYou.textContent = a;
    this.el.scoreThem.textContent = b;
    this.el.nameYou.textContent = names?.you || "你";
    this.el.nameThem.textContent = names?.them || "对手";
    this.el.scoreTarget.textContent = target || 10;
    this.el.scoreboardTarget.textContent = target || 10;
    const max = Math.max(1, target || 10);
    this.el.scoreFillYou.style.width = `${Math.min(100, (a / max) * 100)}%`;
    this.el.scoreFillThem.style.width = `${Math.min(100, (b / max) * 100)}%`;
  }

  setHealth(hp) {
    const v = Math.max(0, Math.round(hp || 0));
    this.el.hpValue.textContent = v;
    this.el.hpFill.style.width = `${Math.min(100, v)}%`;
    this.el.hpFill.style.background = v <= 30 ? "var(--gs-orange)" : "var(--gs-cyan)";
    this.el.lowHp.classList.toggle("on", v > 0 && v <= 30);
  }

  setAmmo({ weapon, mag, reserve, magSize, reload }) {
    this.el.weaponName.textContent = weapon?.name || "AR-15";
    this.el.ammoMag.textContent = Math.max(0, mag | 0);
    this.el.ammoReserve.textContent = Math.max(0, reserve | 0);
    const size = Math.max(1, magSize || 30);
    this.el.ammoFill.style.width = `${Math.min(100, ((mag | 0) / size) * 100)}%`;
    if (reload > 0) {
      this.el.reloadLabel.textContent = `换弹中 ${reload.toFixed(1)}s`;
      this.el.reloadLabel.className = "reload-label on";
    } else if ((mag | 0) <= 0) {
      this.el.reloadLabel.textContent = "弹匣已空 · R 换弹";
      this.el.reloadLabel.className = "reload-label warn";
    } else if ((mag | 0) <= 5) {
      this.el.reloadLabel.textContent = "R 换弹";
      this.el.reloadLabel.className = "reload-label warn";
    } else {
      this.el.reloadLabel.className = "reload-label";
      this.el.reloadLabel.textContent = "R 换弹";
    }
  }

  setCrosshair(spread) {
    const gap = Math.max(3, Math.min(42, 4 + (spread || 0) * 820));
    this.el.crosshair.style.setProperty("--gap", `${gap.toFixed(1)}px`);
  }

  hitmarker(head, kill = false) {
    const el = this.el.hitmarker;
    el.classList.remove("show", "head", "kill");
    // 强制重排以便连续命中也能重播动画
    void el.offsetWidth;
    el.classList.add("show");
    if (head) el.classList.add("head");
    if (kill) el.classList.add("kill");
    clearTimeout(this.hitTimer);
    this.hitTimer = setTimeout(() => el.classList.remove("show", "head", "kill"), 260);
  }

  setScope(scopeOn, adsOn) {
    this.el.scope.classList.toggle("on", !!scopeOn);
    this.el.adsDot.classList.toggle("on", !!adsOn);
  }

  setAssist(active, scoped = false) {
    this.el.crosshair.classList.toggle("assist", !!active && !scoped);
    this.el.adsDot.classList.toggle("assist", !!active && !scoped);
    this.el.scope.classList.toggle("assist", !!active && scoped);
  }

  damageDirection(angleDeg) {
    const el = this.el.damageDir;
    el.style.setProperty("--a", `${Math.round(angleDeg)}deg`);
    el.classList.add("on");
    clearTimeout(this.damageDirTimer);
    this.damageDirTimer = setTimeout(() => el.classList.remove("on"), 820);
  }

  damageNumber(dmg, head = false, kill = false) {
    const el = document.createElement("div");
    el.className = "dmg-num" + (head ? " head" : "") + (kill ? " kill" : "");
    el.textContent = `${Math.round(dmg)}`;
    el.style.marginLeft = `${(Math.random() - 0.5) * 96}px`;
    el.style.marginTop = `${(Math.random() - 0.5) * 26}px`;
    this.el.damageNumbers.appendChild(el);
    setTimeout(() => el.remove(), 950);
  }

  addKillFeed({ killer, victim, head, involvesMe }) {
    const item = document.createElement("div");
    item.className = "feed-item" + (involvesMe ? " involves" : "");
    const k = document.createElement("b");
    k.className = "killer";
    k.textContent = killer || "？";
    const verb = document.createElement("span");
    verb.textContent = "击杀";
    const v = document.createElement("b");
    v.className = "victim";
    v.textContent = victim || "？";
    item.appendChild(k);
    item.appendChild(verb);
    item.appendChild(v);
    if (head) {
      const hs = document.createElement("span");
      hs.className = "hs";
      hs.textContent = "爆头";
      item.appendChild(hs);
    }
    this.el.killfeed.appendChild(item);
    while (this.el.killfeed.children.length > 5) this.el.killfeed.firstChild.remove();
    setTimeout(() => {
      item.style.opacity = "0";
      item.style.transition = "opacity 240ms ease";
      setTimeout(() => item.remove(), 260);
    }, 5200);
  }

  _clearKillfeed() {
    this.el.killfeed.replaceChildren();
  }

  center(text, { big = false, danger = false, duration = 0 } = {}) {
    const el = this.el.centerStatus;
    el.textContent = text || "";
    el.classList.toggle("on", !!text);
    el.classList.toggle("big", !!big);
    el.classList.toggle("danger", !!danger);
    clearTimeout(this.centerTimer);
    if (text && duration > 0) {
      this.centerTimer = setTimeout(() => this.clearCenter(), duration);
    }
  }

  clearCenter() {
    this.el.centerStatus.classList.remove("on", "big", "danger");
  }

  damage() {
    const el = this.el.damageFlash;
    el.classList.add("on");
    clearTimeout(this.damageTimer);
    this.damageTimer = setTimeout(() => el.classList.remove("on"), 130);
  }

  setPing(rtt) {
    const ms = Math.max(0, Math.round((rtt || 0) * 1000));
    this.el.pingLabel.textContent = `${ms} ms`;
    this.el.pingLabel.style.color = ms < 80 ? "#9ad9b0" : ms < 160 ? "#e6c07a" : "#f07167";
  }

  setQualityLabel(text) {
    this.el.qualityLabel.textContent = text || "自动";
  }

  setScoreboard(players, mySlot, target, names) {
    const wrap = this.el.scoreboardRows;
    wrap.replaceChildren();
    for (const p of players || []) {
      if (!p) continue;
      const row = document.createElement("div");
      row.className = "sb-row" + (p.slot === mySlot ? " you" : " them");
      const name = document.createElement("span");
      name.className = "sb-name";
      const dot = document.createElement("i");
      dot.className = "dot";
      name.appendChild(dot);
      const label = document.createElement("span");
      label.textContent = p.slot === mySlot ? `${p.name}（你）` : p.name;
      name.appendChild(label);
      if (p.bot) {
        const bot = document.createElement("span");
        bot.className = "sb-bot";
        bot.textContent = "BOT";
        name.appendChild(bot);
      }
      if (p.connected === false) {
        const off = document.createElement("span");
        off.className = "sb-bot";
        off.textContent = "离线";
        name.appendChild(off);
      }
      const k = document.createElement("span");
      k.textContent = p.kills ?? 0;
      const d = document.createElement("span");
      d.textContent = p.deaths ?? 0;
      const ping = document.createElement("span");
      ping.textContent = p.slot === mySlot ? "本机" : "-";
      row.append(name, k, d, ping);
      wrap.appendChild(row);
    }
    this.el.scoreboardTarget.textContent = target || 10;
    if (names?.you) {
      // 名字已经包含在 players 里，这里不需要额外处理
    }
  }

  showScoreboard(on) {
    this.el.scoreboard.classList.toggle("hidden", !on);
  }

  // ---------- 覆盖层 ----------
  showOverlay({ eyebrow = "", title = "", text = "", score = null, primary = null, secondary = null, kind = "", dismissible = true } = {}) {
    const { overlay, overlayPanel, overlayEyebrow, overlayTitle, overlayText, overlayScore } = this.el;
    overlay.classList.remove("hidden");
    overlayPanel.className = "overlay-panel" + (kind ? ` ${kind}` : "");
    overlayEyebrow.textContent = eyebrow || "TACTICAL";
    overlayTitle.textContent = title || "";
    overlayText.textContent = text || "";
    if (score) {
      overlayScore.classList.remove("hidden");
      overlayScore.replaceChildren();
      const a = document.createElement("span");
      a.className = "you";
      a.textContent = score[0];
      const sep = document.createElement("em");
      sep.textContent = ":";
      const b = document.createElement("span");
      b.className = "them";
      b.textContent = score[1];
      overlayScore.append(a, sep, b);
    } else {
      overlayScore.classList.add("hidden");
    }
    const primaryBtn = this.el.overlayPrimary;
    const secondaryBtn = this.el.overlaySecondary;
    if (primary) {
      primaryBtn.classList.remove("hidden");
      primaryBtn.textContent = primary.label || "确定";
      primaryBtn.onclick = primary.onClick || null;
    } else {
      primaryBtn.classList.add("hidden");
    }
    if (secondary) {
      secondaryBtn.classList.remove("hidden");
      secondaryBtn.textContent = secondary.label || "取消";
      secondaryBtn.onclick = secondary.onClick || null;
    } else {
      secondaryBtn.classList.add("hidden");
    }
    if (!dismissible) overlay.classList.add("is-locked");
    else overlay.classList.remove("is-locked");
  }

  hideOverlay() {
    this.el.overlay.classList.add("hidden");
  }

  // ---------- 通用 ----------
  toast(message, ms = 2800) {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = message;
    this.el.toastStack.appendChild(el);
    while (this.el.toastStack.children.length > 4) this.el.toastStack.firstChild.remove();
    setTimeout(() => {
      el.classList.add("out");
      setTimeout(() => el.remove(), 260);
    }, ms);
  }

  setName(name) {
    this.el.nameInput.value = name || "";
  }

  getName() {
    return (this.el.nameInput.value || "").trim().slice(0, 12);
  }

  setOnline(online) {
    for (const btn of this.el.menuButtons) {
      if (btn) btn.disabled = !online;
    }
    this.el.joinForm.querySelector("button").disabled = !online;
    this.el.qualityLabel.textContent = online ? this.el.qualityLabel.textContent : "离线";
  }

  setJoinCode(code) {
    this.el.joinCode.value = (code || "").toUpperCase();
  }

  async copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      this.toast("已复制到剪贴板");
      return true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        this.toast("已复制到剪贴板");
        return true;
      } catch {
        this.toast("复制失败，请手动选择文本");
        return false;
      } finally {
        ta.remove();
      }
    }
  }
}
