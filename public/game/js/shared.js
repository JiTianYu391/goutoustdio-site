// 客户端与服务器共用的游戏规则：地图、移动、碰撞、射线与武器参数。
// 这个文件不依赖浏览器或 Node 专有 API，两端 import 同一份代码，
// 这样客户端预测与服务器模拟才能对得上。

export const PROTOCOL_VERSION = 1;
export const TICK_RATE = 30;
export const TICK_DT = 1 / TICK_RATE;
// 每个 tick 都发快照：20Hz 在 30Hz tick 下实际是每 2 帧（66ms）才发一次，远端移动一顿一顿的。
export const SNAPSHOT_RATE = 30;
export const SNAPSHOT_DT = 1 / SNAPSHOT_RATE;
export const KILLS_TO_WIN = 10;
export const RESPAWN_TIME = 2.6;
export const COUNTDOWN_SECONDS = 4;
export const PRACTICE_COUNTDOWN = 3;
export const MAX_PLAYERS = 2;
export const MAP_NAME = "warehouse";
export const MAP_LABEL = "仓库 · Warehouse";

export const KEY = {
  FORWARD: 1,
  BACK: 2,
  LEFT: 4,
  RIGHT: 8,
  JUMP: 16,
  CROUCH: 32,
  WALK: 64,
};

export const PLAYER = {
  radius: 0.34,
  height: 1.8,
  crouchHeight: 1.2,
  eye: 1.62,
  crouchEye: 1.05,
  step: 0.52,
  gravity: 20,
  jump: 6.6,
  accel: 12,
  airAccel: 1.8,
  friction: 8,
  crouchSpeed: 0.5,
  walkSpeed: 0.52,
};

export const WEAPONS = {
  rifle: {
    id: "rifle",
    name: "AR-15",
    short: "步枪",
    slot: 1,
    damage: { head: 100, body: 28, legs: 19 },
    interval: 0.1,
    mag: 30,
    reserve: 90,
    reload: 2.1,
    range: 95,
    speed: 4.9,
    auto: true,
    spread: 0.0022,
    moveSpread: 0.014,
    airSpread: 0.05,
    shotSpread: 0.0028,
    maxSpread: 0.045,
    kick: 0.011,
    kickYaw: 0.006,
    adsFov: 58,
    adsSpeed: 0.6,
    adsSpread: 0.0016,
  },
  pistol: {
    id: "pistol",
    name: "P-9",
    short: "手枪",
    slot: 2,
    damage: { head: 100, body: 34, legs: 24 },
    interval: 0.2,
    mag: 12,
    reserve: 60,
    reload: 1.6,
    range: 70,
    speed: 5.6,
    auto: false,
    spread: 0.003,
    moveSpread: 0.012,
    airSpread: 0.04,
    shotSpread: 0.006,
    maxSpread: 0.04,
    kick: 0.016,
    kickYaw: 0.008,
    adsFov: 62,
    adsSpeed: 0.7,
    adsSpread: 0.0014,
  },
  sniper: {
    id: "sniper",
    name: "M-70",
    short: "狙击枪",
    slot: 3,
    damage: { head: 100, body: 100, legs: 70 },
    interval: 1.35,
    mag: 5,
    reserve: 15,
    reload: 2.9,
    range: 130,
    speed: 3.9,
    auto: false,
    spread: 0.085,
    moveSpread: 0.05,
    airSpread: 0.14,
    shotSpread: 0.02,
    maxSpread: 0.1,
    kick: 0.055,
    kickYaw: 0.012,
    adsFov: 26,
    adsSpeed: 0.42,
    adsSpread: 0.00035,
  },
};

export const WEAPON_ORDER = ["rifle", "pistol", "sniper"];

const PAINT = {
  floor: 0x9aa2ac,
  floorTrim: 0x6f7883,
  wall: 0xa4a9ac,
  wallDark: 0x7c838a,
  metal: 0x95a1ae,
  metalDark: 0x76808c,
  crate: 0x9a734a,
  crateLight: 0xb58a5c,
  container: 0x4a8f88,
  containerAlt: 0x9a5a3c,
  platform: 0x8d97a3,
  pillar: 0x7f8995,
  accent: 0xf5b83d,
  amber: 0xdf9b5b,
  violet: 0xd97757, // 品牌陶土色（键名保留以兼容地图描述）
};

