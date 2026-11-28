// Three.js 场景：日光明亮的工业仓库、程序化材质、低模角色、第一人称武器与命中特效。
// 静态阴影只烘焙一次；地图材质合并为少量 draw call，兼顾集显。

import * as THREE from "./vendor/three.module.min.js";
import { MAP_BOXES, PLAYER, WEAPONS } from "./shared.js";

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

const COLORS = {
  enemy: 0xc2623c,
  enemyDim: 0x8a4a2e,
  friendly: 0x3d7fc4,
  friendlyDim: 0x2c5479,
  gun: 0x5d6066,
  gunDark: 0x34373c,
  accent: 0xffb547,
  boot: 0x191c22,
};

const ENEMY_NAME_COLOR = "#ff8a5c";

const MAT_TILE = { concrete: 2.4, wall: 3.2, wood: 1.5, metal: 2.2 };

function lambert(color, extra = {}) {
  return new THREE.MeshLambertMaterial({ color, ...extra });
}
function basic(color, extra = {}) {
  return new THREE.MeshBasicMaterial({ color, ...extra });
}

// 把一组盒子烘成一个带顶点色的 BufferGeometry：一个部件 = 一次 draw call。
// part: { s:[w,h,d], p:[x,y,z], r:[rx,ry,rz], c:hex, top:[sx,sz], bot:[sx,sz], ao }
// top/bot 让盒子上下端收窄（梯形躯干、头盔、大腿），ao 是底部压暗系数（伪环境光遮蔽），
// 都只在建模时计算一次，运行时零额外开销。
const _pm = new THREE.Matrix4();
const _pq = new THREE.Quaternion();
const _pe = new THREE.Euler();
const _pv = new THREE.Vector3();
const _ps = new THREE.Vector3(1, 1, 1);
const _pn = new THREE.Matrix3();
const _pc = new THREE.Color();
function partsGeometry(parts) {
  const pos = [];
  const nor = [];
  const col = [];
  const idx = [];
  for (const part of parts) {
    const [w, h, d] = part.s;
    const box = new THREE.BoxGeometry(w, h, d);
    const bp = box.attributes.position;
    const top = part.top || null;
    const bot = part.bot || null;
    if (top || bot) {
      for (let i = 0; i < bp.count; i++) {
        const k = bp.getY(i) > 0 ? top : bot;
        if (!k) continue;
        bp.setX(i, bp.getX(i) * k[0]);
        bp.setZ(i, bp.getZ(i) * k[1]);
      }
      box.computeVertexNormals();
    }
    const bn = box.attributes.normal;
    const r = part.r || [0, 0, 0];
    _pe.set(r[0], r[1], r[2]);
    _pq.setFromEuler(_pe);
    _pv.set(part.p[0], part.p[1], part.p[2]);
    _pm.compose(_pv, _pq, _ps);
    _pn.getNormalMatrix(_pm);
    _pc.setHex(part.c);
    const ao = part.ao ?? 0.8;
    const base = pos.length / 3;
    const n = new THREE.Vector3();
    const v = new THREE.Vector3();
    for (let i = 0; i < bp.count; i++) {
      const t = (bp.getY(i) + h / 2) / h;
      const shade = ao + (1 - ao) * t;
      v.set(bp.getX(i), bp.getY(i), bp.getZ(i)).applyMatrix4(_pm);
      n.set(bn.getX(i), bn.getY(i), bn.getZ(i)).applyMatrix3(_pn).normalize();
      pos.push(v.x, v.y, v.z);
      nor.push(n.x, n.y, n.z);
      col.push(_pc.r * shade, _pc.g * shade, _pc.b * shade);
    }
    const bi = box.index.array;
    for (let i = 0; i < bi.length; i++) idx.push(base + bi[i]);
    box.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

// 颜色明度缩放（建模配色用）
function tint(hex, k) {
  const r = Math.min(255, Math.round(((hex >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((hex >> 8) & 255) * k));
  const b = Math.min(255, Math.round((hex & 255) * k));
  return (r << 16) | (g << 8) | b;
}

function mulberry(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function canvasTexture(size, draw, { flipY = true } = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d");
  draw(g, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.flipY = flipY;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

function concreteTexture() {
  return canvasTexture(512, (g, s) => {
    const rnd = mulberry(11);
    g.fillStyle = "#dedfdc";
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < 46; i++) {
      const x = rnd() * s;
      const y = rnd() * s;
      const r = 20 + rnd() * 90;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      const dark = rnd() < 0.5;
      grad.addColorStop(0, dark ? "rgba(90,94,98,0.05)" : "rgba(255,255,255,0.05)");
      grad.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = grad;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    for (let i = 0; i < 5200; i++) {
      const a = 0.025 + rnd() * 0.09;
      g.fillStyle = rnd() < 0.55 ? `rgba(70,74,80,${a})` : `rgba(255,255,255,${a})`;
      g.fillRect(rnd() * s, rnd() * s, 1 + rnd() * 2, 1 + rnd() * 2);
    }
    g.strokeStyle = "rgba(88,92,97,0.4)";
    g.lineWidth = 2;
    g.beginPath();
    for (const p of [0.5, s / 2 + 0.5]) {
      g.moveTo(p, 0); g.lineTo(p, s);
      g.moveTo(0, p); g.lineTo(s, p);
    }
    g.stroke();
    g.strokeStyle = "rgba(255,255,255,0.35)";
    g.lineWidth = 1;
    g.beginPath();
    for (const p of [3.5, s / 2 + 3.5]) {
      g.moveTo(p, 0); g.lineTo(p, s);
      g.moveTo(0, p); g.lineTo(s, p);
    }
    g.stroke();
    for (let i = 0; i < 16; i++) {
      const ox = rnd() * s;
      const oy = rnd() * s;
      const or = 12 + rnd() * 34;
      const oil = g.createRadialGradient(ox, oy, 0, ox, oy, or);
      oil.addColorStop(0, `rgba(52,54,56,${0.05 + rnd() * 0.07})`);
      oil.addColorStop(1, "rgba(52,54,56,0)");
      g.fillStyle = oil;
      g.fillRect(ox - or, oy - or, or * 2, or * 2);
    }
    for (let i = 0; i < 12; i++) {
      g.strokeStyle = `rgba(82,86,90,${0.06 + rnd() * 0.09})`;
      g.lineWidth = 5 + rnd() * 16;
      g.lineCap = "round";
      g.beginPath();
      g.moveTo(rnd() * s, rnd() * s);
      g.lineTo(rnd() * s, rnd() * s);
      g.stroke();
    }
    for (let i = 0; i < 8; i++) {
      g.strokeStyle = `rgba(95,98,102,${0.12 + rnd() * 0.15})`;
      g.lineWidth = 1;
      let x = rnd() * s;
      let y = rnd() * s;
      g.beginPath();
      g.moveTo(x, y);
      for (let j = 0; j < 5; j++) {
        x += (rnd() - 0.5) * 46;
        y += (rnd() - 0.5) * 46;
        g.lineTo(x, y);
      }
      g.stroke();
    }
  });
}

function wallTexture() {
  return canvasTexture(512, (g, s) => {
    const rnd = mulberry(23);
    g.fillStyle = "#d6d8d6";
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < 26; i++) {
      const x = rnd() * s;
      const y = rnd() * s;
      const r = 30 + rnd() * 110;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, rnd() < 0.6 ? "rgba(95,100,104,0.05)" : "rgba(255,255,255,0.06)");
      grad.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = grad;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    for (let i = 0; i < 3600; i++) {
      g.fillStyle = rnd() < 0.5 ? `rgba(80,84,88,${0.02 + rnd() * 0.06})` : `rgba(255,255,255,${0.02 + rnd() * 0.05})`;
      g.fillRect(rnd() * s, rnd() * s, 1 + rnd() * 2, 1 + rnd() * 2);
    }
    g.strokeStyle = "rgba(92,96,100,0.45)";
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(0, 1); g.lineTo(s, 1);
    g.moveTo(0, s / 2); g.lineTo(s, s / 2);
    g.moveTo(1, 0); g.lineTo(1, s);
    g.moveTo(s / 2, 0); g.lineTo(s / 2, s);
    g.stroke();
    g.strokeStyle = "rgba(255,255,255,0.4)";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, 4); g.lineTo(s, 4);
    g.moveTo(4, 0); g.lineTo(4, s);
    g.moveTo(0, s / 2 + 4); g.lineTo(s, s / 2 + 4);
    g.stroke();
    for (let i = 0; i < 36; i++) {
      const x = (i % 4) * (s / 4) + 12;
      const y = Math.floor(i / 4) * (s / 2) + (i % 2 ? s / 2 - 16 : 16);
      g.fillStyle = "rgba(85,89,93,0.55)";
      g.beginPath();
      g.arc(x, y, 2.2, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "rgba(255,255,255,0.35)";
      g.fillRect(x - 1, y - 3, 1, 2);
    }
    for (let i = 0; i < 4; i++) {
      const x = rnd() * s;
      const y = s * 0.55 + rnd() * s * 0.4;
      const grad = g.createLinearGradient(x, y - 90, x, y + 20);
      grad.addColorStop(0, "rgba(96,92,86,0)");
      grad.addColorStop(1, "rgba(96,92,86,0.12)");
      g.fillStyle = grad;
      g.fillRect(x - 8, y - 90, 16, 110);
    }
  });
}

function woodTexture() {
  return canvasTexture(512, (g, s) => {
    const rnd = mulberry(37);
    g.fillStyle = "#dfd2bb";
    g.fillRect(0, 0, s, s);
    for (let p = 0; p < 4; p++) {
      const x = p * (s / 4);
      g.fillStyle = `rgba(255,255,255,${0.03 + rnd() * 0.05})`;
      g.fillRect(x + 2, 0, s / 4 - 4, s);
      g.strokeStyle = "rgba(96,76,52,0.5)";
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(x + 1, 0); g.lineTo(x + 1, s);
      g.stroke();
      g.strokeStyle = "rgba(255,255,255,0.3)";
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x + 5, 0); g.lineTo(x + 5, s);
      g.stroke();
      for (let i = 0; i < 20; i++) {
        const gx = x + 8 + rnd() * (s / 4 - 16);
        g.strokeStyle = `rgba(112,88,58,${0.05 + rnd() * 0.12})`;
        g.lineWidth = 1 + rnd() * 1.5;
        g.beginPath();
        let y = rnd() * s;
        g.moveTo(gx, y);
        for (let j = 0; j < 6; j++) {
          y += 12 + rnd() * 18;
          g.lineTo(gx + (rnd() - 0.5) * 5, y);
        }
        g.stroke();
      }
      for (let k = 0; k < 2; k++) {
        const x2 = x + s / 8 + (rnd() - 0.5) * 10;
        const y2 = rnd() * s;
        g.fillStyle = "rgba(80,60,38,0.4)";
        g.beginPath();
        g.ellipse(x2, y2, 4 + rnd() * 5, 2 + rnd() * 3, rnd(), 0, Math.PI * 2);
        g.fill();
      }
      for (const ny of [12, s - 14]) {
        g.fillStyle = "rgba(58,52,46,0.6)";
        g.beginPath();
        g.arc(x + 10, ny, 2, 0, Math.PI * 2);
        g.arc(x + s / 4 - 10, ny, 2, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.strokeStyle = "rgba(95,74,50,0.45)";
    g.lineWidth = 3;
    for (const y of [0.5, s / 2, s - 1]) {
      g.beginPath();
      g.moveTo(0, y); g.lineTo(s, y);
      g.stroke();
    }
  });
}

function metalTexture() {
  return canvasTexture(512, (g, s) => {
    const rnd = mulberry(53);
    g.fillStyle = "#d2d6dc";
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < 2200; i++) {
      const x = rnd() * s;
      const y = rnd() * s;
      g.fillStyle = rnd() < 0.5 ? `rgba(80,86,94,${0.02 + rnd() * 0.05})` : `rgba(255,255,255,${0.02 + rnd() * 0.07})`;
      g.fillRect(x, y, 0.6 + rnd() * 1.4, 5 + rnd() * 26);
    }
    for (let y = 0; y < s; y += 64) {
      g.strokeStyle = "rgba(92,98,106,0.32)";
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(0, y + 0.5); g.lineTo(s, y + 0.5);
      g.stroke();
      g.strokeStyle = "rgba(255,255,255,0.4)";
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0, y + 4.5); g.lineTo(s, y + 4.5);
      g.stroke();
    }
    for (let i = 0; i < 40; i++) {
      const x = (i % 10) * (s / 10) + 10;
      const y = Math.floor(i / 10) * (s / 4) + 8;
      g.fillStyle = "rgba(88,94,102,0.5)";
      g.beginPath();
      g.arc(x, y, 2.4, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "rgba(255,255,255,0.45)";
      g.fillRect(x - 1, y - 3, 1, 2);
    }
    for (let i = 0; i < 10; i++) {
      const x = rnd() * s;
      const y = rnd() * s;
      const r = 8 + rnd() * 30;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, "rgba(116,92,62,0.12)");
      grad.addColorStop(1, "rgba(116,92,62,0)");
      g.fillStyle = grad;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    for (let i = 0; i < 24; i++) {
      g.strokeStyle = `rgba(90,96,104,${0.08 + rnd() * 0.12})`;
      g.lineWidth = 1;
      g.beginPath();
      const x = rnd() * s;
      const y = rnd() * s;
      g.moveTo(x, y);
      g.lineTo(x + (rnd() - 0.5) * 70, y + (rnd() - 0.5) * 20);
      g.stroke();
    }
  });
}

function skyTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 512;
  const g = canvas.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, "#2d5d99");
  grad.addColorStop(0.28, "#5f93c6");
  grad.addColorStop(0.46, "#a8cbe4");
  grad.addColorStop(0.54, "#e7e3d4");
  grad.addColorStop(0.6, "#d6c7ac");
  grad.addColorStop(0.72, "#a8a49c");
  grad.addColorStop(1, "#8a949c");
  g.fillStyle = grad;
  g.fillRect(0, 0, 1024, 512);

  const rnd = mulberry(97);
  for (let i = 0; i < 34; i++) {
    const x = rnd() * 1024;
    const y = 30 + rnd() * 235;
    const rx = 48 + rnd() * 155;
    const ry = 12 + rnd() * 38;
    const soft = g.createRadialGradient(x, y, 0, x, y, rx);
    soft.addColorStop(0, `rgba(255,255,255,${0.1 + rnd() * 0.17})`);
    soft.addColorStop(0.55, `rgba(246,248,250,${0.05 + rnd() * 0.09})`);
    soft.addColorStop(1, "rgba(255,255,255,0)");
    g.save();
    g.translate(x, y);
    g.scale(1, ry / rx);
    g.translate(-x, -y);
    g.fillStyle = soft;
    g.fillRect(x - rx, y - rx, rx * 2, rx * 2);
    g.restore();
  }
  for (let i = 0; i < 12; i++) {
    const x = rnd() * 1024;
    const y = 178 + rnd() * 82;
    const rx = 70 + rnd() * 150;
    const ry = 10 + rnd() * 24;
    const soft = g.createRadialGradient(x, y, 0, x, y, rx);
    soft.addColorStop(0, `rgba(255,255,255,${0.14 + rnd() * 0.2})`);
    soft.addColorStop(0.55, `rgba(238,244,248,${0.07 + rnd() * 0.1})`);
    soft.addColorStop(1, "rgba(255,255,255,0)");
    g.save();
    g.translate(x, y);
    g.scale(1, ry / rx);
    g.translate(-x, -y);
    g.fillStyle = soft;
    g.fillRect(x - rx, y - rx, rx * 2, rx * 2);
    g.restore();
  }
  for (let i = 0; i < 10; i++) {
    const cx = rnd() * 1024;
    const cy = 150 + rnd() * 95;
    const puffs = 4 + Math.floor(rnd() * 3);
    for (let j = 0; j < puffs; j++) {
      const x = cx + (rnd() - 0.5) * 170;
      const y = cy + (rnd() - 0.5) * 34;
      const r = 26 + rnd() * 64;
      const puff = g.createRadialGradient(x, y - 4, 0, x, y, r);
      puff.addColorStop(0, "rgba(255,255,255,0.5)");
      puff.addColorStop(0.5, "rgba(245,248,250,0.28)");
      puff.addColorStop(1, "rgba(225,232,240,0)");
      g.fillStyle = puff;
      g.beginPath();
      g.ellipse(x, y, r, r * 0.46, rnd() * 0.3, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = "rgba(140,155,172,0.07)";
    g.beginPath();
    g.ellipse(cx, cy + 18, 95, 16, 0, 0, Math.PI * 2);
    g.fill();
  }
  const haze = g.createLinearGradient(0, 240, 0, 300);
  haze.addColorStop(0, "rgba(255,244,222,0)");
  haze.addColorStop(0.5, "rgba(255,244,222,0.16)");
  haze.addColorStop(1, "rgba(255,244,222,0)");
  g.fillStyle = haze;
  g.fillRect(0, 240, 1024, 60);
  const sun = g.createRadialGradient(735, 186, 0, 735, 186, 170);
  sun.addColorStop(0, "rgba(255,252,236,0.98)");
  sun.addColorStop(0.06, "rgba(255,248,220,0.9)");
  sun.addColorStop(0.2, "rgba(255,232,180,0.35)");
  sun.addColorStop(0.55, "rgba(255,220,160,0.1)");
  sun.addColorStop(1, "rgba(255,220,160,0)");
  g.fillStyle = sun;
  g.fillRect(500, 0, 470, 400);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

function nameTexture(name, color) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const g = canvas.getContext("2d");
  g.clearRect(0, 0, 512, 128);
  g.font = "600 42px system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
  const text = String(name || "玩家").slice(0, 12);
  const tw = Math.min(430, g.measureText(text).width + 56);
  g.fillStyle = "rgba(8, 12, 18, 0.78)";
  roundRect(g, (512 - tw) / 2, 30, tw, 70, 18);
  g.fill();
  g.strokeStyle = color;
  g.globalAlpha = 0.65;
  g.lineWidth = 2;
  g.stroke();
  g.globalAlpha = 1;
  g.fillStyle = color;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 256, 66);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function flashTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const g = canvas.getContext("2d");
  g.clearRect(0, 0, 128, 128);
  const grad = g.createRadialGradient(64, 64, 2, 64, 64, 62);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.18, "rgba(255,244,205,0.98)");
  grad.addColorStop(0.45, "rgba(255,196,110,0.5)");
  grad.addColorStop(1, "rgba(255,150,60,0)");
  g.fillStyle = grad;
  g.beginPath();
  g.arc(64, 64, 62, 0, Math.PI * 2);
  g.fill();
  g.globalCompositeOperation = "lighter";
  g.fillStyle = "rgba(255,255,255,0.95)";
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + 0.35;
    g.save();
    g.translate(64, 64);
    g.rotate(a);
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(58, 3);
    g.lineTo(58, -3);
    g.closePath();
    g.fill();
    g.restore();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  return tex;
}

function sparkTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const g = canvas.getContext("2d");
  g.clearRect(0, 0, 64, 64);
  const grad = g.createRadialGradient(32, 32, 1, 32, 32, 30);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.3, "rgba(255,240,190,0.9)");
  grad.addColorStop(0.65, "rgba(255,170,90,0.3)");
  grad.addColorStop(1, "rgba(255,130,50,0)");
  g.fillStyle = grad;
  g.beginPath();
  g.arc(32, 32, 30, 0, Math.PI * 2);
  g.fill();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  return tex;
}

function smokeTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const g = canvas.getContext("2d");
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  grad.addColorStop(0, "rgba(230,232,236,0.55)");
  grad.addColorStop(0.5, "rgba(205,210,216,0.22)");
  grad.addColorStop(1, "rgba(190,196,204,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  return tex;
}

function holeTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const g = canvas.getContext("2d");
  g.clearRect(0, 0, 64, 64);
  const ring = g.createRadialGradient(32, 32, 2, 32, 32, 16);
  ring.addColorStop(0, "rgba(12,12,12,0.95)");
  ring.addColorStop(0.55, "rgba(26,26,26,0.85)");
  ring.addColorStop(0.75, "rgba(150,150,146,0.35)");
  ring.addColorStop(1, "rgba(200,200,196,0)");
  g.fillStyle = ring;
  g.beginPath();
  g.arc(32, 32, 16, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = "rgba(40,40,38,0.45)";
  g.lineWidth = 1;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.random();
    g.beginPath();
    g.moveTo(32 + Math.cos(a) * 9, 32 + Math.sin(a) * 9);
    g.lineTo(32 + Math.cos(a) * (14 + Math.random() * 6), 32 + Math.sin(a) * (14 + Math.random() * 6));
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  return tex;
}

function blobTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 96;
  const g = canvas.getContext("2d");
  const grad = g.createRadialGradient(48, 48, 0, 48, 48, 46);
  grad.addColorStop(0, "rgba(0,0,0,0.55)");
  grad.addColorStop(0.55, "rgba(0,0,0,0.32)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 96, 96);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  return tex;
}

export class GameWorld {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      depth: true,
      stencil: false,
      powerPreference: "high-performance",
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.autoClear = false;
    this.renderer.setClearColor(0x9ab4cd, 1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x9ab4cd);
    this.scene.fog = new THREE.Fog(0xb4c7d8, 34, 118);

    this.camera = new THREE.PerspectiveCamera(82, 16 / 9, 0.045, 180);
    this.camera.rotation.order = "YXZ";

    this.vmScene = new THREE.Scene();
    this.vmCamera = new THREE.PerspectiveCamera(64, 16 / 9, 0.01, 6);

    this.mode = "menu";
    this.localSlot = 0;
    this.gameTime = 0;
    this.menuTime = 0;
    this.eyeHeight = PLAYER.eye;
    this.crouchMix = 0;
    this.punchPitch = 0;
    this.punchYaw = 0;
    this.shake = 0;
    this.deathMix = 0;
    this.localAlive = true;
    this.lastViewYaw = 0;
    this.lastViewPitch = 0;
    this.swayX = 0;
    this.swayY = 0;
    this.bobPhase = 0;
    this.weaponKick = 0;
    this.vmFlashTime = 0;
    this.switchAnim = 0;
    this.qualityMode = "auto";
    this.resScale = 1;
    this.adaptTimer = 0;
    this.adaptFrames = 0;
    this.remoteSlot = -1;
    this.remoteModel = null;
    this.weaponId = "rifle";
    this.fov = 82;
    this.fovCurrent = 82;
    this.adsTarget = 0;
    this.adsMix = 0;
    this.aimWeapon = "rifle";
    this.scoped = false;
    this.decals = [];
    this.smoke = [];
    this.skyTime = 0;

    this._buildLights();
    this._buildSky();
    this._buildTextures();
    this._buildMap();
    this._buildSoldiers();
    this._buildViewmodel();
    this._buildEffects();
    this._bindResize();
    this.resize();
    this.setMode("menu");
    this.renderer.shadowMap.needsUpdate = true;
  }

  _buildLights() {
    const hemi = new THREE.HemisphereLight(0xc4dcff, 0x6b5a48, 1.35);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff0d6, 3.25);
    sun.position.set(26, 38, 18);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -32;
    sun.shadow.camera.right = 32;
    sun.shadow.camera.top = 32;
    sun.shadow.camera.bottom = -32;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 110;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.035;
    sun.target.position.set(0, 0, 0);
    this.scene.add(sun.target);
    this.scene.add(sun);
    this.sun = sun;

    const fill = new THREE.DirectionalLight(0xa9c8ff, 0.55);
    fill.position.set(-18, 14, -12);
    this.scene.add(fill);
    // 原来的第三盏弱方向光（0.3）并进环境光：每个像素少算一盏灯，观感几乎一致。
    this.scene.add(new THREE.AmbientLight(0x9a948a, 0.4));

    this.vmScene.add(new THREE.HemisphereLight(0xe9f2ff, 0x2a2e38, 2.2));
    const vmKey = new THREE.DirectionalLight(0xfff2df, 3.0);
    vmKey.position.set(1.2, 2.2, 1.4);
    this.vmScene.add(vmKey);
    const vmRim = new THREE.DirectionalLight(0xd2e0f2, 1.4);
    vmRim.position.set(-2, 0.6, -1);
    this.vmScene.add(vmRim);
    // 原第三盏正面补光折进环境光，武器模型每像素少一盏方向光。
    this.vmScene.add(new THREE.AmbientLight(0xc8c0b2, 0.95));
  }

  _buildSky() {
    const geo = new THREE.SphereGeometry(110, 32, 20);
    const mat = new THREE.MeshBasicMaterial({
      map: skyTexture(),
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.renderOrder = -2;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
  }

  _buildTextures() {
    const maxAniso = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
    this.surfaces = {
      concrete: { tex: concreteTexture(), tile: MAT_TILE.concrete },
      wall: { tex: wallTexture(), tile: MAT_TILE.wall },
      wood: { tex: woodTexture(), tile: MAT_TILE.wood },
      metal: { tex: metalTexture(), tile: MAT_TILE.metal },
    };
    for (const s of Object.values(this.surfaces)) {
      s.tex.anisotropy = maxAniso;
    }
    this.flashTex = flashTexture();
    this.sparkTex = sparkTexture();
    this.smokeTex = smokeTexture();
    this.holeTex = holeTexture();
    this.blobTex = blobTexture();
  }

  _buildMap() {
    const faceDefs = [
      { n: [0, 0, 1], v: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], shade: 0.95, u: "w", vv: "h" },
      { n: [0, 0, -1], v: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]], shade: 0.8, u: "w", vv: "h" },
      { n: [1, 0, 0], v: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]], shade: 0.9, u: "d", vv: "h" },
      { n: [-1, 0, 0], v: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]], shade: 0.84, u: "d", vv: "h" },
      { n: [0, 1, 0], v: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]], shade: 1.08, u: "w", vv: "d" },
      { n: [0, -1, 0], v: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]], shade: 0.55, u: "w", vv: "d" },
    ];
    const tri = [0, 1, 2, 0, 2, 3];
    const groups = {};
    for (const k of Object.keys(this.surfaces)) {
      groups[k] = { pos: [], nor: [], uv: [], col: [] };
    }
    const glow = { pos: [], nor: [], col: [] };
    const baseColor = new THREE.Color();

    for (const b of MAP_BOXES) {
      const isGlow = b.solid === false || !b.mat;
      const g = isGlow ? glow : groups[b.mat];
      baseColor.setHex(b.c, THREE.SRGBColorSpace);
      const jitter = 0.96 + ((Math.abs(Math.imul(Math.round(b.x * 29 + b.z * 17 + b.y * 7), 2654435761)) % 11) / 120);
      const cx = b.x;
      const cy = b.y + b.h / 2;
      const cz = b.z;
      const hx = b.w / 2;
      const hy = b.h / 2;
      const hz = b.d / 2;
      const tile = isGlow ? 1 : this.surfaces[b.mat].tile;
      for (const f of faceDefs) {
        const shade = f.shade * jitter * (isGlow ? 1.3 : 1);
        const r = baseColor.r * shade;
        const gg = baseColor.g * shade;
        const bb = baseColor.b * shade;
        const verts = f.v.map((v) => [cx + v[0] * hx, cy + v[1] * hy, cz + v[2] * hz]);
        const uSize = (f.u === "w" ? b.w : b.d) / tile;
        const vSize = (f.vv === "h" ? b.h : b.d) / tile;
        const uvs = [[0, 0], [uSize, 0], [uSize, vSize], [0, vSize]];
        // 侧面按高度烘一条竖向渐变：贴地的底边压暗，模拟墙脚/箱底的接触阴影（伪 AO），
        // 顶点数不变，运行时零开销。
        const side = !isGlow && f.n[1] === 0;
        const footAo = b.y < 0.05 ? 0.7 : 0.86;
        for (let k = 0; k < 6; k++) {
          const idx = tri[k];
          const p = verts[idx];
          let ao = 1;
          if (side) ao = p[1] <= b.y + 1e-4 ? footAo : Math.min(1.06, 0.96 + b.h * 0.02);
          g.pos.push(p[0], p[1], p[2]);
          g.nor.push(f.n[0], f.n[1], f.n[2]);
          g.col.push(r * ao, gg * ao, bb * ao);
          if (!isGlow) g.uv.push(uvs[idx][0], uvs[idx][1]);
        }
      }
    }

    this.mapMeshes = [];
    for (const [key, grp] of Object.entries(groups)) {
      if (!grp.pos.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(grp.pos, 3));
      geo.setAttribute("normal", new THREE.Float32BufferAttribute(grp.nor, 3));
      geo.setAttribute("uv", new THREE.Float32BufferAttribute(grp.uv, 2));
      geo.setAttribute("color", new THREE.Float32BufferAttribute(grp.col, 3));
      geo.computeBoundingSphere();
      const mat = new THREE.MeshLambertMaterial({
        map: this.surfaces[key].tex,
        vertexColors: true,
        flatShading: true,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.mapMeshes.push(mesh);
    }

    const glowGeo = new THREE.BufferGeometry();
    glowGeo.setAttribute("position", new THREE.Float32BufferAttribute(glow.pos, 3));
    glowGeo.setAttribute("normal", new THREE.Float32BufferAttribute(glow.nor, 3));
    glowGeo.setAttribute("color", new THREE.Float32BufferAttribute(glow.col, 3));
    glowGeo.computeBoundingSphere();
    this.glowMesh = new THREE.Mesh(glowGeo, new THREE.MeshBasicMaterial({ vertexColors: true }));
    this.glowMesh.frustumCulled = false;
    this.scene.add(this.glowMesh);
  }

  _makeSoldier(pal, nameColor) {
    // 每个刚体部件合并成一个顶点色网格：身体 1 + 发光件 1 + 四肢 4 + 枪 1 = 7 次 draw call
    // （旧版 15 次），细节反而更多：背心弹匣包、护肩、耳罩、护膝、手套、枪托瞄具等。
    const { suit, vest, skin, boot, gun, gunDark, accent } = pal;
    const suitD = tint(suit, 0.8);
    const vestD = tint(vest, 0.74);
    const mat = this.soldierMat;
    const glowMat = this.soldierGlowMat;

    const group = new THREE.Group();
    const body = new THREE.Group();
    group.add(body);

    body.add(new THREE.Mesh(partsGeometry([
      { s: [0.44, 0.2, 0.25], p: [0, 0.87, 0], c: suitD, ao: 0.68 },
      { s: [0.48, 0.07, 0.28], p: [0, 0.95, 0], c: boot, ao: 0.9 },
      { s: [0.1, 0.09, 0.06], p: [-0.17, 0.93, -0.14], c: vestD },
      { s: [0.52, 0.46, 0.27], p: [0, 1.14, 0], c: suit, bot: [0.84, 0.9], ao: 0.7 },
      { s: [0.56, 0.36, 0.34], p: [0, 1.18, 0], c: vest, top: [0.94, 0.94], ao: 0.68 },
      { s: [0.13, 0.11, 0.05], p: [-0.15, 1.08, -0.19], c: vestD },
      { s: [0.13, 0.11, 0.05], p: [0, 1.08, -0.19], c: vestD },
      { s: [0.13, 0.11, 0.05], p: [0.15, 1.08, -0.19], c: vestD },
      { s: [0.32, 0.3, 0.1], p: [0, 1.17, 0.2], c: vestD, ao: 0.62 },
      { s: [0.025, 0.22, 0.025], p: [0.11, 1.42, 0.22], c: gunDark, ao: 1 },
      { s: [0.17, 0.1, 0.22], p: [-0.3, 1.36, 0], c: vest, top: [0.8, 0.9] },
      { s: [0.17, 0.1, 0.22], p: [0.3, 1.36, 0], c: vest, top: [0.8, 0.9] },
      { s: [0.13, 0.08, 0.13], p: [0, 1.4, 0], c: tint(skin, 0.75) },
      { s: [0.25, 0.27, 0.26], p: [0, 1.56, 0], c: skin, bot: [0.86, 0.9], ao: 0.72 },
      { s: [0.34, 0.15, 0.35], p: [0, 1.725, 0.005], c: suit, top: [0.76, 0.78], ao: 0.82 },
      { s: [0.36, 0.05, 0.37], p: [0, 1.655, 0.005], c: suitD, ao: 1 },
      { s: [0.05, 0.11, 0.11], p: [-0.145, 1.57, 0.01], c: boot },
      { s: [0.05, 0.11, 0.11], p: [0.145, 1.57, 0.01], c: boot },
      { s: [0.08, 0.05, 0.04], p: [0, 1.715, -0.18], c: gunDark, ao: 1 },
    ]), mat));
    body.add(new THREE.Mesh(partsGeometry([
      { s: [0.575, 0.035, 0.345], p: [0, 1.33, 0], c: accent, ao: 1 },
      { s: [0.22, 0.065, 0.02], p: [0, 1.585, -0.14], c: accent, ao: 1 },
      { s: [0.012, 0.05, 0.1], p: [-0.388, 1.36, 0], c: accent, ao: 1 },
      { s: [0.012, 0.05, 0.1], p: [0.388, 1.36, 0], c: accent, ao: 1 },
    ]), glowMat));

    const legs = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.15, 0.82, 0);
      pivot.add(new THREE.Mesh(partsGeometry([
        { s: [0.18, 0.42, 0.22], p: [0, -0.2, 0], c: suit, bot: [0.86, 0.88], ao: 0.82 },
        { s: [0.04, 0.12, 0.1], p: [side * 0.095, -0.2, -0.01], c: vestD },
        { s: [0.15, 0.13, 0.05], p: [0, -0.44, -0.11], c: vest, ao: 0.85 },
        { s: [0.15, 0.36, 0.18], p: [0, -0.6, 0], c: suitD, bot: [0.9, 0.9], ao: 0.78 },
        { s: [0.17, 0.12, 0.27], p: [0, -0.765, -0.035], c: boot, ao: 0.75 },
        { s: [0.172, 0.03, 0.28], p: [0, -0.81, -0.035], c: tint(boot, 0.6), ao: 1 },
      ]), mat));
      body.add(pivot);
      legs.push(pivot);
    }

    // 手臂朝 -Z（前方）抬起：旧模型 rotation.x 取负值，手臂其实伸在身后。
    const arms = [];
    for (const side of [-1, 1]) {
      const len = side < 0 ? 0.54 : 0.42;
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.36, 1.34, 0);
      pivot.add(new THREE.Mesh(partsGeometry([
        { s: [0.14, 0.25, 0.15], p: [0, -0.11, 0], c: suit, bot: [0.88, 0.88], ao: 0.85 },
        { s: [0.12, 0.07, 0.07], p: [0, -0.25, 0.06], c: vest, ao: 0.9 },
        { s: [0.12, len - 0.24, 0.13], p: [0, -0.24 - (len - 0.24) / 2, 0], c: suitD, ao: 0.85 },
        { s: [0.11, 0.1, 0.12], p: [0, -len - 0.03, 0], c: boot, ao: 0.9 },
      ]), mat));
      body.add(pivot);
      arms.push(pivot);
    }

    const gunGroup = new THREE.Group();
    gunGroup.position.set(0.16, 1.24, -0.34);
    gunGroup.add(new THREE.Mesh(partsGeometry([
      { s: [0.075, 0.09, 0.36], p: [0, 0, -0.02], c: gun, ao: 0.8 },
      { s: [0.07, 0.075, 0.24], p: [0, 0.005, -0.32], c: gunDark, ao: 0.85 },
      { s: [0.03, 0.03, 0.2], p: [0, 0.015, -0.52], c: gunDark, ao: 1 },
      { s: [0.045, 0.045, 0.05], p: [0, 0.015, -0.6], c: gun, ao: 1 },
      { s: [0.055, 0.1, 0.2], p: [0, -0.02, 0.25], c: gunDark, bot: [1, 0.8] },
      { s: [0.05, 0.12, 0.07], p: [0, -0.1, 0.08], r: [-0.3, 0, 0], c: gunDark },
      { s: [0.055, 0.17, 0.085], p: [0, -0.12, -0.08], r: [0.2, 0, 0], c: gunDark, ao: 0.7 },
      { s: [0.04, 0.05, 0.11], p: [0, 0.07, -0.04], c: gunDark, ao: 1 },
      { s: [0.012, 0.04, 0.014], p: [0, 0.055, -0.42], c: gunDark, ao: 1 },
    ]), mat));
    body.add(gunGroup);

    arms[0].rotation.set(1.32, 0, 0.7);
    arms[1].rotation.set(0.98, 0, -0.5);

    const flash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.flashTex,
      color: 0xffd9a0,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    flash.position.set(0, 0.02, -0.66);
    flash.scale.set(0.5, 0.5, 1);
    flash.visible = false;
    gunGroup.add(flash);

    const gunTip = new THREE.Object3D();
    gunTip.position.set(0, 0.015, -0.63);
    gunGroup.add(gunTip);

    const blob = new THREE.Mesh(
      new THREE.PlaneGeometry(1.5, 1.5),
      new THREE.MeshBasicMaterial({
        map: this.blobTex,
        transparent: true,
        opacity: 0.6,
        depthWrite: false,
      })
    );
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.025;
    group.add(blob);

    const nameSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: nameTexture("玩家", nameColor),
      transparent: true,
      depthWrite: false,
      depthTest: true,
    }));
    nameSprite.position.set(0, 2.12, 0);
    nameSprite.scale.set(1.75, 0.44, 1);
    group.add(nameSprite);

    return {
      group,
      body,
      legs,
      arms,
      gunGroup,
      gunTip,
      flash,
      flashTime: 0,
      nameSprite,
      name: "",
      walkPhase: 0,
      fall: 0,
      crouch: 0,
    };
  }

  _buildSoldiers() {
    // 1v1 中远端玩家永远是对手：两个槽位都用敌方配色，避免坐 1 号位时看到“友军蓝”的敌人。
    this.soldierMat = lambert(0xffffff, { vertexColors: true });
    this.soldierGlowMat = basic(0xffffff, { vertexColors: true });
    const pal = {
      suit: COLORS.enemyDim,
      vest: 0x5a3a26,
      skin: 0x3a332c,
      boot: COLORS.boot,
      gun: 0x4a4c50,
      gunDark: 0x2e3034,
      accent: 0xff7a4a,
    };
    this.models = [null, null];
    for (let slot = 0; slot < 2; slot++) {
      const m = this._makeSoldier(pal, ENEMY_NAME_COLOR);
      m.group.visible = false;
      this.scene.add(m.group);
      this.models[slot] = m;
    }
  }

  _buildViewmodel() {
    // 每把枪 = 1 个实体网格 + 1 个发光网格（旧版约 14 个网格），细节翻倍：导轨齿、护木散热孔、
    // 抛壳窗、扳机护圈、红点镜、枪口制退器、手指包裹等，全部烘进顶点色。
    const GUN = COLORS.gun;
    const DARK = COLORS.gunDark;
    const RAIL = 0x26282c;
    const SLEEVE = 0x4d5242;
    const GLOVE = 0x2a2926;
    const ACC = COLORS.accent;
    const LENS = 0x3f6650;
    const vmMat = lambert(0xffffff, { vertexColors: true });
    const vmGlow = basic(0xffffff, { vertexColors: true });

    const B = (w, h, d, c, x, y, z, rx = 0, ry = 0, rz = 0, extra = null) => ({
      s: [w, h, d], p: [x, y, z], r: [rx, ry, rz], c, ...(extra || {}),
    });
    const build = (solid, glow) => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(partsGeometry(solid), vmMat));
      if (glow.length) g.add(new THREE.Mesh(partsGeometry(glow), vmGlow));
      return g;
    };
    const addFlash = (parent, x, y, z, size) => {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.flashTex,
        color: 0xfff0c0,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }));
      sprite.position.set(x, y, z);
      sprite.scale.set(size, size, 1);
      sprite.visible = false;
      parent.add(sprite);
      return sprite;
    };
    const F = { ao: 1 };

    // ---------- 步枪 ----------
    const rifle = [
      B(0.08, 0.055, 0.44, GUN, 0, 0.025, -0.06, 0, 0, 0, { ao: 0.85 }),
      B(0.07, 0.05, 0.3, tint(GUN, 0.9), 0, -0.025, 0.02),
      B(0.004, 0.022, 0.07, RAIL, 0.042, 0.025, -0.02, 0, 0, 0, F),
      B(0.04, 0.012, 0.4, RAIL, 0, 0.058, -0.12, 0, 0, 0, F),
      B(0.074, 0.074, 0.3, DARK, 0, 0.008, -0.42, 0, 0, 0, { top: [0.9, 1], ao: 0.75 }),
      B(0.03, 0.03, 0.24, DARK, 0, 0.018, -0.68, 0, 0, 0, F),
      B(0.04, 0.045, 0.03, DARK, 0, 0.03, -0.6),
      B(0.012, 0.05, 0.014, DARK, 0, 0.065, -0.6, 0, 0, 0, F),
      B(0.048, 0.048, 0.07, GUN, 0, 0.018, -0.83, 0, 0, 0, { ao: 0.9 }),
      B(0.052, 0.052, 0.012, RAIL, 0, 0.018, -0.815, 0, 0, 0, F),
      B(0.035, 0.035, 0.12, DARK, 0, 0.01, 0.2, 0, 0, 0, F),
      B(0.058, 0.1, 0.18, GUN, 0, -0.01, 0.3, 0, 0, 0, { bot: [1, 0.85] }),
      B(0.062, 0.106, 0.02, RAIL, 0, -0.01, 0.395, 0, 0, 0, F),
      B(0.05, 0.15, 0.085, DARK, 0, -0.1, 0.02, -0.18, 0, 0, { ao: 0.7 }),
      B(0.056, 0.02, 0.092, RAIL, 0, -0.174, 0.033, -0.18, 0, 0, F),
      B(0.012, 0.012, 0.07, DARK, 0, -0.058, 0.11, 0, 0, 0, F),
      B(0.006, 0.03, 0.008, RAIL, 0, -0.045, 0.1, 0, 0, 0, F),
      B(0.052, 0.13, 0.075, DARK, 0, -0.09, 0.18, 0.2, 0, 0, { ao: 0.75 }),
      B(0.04, 0.018, 0.08, DARK, 0, 0.073, -0.08, 0, 0, 0, F),
      B(0.05, 0.048, 0.1, DARK, 0, 0.105, -0.08, 0, 0, 0, { top: [0.9, 0.95], ao: 0.85 }),
      B(0.03, 0.025, 0.015, DARK, 0, 0.075, 0.08, 0, 0, 0, F),
      B(0.16, 0.13, 0.28, SLEEVE, 0.11, -0.22, 0.12, 0.3, -0.5, 0.5, { ao: 0.7 }),
      B(0.13, 0.12, 0.2, SLEEVE, -0.12, -0.18, -0.26, 0.1, 0.55, -0.45, { ao: 0.7 }),
      B(0.07, 0.08, 0.1, GLOVE, 0, -0.08, 0.15, 0.2),
      B(0.02, 0.018, 0.06, GLOVE, 0.025, -0.045, 0.1, 0, 0, 0, F),
      B(0.07, 0.08, 0.1, GLOVE, 0, -0.055, -0.28, 0.1),
      B(0.082, 0.03, 0.07, tint(GLOVE, 1.18), 0, -0.02, -0.3, 0, 0, 0, F),
    ];
    for (let i = 0; i < 6; i++) rifle.push(B(0.046, 0.008, 0.014, RAIL, 0, 0.067, -0.29 + i * 0.065, 0, 0, 0, F));
    for (const z of [-0.34, -0.42, -0.5]) {
      for (const sx of [-1, 1]) rifle.push(B(0.004, 0.02, 0.045, RAIL, sx * 0.0365, 0.004, z, 0, 0, 0, F));
    }
    this.rifleGroup = build(rifle, [
      B(0.004, 0.008, 0.16, ACC, -0.0415, 0.035, -0.1, 0, 0, 0, F),
      B(0.036, 0.03, 0.004, LENS, 0, 0.108, -0.131, 0, 0, 0, F),
      B(0.036, 0.03, 0.004, LENS, 0, 0.108, -0.029, 0, 0, 0, F),
    ]);
    this.vmFlashes = {};
    this.vmFlashes.rifle = addFlash(this.rifleGroup, 0, 0.02, -0.92, 0.34);

    // ---------- 手枪 ----------
    const pistol = [
      B(0.062, 0.058, 0.3, GUN, 0, 0.032, -0.1, 0, 0, 0, { ao: 0.85 }),
      B(0.004, 0.02, 0.06, RAIL, 0.032, 0.04, -0.12, 0, 0, 0, F),
      B(0.054, 0.038, 0.24, DARK, 0, -0.013, -0.12, 0, 0, 0, { ao: 0.85 }),
      B(0.03, 0.03, 0.03, RAIL, 0, 0.03, -0.255, 0, 0, 0, F),
      B(0.04, 0.012, 0.06, RAIL, 0, -0.035, -0.2, 0, 0, 0, F),
      B(0.05, 0.16, 0.085, DARK, 0, -0.1, 0.02, -0.2, 0, 0, { ao: 0.7 }),
      B(0.054, 0.1, 0.06, RAIL, 0, -0.1, 0.02, -0.2, 0, 0, F),
      B(0.054, 0.018, 0.09, RAIL, 0, -0.178, 0.036, -0.2, 0, 0, F),
      B(0.01, 0.01, 0.06, DARK, 0, -0.045, -0.06, 0, 0, 0, F),
      B(0.005, 0.025, 0.008, RAIL, 0, -0.04, -0.045, 0, 0, 0, F),
      B(0.04, 0.016, 0.016, DARK, 0, 0.069, 0.035, 0, 0, 0, F),
      B(0.01, 0.016, 0.012, DARK, 0, 0.069, -0.235, 0, 0, 0, F),
      B(0.012, 0.022, 0.03, DARK, 0, 0.03, 0.06, 0, 0, 0, F),
      B(0.14, 0.12, 0.22, SLEEVE, 0.09, -0.2, 0.1, 0.3, -0.5, 0.5, { ao: 0.7 }),
      B(0.12, 0.11, 0.18, SLEEVE, -0.1, -0.17, -0.05, 0.1, 0.55, -0.45, { ao: 0.7 }),
      B(0.065, 0.075, 0.09, GLOVE, 0, -0.08, 0.03),
      B(0.075, 0.05, 0.06, tint(GLOVE, 1.18), 0, -0.1, 0.0),
      B(0.02, 0.016, 0.05, GLOVE, 0.026, -0.03, -0.04, 0, 0, 0, F),
    ];
    for (const z of [0.0, 0.016, 0.032]) pistol.push(B(0.065, 0.04, 0.006, RAIL, 0, 0.036, z, 0, 0, 0, F));
    this.pistolGroup = build(pistol, [
      B(0.007, 0.007, 0.003, ACC, -0.012, 0.07, 0.044, 0, 0, 0, F),
      B(0.007, 0.007, 0.003, ACC, 0.012, 0.07, 0.044, 0, 0, 0, F),
      B(0.007, 0.007, 0.003, ACC, 0, 0.072, -0.242, 0, 0, 0, F),
      B(0.003, 0.006, 0.12, ACC, -0.0325, 0.032, -0.12, 0, 0, 0, F),
    ]);
    this.vmFlashes.pistol = addFlash(this.pistolGroup, 0, 0.02, -0.36, 0.28);

    // ---------- 狙击枪 ----------
    this.sniperGroup = build([
      B(0.075, 0.09, 0.72, GUN, 0, 0, -0.1, 0, 0, 0, { ao: 0.8 }),
      B(0.06, 0.085, 0.3, GUN, 0, -0.005, 0.34, 0, 0, 0, { bot: [1, 0.85] }),
      B(0.064, 0.09, 0.02, RAIL, 0, -0.005, 0.5, 0, 0, 0, F),
      B(0.05, 0.035, 0.18, tint(GUN, 1.1), 0, 0.06, 0.3, 0, 0, 0, { ao: 0.9 }),
      B(0.028, 0.028, 0.72, DARK, 0, 0.015, -0.78, 0, 0, 0, F),
      B(0.05, 0.05, 0.1, GUN, 0, 0.015, -1.17, 0, 0, 0, { ao: 0.9 }),
      B(0.056, 0.024, 0.03, RAIL, 0, 0.015, -1.17, 0, 0, 0, F),
      B(0.045, 0.06, 0.18, DARK, 0, 0.09, -0.2),
      B(0.055, 0.055, 0.38, DARK, 0, 0.135, -0.26, 0, 0, 0, { ao: 0.9 }),
      B(0.072, 0.072, 0.08, DARK, 0, 0.135, -0.48, 0, 0, 0, { ao: 0.85 }),
      B(0.066, 0.066, 0.06, DARK, 0, 0.135, -0.05, 0, 0, 0, { ao: 0.85 }),
      B(0.07, 0.026, 0.03, RAIL, 0, 0.112, -0.34, 0, 0, 0, F),
      B(0.07, 0.026, 0.03, RAIL, 0, 0.112, -0.17, 0, 0, 0, F),
      B(0.032, 0.028, 0.032, RAIL, 0, 0.175, -0.26, 0, 0, 0, F),
      B(0.028, 0.032, 0.032, RAIL, 0.04, 0.135, -0.26, 0, 0, 0, F),
      B(0.055, 0.1, 0.1, DARK, 0, -0.09, 0.06, -0.16),
      B(0.05, 0.045, 0.09, DARK, 0.06, 0.02, 0.06),
      B(0.07, 0.02, 0.02, DARK, 0.08, 0.03, 0.08, 0, 0, 0, F),
      B(0.032, 0.032, 0.032, RAIL, 0.115, 0.02, 0.08, 0, 0, 0, F),
      B(0.05, 0.12, 0.07, DARK, 0, -0.09, -0.12, 0, 0, 0, { ao: 0.7 }),
      B(0.012, 0.012, 0.08, DARK, 0, -0.058, 0.0, 0, 0, 0, F),
      B(0.014, 0.014, 0.24, RAIL, -0.022, -0.055, -0.5, 0, 0, 0, F),
      B(0.014, 0.014, 0.24, RAIL, 0.022, -0.055, -0.5, 0, 0, 0, F),
      B(0.16, 0.13, 0.28, SLEEVE, 0.11, -0.22, 0.14, 0.3, -0.5, 0.5, { ao: 0.7 }),
      B(0.13, 0.12, 0.2, SLEEVE, -0.12, -0.18, -0.32, 0.1, 0.55, -0.45, { ao: 0.7 }),
      B(0.07, 0.08, 0.1, GLOVE, 0, -0.08, 0.16, 0.2),
      B(0.07, 0.08, 0.1, GLOVE, 0, -0.055, -0.34, 0.1),
      B(0.084, 0.03, 0.07, tint(GLOVE, 1.18), 0, -0.03, -0.35, 0, 0, 0, F),
    ], [
      B(0.06, 0.06, 0.004, LENS, 0, 0.135, -0.522, 0, 0, 0, F),
      B(0.054, 0.054, 0.004, LENS, 0, 0.135, -0.019, 0, 0, 0, F),
      B(0.003, 0.008, 0.3, ACC, -0.039, 0.02, -0.1, 0, 0, 0, F),
    ]);
    this.vmFlashes.sniper = addFlash(this.sniperGroup, 0, 0.015, -1.25, 0.55);

    this.weaponGroups = {
      rifle: this.rifleGroup,
      pistol: this.pistolGroup,
      sniper: this.sniperGroup,
    };
    this.vmGroup = new THREE.Group();
    this.vmGroup.add(this.rifleGroup);
    this.vmGroup.add(this.pistolGroup);
    this.vmGroup.add(this.sniperGroup);
    this.pistolGroup.visible = false;
    this.sniperGroup.visible = false;
    this.vmGroup.position.set(0.27, -0.26, -0.55);
    this.vmGroup.scale.setScalar(0.9);
    this.vmScene.add(this.vmGroup);
  }

  _buildEffects() {
    const tracerGeo = new THREE.BoxGeometry(1, 1, 1);
    this.tracerPool = [];
    for (let i = 0; i < 18; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffe3a3,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(tracerGeo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.tracerPool.push({ mesh, mat, life: 0, max: 0.1, base: 0.03 });
    }

    this.sparkPool = [];
    for (let i = 0; i < 72; i++) {
      const mat = new THREE.SpriteMaterial({
        map: this.sparkTex,
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      this.scene.add(sprite);
      this.sparkPool.push({ sprite, mat, life: 0, max: 0.2, vx: 0, vy: 0, vz: 0, grav: 3 });
    }

    this.smokePool = [];
    for (let i = 0; i < 14; i++) {
      const mat = new THREE.SpriteMaterial({
        map: this.smokeTex,
        color: 0xd8dbdf,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      this.scene.add(sprite);
      this.smokePool.push({ sprite, mat, life: 0, max: 0.7, vx: 0, vy: 0, vz: 0 });
    }

    this.holePool = [];
    for (let i = 0; i < 26; i++) {
      const mat = new THREE.SpriteMaterial({
        map: this.holeTex,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      this.scene.add(sprite);
      this.holePool.push({ sprite, mat, life: 0, max: 9 });
    }
  }

  _bindResize() {
    this._onResize = () => this.resize();
    window.addEventListener("resize", this._onResize);
    if (typeof ResizeObserver !== "undefined") {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(this.canvas);
    }
  }

  resize() {
    const w = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.vmCamera.aspect = w / h;
    this.vmCamera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  _pixelRatio() {
    const dpr = window.devicePixelRatio || 1;
    if (this.qualityMode === "high") return Math.min(1.75, dpr);
    if (this.qualityMode === "low") return 0.65;
    return Math.max(0.5, Math.min(1.5, dpr) * this.resScale);
  }

  applyResolution() {
    this.renderer.setPixelRatio(this._pixelRatio());
    this.resize();
  }

  setQuality(mode) {
    this.qualityMode = ["high", "low", "auto"].includes(mode) ? mode : "auto";
    this.resScale = 1;
    this.applyResolution();
    return this.qualityMode;
  }

  setFov(fov) {
    this.fov = Math.max(60, Math.min(110, Number(fov) || 82));
    if (this.adsMix < 0.2) {
      this.fovCurrent = this.fov;
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  setAiming(aiming, weaponId) {
    this.adsTarget = aiming ? 1 : 0;
    this.aimWeapon = weaponId || this.weaponId;
  }

  setMode(mode) {
    this.mode = mode;
    if (mode === "menu") {
      this.vmGroup.visible = false;
      for (const m of this.models) if (m) m.group.visible = false;
      this.remoteModel = null;
      this.remoteSlot = -1;
      this.adsMix = 0;
      this.adsTarget = 0;
      this.scoped = false;
    } else {
      this.vmGroup.visible = true;
      this.menuTime = 0;
      this.eyeHeight = PLAYER.eye;
      this.crouchMix = 0;
      this.deathMix = 0;
      this.punchPitch = 0;
      this.punchYaw = 0;
      this.shake = 0;
      this.swayX = 0;
      this.swayY = 0;
      this.bobPhase = 0;
      this.weaponKick = 0;
      this.switchAnim = 0;
      this.reloadLeft = 0;
      this.lastViewYaw = 0;
      this.lastViewPitch = 0;
      this.adsMix = 0;
      this.adsTarget = 0;
      this.scoped = false;
      this.vmGroup.position.set(0.27, -0.26, -0.55);
      this.vmGroup.rotation.set(0, 0, 0);
      this.fovCurrent = this.fov;
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  primeView(yaw, pitch) {
    this.lastViewYaw = yaw;
    this.lastViewPitch = pitch;
  }

  setLocalSlot(slot) {
    this.localSlot = slot;
    for (let i = 0; i < 2; i++) {
      if (this.models[i]) this.models[i].group.visible = false;
    }
    this.remoteSlot = -1;
    this.remoteModel = null;
  }

  setWeapon(id) {
    if (!WEAPONS[id] || id === this.weaponId) return;
    this.weaponId = id;
    for (const [key, group] of Object.entries(this.weaponGroups)) {
      group.visible = key === id;
    }
    this.switchAnim = 0.22;
    this.weaponKick = Math.max(this.weaponKick, 0.35);
  }

  setReload(left) {
    this.reloadLeft = Math.max(0, left || 0);
  }

  setRemote(remote, dt = 0.016) {
    if (!remote) {
      if (this.remoteModel) this.remoteModel.group.visible = false;
      this.remoteModel = null;
      this.remoteSlot = -1;
      return;
    }
    const slot = remote.slot;
    if (slot === this.localSlot) return;
    if (this.remoteSlot !== slot) {
      if (this.remoteModel) this.remoteModel.group.visible = false;
      this.remoteSlot = slot;
      this.remoteModel = this.models[slot] || null;
      if (this.remoteModel) this.remoteModel.group.visible = true;
    }
    const model = this.remoteModel;
    if (!model) return;
    model.group.visible = true;

    const crouchTarget = remote.crouch ? 1 : 0;
    model.crouch += (crouchTarget - model.crouch) * Math.min(1, dt * 12);
    model.group.scale.y = 1 - 0.3 * model.crouch;

    const fallTarget = remote.alive ? 0 : 1;
    model.fall += (fallTarget - model.fall) * Math.min(1, dt * (remote.alive ? 9 : 5));
    model.body.rotation.x = -model.fall * Math.PI * 0.48;
    model.group.position.set(remote.x, remote.y + model.fall * 0.32, remote.z);
    model.group.rotation.y = remote.yaw;
    model.nameSprite.visible = remote.alive !== false;

    if (remote.name && model.name !== remote.name) {
      model.name = remote.name;
      model.nameSprite.material.map?.dispose();
      model.nameSprite.material.map = nameTexture(remote.name, ENEMY_NAME_COLOR);
      model.nameSprite.material.needsUpdate = true;
    }

    const speed = Math.max(0, Math.min(8, remote.speed || 0));
    const amt = (remote.onGround === false ? 0.35 : 1) * Math.min(1, speed / 5);
    model.walkPhase += dt * (3.4 + speed * 1.6);
    const swing = Math.sin(model.walkPhase) * 0.6 * amt;
    model.legs[0].rotation.x = swing;
    model.legs[1].rotation.x = -swing;
    const aimLift = remote.aiming ? 0.14 : 0;
    model.arms[0].rotation.x = 1.32 - swing * 0.25 + aimLift;
    model.arms[1].rotation.x = 0.98 - swing * 0.18 + aimLift;
    model.gunGroup.position.y = 1.24 + (remote.aiming ? 0.045 : 0);
    model.body.position.y = Math.abs(Math.sin(model.walkPhase * 2)) * 0.025 * amt;

    if (model.flashTime > 0) {
      model.flashTime -= dt;
      if (model.flashTime <= 0) model.flash.visible = false;
    }
  }

  flashRemote() {
    const model = this.remoteModel;
    if (!model) return;
    model.flash.visible = true;
    model.flash.material.rotation = Math.random() * Math.PI * 2;
    model.flash.scale.setScalar(0.45 + Math.random() * 0.15);
    model.flashTime = 0.06;
  }

  remoteGunPos(out = new THREE.Vector3()) {
    const model = this.remoteModel;
    if (!model) return null;
    model.gunTip.getWorldPosition(out);
    return out;
  }

  localMuzzle(weaponId = this.weaponId, out = new THREE.Vector3()) {
    this.camera.updateMatrixWorld();
    const z = weaponId === "sniper" ? -1.38 : weaponId === "pistol" ? -0.72 : -1.24;
    out.set(0.27, -0.21, z);
    return out.applyMatrix4(this.camera.matrixWorld);
  }

  addTracer(from, to, friendly = true, weaponId = "rifle") {
    const t = this.tracerPool.find((p) => p.life <= 0) || this.tracerPool[0];
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.01) return;
    const dir = new THREE.Vector3(dx / len, dy / len, dz / len);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    t.mesh.position.set((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
    t.mesh.quaternion.copy(q);
    t.base = weaponId === "sniper" ? 0.05 : weaponId === "pistol" ? 0.022 : 0.03;
    t.mesh.scale.set(t.base, t.base, len);
    t.mesh.visible = true;
    t.mat.color.setHex(weaponId === "sniper" ? 0xfff4dc : friendly ? 0xffe3a3 : 0xff9a6a);
    t.mat.opacity = 0.85;
    t.life = 0.1;
    t.max = 0.1;
  }

  localShot(end, weaponId = this.weaponId) {
    const from = this.localMuzzle(weaponId, new THREE.Vector3());
    this.addTracer(from, end, true, weaponId);
    const flash = this.vmFlashes[weaponId];
    if (flash) {
      flash.visible = true;
      flash.material.rotation = Math.random() * Math.PI * 2;
      const s = weaponId === "sniper" ? 0.62 : weaponId === "pistol" ? 0.28 : 0.38;
      flash.scale.set(s, s, 1);
    }
    this.vmFlashTime = 0.055;
    this.weaponKick = Math.min(1.7, this.weaponKick + (weaponId === "sniper" ? 1.2 : 0.6));
    this.spawnSmoke(from, true);
  }

  remoteShot(from, to, weaponId = "rifle") {
    const tip = this.remoteGunPos(new THREE.Vector3());
    const start = tip ? { x: tip.x, y: tip.y, z: tip.z } : from;
    this.addTracer(start, to, false, weaponId);
    this.flashRemote();
    this.spawnSmoke(start, false);
  }

  spawnSmoke(point, local) {
    const s = this.smokePool.find((p) => p.life <= 0) || this.smokePool[0];
    s.sprite.position.set(point.x, point.y, point.z);
    s.sprite.visible = true;
    s.mat.opacity = local ? 0.3 : 0.22;
    s.life = 0.6;
    s.max = 0.6;
    s.vx = (Math.random() - 0.5) * 0.35;
    s.vy = 0.35 + Math.random() * 0.3;
    s.vz = (Math.random() - 0.5) * 0.35;
    const sc = local ? 0.18 : 0.15;
    s.sprite.scale.set(sc, sc, 1);
  }

  impact(point, { friendly = true, decal = false, big = false } = {}) {
    const cam = this.camera.position;
    let dx = cam.x - point.x;
    let dy = cam.y - point.y;
    let dz = cam.z - point.z;
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl;
    dy /= dl;
    dz /= dl;
    const n = big ? 14 : 9;
    for (let i = 0; i < n; i++) {
      const s = this.sparkPool.find((p) => p.life <= 0) || this.sparkPool[0];
      s.sprite.position.set(point.x, point.y, point.z);
      s.sprite.visible = true;
      const speed = (big ? 1.4 : 0.9) + Math.random() * (big ? 2.6 : 1.7);
      const spread = 0.9;
      s.vx = (dx + (Math.random() - 0.5) * spread) * speed;
      s.vy = (dy + (Math.random() - 0.5) * spread + 0.45) * speed;
      s.vz = (dz + (Math.random() - 0.5) * spread) * speed;
      s.grav = 3.2;
      s.life = 0.14 + Math.random() * (big ? 0.28 : 0.18);
      s.max = s.life;
      s.mat.color.setHex(big ? 0xffd278 : friendly ? 0xffdca8 : 0xffb27a);
      s.mat.opacity = 1;
      const sc = (big ? 0.1 : 0.06) + Math.random() * (big ? 0.1 : 0.06);
      s.sprite.scale.set(sc, sc, 1);
    }
    const flash = this.sparkPool.find((p) => p.life <= 0) || this.sparkPool[0];
    flash.sprite.position.set(point.x, point.y, point.z);
    flash.sprite.visible = true;
    flash.vx = flash.vy = flash.vz = 0;
    flash.grav = 0;
    flash.life = 0.07;
    flash.max = 0.07;
    flash.mat.color.setHex(big ? 0xffe2a0 : 0xffd28a);
    flash.mat.opacity = 1;
    flash.sprite.scale.set(big ? 0.34 : 0.22, big ? 0.34 : 0.22, 1);

    if (decal) {
      const d = this.holePool.find((p) => p.life <= 0) || this.holePool[0];
      d.sprite.position.set(point.x + dx * 0.02, point.y + dy * 0.02, point.z + dz * 0.02);
      d.sprite.visible = true;
      d.mat.opacity = 0.85;
      const sc = 0.09 + Math.random() * 0.035;
      d.sprite.scale.set(sc, sc, 1);
      d.sprite.material.rotation = Math.random() * Math.PI * 2;
      d.life = 9;
      d.max = 9;
    }
  }

  addPunch(amount) {
    this.punchPitch = Math.min(0.14, this.punchPitch + amount);
    this.punchYaw += (Math.random() - 0.5) * amount * 0.55;
  }

  addShake(amount) {
    this.shake = Math.min(1, this.shake + amount);
  }

  updateCamera(pos, view, state, dt) {
    if (this.mode !== "game") return;
    const weapon = WEAPONS[this.aimWeapon] || WEAPONS[this.weaponId] || WEAPONS.rifle;
    const wasAlive = state.alive !== false;
    this.adsTarget = wasAlive ? this.adsTarget : 0;
    this.adsMix += (this.adsTarget - this.adsMix) * Math.min(1, dt * 13);
    this.scoped = this.aimWeapon === "sniper" && this.adsMix > 0.62;
    this.vmGroup.visible = wasAlive && !this.scoped;

    const targetFov = this.fov + ((weapon.adsFov || this.fov) - this.fov) * this.adsMix;
    this.fovCurrent += (targetFov - this.fovCurrent) * Math.min(1, dt * 11);
    if (Math.abs(this.camera.fov - this.fovCurrent) > 0.02) {
      this.camera.fov = this.fovCurrent;
      this.camera.updateProjectionMatrix();
    }

    const targetEye = state.crouch ? PLAYER.crouchEye : PLAYER.eye;
    this.eyeHeight += (targetEye - this.eyeHeight) * Math.min(1, dt * 13);
    this.crouchMix += ((state.crouch ? 1 : 0) - this.crouchMix) * Math.min(1, dt * 12);

    const aliveTarget = state.alive ? 0 : 1;
    this.deathMix += (aliveTarget - this.deathMix) * Math.min(1, dt * 7);
    this.deathFall += (aliveTarget - this.deathFall) * Math.min(1, dt * 5);

    this.punchPitch *= Math.exp(-11 * dt);
    this.punchYaw *= Math.exp(-9 * dt);
    this.shake *= Math.exp(-7 * dt);

    const shakeX = (Math.random() - 0.5) * this.shake * 0.022;
    const shakeY = (Math.random() - 0.5) * this.shake * 0.018;
    const eye = this.eyeHeight - this.deathMix * (this.eyeHeight - 0.34);
    this.camera.position.set(pos.x + shakeX, pos.y + eye + shakeY, pos.z);
    this.camera.rotation.set(
      // 镜头 = 子弹方向：后坐力上跳只作用在枪模上。旧版把 punch 加在镜头上而子弹不含它，
      // 连射时准星比实际弹道高 ~0.02rad（20m 外约 0.4m），准星压着敌人子弹却打在脚下。
      view.pitch,
      view.yaw,
      -this.deathMix * 0.55 + (Math.random() - 0.5) * this.shake * 0.012
    );
    this.camera.updateMatrixWorld();

    if (this.vmGroup.visible) {
      const yawDelta = view.yaw - this.lastViewYaw;
      const pitchDelta = view.pitch - this.lastViewPitch;
      this.lastViewYaw = view.yaw;
      this.lastViewPitch = view.pitch;
      const aim = this.adsMix;
      const swayTX = Math.max(-0.035, Math.min(0.035, -yawDelta * 0.9)) * (1 - aim * 0.82);
      const swayTY = Math.max(-0.03, Math.min(0.03, -pitchDelta * 0.7)) * (1 - aim * 0.82);
      const k = Math.min(1, dt * 14);
      this.swayX += (swayTX - this.swayX) * k;
      this.swayY += (swayTY - this.swayY) * k;

      const speed = Math.min(7, state.speed || 0);
      const grounded = state.onGround !== false;
      this.bobPhase += dt * (1.6 + speed * 2.6);
      const bobAmt = (grounded ? Math.min(1, speed / 5) : 0.15) * (1 - aim * 0.85);
      const bobX = Math.sin(this.bobPhase) * 0.012 * bobAmt;
      const bobY = Math.abs(Math.cos(this.bobPhase)) * 0.01 * bobAmt;

      this.weaponKick *= Math.exp(-13 * dt);
      this.vmFlashTime -= dt;
      if (this.vmFlashTime <= 0) {
        for (const f of Object.values(this.vmFlashes)) f.visible = false;
      }

      const wp = WEAPONS[this.weaponId] || WEAPONS.rifle;
      const reload = Math.max(0, this.reloadLeft || 0);
      const rp = reload > 0 ? Math.min(1, reload / wp.reload) : 0;
      const dip = Math.sin(rp * Math.PI);
      const switchDip = this.switchAnim > 0 ? this.switchAnim : 0;
      this.switchAnim = Math.max(0, this.switchAnim - dt);
      const kick = this.weaponKick;

      const baseX = 0.27;
      const baseY = -0.26;
      const baseZ = -0.55;
      const adsX = this.weaponId === "sniper" ? 0.0 : 0.02;
      const adsY = this.weaponId === "sniper" ? -0.1 : -0.205;
      const adsZ = -0.5;
      this.vmGroup.position.set(
        lerp(baseX, adsX, aim) + this.swayX + bobX,
        lerp(baseY, adsY, aim) + this.swayY + bobY - dip * 0.26 - switchDip * 0.35,
        lerp(baseZ, adsZ, aim) + kick * 0.07
      );
      this.vmGroup.rotation.set(
        -dip * 0.55 + kick * 0.08 + this.punchPitch * 1.6 - switchDip * 0.7,
        -this.swayX * 2.2 * (1 - aim * 0.6),
        dip * 0.35 + this.swayY * 1.4
      );
    }
  }

  updateEffects(dt) {
    for (const t of this.tracerPool) {
      if (t.life <= 0) continue;
      t.life -= dt;
      const a = Math.max(0, t.life / t.max);
      t.mat.opacity = a * 0.85;
      t.mesh.scale.x = t.base * (0.7 + a * 0.3);
      t.mesh.scale.y = t.base * (0.7 + a * 0.3);
      if (t.life <= 0) t.mesh.visible = false;
    }
    for (const s of this.sparkPool) {
      if (s.life <= 0) continue;
      s.life -= dt;
      const a = Math.max(0, s.life / s.max);
      s.mat.opacity = a;
      s.vy -= s.grav * dt;
      s.sprite.position.x += s.vx * dt;
      s.sprite.position.y += s.vy * dt;
      s.sprite.position.z += s.vz * dt;
      if (s.life <= 0) s.sprite.visible = false;
    }
    for (const s of this.smokePool) {
      if (s.life <= 0) continue;
      s.life -= dt;
      const a = Math.max(0, s.life / s.max);
      s.mat.opacity = a * 0.28;
      s.sprite.position.x += s.vx * dt;
      s.sprite.position.y += s.vy * dt;
      s.sprite.position.z += s.vz * dt;
      s.vx *= 1 - 2 * dt;
      s.vz *= 1 - 2 * dt;
      const sc = s.sprite.scale.x + dt * 0.35;
      s.sprite.scale.set(sc, sc, 1);
      if (s.life <= 0) s.sprite.visible = false;
    }
    for (const d of this.holePool) {
      if (d.life <= 0) continue;
      d.life -= dt;
      if (d.life < 1) d.mat.opacity = Math.max(0, d.life) * 0.85;
      if (d.life <= 0) d.sprite.visible = false;
    }
  }

  update(dt) {
    this.gameTime += dt;
    if (this.mode === "menu") {
      this.menuTime += dt;
      const a = this.menuTime * 0.055 + 0.6;
      const h = 9.6 + Math.sin(this.menuTime * 0.16) * 0.55;
      this.camera.position.set(Math.sin(a) * 15.5, h, Math.cos(a) * 15.5);
      this.camera.lookAt(0, 1.2, 0);
      this.camera.rotation.z = Math.sin(this.menuTime * 0.11) * 0.012;
      this.camera.updateMatrixWorld();
      this.vmGroup.visible = false;
    }
    this.updateEffects(dt);

    if (this.mode === "game" && this.qualityMode === "auto") {
      this.adaptTimer += dt;
      this.adaptFrames++;
      if (this.adaptFrames >= 20) {
        const avg = this.adaptTimer / this.adaptFrames;
        let changed = false;
        if (avg > 1 / 42 && this.resScale > 0.55) {
          this.resScale = Math.max(0.55, this.resScale - 0.1);
          changed = true;
        } else if (avg < 1 / 58 && this.resScale < 1) {
          this.resScale = Math.min(1, this.resScale + 0.05);
          changed = true;
        }
        if (changed) this.applyResolution();
        this.adaptTimer = 0;
        this.adaptFrames = 0;
      }
    }
  }

  render() {
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    if (this.mode === "game" && this.vmGroup.visible) {
      this.renderer.clearDepth();
      this.renderer.render(this.vmScene, this.vmCamera);
    }
  }

  drawCalls() {
    return this.renderer.info?.render?.calls || 0;
  }
}
