// 触屏操作层（手机 / 平板）。
// 布局沿用主流手游 FPS：左侧浮动摇杆（按下处即摇杆中心，拖出范围后底座跟随手指，参考 nipplejs 的
// dynamic + follow 模式），右侧空白处滑动转视角，开火键按住连发且按住时仍可滑动微调准星。
// 全部基于 Pointer Events，用 pointerId 区分手指，多指互不串扰；touch-action:none 由 CSS 提供，
// 这里再 preventDefault 一次，阻止滚动 / 双击缩放 / 兼容鼠标事件。

import { KEY } from "./shared.js";

const STICK_R = 54;          // 摇杆半径（CSS px）
const STICK_FOLLOW = 1.45;   // 拖出 1.45 倍半径后底座跟随
const DEAD = 0.18;           // 死区
const WALK_AT = 0.5;         // 推杆小于一半时静步
const DIR = 0.383;           // sin(22.5°)，8 方向分区
const LOOK_BASE = 0.0058;    // 每像素弧度，再乘灵敏度 / 开镜系数 / 辅助减速
const STICK_ZONE = 0.42;     // 左侧 42% 屏宽为摇杆区
const MOVE_MASK = KEY.FORWARD | KEY.BACK | KEY.LEFT | KEY.RIGHT | KEY.WALK;

export class TouchControls {
  constructor(root, input, { slots = null, onPause = null } = {}) {
    this.root = root;
    this.input = input;
    this.onPause = onPause;
    this.pointers = new Map();
    this.stickId = null;
    this.fireCount = 0;
    this.crouch = false;
    this.lastAim = null;
    this.stick = root?.querySelector(".tstick") || null;
    this.knob = this.stick?.querySelector("i") || null;
    this.aimBtn = root?.querySelector('[data-act="aim"]') || null;
    this.crouchBtn = root?.querySelector('[data-act="crouch"]') || null;
    if (!root) return;

    root.addEventListener("pointerdown", (e) => this._down(e), { passive: false });
    root.addEventListener("pointermove", (e) => this._move(e), { passive: false });
    root.addEventListener("pointerup", (e) => this._up(e));
    root.addEventListener("pointercancel", (e) => this._up(e));
    root.addEventListener("lostpointercapture", (e) => this._up(e));
    root.addEventListener("contextmenu", (e) => e.preventDefault());

    if (slots) {
      slots.addEventListener("pointerdown", (e) => {
        if (e.pointerType === "mouse" || !this.input.enabled) return;
        const btn = e.target.closest?.("[data-slot]");
        if (!btn) return;
        e.preventDefault();
        this.input.slotPressed = Number(btn.dataset.slot) || 0;
        this.input.aimHeld = false;
      }, { passive: false });
      slots.addEventListener("contextmenu", (e) => e.preventDefault());
    }

    const prev = input.onClear;
    input.onClear = () => {
      prev?.();
      this.reset();
    };
  }

  _down(e) {
    if (e.pointerType === "mouse") return;
    e.preventDefault();
    const btn = e.target.closest?.("[data-act]") || null;
    const act = btn?.dataset.act || "";
    if (act === "pause") {
      this.onPause?.();
      return;
    }
    if (!this.input.enabled) return;
    try { this.root.setPointerCapture(e.pointerId); } catch { /* 部分 WebView 不支持 */ }
    const p = { act, btn, x: e.clientX, y: e.clientY, cx: 0, cy: 0 };
    btn?.classList.add("down");
    const input = this.input;
    switch (act) {
      case "fire":
        this.fireCount++;
        input.fireHeld = true;
        input.firePressed = true;
        break;
      case "aim":
        input.aimHeld = !input.aimHeld;
        break;
      case "reload":
        input.reloadPressed = true;
        break;
      case "jump":
        input.touchKeys |= KEY.JUMP;
        input.touchLatch |= KEY.JUMP;
        break;
      case "crouch":
        this._setCrouch(!this.crouch);
        break;
      case "score":
        input.scoreHeld = true;
        break;
      default:
        if (e.clientX < window.innerWidth * STICK_ZONE && this.stickId === null) {
          p.act = "stick";
          this.stickId = e.pointerId;
          this._stickStart(p);
        } else {
          p.act = "look";
        }
    }
    this.pointers.set(e.pointerId, p);
  }