// 地图以“中心件 + 180° 旋转对称件”描述，保证双方出生点公平。
// y 是盒子底部，x/z 是中心，w/h/d 是完整尺寸。
const centerBoxes = [];
const pairBoxes = [];

function surfaceFor(color, solid) {
  if (solid === false) return null;
  if (color === PAINT.floor || color === PAINT.floorTrim || color === PAINT.platform) return "concrete";
  if (color === PAINT.wall || color === PAINT.wallDark) return "wall";
  if (color === PAINT.crate || color === PAINT.crateLight) return "wood";
  return "metal";
}

function center(x, y, z, w, h, d, color, solid = true) {
  centerBoxes.push({ x, y, z, w, h, d, c: color, solid, mat: surfaceFor(color, solid) });
}

function pair(x, y, z, w, h, d, color, solid = true) {
  pairBoxes.push({ x, y, z, w, h, d, c: color, solid, mat: surfaceFor(color, solid) });
}

function spawnFrame(x, z, w, d, color) {
  pair(x - w / 2, 0.02, z, 0.1, 0.03, d, color, false);
  pair(x + w / 2, 0.02, z, 0.1, 0.03, d, color, false);
  pair(x, 0.02, z - d / 2, w, 0.03, 0.1, color, false);
  pair(x, 0.02, z + d / 2, w, 0.03, 0.1, color, false);
  pair(x - 0.55, 0.02, z, 0.5, 0.03, 0.09, color, false);
  pair(x + 0.55, 0.02, z, 0.5, 0.03, 0.09, color, false);
}

