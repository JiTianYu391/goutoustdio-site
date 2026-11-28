// 游戏入口：菜单、匹配、预测、快照回放、插值、HUD 与音效。

import { Net } from "./net.js";
import { Input } from "./input.js";
import { GameAudio } from "./audio.js";
import { GameWorld } from "./world.js";
import { UI } from "./ui.js";
import { Minimap } from "./minimap.js";
import {
  TICK_DT,
  WEAPONS,
  KEY,
  PLAYER,
  stepPlayer,
  currentSpread,
  shotDirection,
  shotSeed,
  raycastMap,
  raycastPlayer,
  eyePosition,
  clamp,
  lerpAngle,
  wrapAngle,
} from "./shared.js";

const SETTINGS_KEY = "gs_settings_v1";
const NAME_KEY = "gs_name_v1";
const SESSION_KEY = "gs_session_v1";

const DEFAULT_SETTINGS = { sens: 1, fov: 82, quality: "auto", volume: 0.6, assist: "standard" };

const AIM_ASSIST = {
  weak: { cone: 6 * Math.PI / 180, pull: 0.45, slow: 0.14, maxDist: 70, fullDist: 18, falloff: 55 },
  standard: { cone: 8.5 * Math.PI / 180, pull: 0.72, slow: 0.24, maxDist: 80, fullDist: 22, falloff: 60 },
  strong: { cone: 11 * Math.PI / 180, pull: 0.95, slow: 0.36, maxDist: 90, fullDist: 28, falloff: 65 },
};

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}

function loadName() {
  try {
    return (localStorage.getItem(NAME_KEY) || "").slice(0, 12);
  } catch {
    return "";
  }
}

function saveName(name) {
  try { localStorage.setItem(NAME_KEY, name); } catch { /* ignore */ }
}

function safeSession() {
  try { return sessionStorage.getItem(SESSION_KEY) || null; } catch { return null; }
}

function saveSession(id) {
  try {
    if (id) sessionStorage.setItem(SESSION_KEY, id);
    else sessionStorage.removeItem(SESSION_KEY);
  } catch { /* ignore */ }
}

function cloneAmmo(ammo) {
  const src = ammo || {};
  return {
    rifle: { mag: src.rifle?.mag ?? WEAPONS.rifle.mag, reserve: src.rifle?.reserve ?? WEAPONS.rifle.reserve },
    pistol: { mag: src.pistol?.mag ?? WEAPONS.pistol.mag, reserve: src.pistol?.reserve ?? WEAPONS.pistol.reserve },
    sniper: { mag: src.sniper?.mag ?? WEAPONS.sniper.mag, reserve: src.sniper?.reserve ?? WEAPONS.sniper.reserve },
  };
}

function qualityText(q) {
  return q === "high" ? "高画质" : q === "low" ? "性能优先" : "自动画质";
}

class Game {
  constructor() {
    this.canvas = document.getElementById("scene");
    this.ui = new UI();
    this.minimap = new Minimap(document.getElementById("minimap"));
    this.net = new Net();
    this.audio = new GameAudio();
    this.input = new Input(this.canvas);
    this.world = null;

    this.settings = loadSettings();
    this.assistMode = this.settings.assist || "standard";
    this.assistActive = false;
    this.assistSlow = 1;
    this.name = loadName() || `玩家${Math.floor(10 + Math.random() * 90)}`;
    this.sessionId = safeSession();
    this.lastSentName = "";

    this.mode = "boot";
    this.gameState = "idle";
    this.roomInfo = null;
    this.mySlot = 0;
    this.names = { you: "你", them: "对手" };
    this.local = null;
    this.visual = { x: 0, y: 0, z: 0 };
    this.history = [];
    this.seq = 0;
    this.localTime = 0;
    this.accumulator = 0;
    this.remoteView = null;
    this.buf = [];
    this.clockOffset = 0;
    this.offsetReady = false;
    this.lastSnapshot = null;
    this.lastSnapshotAt = 0;
    this.lastLocalShotAt = -10;
    this.lastLocalSwitchAt = -10;
    this.lastHudAt = 0;
    this.lastHudSig = "";
    this.lastBeep = -1;
    this.persistentCenter = null;
    this.transientUntil = 0;
    this.footstepAcc = 0;
    this.remoteStepAt = 0;
    this.resultsOpen = false;
    this.endedShown = false;
    this.scoreboardVisible = false;
    this.minimapAcc = 0;
    this.enemyVisible = false;
    this.enemyRevealUntil = 0;
    this.lastKnownEnemy = null;
    this.lastAimFactor = 1;
    this.lastScopeState = null;
    this.lastCrosshairOn = null;
    this.paused = true;
    this.fallbackControl = false;
    this.reconnectTimer = 0;
    this.reconnectAttempts = 0;
    this.reconnecting = false;
    this.connecting = false;
    this.fatal = false;
    this.autoJoinCode = new URLSearchParams(location.search).get("room");
    this.lastFrame = performance.now() / 1000;
    this.resumeDeadline = 0;

    this._frame = this._frame.bind(this);
    this._bind();
    this._initWorld();
    this._bindNet();
    this._startLoop();
    this._connect();
  }

  _bind() {
    this.ui.setSettings(this.settings);
    this.ui.onSettingChange((key, value) => {
      this.settings[key] = value;
      saveSettings(this.settings);
      if (key === "sens") this.input.setSensitivity(value);
      if (key === "fov") this.world?.setFov(value);
      if (key === "volume") this.audio.setVolume(value);
      if (key === "quality") {
        this.world?.setQuality(value);
        this.ui.setQualityLabel(qualityText(value));
      }
      if (key === "assist") {
        this.assistMode = value;
        this._resetAssist();
      }
    });
    this.input.setSensitivity(this.settings.sens);
    this.audio.setVolume(this.settings.volume);

    this.ui.setName(this.name);
    this.ui.onRetry(() => this._connect());
    this.ui.setQualityLabel(qualityText(this.settings.quality));

    const onMenu = (id, fn) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("click", () => {
        this.audio.init();
        this.audio.ui();
        fn();
      });
    };
    onMenu("btn-quick", () => this._menuAction("quick"));
    onMenu("btn-create", () => this._menuAction("create"));
    onMenu("btn-practice", () => this._menuAction("practice"));
    onMenu("btn-copy-link", () => {
      if (!this.roomInfo?.code) return;
      this.ui.copy(`${location.origin}/game?room=${this.roomInfo.code}`);
    });
    onMenu("btn-cancel-room", () => {
      this.net.send({ t: "leave" });
      this._resetToMenu();
    });

    const joinForm = document.getElementById("join-form");
    joinForm.addEventListener("submit", (e) => {
      e.preventDefault();
      this.audio.init();
      const code = (document.getElementById("join-code").value || "").trim().toUpperCase();
      if (code.length < 4) {
        this.ui.toast("请输入正确的房间码");
        return;
      }
      this._join(code);
    });

