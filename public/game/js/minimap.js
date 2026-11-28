// 俯视战术小地图：静态布局一次绘制，敌人只在可见或刚开过火时暴露。

import { MAP_BOXES } from "./shared.js";

const MAP_HALF = 22;
const WORLD_SIZE = MAP_HALF * 2;

export class Minimap {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.size = canvas.width;
    this.pad = 13;
    this.scale = (this.size - this.pad * 2) / WORLD_SIZE;
    this.staticLayer = document.createElement("canvas");
    this.staticLayer.width = this.staticLayer.height = this.size;
    this.time = 0;
    this._drawStatic();
  }

  mx(x) { return this.pad + (x + MAP_HALF) * this.scale; }
  mz(z) { return this.pad + (z + MAP_HALF) * this.scale; }

  _drawStatic() {
    const g = this.staticLayer.getContext("2d");
    const S = this.size;
    g.clearRect(0, 0, S, S);
    g.fillStyle = "#0a111b";
    g.fillRect(0, 0, S, S);

    g.fillStyle = "rgba(72, 96, 120, 0.14)";
    g.fillRect(this.mx(-MAP_HALF), this.mz(-MAP_HALF), WORLD_SIZE * this.scale, WORLD_SIZE * this.scale);

    g.strokeStyle = "rgba(120, 168, 200, 0.075)";
    g.lineWidth = 1;
    for (let v = -20; v <= 20; v += 8) {
      g.beginPath();
      g.moveTo(this.mx(v), this.mz(-MAP_HALF));
      g.lineTo(this.mx(v), this.mz(MAP_HALF));
      g.stroke();
      g.beginPath();
      g.moveTo(this.mx(-MAP_HALF), this.mz(v));
      g.lineTo(this.mx(MAP_HALF), this.mz(v));
      g.stroke();
    }

    const boxes = MAP_BOXES
      .filter((b) => b.solid !== false && b.y < 3 && !(b.w > 40 && b.d > 40))
      .slice()
      .sort((a, b) => (a.y + a.h) - (b.y + b.h));

    for (const b of boxes) {
      const x = this.mx(b.x - b.w / 2);
      const y = this.mz(b.z - b.d / 2);
      const w = b.w * this.scale;
      const d = b.d * this.scale;
      let fill = "rgba(150, 168, 184, 0.28)";
      let stroke = "rgba(190, 210, 228, 0.28)";
      if (b.mat === "wood") {
        fill = "rgba(196, 152, 96, 0.36)";
        stroke = "rgba(224, 184, 128, 0.45)";
      } else if (b.mat === "metal") {
        fill = "rgba(92, 160, 172, 0.3)";
        stroke = "rgba(122, 202, 214, 0.4)";
      } else if (b.mat === "concrete") {
        fill = "rgba(142, 158, 176, 0.34)";
        stroke = "rgba(188, 206, 224, 0.4)";
      }
      if (b.h > 4) {
        fill = "rgba(116, 134, 154, 0.5)";
        stroke = "rgba(200, 220, 238, 0.5)";
      }
      g.fillStyle = fill;
      g.fillRect(x, y, w, d);
      g.strokeStyle = stroke;
      g.lineWidth = 1;
      g.strokeRect(x + 0.5, y + 0.5, Math.max(1, w - 1), Math.max(1, d - 1));
    }

    g.strokeStyle = "rgba(88, 210, 238, 0.35)";
    g.lineWidth = 1.5;
    g.strokeRect(this.pad - 2.5, this.pad - 2.5, WORLD_SIZE * this.scale + 5, WORLD_SIZE * this.scale + 5);

    g.font = "600 11px ui-monospace, Menlo, monospace";
    g.fillStyle = "rgba(150, 190, 212, 0.55)";
    g.textAlign = "center";
    g.fillText("N", S / 2, 10);
    g.textAlign = "left";
    g.fillText("仓库", this.pad + 1, S - 5);
    g.textAlign = "right";
    g.fillText("1V1", S - this.pad - 1, S - 5);
  }

  update(local, remote, info, dt) {
    this.time += dt;
    const g = this.ctx;
    g.clearRect(0, 0, this.size, this.size);
    g.drawImage(this.staticLayer, 0, 0);
    if (!local) return;

    const px = this.mx(local.x);
    const py = this.mz(local.z);
    const fx = -Math.sin(local.yaw);
    const fz = -Math.cos(local.yaw);
    const ang = Math.atan2(fz, fx);

    g.save();
    g.translate(px, py);
    g.rotate(ang);
    const cone = g.createRadialGradient(0, 0, 0, 0, 0, 44);
    cone.addColorStop(0, "rgba(80, 224, 248, 0.22)");
    cone.addColorStop(1, "rgba(80, 224, 248, 0)");
    g.fillStyle = cone;
    g.beginPath();
    g.moveTo(0, 0);
    g.arc(0, 0, 44, -0.52, 0.52);
    g.closePath();
    g.fill();
    g.restore();

    if (remote && remote.alive !== false && info) {
      const ex = this.mx(remote.x);
      const ey = this.mz(remote.z);
      if (info.visible) {
        this._enemy(g, ex, ey, 0.95, true);
      } else if (info.revealed > 0.03 && info.lastKnown) {
        const lx = this.mx(info.lastKnown.x);
        const ly = this.mz(info.lastKnown.z);
        const pulse = (this.time * 1.6) % 1;
        g.strokeStyle = `rgba(255, 138, 92, ${0.4 * info.revealed * (1 - pulse)})`;
        g.lineWidth = 2;
        g.beginPath();
        g.arc(lx, ly, 4 + pulse * 10, 0, Math.PI * 2);
        g.stroke();
        this._enemy(g, lx, ly, info.revealed * 0.75, false);
      }
    }

    g.save();
    g.translate(px, py);
    g.rotate(ang);
    g.fillStyle = local.alive === false ? "rgba(170, 180, 196, 0.7)" : "#63e8ff";
    g.shadowColor = "rgba(80, 230, 255, 0.9)";
    g.shadowBlur = 7;
    g.beginPath();
    g.moveTo(7, 0);
    g.lineTo(-4.5, 4.5);
    g.lineTo(-2, 0);
    g.lineTo(-4.5, -4.5);
    g.closePath();
    g.fill();
    g.restore();
  }

  _enemy(g, x, y, alpha, visible) {
    g.save();
    g.globalAlpha = Math.max(0, Math.min(1, alpha));
    g.fillStyle = visible ? "#ff8a5c" : "rgba(255, 138, 92, 0.72)";
    g.shadowColor = "rgba(255, 110, 70, 0.9)";
    g.shadowBlur = visible ? 9 : 4;
    g.beginPath();
    g.arc(x, y, visible ? 4 : 3.2, 0, Math.PI * 2);
    g.fill();
    if (visible) {
      g.strokeStyle = "rgba(255, 190, 160, 0.7)";
      g.lineWidth = 1;
      g.beginPath();
      g.arc(x, y, 7.5, 0, Math.PI * 2);
      g.stroke();
    }
    g.restore();
  }
}