function buildMap() {
  // 地面与外墙
  center(0, -1, 0, 44, 1, 44, PAINT.floor);
  pair(0, 0, -21.5, 44, 7, 1, PAINT.wallDark);
  pair(-21.5, 0, 0, 1, 7, 44, PAINT.wallDark);

  // 墙面灯带（纯装饰）
  pair(0, 5.55, -20.92, 42, 0.12, 0.1, PAINT.accent, false);
  pair(-20.92, 5.55, 0, 0.1, 0.12, 42, PAINT.accent, false);

  // 屋顶钢梁与墙边管线
  center(0, 6.4, 0, 43, 0.28, 0.3, PAINT.metalDark);
  pair(0, 6.4, 10, 43, 0.28, 0.3, PAINT.metalDark);
  pair(-20.55, 6.4, 0, 0.3, 0.28, 43, PAINT.metalDark);
  pair(0, 4.6, -20.8, 42, 0.22, 0.22, PAINT.metalDark);
  pair(-20.8, 4.6, 0, 0.22, 0.22, 42, PAINT.metalDark);

  // 中央高台与南北两侧台阶
  center(0, 0, 0, 7, 1.2, 7, PAINT.platform);
  pair(0, 0, -5.1, 4.4, 0.4, 1.2, PAINT.metal);
  pair(0, 0, -4.5, 4.4, 0.8, 0.9, PAINT.metal);
  pair(0, 0, -4.0, 4.4, 1.2, 0.55, PAINT.metalDark);

  // 高台护墙，中间给台阶留口
  pair(-2.3, 1.2, -3.15, 2.2, 0.7, 0.5, PAINT.metalDark);
  pair(2.3, 1.2, -3.15, 2.2, 0.7, 0.5, PAINT.metalDark);

  // 高台顶上的中央箱体与发光标记
  center(0, 1.2, 0, 2.3, 0.9, 2.3, PAINT.crate);
  center(-1.75, 1.22, 0, 1.5, 0.025, 0.12, PAINT.violet, false);
  center(1.75, 1.22, 0, 1.5, 0.025, 0.12, PAINT.violet, false);

  // 出生点侧翼掩体（不挡住面向中场的视野）
  pair(-18.8, 0, -15.5, 2.2, 2.2, 2.2, PAINT.container);
  pair(-16.5, 0, -17.8, 2.4, 1.0, 0.6, PAINT.metal);
  pair(-11.0, 0, -13.5, 1.7, 0.9, 1.7, PAINT.crateLight);
  spawnFrame(-13.5, -17.2, 4.0, 3.6, PAINT.accent);
  spawnFrame(-8.5, -17.8, 3.4, 3.0, PAINT.amber);
  pair(-19.6, 0, -8.6, 0.9, 1.25, 3.0, PAINT.metalDark);

  // 西侧集装箱通道
  pair(-11.3, 0, -5.2, 2.8, 2.2, 5.4, PAINT.container);
  pair(-13.9, 0, -8.6, 2.0, 0.9, 2.0, PAINT.crate);

  // 中场掩体与箱体
  pair(5.6, 0, -12.6, 5.6, 1.15, 0.7, PAINT.metal);
  pair(10.2, 0, -7.2, 1.8, 0.9, 1.8, PAINT.crate);
  pair(10.2, 0.9, -7.2, 1.4, 0.9, 1.4, PAINT.crateLight);
  pair(16.6, 0, -12.4, 1.4, 1.4, 1.4, PAINT.amber);
  pair(8.4, 0, 3.2, 2.2, 1.3, 1.0, PAINT.containerAlt);
  pair(-3.0, 0, -2.5, 1.4, 0.9, 1.4, PAINT.crate);
  pair(6.0, 0, 7.0, 2.0, 1.6, 0.8, PAINT.containerAlt);

  // 四根立柱
  pair(-7.5, 0, -7.5, 0.9, 6.5, 0.9, PAINT.pillar);
  pair(-7.5, 0, 7.5, 0.9, 6.5, 0.9, PAINT.pillar);

  // 东西两侧矮墙与近墙掩体
  pair(13.8, 0, 2.4, 0.7, 1.7, 5.0, PAINT.wall);
  pair(-17.8, 0, 4.0, 2.4, 2.2, 2.4, PAINT.container);
  pair(18.4, 0, 8.0, 1.0, 0.9, 3.0, PAINT.crate);
  pair(3.4, 0, 9.8, 1.5, 0.9, 1.5, PAINT.crateLight);

  // 墙面检修板
  pair(-20.84, 3.2, -8.0, 0.12, 1.0, 2.4, PAINT.metalDark);
  pair(-20.84, 3.2, 8.0, 0.12, 1.0, 2.4, PAINT.metalDark);
  pair(0, 3.2, -20.84, 2.4, 1.0, 0.12, PAINT.metalDark);
  pair(-6.0, 5.1, -20.84, 1.8, 0.18, 0.12, PAINT.amber);
  pair(6.0, 5.1, -20.84, 1.8, 0.18, 0.12, PAINT.amber);

  // 中央平台外的警示线
  pair(4.2, 0.016, 0, 0.14, 0.02, 7.4, PAINT.amber, false);
  pair(0, 0.016, 4.2, 7.4, 0.02, 0.14, PAINT.amber, false);

  // 地面导向条
  pair(9.5, 0.012, 0, 6.0, 0.02, 0.12, PAINT.floorTrim, false);
  pair(0, 0.012, 9.5, 0.12, 0.02, 6.0, PAINT.floorTrim, false);

  const all = [];
  for (const b of centerBoxes) all.push(b);
  for (const b of pairBoxes) all.push(b);
  for (const b of pairBoxes) all.push({ ...b, x: -b.x, z: -b.z });
  return all;
}

export const MAP_BOXES = buildMap();

function withBounds(b) {
  return {
    ...b,
    minX: b.x - b.w / 2,
    maxX: b.x + b.w / 2,
    minY: b.y,
    maxY: b.y + b.h,
    minZ: b.z - b.d / 2,
    maxZ: b.z + b.d / 2,
  };
}

export const SOLID_BOUNDS = MAP_BOXES.filter((b) => b.solid !== false).map(withBounds);

export const SPAWNS = [
  { slot: 0, points: [{ x: -13.5, z: -17.2 }, { x: -8.5, z: -17.8 }] },
  { slot: 1, points: [{ x: 13.5, z: 17.2 }, { x: 8.5, z: 17.8 }] },
];

export function spawnYaw(x, z) {
  return Math.atan2(-(0 - x), -(0 - z));
}