    const nameInput = document.getElementById("name-input");
    nameInput.addEventListener("change", () => {
      this._syncName();
    });
    nameInput.addEventListener("blur", () => this._syncName());

    window.addEventListener("pointerdown", () => this.audio.init(), { once: true });
    this.input.onLockChange = (locked) => this._onLockChange(locked);
    this.input.onLockError = () => this._onLockError();

    window.addEventListener("beforeunload", () => {
      saveSettings(this.settings);
      saveName(this.name);
    });

    document.addEventListener("keydown", (e) => {
      if (e.code === "Tab" && this.mode === "game" && !this.resultsOpen && this.input.enabled) {
        this.ui.showScoreboard(true);
        this._renderScoreboard();
      }
    }, true);
    document.addEventListener("keyup", (e) => {
      if (e.code === "Tab") this.ui.showScoreboard(false);
    }, true);
  }

  _initWorld() {
    try {
      this.world = new GameWorld(this.canvas);
      this.world.setFov(this.settings.fov);
      this.world.setQuality(this.settings.quality);
      this.world.setMode("menu");
      this.ui.setQualityLabel(qualityText(this.settings.quality));
    } catch (err) {
      console.error(err);
      this.fatal = true;
      this.ui.bootError("无法创建 WebGL 场景。请开启浏览器硬件加速，或换用 Chrome / Edge / Firefox 再试。");
    }
  }

  _bindNet() {
    this.net.on("welcome", (msg) => this._onWelcome(msg));
    this.net.on("room", (msg) => this._onRoom(msg));
    this.net.on("start", (msg) => this._onStart(msg));
    this.net.on("live", () => {
      if (this.gameState !== "live") this.gameState = "live";
    });
    this.net.on("snapshot", (msg) => this._onSnapshot(msg));
    this.net.on("ended", (msg) => this._onEnded(msg));
    this.net.on("toast", (msg) => {
      if (msg.message) this.ui.toast(msg.message, 3800);
    });
    this.net.on("left", () => this._resetToMenu());
    this.net.on("error", (msg) => {
      this.ui.toast(msg.message || "操作失败");
      this.ui.setOnline(this.net.isOpen());
    });
    this.net.on("rtt", (rtt) => this.ui.setPing(rtt));
    this.net.on("fatal", (msg) => {
      this.fatal = true;
      this.ui.bootError(msg.message || "客户端版本不匹配，请刷新页面");
    });
    this.net.on("close", () => this._onClose());
  }

  async _connect() {
    if (this.fatal || this.connecting) return;
    this.connecting = true;
    this.ui.showBoot("正在连接游戏服务器…");
    try {
      await this.net.connect({ name: this.name, session: this.sessionId });
    } catch (err) {
      console.error(err);
      this.ui.bootError("无法连接游戏服务器。请检查网络，或稍后重试。");
      this.ui.setOnline(false);
    } finally {
      this.connecting = false;
    }
  }

  _onWelcome(msg) {
    this.sessionId = msg.id;
    saveSession(msg.id);
    if (msg.name) this.name = msg.name;
    this.lastSentName = msg.name || this.name;
    this.ui.setName(this.name);
    this.ui.setOnline(true);
    this.audio.init();
    if (msg.resumed) {
      this.mode = "boot";
      this.ui.showBoot("正在恢复对局…");
      clearTimeout(this.resumeDeadline);
      this.resumeDeadline = setTimeout(() => {
        if (this.mode === "boot") this._resetToMenu();
      }, 2600);
    } else {
      this._resetToMenu();
      if (this.autoJoinCode) {
        const code = this.autoJoinCode;
        this.autoJoinCode = null;
        this.ui.setJoinCode(code);
        this._join(code);
      }
    }
  }

  _onClose() {
    this.ui.setOnline(false);
    const inMatch = this.mode === "game" || this.mode === "room";
    this.input.enabled = false;
    this.paused = true;
    if (inMatch) {
      this.ui.showOverlay({
        eyebrow: "CONNECTION LOST",
        title: "连接中断",
        text: "正在尝试重新连接。服务器会为你保留席位约 15 秒。",
        dismissible: false,
      });
    } else {
      this.ui.toast("与服务器断开连接，正在重连…", 4200);
    }
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.reconnectAttempts = 0;
    clearTimeout(this.reconnectTimer);
    const attempt = async () => {
      if (this.net.isOpen()) {
        this.reconnecting = false;
        return;
      }
      this.reconnectAttempts++;
      try {
        await this.net.connect({ name: this.name, session: this.sessionId });
        this.reconnecting = false;
        this.ui.setOnline(true);
      } catch {
        if (this.reconnectAttempts >= 12) {
          this.reconnecting = false;
          if (this.mode === "game" || this.mode === "room") {
            this.ui.showOverlay({
              eyebrow: "OFFLINE",
              title: "无法连接",
              text: "服务器暂时没有响应。你可以返回大厅稍后再试。",
              primary: { label: "返回大厅", onClick: () => this._resetToMenu() },
              dismissible: false,
            });
          } else {
            this.ui.toast("仍然无法连接服务器，请刷新页面重试", 5000);
          }
          return;
        }
        this.reconnectTimer = setTimeout(attempt, 900 + Math.min(2500, this.reconnectAttempts * 220));
      }
    };
    attempt();
  }

  _syncName() {
    const raw = this.ui.getName();
    const name = (raw || "玩家").slice(0, 12);
    this.name = name;
    saveName(name);
    if (this.net.isOpen() && name !== this.lastSentName) {
      this.lastSentName = name;
      this.net.send({ t: "name", name });
    }
  }

  _menuAction(kind) {
    if (!this.net.isOpen()) {
      this.ui.toast("正在重新连接服务器…");
      this._connect();
      return;
    }
    this._syncName();
    this.audio.init();
    if (kind === "quick") {
      this.ui.toast("正在匹配对手…", 1800);
      this.net.send({ t: "quick" });
    } else if (kind === "practice") {
      this.net.send({ t: "create", practice: true });
    } else {
      this.net.send({ t: "create" });
    }
  }

  _join(code) {
    if (!this.net.isOpen()) {
      this.ui.toast("尚未连接服务器");
      return;
    }
    this._syncName();
    this.net.send({ t: "join", code });
    try { history.replaceState(null, "", location.pathname); } catch { /* ignore */ }
  }

  _onRoom(msg) {
    clearTimeout(this.resumeDeadline);
    this.roomInfo = msg;
    this.mySlot = msg.youSlot ?? this.mySlot ?? 0;
    this._updateNames(msg);
    if (msg.state === "waiting") {
      this.mode = "room";
      this.gameState = "waiting";
      this.world?.setMode("menu");
      this.ui.showRoom(msg);
      this.input.enabled = false;
      this.paused = true;
      this.fallbackControl = false;
      this.resultsOpen = false;
      this.endedShown = false;
      this.ui.setScope(false, false);
      this.lastScopeState = null;
      this._resetAssist();
      if (document.pointerLockElement) document.exitPointerLock();
      return;
    }
    if (msg.state === "countdown" || msg.state === "live") {
      const entered = this._ensureGameView(false);
      if (entered) {
        this.ui.hideRoom();
        this.ui.showHud();
        if (!this.input.locked && !this.resultsOpen) this._showLockPrompt();
      }
      this.ui.setScore(msg.score, this.mySlot, this.names, msg.target);
      return;
    }
    if (msg.state === "ended") {
      this._ensureGameView(true);
    }
  }

  _ensureGameView(silent = false) {
    if (this.mode === "game") return false;
    this.mode = "game";
    this.gameState = this.gameState === "idle" ? "countdown" : this.gameState;
    this.world?.setMode("game");
    this.world?.setLocalSlot(this.mySlot);
    this.ui.hideBoot();
    this.ui.hideRoom();
    this.ui.showHud();
    if (!silent) this.ui.hideOverlay();
    this.input.enabled = false;
    this.paused = true;
    this.audio.init();
    return true;
  }

  _onStart(msg) {
    this._ensureGameView(true);
    this.gameState = "countdown";
    this.resultsOpen = false;
    this.endedShown = false;
    this.local = null;
    this.history = [];
    this.buf = [];
    this.seq = 0;
    this.localTime = 0;
    this.accumulator = 0;
    this.remoteView = null;
    this.lastBeep = -1;
    this.persistentCenter = null;
    this.transientUntil = 0;
    this._resetAssist();
    this.ui.hideRoom();
    this.ui.showHud();
    this.ui.hideOverlay();
    this.ui.clearCenter();
    this.ui.showScoreboard(false);
    const primary = this.ui.el.overlayPrimary;
    if (primary) {
      primary.disabled = false;
      primary.textContent = "进入战斗";
    }
    this.world?.setMode("game");
    this.world?.setLocalSlot(this.mySlot);
    this.world?.primeView(this.input.view.yaw, this.input.view.pitch);
    this._showLockPrompt();
    this.audio.init();
    this.audio.beep(true);
  }

  _showLockPrompt() {
    if (this.resultsOpen) return;
    if (this.fallbackControl) {
      this.ui.hideOverlay();
      this.paused = false;
      this.input.enabled = this.mode === "game";
      return;
    }
    if (this.input.locked) {
      this.ui.hideOverlay();
      this.paused = false;
      this.input.enabled = this.mode === "game";
      return;
    }
    this.paused = true;
    this.input.enabled = false;
    const live = this.gameState === "live";
    this.ui.showOverlay({
      eyebrow: live ? "RESUME MATCH" : "DEPLOY",
      title: live ? "回到战斗" : "准备进入战斗",
      text: live
        ? "对局还在继续。点击按钮锁定鼠标回到战斗，按 Esc 可以再次释放鼠标。"
        : "点击按钮锁定鼠标。倒计时结束后开打，按 Esc 可释放鼠标并暂停操作。",
      primary: { label: "进入战斗", onClick: () => this._tryLock() },
      secondary: { label: "退出对局", onClick: () => this._leaveMatch() },
    });
  }

  _tryLock() {
    this.audio.init();
    this.input.requestLock();
    clearTimeout(this.lockFallbackTimer);
    this.lockFallbackTimer = setTimeout(() => {
      if (this.input.locked || this.mode !== "game" || this.resultsOpen) return;
      this.fallbackControl = true;
      this.ui.hideOverlay();
      this.paused = false;
      this.input.enabled = true;
      if (!this.fallbackToastShown) {
        this.fallbackToastShown = true;
        this.ui.toast("当前浏览器无法锁定鼠标：按住左键拖动视角，点击开火", 5200);
      }
    }, 520);
  }

  _onLockChange(locked) {
    if (locked) {
      this.fallbackControl = false;
      this.ui.hideOverlay();
      this.paused = false;
      this.input.enabled = this.mode === "game" && this.gameState !== "ended";
      return;
    }
    this.fallbackControl = false;
    this.input.enabled = false;
    this.input.clear();
    if (this.mode !== "game" || this.resultsOpen) return;
    if (this.gameState !== "live" && this.gameState !== "countdown") return;
    this.paused = true;
    this.ui.showOverlay({
      eyebrow: "TACTICAL PAUSE",
      title: "已暂停",
      text: "鼠标已解锁，对局仍在继续。点击继续回到战斗。",
      primary: { label: "继续游戏", onClick: () => this._tryLock() },
      secondary: { label: "退出对局", onClick: () => this._leaveMatch() },
    });
  }

  _onLockError() {
    if (this.mode !== "game" || this.resultsOpen) return;
    this.fallbackControl = true;
    this.ui.hideOverlay();
    this.paused = false;
    this.input.enabled = true;
    if (!this.fallbackToastShown) {
      this.fallbackToastShown = true;
      this.ui.toast("鼠标锁定不可用：按住左键拖动视角，点击开火", 5200);
    }
  }

  _canControl() {
    return this.mode === "game" && !this.resultsOpen && !this.paused &&
      (this.input.locked || this.fallbackControl);
  }

  _updateNames(msg) {
    for (const seat of msg.seats || []) {
      if (!seat) continue;
      if (seat.slot === this.mySlot) this.names.you = "你";
      else this.names.them = seat.name;
    }
    if (!(msg.seats || []).some((s) => s && s.slot !== this.mySlot)) this.names.them = "对手";
  }

  _updateNamesFromPlayers(players) {
    for (const p of players || []) {
      if (p.slot === this.mySlot) this.names.you = "你";
      else this.names.them = p.name;
    }
  }

  _initLocalFromServer(you) {
    this.input.view.yaw = you.yaw || 0;
    this.input.view.pitch = you.pitch || 0;
    this.local = {
      x: you.x,
      y: you.y,
      z: you.z,
      vx: you.vx || 0,
      vy: you.vy || 0,
      vz: you.vz || 0,
      yaw: this.input.view.yaw,
      pitch: this.input.view.pitch,
      crouch: !!you.crouch,
      aiming: false,
      onGround: you.onGround !== false,
      speed: you.speed || 0,
      jumpHeld: false,
      alive: you.alive !== false,
      hp: you.hp ?? 100,
      weapon: you.weapon || "rifle",
      ammo: cloneAmmo(you.ammo),
      reloadLeft: you.reload || 0,
      readyAt: 0,
      nextFireAt: 0,
      lastShotAt: -10,
      spray: 0,
      kills: you.kills || 0,
      deaths: you.deaths || 0,
    };
    this.visual = { x: you.x, y: you.y, z: you.z };
    this.history = [];
    this.seq = you.ack || 0;
    this.accumulator = 0;
    this.world?.setWeapon(this.local.weapon);
    this.world?.primeView(this.input.view.yaw, this.input.view.pitch);
  }

  _snapLocalFromServer(you, resetView = true) {
    if (!this.local) {
      this._initLocalFromServer(you);
      return;
    }
    this.local.x = you.x;
    this.local.y = you.y;
    this.local.z = you.z;
    this.local.vx = you.vx || 0;
    this.local.vy = you.vy || 0;
    this.local.vz = you.vz || 0;
    this.local.crouch = !!you.crouch;
    this.local.aiming = false;
    this.local.onGround = you.onGround !== false;
    this.local.alive = you.alive !== false;
    this.local.hp = you.hp ?? 100;
    this.local.weapon = you.weapon || this.local.weapon;
    this.local.ammo = cloneAmmo(you.ammo);
    this.local.reloadLeft = you.reload || 0;
    this.local.kills = you.kills || 0;
    this.local.deaths = you.deaths || 0;
    this.local.spray = 0;
    this.local.jumpHeld = false;
    this.local.readyAt = this.localTime + 0.4;
    this.local.nextFireAt = this.localTime + 0.4;
    this.local.lastShotAt = -10;
    if (resetView) {
      this.input.view.yaw = you.yaw || 0;
      this.input.view.pitch = you.pitch || 0;
      this.local.yaw = this.input.view.yaw;
      this.local.pitch = this.input.view.pitch;
      this.world?.primeView(this.input.view.yaw, this.input.view.pitch);
    }
    this.visual = { x: you.x, y: you.y, z: you.z };
    this.history = [];
    this.accumulator = 0;
    this.world?.setWeapon(this.local.weapon);
    this.world?.setReload(this.local.reloadLeft);
  }

  _syncLocalPosition(you) {
    if (!this.local) return;
    this.local.x = you.x;
    this.local.y = you.y;
    this.local.z = you.z;
    this.local.vx = 0;
    this.local.vy = 0;
    this.local.vz = 0;
    this.local.onGround = you.onGround !== false;
    this.local.crouch = !!you.crouch;
    this.local.alive = you.alive !== false;
    this.local.hp = you.hp ?? 100;
    this.visual = { x: you.x, y: you.y, z: you.z };
    this.local.ammo = cloneAmmo(you.ammo);
    this.local.weapon = you.weapon || this.local.weapon;
    this.world?.setWeapon(this.local.weapon);
  }

  _syncVitals(you) {
    if (!this.local) return;
    this.local.hp = you.hp ?? this.local.hp;
    this.local.kills = you.kills ?? this.local.kills;
    this.local.deaths = you.deaths ?? this.local.deaths;
    this.local.alive = you.alive !== false;
    const nowPerf = performance.now() / 1000;
    if (you.weapon && you.weapon !== this.local.weapon && nowPerf - this.lastLocalSwitchAt > 0.45) {
      this.local.weapon = you.weapon;
      this.local.reloadLeft = 0;
      this.local.spray = 0;
      this.world?.setWeapon(you.weapon);
    }
    const quiet = nowPerf - this.lastLocalShotAt > 0.4;
    if (you.ammo) {
      for (const id of ["rifle", "pistol", "sniper"]) {
        const srv = you.ammo[id];
        const mine = this.local.ammo[id];
        if (!srv || !mine) continue;
        if (quiet) {
          mine.mag = srv.mag;
          mine.reserve = srv.reserve;
        } else {
          mine.mag = Math.min(mine.mag, srv.mag);
          mine.reserve = Math.min(mine.reserve, srv.reserve);
        }
      }
    }
    if (you.reload > 0.05) this.local.reloadLeft = Math.max(this.local.reloadLeft, you.reload);
    else if (this.local.reloadLeft > 0 && you.reload <= 0) {
      // 本地预测的换弹还没走完时保留动画，服务器会随后确认。
    }
    this.world?.setReload(this.local.reloadLeft);
  }

  _snapLocalForHistory() {
    return {
      x: this.local.x,
      y: this.local.y,
      z: this.local.z,
      vy: this.local.vy,
      onGround: this.local.onGround,
      crouch: this.local.crouch,
    };
  }

  _reconcile(you) {
    if (!this.local || !this.local.alive || !you.alive) return;
    const ack = you.ack | 0;
    const idx = this.history.findIndex((h) => h.seq === ack);
    if (idx >= 0) {
      const h = this.history[idx];
      const err = Math.hypot(you.x - h.after.x, you.y - h.after.y, you.z - h.after.z);
      if (err > 0.06) {
        this.local.x = you.x;
        this.local.y = you.y;
        this.local.z = you.z;
        this.local.vx = you.vx || 0;
        this.local.vy = you.vy || 0;
        this.local.vz = you.vz || 0;
        this.local.onGround = you.onGround !== false;
        this.local.crouch = !!you.crouch;
        for (const h2 of this.history.slice(idx + 1)) {
          this._replayFrame(h2.frame);
          h2.after = this._snapLocalForHistory();
        }
        this.local.yaw = this.input.view.yaw;
        this.local.pitch = this.input.view.pitch;
        const vd = Math.hypot(this.visual.x - this.local.x, this.visual.y - this.local.y, this.visual.z - this.local.z);
        if (vd > 0.8) this.visual = { x: this.local.x, y: this.local.y, z: this.local.z };
      }
      this.history = this.history.slice(idx + 1);
    } else if (ack > 0) {
      const rest = this.history.filter((h) => h.seq > ack);
      const err = Math.hypot(you.x - this.local.x, you.y - this.local.y, you.z - this.local.z);
      if (err > 0.7) {
        this.local.x = you.x;
        this.local.y = you.y;
        this.local.z = you.z;
        this.local.vx = you.vx || 0;
        this.local.vy = you.vy || 0;
        this.local.vz = you.vz || 0;
        this.local.onGround = you.onGround !== false;
        this.local.crouch = !!you.crouch;
        for (const h2 of rest) {
          this._replayFrame(h2.frame);
          h2.after = this._snapLocalForHistory();
        }
        this.local.yaw = this.input.view.yaw;
        this.local.pitch = this.input.view.pitch;
        this.visual = { x: this.local.x, y: this.local.y, z: this.local.z };
      }
      this.history = rest;
    }
  }

  _replayFrame(frame) {
    if (!frame) return;
    if (frame.slot === 1 || frame.slot === 2 || frame.slot === 3) {
      const id = frame.slot === 1 ? "rifle" : frame.slot === 2 ? "pistol" : "sniper";
      if (id !== this.local.weapon) this.local.weapon = id;
    }
    stepPlayer(this.local, { keys: frame.keys, yaw: frame.yaw, pitch: frame.pitch, aim: frame.aim }, TICK_DT);
  }

  _onSnapshot(msg) {
    if (!msg?.you) return;
    clearTimeout(this.resumeDeadline);
    const prevState = this.gameState;
    this.gameState = msg.state;
    this.mySlot = msg.you.slot ?? this.mySlot;
    this._updateNamesFromPlayers(msg.players);
    this.roomInfo = this.roomInfo || {};
    this.roomInfo.state = msg.state;
    this.roomInfo.score = msg.score;
    this.roomInfo.target = msg.target;
    this.roomInfo.seats = (msg.players || []).map((p) => ({
      slot: p.slot, name: p.name, bot: p.bot, connected: p.connected, kills: p.kills, deaths: p.deaths,
    }));
    if (this.mode !== "game" && msg.state !== "waiting") {
      const entered = this._ensureGameView(true);
      if (entered) {
        this.ui.showHud();
        if ((msg.state === "countdown" || msg.state === "live") && !this.resultsOpen) {
          this._showLockPrompt();
        }
      }
    }
    const now = performance.now() / 1000;
    this.lastSnapshot = msg;
    this.lastSnapshotAt = now;
    this.buf.push({ recv: now, now: msg.now || now, players: msg.players || [], you: msg.you });
    if (this.buf.length > 30) this.buf.shift();
    if (!this.offsetReady) {
      this.clockOffset = now - (msg.now || now);
      this.offsetReady = true;
    } else {
      const sample = now - (msg.now || now);
      this.clockOffset = this.clockOffset * 0.985 + sample * 0.015;
    }

    const you = msg.you;
    if (msg.state === "countdown") {
      if (!this.local) this._initLocalFromServer(you);
      else this._syncLocalPosition(you);
      this._syncVitals(you);
      const sec = Math.max(0, Math.ceil(msg.countdown || 0));
      if (sec !== this.lastBeep) {
        this.lastBeep = sec;
        if (sec > 0) this.audio.beep(sec <= 1);
      }
      this.persistentCenter = "countdown";
      this.ui.center(`${sec} 秒后开始`, { big: true });
      this.input.enabled = this._canControl();
    } else if (msg.state === "live") {
      if (!this.local) this._initLocalFromServer(you);
      if (prevState === "countdown") {
        this._snapLocalFromServer(you, false);
        this.persistentCenter = null;
        this.ui.center("开始！", { big: true, duration: 800 });
        this.audio.beep(true);
      }
      const wasAlive = this.local.alive;
      if (you.alive && !wasAlive) {
        this._snapLocalFromServer(you, true);
        this.audio.spawn();
        this.persistentCenter = null;
        this.ui.clearCenter();
      }
      if (!you.alive && wasAlive) {
        this.local.alive = false;
        this.local.x = you.x;
        this.local.y = you.y;
        this.local.z = you.z;
        this.local.reloadLeft = 0;
        this.local.spray = 0;
        this.visual = { x: you.x, y: you.y, z: you.z };
        this.world?.setReload(0);
      }
      this._syncVitals(you);
      if (you.alive) this._reconcile(you);
      this.input.enabled = this._canControl();
      if (you.alive) {
        if (this.persistentCenter === "death" || this.persistentCenter === "countdown") {
          this.persistentCenter = null;
          this.ui.clearCenter();
        }
      } else if (now >= this.transientUntil) {
        if (this.persistentCenter !== "death") this.persistentCenter = "death";
        this.ui.center(`重生中 ${Math.max(0, msg.you.respawn || 0).toFixed(1)}s`, { danger: true });
      }
    } else if (msg.state === "ended") {
      this.local && (this.local.alive = false);
      if (now >= this.transientUntil) this.ui.clearCenter();
    }

    this.ui.setScore(msg.score, this.mySlot, this.names, msg.target);
    this.ui.setHealth(you.alive ? you.hp : 0);
    this.ui.setPing(this.net.rtt);
    this._handleEvents(msg.events || []);
    this._updateAmmoHud(true);
    if (this.scoreboardVisible) this._renderScoreboard();

    if (msg.state === "ended" && !this.endedShown) {
      this._onEnded({ winner: msg.winner, reason: msg.reason, score: msg.score });
    }
  }

  _onEnded(msg) {
    if (this.endedShown) return;
    this.endedShown = true;
    this.resultsOpen = true;
    this.gameState = "ended";
    this.paused = true;
    this.fallbackControl = false;
    this.input.enabled = false;
    this.ui.showScoreboard(false);
    this.ui.setScope(false, false);
    this.lastScopeState = null;
    this.lastCrosshairOn = null;
    this.world?.setAiming(false, this.local?.weapon);
    this.input.setAimFactor(1);
    this._resetAssist();
    if (document.pointerLockElement) document.exitPointerLock();
    const win = msg.winner === this.mySlot;
    const score = msg.score || [0, 0];
    const reason = msg.reason === "left" ? "对手离开了对局。" : `先到 ${this.lastSnapshot?.target || 10} 杀，对局结束。`;
    this.ui.showOverlay({
      eyebrow: "MATCH COMPLETE",
      title: win ? "胜利" : "失败",
      text: reason,
      score: [score[this.mySlot] || 0, score[1 - this.mySlot] || 0],
      kind: win ? "win" : "lose",
      primary: { label: "再来一局", onClick: () => this._rematch() },
      secondary: { label: "返回大厅", onClick: () => this._leaveMatch() },
      dismissible: false,
    });
    this.audio.init();
    if (win) this.audio.win();
    else this.audio.lose();
  }

  _rematch() {
    if (!this.net.isOpen()) {
      this.ui.toast("连接已断开，无法开始新对局");
      return;
    }
    this.audio.ui();
    this.net.send({ t: "rematch" });
    const btn = this.ui.el.overlayPrimary;
    if (btn) {
      btn.textContent = "等待开始…";
      btn.disabled = true;
    }
    this.ui.toast("已请求再来一局，等待服务器开始…", 2400);
  }

  _leaveMatch() {
    this.audio.ui();
    if (this.net.isOpen()) this.net.send({ t: "leave" });
    this._resetToMenu();
  }

  _resetToMenu() {
    clearTimeout(this.resumeDeadline);
    if (document.pointerLockElement) document.exitPointerLock();
    this.mode = "menu";
    this.gameState = "idle";
    this.resultsOpen = false;
    this.endedShown = false;
    this.roomInfo = null;
    this.local = null;
    this.remoteView = null;
    this.history = [];
    this.buf = [];
    this.offsetReady = false;
    this.seq = 0;
    this.accumulator = 0;
    this.persistentCenter = null;
    this.transientUntil = 0;
    this.scoreboardVisible = false;
    this.fallbackControl = false;
    this.input.enabled = false;
    this.paused = true;
    this.lastAimFactor = 1;
    this.lastScopeState = null;
    this.lastCrosshairOn = null;
    this.enemyVisible = false;
    this.enemyRevealUntil = 0;
    this.lastKnownEnemy = null;
    this.input.clear();
    this.input.setAimFactor(1);
    this._resetAssist();
    this.ui.setScope(false, false);
    this.world?.setMode("menu");
    this.ui.showMenu();
    this.ui.setOnline(this.net.isOpen());
    this.ui.setJoinCode("");
    if (this.autoJoinCode) {
      const code = this.autoJoinCode;
      this.autoJoinCode = null;
      this.ui.setJoinCode(code);
      this._join(code);
    }
  }

  _handleEvents(events) {
    const my = this.mySlot;
    for (const ev of events) {
      if (!ev) continue;
      if (ev.type === "shot") {
        if (ev.by === my) continue;
        const from = ev.from || [0, 0, 0];
        const dx = from[0] - this.visual.x;
        const dz = from[2] - this.visual.z;
        const dist = Math.hypot(dx, dz);
        const rightX = Math.cos(this.input.view.yaw);
        const rightZ = -Math.sin(this.input.view.yaw);
        const pan = dist > 0.1 ? clamp((dx * rightX + dz * rightZ) / dist, -1, 1) * 0.8 : 0;
        const gain = clamp(0.9 - dist / 60, 0.15, 0.8);
        this.audio.shot(ev.weapon, { pan, gain });
        this.enemyRevealUntil = performance.now() / 1000 + 2.4;
        this.lastKnownEnemy = { x: from[0], z: from[2] };
        this.world?.remoteShot(
          { x: from[0], y: from[1], z: from[2] },
          { x: ev.to?.[0] ?? 0, y: ev.to?.[1] ?? 0, z: ev.to?.[2] ?? 0 },
          ev.weapon
        );
      } else if (ev.type === "hit") {
        if (ev.by === my) {
          const head = ev.part === "head";
          this.ui.hitmarker(head);
          this.audio.hit(head);
          this.ui.damageNumber(ev.dmg, head);
          if (ev.at) {
            this.world?.impact(
              { x: ev.at[0], y: ev.at[1], z: ev.at[2] },
              { big: head, friendly: true }
            );
          }
        }
        if (ev.target === my) {
          this.ui.setHealth(ev.hp);
          if (this.local) this.local.hp = ev.hp;
          this.ui.damage();
          this.audio.hurt();
          this.world?.addShake(0.55);
          const rv = this.remoteView;
          const from = ev.from;
          if (this.local && (from || rv)) {
            const ox = from ? from[0] : rv.x;
            const oz = from ? from[2] : rv.z;
            const dx = ox - this.local.x;
            const dz = oz - this.local.z;
            const yaw = this.input.view.yaw;
            const fx = -Math.sin(yaw);
            const fz = -Math.cos(yaw);
            const rx = Math.cos(yaw);
            const rz = -Math.sin(yaw);
            const angle = Math.atan2(dx * rx + dz * rz, dx * fx + dz * fz) * 180 / Math.PI;
            this.ui.damageDirection(angle);
          }
        }
      } else if (ev.type === "kill") {
        const killer = this._nameFor(ev.by);
        const victim = this._nameFor(ev.target);
        const involves = ev.by === my || ev.target === my;
        this.ui.addKillFeed({ killer, victim, head: ev.part === "head", involvesMe: involves });
        if (ev.by === my) {
          this.ui.hitmarker(ev.part === "head", true);
          this.audio.kill();
          this.transientUntil = performance.now() / 1000 + 0.9;
          this.persistentCenter = null;
          this.ui.center(`击杀 ${victim}`, { big: true, duration: 900 });
        }
        if (ev.target === my) {
          this.audio.death();
          this.world?.addShake(0.8);
        }
      } else if (ev.type === "reload") {
        if (ev.by !== my) {
          this.audio.reloadStart();
        }
      } else if (ev.type === "reloaded") {
        if (ev.by !== my) this.audio.reloadEnd();
      } else if (ev.type === "switch") {
        if (ev.by !== my) this.audio.switchWeapon();
      } else if (ev.type === "respawn") {
        if (ev.slot === my) this.audio.spawn();
      }
    }
  }

  _nameFor(slot) {
    if (slot === this.mySlot) return "你";
    const p = this.lastSnapshot?.players?.find((x) => x.slot === slot);
    return p?.name || "对手";
  }

  _resetAssist() {
    this.assistActive = false;
    this.input.setAssistSlow(1);
    this.ui.setAssist(false, !!this.world?.scoped);
  }

  _applyAimAssist(now, dt) {
    const preset = AIM_ASSIST[this.assistMode];
    const local = this.local;
    const remote = this.remoteView;
    const engaging = this.input.aimHeld || this.input.fireHeld;
    if (!preset || !local || !local.alive || !remote || !remote.alive || !engaging ||
        !this._canControl() || this.gameState !== "live") {
      if (this.assistActive) this._resetAssist();
      else this.input.setAssistSlow(1);
      return;
    }
    const eye = eyePosition(local);
    const tx = remote.x;
    const ty = remote.y + (remote.crouch ? 0.92 : 1.26);
    const tz = remote.z;
    const dx = tx - eye.x;
    const dy = ty - eye.y;
    const dz = tz - eye.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.8 || dist > preset.maxDist) {
      this._resetAssist();
      return;
    }
    const nx = dx / dist;
    const ny = dy / dist;
    const nz = dz / dist;
    const wall = raycastMap(eye.x, eye.y, eye.z, nx, ny, nz, dist);
    if (wall < dist - 0.22) {
      this._resetAssist();
      return;
    }

    const view = this.input.view;
    const targetYaw = Math.atan2(-dx, -dz);
    const targetPitch = Math.atan2(dy, Math.hypot(dx, dz));
    const dYaw = wrapAngle(targetYaw - view.yaw);
    const dPitch = targetPitch - view.pitch;
    const err = Math.hypot(dYaw * Math.cos(view.pitch), dPitch);
    if (err > preset.cone) {
      this._resetAssist();
      return;
    }

    const prox = 1 - err / preset.cone;
    const distFactor = clamp(1 - Math.max(0, dist - preset.fullDist) / preset.falloff, 0.3, 1);
    const engage = this.input.aimHeld ? 1 : 0.55;
    const strength = preset.pull * prox * distFactor * engage;
    const k = Math.min(0.5, Math.max(0, strength * dt * 22));
    if (err > 1e-4 && k > 0) {
      view.yaw = wrapAngle(view.yaw + dYaw * k);
      view.pitch = clamp(view.pitch + dPitch * k, -1.52, 1.52);
    }
    const slow = 1 - preset.slow * prox * distFactor * (this.input.aimHeld ? 1 : 0.5);
    this.input.setAssistSlow(slow);
    if (!this.assistActive) {
      this.assistActive = true;
      this.ui.setAssist(true, !!this.world?.scoped);
    }
  }

  _step() {
    if (!this.local || !this.local.alive) return;
    const weapon = WEAPONS[this.local.weapon] || WEAPONS.rifle;
    const frame = this.input.sample(weapon.auto);
    frame.seq = ++this.seq;
    this.localTime += TICK_DT;

    if (frame.slot) this._localSwitch(frame.slot);
    if (frame.reload) this._localStartReload();

    stepPlayer(this.local, { keys: frame.keys, yaw: frame.yaw, pitch: frame.pitch, aim: frame.aim }, TICK_DT);
    this.local.yaw = frame.yaw;
    this.local.pitch = frame.pitch;

    if (this.local.reloadLeft > 0) {
      this.local.reloadLeft = Math.max(0, this.local.reloadLeft - TICK_DT);
      if (this.local.reloadLeft === 0) this._localFinishReload();
    }

    if (frame.fire) this._localFire(frame.seq);

    this.history.push({ seq: frame.seq, frame, after: this._snapLocalForHistory() });
    if (this.history.length > 150) this.history.shift();

    this.net.send({
      t: "input",
      seq: frame.seq,
      keys: frame.keys,
      yaw: frame.yaw,
      pitch: frame.pitch,
      fire: frame.fire,
      reload: frame.reload,
      aim: frame.aim,
      slot: frame.slot,
    });
  }

  _localSwitch(slot) {
    const id = slot === 1 ? "rifle" : slot === 2 ? "pistol" : "sniper";
    if (id === this.local.weapon) return;
    this.local.weapon = id;
    this.local.reloadLeft = 0;
    this.local.spray = 0;
    this.local.readyAt = this.localTime + 0.35;
    this.local.nextFireAt = Math.max(this.local.nextFireAt, this.local.readyAt);
    this.lastLocalSwitchAt = performance.now() / 1000;
    this.world?.setWeapon(id);
    this.audio.switchWeapon();
  }

  _localStartReload() {
    if (this.local.reloadLeft > 0) return;
    if (this.localTime < this.local.readyAt) return;
    const w = WEAPONS[this.local.weapon];
    const ammo = this.local.ammo[this.local.weapon];
    if (!ammo || ammo.mag >= w.mag || ammo.reserve <= 0) return;
    this.local.reloadLeft = w.reload;
    this.local.spray = 0;
    this.audio.reloadStart();
  }

  _localFinishReload() {
    const w = WEAPONS[this.local.weapon];
    const ammo = this.local.ammo[this.local.weapon];
    if (!ammo) return;
    const take = Math.min(w.mag - ammo.mag, ammo.reserve);
    ammo.mag += take;
    ammo.reserve -= take;
    this.audio.reloadEnd();
  }

  _localFire(seq) {
    if (!this.local?.alive) return;
    const w = WEAPONS[this.local.weapon] || WEAPONS.rifle;
    if (this.localTime < this.local.readyAt) return;
    if (this.local.reloadLeft > 0) return;
    const ammo = this.local.ammo[this.local.weapon];
    if (!ammo) return;
    if (ammo.mag <= 0) {
      this.audio.empty();
      this._localStartReload();
      return;
    }
    if (this.localTime < this.local.nextFireAt) return;

    ammo.mag--;
    this.local.nextFireAt = this.localTime + w.interval;
    this.lastLocalShotAt = performance.now() / 1000;
    if (this.localTime - (this.local.lastShotAt || -10) > 0.4) this.local.spray = 0;
    else this.local.spray = Math.min(8, (this.local.spray || 0) + 1);
    this.local.lastShotAt = this.localTime;

    const spread = currentSpread(this.local, this.local.weapon, this.local.spray);
    const seed = shotSeed(this.mySlot, seq, this.local.spray);
    const dir = shotDirection(this.input.view.yaw, this.input.view.pitch, spread, seed);
    const eye = eyePosition(this.local);
    let endT = Math.min(raycastMap(eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, w.range), w.range);
    let hitRemote = false;
    if (this.remoteView?.alive) {
      const hit = raycastPlayer(eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, this.remoteView, endT);
      if (hit) {
        endT = hit.t;
        hitRemote = true;
      }
    }
    const end = {
      x: eye.x + dir.x * endT,
      y: eye.y + dir.y * endT,
      z: eye.z + dir.z * endT,
    };
    this.world?.localShot(end, this.local.weapon);
    if (!hitRemote && endT < w.range - 0.05) {
      this.world?.impact(end, { decal: true, friendly: true });
    } else if (hitRemote) {
      this.world?.impact(end, { friendly: true });
    }
    this.audio.shot(this.local.weapon, { pan: 0, gain: 1 });

    const kick = w.kick * (this.local.crouch ? 0.8 : 1);
    this.input.view.pitch = clamp(this.input.view.pitch + kick, -1.52, 1.52);
    this.input.view.yaw += (Math.random() - 0.5) * w.kickYaw;
    this.world?.addPunch(kick * 1.3);
  }

  _updateAmmoHud(force = false) {
    if (!this.local) return;
    const w = WEAPONS[this.local.weapon] || WEAPONS.rifle;
    const ammo = this.local.ammo[this.local.weapon] || { mag: 0, reserve: 0 };
    const reload = Math.max(0, this.local.reloadLeft || 0);
    const sig = `${w.id}|${ammo.mag}|${ammo.reserve}|${reload.toFixed(1)}`;
    if (!force && sig === this.lastHudSig) return;
    this.lastHudSig = sig;
    this.ui.setAmmo({ weapon: w, mag: ammo.mag, reserve: ammo.reserve, magSize: w.mag, reload });
    this.world?.setReload(reload);
  }

  _renderScoreboard() {
    if (!this.lastSnapshot) return;
    this.ui.setScoreboard(this.lastSnapshot.players || [], this.mySlot, this.lastSnapshot.target, this.names);
  }

  _sampleRemote(now) {
    if (!this.buf.length) return null;
    const remoteSlot = 1 - this.mySlot;
    const latest = this.buf[this.buf.length - 1];
    const target = now - this.clockOffset - 0.1;
    let a = null;
    let b = null;
    for (let i = this.buf.length - 1; i >= 0; i--) {
      const snap = this.buf[i];
      if (snap.now <= target) {
        a = snap;
        b = this.buf[i + 1] || snap;
        break;
      }
    }
    if (!a) {
      a = this.buf[0];
      b = a;
    }
    const pa = a.players.find((p) => p.slot === remoteSlot);
    const pb = b.players.find((p) => p.slot === remoteSlot);
    const p0 = pa || pb;
    const p1 = pb || pa;
    if (!p0 || !p1) return null;
    const span = Math.max(0.001, (b.now - a.now));
    const t = Math.max(0, Math.min(1, (target - a.now) / span));
    let x = p0.x + (p1.x - p0.x) * t;
    let y = p0.y + (p1.y - p0.y) * t;
    let z = p0.z + (p1.z - p0.z) * t;
    if (Math.hypot(p1.x - p0.x, p1.z - p0.z) > 5) {
      x = p1.x;
      y = p1.y;
      z = p1.z;
    }
    const yaw = lerpAngle(p0.yaw, p1.yaw, t);
    const pitch = p0.pitch + (p1.pitch - p0.pitch) * t;
    return {
      slot: remoteSlot,
      name: p1.name,
      x, y, z,
      yaw,
      pitch,
      crouch: !!p1.crouch,
      aiming: !!p1.aiming,
      alive: p1.alive !== false,
      speed: p1.alive ? (p1.speed || 0) : 0,
      onGround: p1.onGround !== false,
    };
  }

  _startLoop() {
    requestAnimationFrame(this._frame);
  }

  _frame(tsMs) {
    requestAnimationFrame(this._frame);
    const now = tsMs / 1000;
    let dt = now - this.lastFrame;
    this.lastFrame = now;
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    dt = Math.min(dt, 0.05);

    this.world?.update(dt);

    if (this.mode === "game") {
      let remote = null;
      if (this.local) {
        remote = this._sampleRemote(now);
        this.remoteView = remote;
        if (this.gameState === "live") this._applyAimAssist(now, dt);
      }
      if (this.gameState === "live" && this.local?.alive) {
        this.accumulator += dt;
        let steps = 0;
        while (this.accumulator >= TICK_DT && steps < 5) {
          this._step();
          this.accumulator -= TICK_DT;
          steps++;
        }
      } else {
        this.accumulator = 0;
        if (this.gameState !== "live") this._resetAssist();
      }

      if (this.local) {
        const dx = this.local.x - this.visual.x;
        const dy = this.local.y - this.visual.y;
        const dz = this.local.z - this.visual.z;
        if (Math.hypot(dx, dy, dz) > 4) {
          this.visual.x = this.local.x;
          this.visual.y = this.local.y;
          this.visual.z = this.local.z;
        } else {
          const k = 1 - Math.exp(-24 * dt);
          this.visual.x += dx * k;
          this.visual.y += dy * k;
          this.visual.z += dz * k;
        }
        const weaponId = this.local.weapon || "rifle";
        const aiming = this._canControl() && this.input.aimHeld && this.local.alive;
        this.world?.setAiming(aiming, weaponId);
        const aimFactor = aiming ? (weaponId === "sniper" ? 0.38 : 0.72) : 1;
        if (aimFactor !== this.lastAimFactor) {
          this.lastAimFactor = aimFactor;
          this.input.setAimFactor(aimFactor);
        }
        this.world?.setRemote(remote, dt);
        this.world?.updateCamera(this.visual, this.input.view, this.local, dt);
        this.world?.setReload(this.local.reloadLeft || 0);
        const scoped = !!this.world?.scoped && aiming;
        const adsDot = aiming && weaponId !== "sniper";
        const scopeState = `${scoped}|${adsDot}`;
        if (scopeState !== this.lastScopeState) {
          this.lastScopeState = scopeState;
          this.ui.setScope(scoped, adsDot);
        }
        if (this.assistActive) this.ui.setAssist(true, scoped);
        const spread = currentSpread(this.local, this.local.weapon, this.local.spray);
        this.ui.setCrosshair(spread);
        const crosshairOn = this.local.alive && !aiming;
        if (crosshairOn !== this.lastCrosshairOn) {
          this.lastCrosshairOn = crosshairOn;
          this.ui.el.crosshair.style.opacity = crosshairOn ? "1" : "0";
        }
        this.minimapAcc += dt;
        if (this.minimapAcc >= 0.09) {
          this.minimapAcc = 0;
          this._updateMinimap(now, remote);
        }
        this._footsteps(dt, remote);
      }
    }

    this._updateAmmoHud();
    if (this.input.scoreHeld && this.mode === "game" && this.gameState === "live" && !this.resultsOpen) {
      if (!this.scoreboardVisible) {
        this.scoreboardVisible = true;
        this.ui.showScoreboard(true);
      }
      this._renderScoreboard();
    } else if (this.scoreboardVisible) {
      this.scoreboardVisible = false;
      this.ui.showScoreboard(false);
    }

    this.world?.render();
  }

  _updateMinimap(now, remote) {
    if (!this.local) return;
    let visible = false;
    if (this.gameState === "live" && remote && remote.alive) {
      const eye = eyePosition(this.local);
      const re = eyePosition(remote);
      const dx = re.x - eye.x;
      const dy = re.y - eye.y;
      const dz = re.z - eye.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > 0.2 && dist < 95) {
        const hit = raycastMap(eye.x, eye.y, eye.z, dx / dist, dy / dist, dz / dist, dist);
        const los = hit >= dist - 0.2;
        const fx = -Math.sin(this.input.view.yaw);
        const fz = -Math.cos(this.input.view.yaw);
        const horiz = Math.hypot(dx, dz) || 1;
        const dot = (dx * fx + dz * fz) / horiz;
        visible = los && dot > 0.38;
      }
      if (visible) {
        this.lastKnownEnemy = { x: remote.x, z: remote.z };
        this.enemyRevealUntil = Math.max(this.enemyRevealUntil, now + 0.5);
      }
    }
    this.enemyVisible = visible;
    const revealed = this.enemyRevealUntil > now ? Math.min(1, (this.enemyRevealUntil - now) / 2.4) : 0;
    this.minimap.update(
      { x: this.local.x, z: this.local.z, yaw: this.input.view.yaw, alive: this.local.alive },
      remote ? { x: remote.x, z: remote.z, alive: remote.alive } : null,
      { visible, revealed, lastKnown: this.lastKnownEnemy },
      0.09
    );
  }

  _footsteps(dt, remote) {
    if (!this.local?.alive) return;
    const speed = this.local.speed || 0;
    if (this.local.onGround && speed > 1.6 && !this.paused) {
      this.footstepAcc += dt * speed;
      const threshold = this.local.crouch ? 3.4 : 2.15;
      if (this.footstepAcc > threshold) {
        this.footstepAcc = 0;
        this.audio.footstep(0, this.local.crouch ? 0.025 : 0.07);
      }
    } else {
      this.footstepAcc = Math.max(0, this.footstepAcc - dt * 2);
    }

    if (remote && remote.alive && remote.speed > 2.2 && remote.onGround) {
      const now = performance.now() / 1000;
      if (now - this.remoteStepAt > 0.34) {
        this.remoteStepAt = now;
        const dx = remote.x - this.visual.x;
        const dz = remote.z - this.visual.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 18) {
          const rightX = Math.cos(this.input.view.yaw);
          const rightZ = -Math.sin(this.input.view.yaw);
          const pan = clamp((dx * rightX + dz * rightZ) / Math.max(0.2, dist), -1, 1);
          this.audio.footstep(pan, clamp(0.14 - dist / 180, 0.01, 0.12));
        }
      }
    }
  }
}

const game = new Game();
window.__gs = game;