  _move(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (!this.input.enabled) return;
    if (p.act === "stick") this._stickMove(p);
    else if (p.act === "look" || p.act === "fire") this.input.look(dx, dy, LOOK_BASE);
  }

  _up(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.pointers.delete(e.pointerId);
    p.btn?.classList.remove("down");
    const input = this.input;
    if (p.act === "fire") {
      this.fireCount = Math.max(0, this.fireCount - 1);
      if (!this.fireCount) input.fireHeld = false;
    } else if (p.act === "jump") {
      input.touchKeys &= ~KEY.JUMP;
    } else if (p.act === "score") {
      input.scoreHeld = false;
    } else if (p.act === "stick") {
      this._stickEnd();
    }
  }

  _stickStart(p) {
    const m = STICK_R + 10;
    p.cx = Math.max(m, Math.min(window.innerWidth * STICK_ZONE, p.x));
    p.cy = Math.max(m, Math.min(window.innerHeight - m, p.y));
    this.stick?.classList.add("on");
    this._placeStick(p);
    this._stickMove(p);
  }

  _placeStick(p) {
    if (!this.stick) return;
    this.stick.style.left = `${p.cx - STICK_R}px`;
    this.stick.style.top = `${p.cy - STICK_R}px`;
    this.stick.style.bottom = "auto";
  }

  _stickMove(p) {
    let dx = p.x - p.cx;
    let dy = p.y - p.cy;
    let d = Math.hypot(dx, dy);
    const follow = STICK_R * STICK_FOLLOW;
    if (d > follow) {
      const k = (d - follow) / d;
      p.cx += dx * k;
      p.cy += dy * k;
      dx = p.x - p.cx;
      dy = p.y - p.cy;
      d = follow;
      this._placeStick(p);
    }
    const nx = d > 0 ? dx / d : 0;
    const ny = d > 0 ? dy / d : 0;
    const r = Math.min(d, STICK_R);
    if (this.knob) this.knob.style.transform = `translate3d(${(nx * r).toFixed(1)}px, ${(ny * r).toFixed(1)}px, 0)`;
    const mag = Math.min(1, d / STICK_R);
    let keys = 0;
    if (mag > DEAD) {
      if (ny < -DIR) keys |= KEY.FORWARD;
      if (ny > DIR) keys |= KEY.BACK;
      if (nx < -DIR) keys |= KEY.LEFT;
      if (nx > DIR) keys |= KEY.RIGHT;
      if (mag < WALK_AT) keys |= KEY.WALK;
    }
    this.input.touchKeys = (this.input.touchKeys & ~MOVE_MASK) | keys;
  }

  _stickEnd() {
    this.stickId = null;
    this.input.touchKeys &= ~MOVE_MASK;
    if (!this.stick) return;
    this.stick.classList.remove("on");
    this.stick.style.left = "";
    this.stick.style.top = "";
    this.stick.style.bottom = "";
    if (this.knob) this.knob.style.transform = "";
  }

  _setCrouch(on) {
    this.crouch = !!on;
    if (this.crouch) this.input.touchKeys |= KEY.CROUCH;
    else this.input.touchKeys &= ~KEY.CROUCH;
    this.crouchBtn?.classList.toggle("on", this.crouch);
  }

  // input.clear() 时调用（暂停、失焦、退出对局）：松开所有手指的状态。
  reset() {
    for (const p of this.pointers.values()) p.btn?.classList.remove("down");
    this.pointers.clear();
    this.fireCount = 0;
    this._stickEnd();
    this.crouch = false;
    this.crouchBtn?.classList.remove("on");
    this.lastAim = null;
    this.sync();
  }

  // 每帧调用：开镜是切换式的，按钮高亮跟随真实状态（换枪 / 死亡会被外部重置）。
  sync() {
    const aim = !!this.input.aimHeld;
    if (aim === this.lastAim) return;
    this.lastAim = aim;
    this.aimBtn?.classList.toggle("on", aim);
  }
}

export function prefersTouch() {
  try {
    if (window.matchMedia("(hover: none) and (pointer: coarse)").matches) return true;
  } catch { /* ignore */ }
  return false;
}