export function pickSpawn(slot, enemy) {
  const side = SPAWNS[slot] || SPAWNS[0];
  let best = side.points[0];
  let bestScore = -Infinity;
  for (const p of side.points) {
    const d = enemy ? Math.hypot(p.x - enemy.x, p.z - enemy.z) : 0;
    const jitter = Math.random() * 1.5;
    if (d + jitter > bestScore) {
      bestScore = d + jitter;
      best = p;
    }
  }
  return { x: best.x, y: 0, z: best.z, yaw: spawnYaw(best.x, best.z) };
}

export function createAmmo() {
  return {
    rifle: { mag: WEAPONS.rifle.mag, reserve: WEAPONS.rifle.reserve },
    pistol: { mag: WEAPONS.pistol.mag, reserve: WEAPONS.pistol.reserve },
    sniper: { mag: WEAPONS.sniper.mag, reserve: WEAPONS.sniper.reserve },
  };
}

export function createPlayerState(spawn, slot = 0, name = "玩家") {
  return {
    slot,
    name,
    x: spawn.x,
    y: spawn.y || 0,
    z: spawn.z,
    vx: 0,
    vy: 0,
    vz: 0,
    yaw: spawn.yaw || 0,
    pitch: 0,
    crouch: false,
    aiming: false,
    onGround: true,
    speed: 0,
    jumpHeld: false,
    alive: true,
    hp: 100,
    weapon: "rifle",
    ammo: createAmmo(),
    reloadEnd: 0,
    readyAt: 0,
    nextFireAt: 0,
    lastShotAt: -10,
    spray: 0,
    prevFire: false,
    kills: 0,
    deaths: 0,
    respawnAt: 0,
    spawnGuardUntil: 0,
  };
}

export function eyePosition(p) {
  return {
    x: p.x,
    y: p.y + (p.crouch ? PLAYER.crouchEye : PLAYER.eye),
    z: p.z,
  };
}

export function playerHeight(p) {
  return p.crouch ? PLAYER.crouchHeight : PLAYER.height;
}

function boundsAt(p, x = p.x, z = p.z, y = p.y, crouch = p.crouch) {
  const h = crouch ? PLAYER.crouchHeight : PLAYER.height;
  const r = PLAYER.radius;
  return { minX: x - r, maxX: x + r, minY: y, maxY: y + h, minZ: z - r, maxZ: z + r };
}

export function intersects(b, box) {
  return b.minX < box.maxX && b.maxX > box.minX &&
    b.minY < box.maxY && b.maxY > box.minY &&
    b.minZ < box.maxZ && b.maxZ > box.minZ;
}

export function collides(p, boxes = SOLID_BOUNDS) {
  const b = boundsAt(p);
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    if (b.minX < box.maxX && b.maxX > box.minX &&
        b.minY < box.maxY && b.maxY > box.minY &&
        b.minZ < box.maxZ && b.maxZ > box.minZ) return true;
  }
  return false;
}

function collidesAt(p, y, crouch = p.crouch, boxes = SOLID_BOUNDS) {
  const b = boundsAt(p, p.x, p.z, y, crouch);
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    if (b.minX < box.maxX && b.maxX > box.minX &&
        b.minY < box.maxY && b.maxY > box.minY &&
        b.minZ < box.maxZ && b.maxZ > box.minZ) return true;
  }
  return false;
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function lerpAngle(a, b, t) {
  let d = wrapAngle(b - a);
  return a + d * t;
}

function moveAxis(p, axis, delta, boxes) {
  if (Math.abs(delta) < 1e-9) return true;
  if (collides(p, boxes)) return false;
  const start = p[axis];
  p[axis] = start + delta;
  if (!collides(p, boxes)) return true;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 10; i++) {
    const mid = (lo + hi) * 0.5;
    p[axis] = start + delta * mid;
    if (collides(p, boxes)) hi = mid;
    else lo = mid;
  }
  p[axis] = start + delta * lo - Math.sign(delta) * 0.0001;
  return false;
}

function moveVertical(p, dy, boxes) {
  if (Math.abs(dy) < 1e-9) return false;
  if (collides(p, boxes)) return false;
  const start = p.y;
  p.y = start + dy;
  if (!collides(p, boxes)) return false;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 10; i++) {
    const mid = (lo + hi) * 0.5;
    p.y = start + dy * mid;
    if (collides(p, boxes)) hi = mid;
    else lo = mid;
  }
  p.y = start + dy * lo - Math.sign(dy) * 0.0001;
  return true;
}

