// 键鼠输入与指针锁定。视角角度和移动键位按 30Hz 采样后发给服务器。

import { KEY } from "./shared.js";

const GAME_KEYS = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD", "Space", "ControlLeft", "ControlRight",
  "ShiftLeft", "ShiftRight", "KeyR", "Digit1", "Digit2", "Digit3", "Tab", "KeyC",
]);

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.view = { yaw: 0, pitch: 0 };
    this.fireHeld = false;
    this.firePressed = false;
    this.aimHeld = false;
    this.reloadPressed = false;
    this.slotPressed = 0;
    this.enabled = false;
    this.locked = false;
    this.dragging = false;
    this.scoreHeld = false;
    this.sensitivity = 1;
    this.aimFactor = 1;
    this.assistSlow = 1;
    this.lockSupported = !!canvas.requestPointerLock;
    this.onLockChange = null;
    this.onLockError = null;
    this._bind();
  }

  _bind() {
    window.addEventListener("keydown", (e) => this._key(e, true));
    window.addEventListener("keyup", (e) => this._key(e, false));
    window.addEventListener("blur", () => this.clear());
    document.addEventListener("pointerlockchange", () => {
      const locked = document.pointerLockElement === this.canvas;
      if (locked === this.locked) return;
      this.locked = locked;
      if (!locked) {
        this.clear();
        this.dragging = false;
      }
      if (this.onLockChange) this.onLockChange(locked);
    });
    document.addEventListener("pointerlockerror", () => {
      if (this.onLockError) this.onLockError();
    });

    this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    this.canvas.addEventListener("mousedown", (e) => {
      if (!this.enabled) return;
      if (e.button !== 0) return;
      e.preventDefault();
      if (this.locked) {
        this.fireHeld = true;
        this.firePressed = true;
      } else {
        this.dragging = true;
        this.fireHeld = true;
        this.firePressed = true;
      }
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 2) {
        this.aimHeld = false;
        return;
      }
      if (e.button !== 0) return;
      this.fireHeld = false;
      this.dragging = false;
    });
    this.canvas.addEventListener("mousedown", (e) => {
      if (!this.enabled || e.button !== 2) return;
      e.preventDefault();
      this.aimHeld = true;
    });
    window.addEventListener("mousemove", (e) => {
      if (!this.enabled) return;
      if (!this.locked && !this.dragging) return;
      const speed = 0.0021 * this.sensitivity * this.aimFactor * this.assistSlow * (this.locked ? 1 : 0.8);
      this.view.yaw -= (e.movementX || 0) * speed;
      this.view.pitch -= (e.movementY || 0) * speed;
      this.view.pitch = Math.max(-1.52, Math.min(1.52, this.view.pitch));
      if (Math.abs(this.view.yaw) > Math.PI * 4) this.view.yaw = ((this.view.yaw + Math.PI) % (Math.PI * 2)) - Math.PI;
    });
  }

  _key(e, down) {
    const tag = e.target?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || e.target?.isContentEditable) return;
    if (!GAME_KEYS.has(e.code)) return;
    if (!this.enabled) return;
    e.preventDefault();

    if (down) {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === "KeyR") this.reloadPressed = true;
      if (e.code === "Digit1") this.slotPressed = 1;
      if (e.code === "Digit2") this.slotPressed = 2;
      if (e.code === "Digit3") this.slotPressed = 3;
      if (e.code === "Tab") this.scoreHeld = true;
    } else {
      this.keys.delete(e.code);
      if (e.code === "Tab") this.scoreHeld = false;
    }
  }

  setSensitivity(value) {
    this.sensitivity = Math.max(0.1, Math.min(5, Number(value) || 1));
  }

  setAimFactor(value) {
    this.aimFactor = Math.max(0.2, Math.min(1, Number(value) || 1));
  }

  setAssistSlow(value) {
    this.assistSlow = Math.max(0.35, Math.min(1, Number(value) || 1));
  }

  requestLock() {
    if (this.locked) return;
    if (!this.canvas.requestPointerLock) {
      if (this.onLockError) this.onLockError();
      return;
    }
    try {
      const p = this.canvas.requestPointerLock({ unadjustedMovement: true });
      if (p && typeof p.catch === "function") {
        p.catch(() => {
          try {
            const fallback = this.canvas.requestPointerLock();
            if (fallback && typeof fallback.catch === "function") fallback.catch(() => this.onLockError?.());
          } catch {
            this.onLockError?.();
          }
        });
      }
    } catch {
      try { this.canvas.requestPointerLock(); } catch { this.onLockError?.(); }
    }
  }

  clear() {
    this.keys.clear();
    this.fireHeld = false;
    this.firePressed = false;
    this.aimHeld = false;
    this.aimHeld = false;
    this.reloadPressed = false;
    this.slotPressed = 0;
    this.scoreHeld = false;
  }

  reset() {
    this.clear();
    this.view.yaw = 0;
    this.view.pitch = 0;
  }

  sample(autoFire) {
    let keys = 0;
    if (this.enabled) {
      if (this.keys.has("KeyW")) keys |= KEY.FORWARD;
      if (this.keys.has("KeyS")) keys |= KEY.BACK;
      if (this.keys.has("KeyA")) keys |= KEY.LEFT;
      if (this.keys.has("KeyD")) keys |= KEY.RIGHT;
      if (this.keys.has("Space")) keys |= KEY.JUMP;
      if (this.keys.has("ControlLeft") || this.keys.has("ControlRight") || this.keys.has("KeyC")) keys |= KEY.CROUCH;
      if (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight")) keys |= KEY.WALK;
    }
    const fire = this.enabled && (autoFire ? this.fireHeld : this.firePressed);
    const reload = this.enabled && this.reloadPressed;
    const slot = this.enabled ? this.slotPressed : 0;
    this.firePressed = false;
    this.reloadPressed = false;
    this.slotPressed = 0;
    return {
      keys,
      yaw: this.view.yaw,
      pitch: this.view.pitch,
      fire,
      reload,
      aim: this.enabled && this.aimHeld,
      slot,
    };
  }
}