function moveHorizontal(p, dx, dz, boxes) {
  if (collides(p, boxes)) return;
  const x0 = p.x;
  const z0 = p.z;
  const y0 = p.y;
  moveAxis(p, "x", dx, boxes);
  moveAxis(p, "z", dz, boxes);
  const wanted = Math.hypot(dx, dz);
  if (wanted < 1e-6) return;
  const flat = Math.hypot(p.x - x0, p.z - z0);
  if (flat >= wanted - 0.0005 || !p.onGround) return;

  // 被挡住时尝试抬脚上台阶，只有走得更远才采纳。
  const x1 = p.x;
  const z1 = p.z;
  p.x = x0;
  p.z = z0;
  p.y = y0 + PLAYER.step;
  if (collides(p, boxes)) {
    p.x = x1;
    p.z = z1;
    p.y = y0;
    return;
  }
  moveAxis(p, "x", dx, boxes);
  moveAxis(p, "z", dz, boxes);
  if (Math.hypot(p.x - x0, p.z - z0) > flat + 0.001) {
    p.onGround = false;
  } else {
    p.x = x1;
    p.z = z1;
    p.y = y0;
  }
}

function snapToGround(p, maxDrop, boxes) {
  if (p.vy > 0.01) return;
  const startY = p.y;
  let lo = startY - maxDrop;
  let hi = startY;
  if (!collidesAt(p, lo, p.crouch, boxes)) {
    p.onGround = false;
    return;
  }
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) * 0.5;
    if (collidesAt(p, mid, p.crouch, boxes)) lo = mid;
    else hi = mid;
  }
  p.y = hi;
  p.vy = 0;
  p.onGround = true;
}

function accelerate(p, wx, wz, wishSpeed, accel, dt) {
  const current = p.vx * wx + p.vz * wz;
  const add = wishSpeed - current;
  if (add <= 0) return;
  const step = Math.min(accel * wishSpeed * dt, add);
  p.vx += wx * step;
  p.vz += wz * step;
}

export function stepPlayer(p, input, dt, boxes = SOLID_BOUNDS) {
  dt = clamp(dt, 0.005, 0.05);
  p.yaw = wrapAngle(Number.isFinite(input.yaw) ? input.yaw : p.yaw);
  p.pitch = clamp(Number.isFinite(input.pitch) ? input.pitch : p.pitch, -1.5, 1.5);
  const keys = (input.keys | 0) >>> 0;

  const wantCrouch = !!(keys & KEY.CROUCH);
  if (wantCrouch) {
    p.crouch = true;
  } else if (p.crouch) {
    p.crouch = false;
    if (collides(p, boxes)) p.crouch = true;
  }
  p.aiming = !!input.aim;

  const weapon = WEAPONS[p.weapon] || WEAPONS.rifle;
  const speedCap = weapon.speed *
    (p.crouch ? PLAYER.crouchSpeed : 1) *
    ((keys & KEY.WALK) ? PLAYER.walkSpeed : 1) *
    (p.aiming ? (weapon.adsSpeed || 0.65) : 1);

  const jumpNow = !!(keys & KEY.JUMP);
  if (jumpNow && !p.jumpHeld && p.onGround) {
    p.vy = PLAYER.jump;
    p.onGround = false;
  }
  p.jumpHeld = jumpNow;

  let wx = 0;
  let wz = 0;
  const fwd = ((keys & KEY.FORWARD) ? 1 : 0) - ((keys & KEY.BACK) ? 1 : 0);
  const strafe = ((keys & KEY.RIGHT) ? 1 : 0) - ((keys & KEY.LEFT) ? 1 : 0);
  if (fwd || strafe) {
    const sy = Math.sin(p.yaw);
    const cy = Math.cos(p.yaw);
    wx = -sy * fwd + cy * strafe;
    wz = -cy * fwd - sy * strafe;
    const len = Math.hypot(wx, wz) || 1;
    wx /= len;
    wz /= len;
  }

  if (p.onGround) {
    const speed = Math.hypot(p.vx, p.vz);
    if (speed > 0.0001) {
      const drop = Math.max(speed, 2) * PLAYER.friction * dt;
      const next = Math.max(0, speed - drop);
      p.vx *= next / speed;
      p.vz *= next / speed;
    }
    if (wx || wz) accelerate(p, wx, wz, speedCap, PLAYER.accel, dt);
  } else if (wx || wz) {
    accelerate(p, wx, wz, speedCap, PLAYER.airAccel, dt);
  }

  moveHorizontal(p, p.vx * dt, p.vz * dt, boxes);

  const wasGround = p.onGround;
  p.vy -= PLAYER.gravity * dt;
  const dy = p.vy * dt;
  const blocked = moveVertical(p, dy, boxes);
  if (blocked) {
    if (dy < 0) {
      p.onGround = true;
      p.vy = 0;
    } else {
      p.vy = Math.min(p.vy, 0);
    }
  } else {
    p.onGround = false;
  }

  snapToGround(p, wasGround ? PLAYER.step + 0.08 : 0.08, boxes);

  p.x = clamp(p.x, -20.4, 20.4);
  p.z = clamp(p.z, -20.4, 20.4);
  if (p.y < -5) {
    p.y = 0.1;
    p.vy = 0;
  }
  p.speed = Math.hypot(p.vx, p.vz);
  return p;
}

export function damageFor(part, weaponId) {
  const w = WEAPONS[weaponId] || WEAPONS.rifle;
  return w.damage[part] ?? w.damage.body;
}

export function currentSpread(p, weaponId, spray) {
  const w = WEAPONS[weaponId] || WEAPONS.rifle;
  const speed = p.speed || 0;
  const move = clamp(speed / w.speed, 0, 1);
  const air = p.onGround ? 0 : 1;
  const aiming = !!p.aiming;
  const base = aiming ? (w.adsSpread ?? w.spread * 0.5) : w.spread;
  const moveMul = aiming ? 0.42 : 1;
  const airMul = aiming ? 0.5 : 1;
  const shotMul = aiming ? 0.6 : 1;
  return Math.min(
    w.maxSpread,
    base + move * move * w.moveSpread * moveMul +
      air * w.airSpread * airMul + (spray || 0) * w.shotSpread * shotMul
  );
}

export function hash01(n) {
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = n ^ (n >>> 16);
  return (n >>> 0) / 4294967296;
}

export function shotSeed(slot, seq, spray = 0) {
  return Math.imul(slot + 1, 1000003) + Math.imul(seq | 0, 7919) + Math.imul(spray | 0, 104729);
}

export function shotDirection(yaw, pitch, spread, seed) {
  const cp = Math.cos(pitch);
  const fwd = { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
  const right = { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) };
  const up = {
    x: right.y * fwd.z - right.z * fwd.y,
    y: right.z * fwd.x - right.x * fwd.z,
    z: right.x * fwd.y - right.y * fwd.x,
  };
  const angle = hash01(seed) * Math.PI * 2;
  const radius = Math.sqrt(hash01(seed ^ 0x5bd1e995)) * spread;
  const dx = fwd.x + right.x * Math.cos(angle) * radius + up.x * Math.sin(angle) * radius;
  const dy = fwd.y + right.y * Math.cos(angle) * radius + up.y * Math.sin(angle) * radius;
  const dz = fwd.z + right.z * Math.cos(angle) * radius + up.z * Math.sin(angle) * radius;
  const len = Math.hypot(dx, dy, dz) || 1;
  return { x: dx / len, y: dy / len, z: dz / len };
}

function rayBox(ox, oy, oz, dx, dy, dz, box, maxT) {
  let tmin = 0;
  let tmax = maxT;
  if (Math.abs(dx) < 1e-9) {
    if (ox < box.minX || ox > box.maxX) return Infinity;
  } else {
    const inv = 1 / dx;
    let t1 = (box.minX - ox) * inv;
    let t2 = (box.maxX - ox) * inv;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return Infinity;
  }
  if (Math.abs(dy) < 1e-9) {
    if (oy < box.minY || oy > box.maxY) return Infinity;
  } else {
    const inv = 1 / dy;
    let t1 = (box.minY - oy) * inv;
    let t2 = (box.maxY - oy) * inv;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return Infinity;
  }
  if (Math.abs(dz) < 1e-9) {
    if (oz < box.minZ || oz > box.maxZ) return Infinity;
  } else {
    const inv = 1 / dz;
    let t1 = (box.minZ - oz) * inv;
    let t2 = (box.maxZ - oz) * inv;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return Infinity;
  }
  return tmin;
}

export function raycastMap(ox, oy, oz, dx, dy, dz, maxT = 100, boxes = SOLID_BOUNDS) {
  let best = Infinity;
  for (let i = 0; i < boxes.length; i++) {
    const t = rayBox(ox, oy, oz, dx, dy, dz, boxes[i], maxT);
    if (t < best) best = t;
  }
  return best;
}

export function playerHitboxes(p) {
  const crouch = !!p.crouch;
  const eye = crouch ? PLAYER.crouchEye : PLAYER.eye;
  const top = p.y + eye;
  const headBottom = top - (crouch ? 0.24 : 0.3);
  const bodyBottom = p.y + (crouch ? 0.42 : 0.68);
  const bodyHalf = crouch ? 0.3 : 0.34;
  const legHalf = crouch ? 0.26 : 0.3;
  return [
    {
      part: "head",
      minX: p.x - 0.17, maxX: p.x + 0.17,
      minY: headBottom, maxY: top,
      minZ: p.z - 0.17, maxZ: p.z + 0.17,
    },
    {
      part: "body",
      minX: p.x - bodyHalf, maxX: p.x + bodyHalf,
      minY: bodyBottom, maxY: headBottom,
      minZ: p.z - bodyHalf, maxZ: p.z + bodyHalf,
    },
    {
      part: "legs",
      minX: p.x - legHalf, maxX: p.x + legHalf,
      minY: p.y, maxY: bodyBottom,
      minZ: p.z - legHalf, maxZ: p.z + legHalf,
    },
  ];
}

export function raycastPlayer(ox, oy, oz, dx, dy, dz, target, maxT = 100) {
  let best = Infinity;
  let part = null;
  const boxes = playerHitboxes(target);
  for (const box of boxes) {
    const t = rayBox(ox, oy, oz, dx, dy, dz, box, maxT);
    if (t < best) {
      best = t;
      part = box.part;
    }
  }
  return best === Infinity ? null : { t: best, part };
}

export function resetForSpawn(p, spawn) {
  p.x = spawn.x;
  p.y = spawn.y || 0;
  p.z = spawn.z;
  p.vx = 0;
  p.vy = 0;
  p.vz = 0;
  p.yaw = spawn.yaw;
  p.pitch = 0;
  p.crouch = false;
  p.aiming = false;
  p.onGround = true;
  p.speed = 0;
  p.alive = true;
  p.hp = 100;
  p.weapon = "rifle";
  p.ammo = createAmmo();
  p.reloadEnd = 0;
  p.readyAt = 0;
  p.nextFireAt = 0;
  p.lastShotAt = -10;
  p.spray = 0;
  p.prevFire = false;
  p.respawnAt = 0;
  p.jumpHeld = false;
}

export function ammoOf(p) {
  return p.ammo?.[p.weapon] || { mag: 0, reserve: 0 };
}

export function serializePlayer(p) {
  const ammo = p.ammo || createAmmo();
  return {
    slot: p.slot,
    name: p.name,
    bot: !!p.bot,
    connected: p.connected !== false,
    x: +p.x.toFixed(3),
    y: +p.y.toFixed(3),
    z: +p.z.toFixed(3),
    vx: +(p.vx || 0).toFixed(3),
    vy: +(p.vy || 0).toFixed(3),
    vz: +(p.vz || 0).toFixed(3),
    yaw: +p.yaw.toFixed(3),
    pitch: +p.pitch.toFixed(3),
    crouch: !!p.crouch,
    aiming: !!p.aiming,
    onGround: !!p.onGround,
    hp: Math.max(0, Math.round(p.hp)),
    alive: !!p.alive,
    weapon: p.weapon,
    kills: p.kills,
    deaths: p.deaths,
    speed: +(p.speed || 0).toFixed(2),
    respawn: p.alive ? 0 : Math.max(0, +(p.respawnAt || 0)),
    ammo: {
      rifle: { mag: ammo.rifle.mag, reserve: ammo.rifle.reserve },
      pistol: { mag: ammo.pistol.mag, reserve: ammo.pistol.reserve },
      sniper: { mag: ammo.sniper.mag, reserve: ammo.sniper.reserve },
    },
  };
}
