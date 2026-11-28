// 房间与权威模拟：移动、射击、命中、计分、机器人和快照。
// 服务器每 tick 推进一次，客户端只发送输入，不决定伤害或位置。

import {
  TICK_DT,
  SNAPSHOT_DT,
  KILLS_TO_WIN,
  COUNTDOWN_SECONDS,
  PRACTICE_COUNTDOWN,
  RESPAWN_TIME,
  WEAPONS,
  KEY,
  TICK_RATE,
  createPlayerState,
  resetForSpawn,
  pickSpawn,
  stepPlayer,
  eyePosition,
  raycastMap,
  raycastPlayer,
  shotDirection,
  shotSeed,
  currentSpread,
  damageFor,
  collides,
  clamp,
  wrapAngle,
  serializePlayer,
} from "../../public/game/js/shared.js";

const BOT_NAME = "训练机器人";
const DISCONNECT_GRACE = 15000;
const MAX_QUEUED_INPUTS = 45; // 1.5s：服务器或网络卡一下时不丢输入
// 延迟补偿最多回退 0.5s：覆盖 ~300ms ping + 100ms 插值，防止高延迟 / 伪造时间戳“打过去”。
const MAX_UNLAG = 0.5;
const BOT_REACT = 0.2;

let botSeqSeed = 100000;

export class Room {
  constructor(code, { practice = false } = {}) {
    this.code = code;
    this.practice = practice;
    this.seats = [null, null];
    this.state = "waiting";
    this.time = 0;
    this.countdownEnd = 0;
    this.winner = null;
    this.endReason = null;
    this.pendingEvents = [];
    this.history = [];
    this.lastReal = Date.now();
    this.acc = 0;
    this.lastSnapshotAt = -1;
    this.lastSnapshotSentAt = -1;
    this.emptySince = 0;
    this.createdAt = Date.now();
    this.closed = false;
  }

  humans() {
    return this.seats.filter((p) => p && !p.bot && p.connected);
  }

  other(slot) {
    return this.seats[1 - slot] || null;
  }

  seatInfo(p) {
    if (!p) return null;
    return {
      slot: p.slot,
      name: p.name,
      bot: !!p.bot,
      connected: p.connected !== false,
      kills: p.kills,
      deaths: p.deaths,
    };
  }

  roomInfoFor(p) {
    return {
      t: "room",
      code: this.code,
      state: this.state,
      practice: this.practice,
      target: KILLS_TO_WIN,
      countdown: this.state === "countdown" ? Math.max(0, this.countdownEnd - this.time) : 0,
      score: [this.seats[0]?.kills || 0, this.seats[1]?.kills || 0],
      winner: this.winner,
      youSlot: p?.slot ?? null,
      seats: this.seats.map((s) => this.seatInfo(s)),
    };
  }

  broadcast(obj) {
    const text = JSON.stringify(obj);
    for (const p of this.seats) {
      if (p?.conn && p.connected !== false) p.conn.sendRaw(text);
    }
  }

  broadcastRoomInfo() {
    for (const p of this.seats) {
      if (p?.conn) p.conn.send(this.roomInfoFor(p));
    }
  }

  addHuman(conn, name) {
    if (this.state !== "waiting") return null;
    const slot = this.seats[0] ? (this.seats[1] ? -1 : 1) : 0;
    if (slot < 0) return null;
    const enemy = this.other(slot);
    const spawn = pickSpawn(slot, enemy);
    const p = createPlayerState(spawn, slot, name);
    p.bot = false;
    p.conn = conn;
    p.connected = true;
    p.sessionId = conn.sessionId;
    p.inputQueue = [];
    p.lastAck = 0;
    p.rtt = 0.08;
    p.lastInputYaw = p.yaw;
    p.lastInputPitch = 0;
    p.disconnectAt = 0;
    this.seats[slot] = p;
    conn.room = this;
    conn.player = p;
    if (this.humans().length > 0) this.emptySince = 0;
    this.broadcastRoomInfo();
    if (this.seats.filter(Boolean).length === 2) {
      this.beginCountdown(COUNTDOWN_SECONDS);
    }
    return p;
  }

  addBot(slot, keepStats = false) {
    const enemy = this.other(slot);
    const spawn = pickSpawn(slot, enemy);
    const p = createPlayerState(spawn, slot, BOT_NAME);
    p.bot = true;
    p.conn = null;
    p.connected = true;
    p.inputQueue = [];
    p.lastAck = 0;
    p.lastInputYaw = p.yaw;
    p.lastInputPitch = 0;
    p.botSeq = (++botSeqSeed) * 131;
    p.botState = {
      skill: 0.46,
      phase: Math.random() * 10,
      noiseYaw: 0,
      noisePitch: 0,
      strafe: Math.random() < 0.5 ? -1 : 1,
      strafeUntil: 0,
      burstEnd: 0,
      restUntil: 0,
      hadLos: false,
      acquireAt: 0,
      lastX: spawn.x,
      lastZ: spawn.z,
      stuck: 0,
    };
    if (keepStats && this.seats[slot]) {
      p.kills = this.seats[slot].kills;
      p.deaths = this.seats[slot].deaths;
    }
    this.seats[slot] = p;
    return p;
  }

  startPractice(conn, name) {
    const p = this.addHuman(conn, name);
    if (!p) return false;
    this.practice = true;
    this.addBot(1);
    this.seats[0].kills = 0;
    this.seats[0].deaths = 0;
    this.beginCountdown(PRACTICE_COUNTDOWN);
    return true;
  }

  beginCountdown(duration) {
    this.state = "countdown";
    this.countdownEnd = this.time + duration;
    this.winner = null;
    this.endReason = null;
    this.pendingEvents = [];
    this.history = [];
    for (const p of this.seats) {
      if (!p) continue;
      p.kills = 0;
      p.deaths = 0;
      p.inputQueue = [];
      p.lastAck = 0;
      p.prevFire = false;
      p.reloadEnd = 0;
      p.readyAt = 0;
      p.nextFireAt = 0;
      p.spray = 0;
      p.respawnAt = 0;
      const enemy = this.other(p.slot);
      resetForSpawn(p, pickSpawn(p.slot, enemy));
      if (p.bot) this.resetBotState(p);
    }
    this.broadcast({
      t: "start",
      code: this.code,
      countdown: duration,
      practice: this.practice,
      target: KILLS_TO_WIN,
    });
    this.broadcastRoomInfo();
    this.pushSnapshot(true);
  }

  startMatch() {
    this.state = "live";
    this.countdownEnd = 0;
    this.pendingEvents = [];
    this.history = [];
    for (const p of this.seats) {
      if (!p) continue;
      p.inputQueue = [];
      p.lastAck = 0;
      const enemy = this.other(p.slot);
      resetForSpawn(p, pickSpawn(p.slot, enemy));
      if (p.bot) this.resetBotState(p);
    }
    this.broadcast({ t: "live", at: Date.now() / 1000 });
    this.broadcastRoomInfo();
    this.pushSnapshot(true);
  }

  endMatch(winnerSlot, reason) {
    if (this.state === "ended") return;
    this.state = "ended";
    this.winner = winnerSlot;
    this.endReason = reason;
    this.pendingEvents = this.pendingEvents.slice(-12);
    this.broadcast({
      t: "ended",
      winner: winnerSlot,
      reason,
      score: [this.seats[0]?.kills || 0, this.seats[1]?.kills || 0],
      target: KILLS_TO_WIN,
    });
    this.broadcastRoomInfo();
    this.pushSnapshot(true);
  }

  rematch() {
    if (this.state !== "ended") return false;
    if (!this.seats[0] || !this.seats[1]) return false;
    this.beginCountdown(COUNTDOWN_SECONDS);
    return true;
  }

  replaceWithBot(slot) {
    const old = this.seats[slot];
    if (!old || old.bot) return;
    this.addBot(slot, true);
    this.broadcast({ t: "toast", message: "对手离开了，机器人接管了对局" });
    this.broadcastRoomInfo();
    this.pushSnapshot(true);
  }

  removeSeat(slot) {
    const p = this.seats[slot];
    if (!p) return;
    if (p.conn) {
      p.conn.room = null;
      p.conn.player = null;
    }
    this.seats[slot] = null;
    if (this.state === "countdown" && this.seats.filter(Boolean).length < 2) {
      this.state = "waiting";
      this.countdownEnd = 0;
    }
    if (this.state === "live" && this.seats.filter(Boolean).length < 2) {
      this.endMatch(this.seats[0] ? 0 : 1, "left");
    }
    if (!this.humans().length) this.emptySince = Date.now();
    this.broadcastRoomInfo();
  }

  handleDisconnect(player) {
    if (!player || player.bot) return;
    player.connected = false;
    player.conn = null;
    player.disconnectAt = Date.now();
    player.inputQueue = [];
    if (this.state === "waiting") {
      this.removeSeat(player.slot);
      return;
    }
    const other = this.other(player.slot);
    if (other?.conn) {
      other.conn.send({ t: "toast", message: "对手连接中断，等待重连…" });
    }
    this.broadcastRoomInfo();
    if (!this.humans().length) this.emptySince = Date.now();
  }

  handleLeave(player) {
    if (!player) return;
    const other = this.other(player.slot);
    if (this.state === "waiting") {
      this.removeSeat(player.slot);
      return;
    }
    if (other && !other.bot) {
      this.replaceWithBot(player.slot);
    } else {
      this.removeSeat(player.slot);
    }
    player.conn = null;
    if (!this.humans().length) this.emptySince = Date.now();
  }

  queueInput(player, frame) {
    if (!player || player.bot) return;
    player.inputQueue.push(frame);
    if (player.inputQueue.length > MAX_QUEUED_INPUTS) {
      player.inputQueue.splice(0, player.inputQueue.length - MAX_QUEUED_INPUTS);
    }
  }

  update() {
    if (this.closed) return;
    const now = Date.now();
    let elapsed = (now - this.lastReal) / 1000;
    this.lastReal = now;
    if (elapsed > 0.5) elapsed = 0.5;
    this.acc += elapsed;
    let steps = 0;
    // 主机卡顿后补跑最多 10 帧（333ms），并且每补一帧就发一次快照：客户端按模拟时间插值，
    // 补发的帧能还原中间轨迹，而不是一次跳过去。
    while (this.acc >= TICK_DT && steps < 10) {
      this.step(TICK_DT);
      this.acc -= TICK_DT;
      steps++;
      if (this.state !== "waiting" && this.time - this.lastSnapshotAt >= SNAPSHOT_DT - 1e-6) this.pushSnapshot();
    }
    if (steps === 10) this.acc = 0;

    if (!this.humans().length && !this.emptySince) this.emptySince = now;
  }

  step(dt) {
    this.time += dt;

    if (this.state === "countdown" && this.time >= this.countdownEnd) {
      this.startMatch();
    }

    if (this.state === "live") {
      for (const p of this.seats) {
        if (!p) continue;
        if (p.reloadEnd > 0 && this.time >= p.reloadEnd) this.finishReload(p);
        if (!p.alive && this.time >= p.respawnAt) this.respawn(p);
        if (p.alive) {
          if (p.bot) this.botStep(p);
          else this.humanStep(p);
        }
      }
      this.recordHistory();
    }

    if (this.state === "ended") {
      for (const p of this.seats) if (p) p.speed = 0;
    }

    for (const p of this.seats) {
      if (!p || p.bot || p.connected !== false) continue;
      if (Date.now() - p.disconnectAt > DISCONNECT_GRACE) {
        const other = this.other(p.slot);
        if (other && !other.bot) this.replaceWithBot(p.slot);
        else this.removeSeat(p.slot);
      }
    }
  }

  humanStep(p) {
    let processed = 0;
    // 正常每帧 1~2 个输入；积压时（网络成批到达）最多 4 个，尽快追平且不至于让人“加速”。
    const budget = p.inputQueue.length > 3 ? 4 : 2;
    while (p.inputQueue.length && processed < budget) {
      const frame = p.inputQueue.shift();
      if (!frame) continue;
      if (frame.seq > p.lastAck) p.lastAck = frame.seq;
      this.applyInput(p, frame);
      processed++;
      if (!p.alive) break;
    }
    // 只推进真正收到的输入帧，避免服务器凭空多走一步导致客户端预测反复回滚。
  }

  applyInput(p, frame) {
    if (!p.alive) return;
    if (frame.slot === 1 || frame.slot === 2 || frame.slot === 3) {
      const id = frame.slot === 1 ? "rifle" : frame.slot === 2 ? "pistol" : "sniper";
      if (id !== p.weapon && this.time >= p.readyAt) {
        p.weapon = id;
        p.readyAt = this.time + 0.35;
        p.reloadEnd = 0;
        p.spray = 0;
        this.pushEvent({ type: "switch", by: p.slot, weapon: id });
      }
    }
    if (!frame.idle && frame.reload) this.startReload(p);

    stepPlayer(p, frame, TICK_DT);
    p.lastInputYaw = p.yaw;
    p.lastInputPitch = p.pitch;

    if (!frame.idle && frame.fire) {
      const w = WEAPONS[p.weapon];
      const edge = w.auto ? true : !p.prevFire;
      p.prevFire = true;
      if (edge) this.tryFire(p, frame.seq, frame.rt);
    } else {
      p.prevFire = false;
    }
  }

  startReload(p) {
    if (!p.alive || p.reloadEnd > 0 || this.time < p.readyAt) return false;
    const w = WEAPONS[p.weapon];
    const ammo = p.ammo[p.weapon];
    if (ammo.mag >= w.mag || ammo.reserve <= 0) return false;
    p.reloadEnd = this.time + w.reload;
    p.spray = 0;
    this.pushEvent({ type: "reload", by: p.slot, weapon: p.weapon, time: w.reload });
    return true;
  }

  finishReload(p) {
    const w = WEAPONS[p.weapon];
    const ammo = p.ammo[p.weapon];
    const need = w.mag - ammo.mag;
    const take = Math.min(need, ammo.reserve);
    ammo.mag += take;
    ammo.reserve -= take;
    p.reloadEnd = 0;
    p.spray = 0;
    this.pushEvent({ type: "reloaded", by: p.slot, weapon: p.weapon });
  }

  tryFire(p, seq, renderTime = null) {
    if (!p.alive || this.state !== "live") return;
    if (this.time < p.nextFireAt || this.time < p.readyAt) return;
    if (p.reloadEnd > 0 && this.time < p.reloadEnd) return;
    const w = WEAPONS[p.weapon];
    const ammo = p.ammo[p.weapon];
    if (!ammo || ammo.mag <= 0) {
      this.startReload(p);
      return;
    }
    ammo.mag--;
    p.nextFireAt = this.time + w.interval;
    if (this.time - p.lastShotAt > 0.4) p.spray = 0;
    else p.spray = Math.min(p.spray + 1, 8);
    p.lastShotAt = this.time;

    const eye = eyePosition(p);
    const spread = currentSpread(p, p.weapon, p.spray);
    const seed = shotSeed(p.slot, seq, p.spray);
    const dir = shotDirection(p.yaw, p.pitch, spread, seed);
    const range = w.range;
    const mapT = raycastMap(eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, range);
    let endT = Math.min(mapT, range);
    let hit = null;
    let target = null;

    const enemy = this.other(p.slot);
    if (enemy && enemy.alive) {
      // 延迟补偿（Source / Overwatch 做法）：客户端随开火帧上报“画面里敌人所处的服务器时间”，
      // 服务器回退到那一刻并在两帧历史之间插值，命中判定 = 玩家屏幕上看到的位置。
      // 人机看到的就是当前状态，不回退；旧客户端没上报时退回 RTT 估算。
      let targetPos = enemy;
      if (!p.bot) {
        const t = Number.isFinite(renderTime)
          ? clamp(renderTime, this.time - MAX_UNLAG, this.time)
          : this.time - clamp((p.rtt || 0.08) / 2 + 0.1, 0.04, 0.28);
        targetPos = this.positionAt(enemy.slot, t) || enemy;
      }
      const res = raycastPlayer(
        eye.x, eye.y, eye.z, dir.x, dir.y, dir.z,
        { ...targetPos, crouch: targetPos.crouch }, endT
      );
      if (res) {
        hit = res;
        target = enemy;
        endT = res.t;
      }
    }

    const to = {
      x: +(eye.x + dir.x * endT).toFixed(3),
      y: +(eye.y + dir.y * endT).toFixed(3),
      z: +(eye.z + dir.z * endT).toFixed(3),
    };
    this.pushEvent({
      type: "shot",
      by: p.slot,
      weapon: p.weapon,
      from: [+eye.x.toFixed(3), +eye.y.toFixed(3), +eye.z.toFixed(3)],
      to: [to.x, to.y, to.z],
      seed,
    });

    if (hit && target) {
      this.damage(p, target, hit.part, w, to);
    }
  }

  damage(shooter, target, part, weapon, point) {
    if (!target.alive) return;
    let dmg = damageFor(part, weapon.id);
    if (shooter.bot) dmg = Math.max(1, Math.round(dmg * 0.75));
    target.hp = Math.max(0, target.hp - dmg);
    target.lastHurtAt = this.time;
    target.lastHurtBy = shooter.slot;
    const sEye = eyePosition(shooter);
    this.pushEvent({
      type: "hit",
      by: shooter.slot,
      target: target.slot,
      part,
      dmg,
      hp: target.hp,
      at: [point.x, point.y, point.z],
      from: [+sEye.x.toFixed(2), +sEye.y.toFixed(2), +sEye.z.toFixed(2)],
    });
    if (target.hp <= 0) {
      target.alive = false;
      target.hp = 0;
      target.deaths++;
      target.respawnAt = this.time + RESPAWN_TIME;
      target.reloadEnd = 0;
      target.vx = 0;
      target.vy = 0;
      target.vz = 0;
      target.speed = 0;
      target.spray = 0;
      shooter.kills++;
      this.pushEvent({
        type: "kill",
        by: shooter.slot,
        target: target.slot,
        part,
        weapon: weapon.id,
        kills: shooter.kills,
        deaths: target.deaths,
      });
      if (shooter.kills >= KILLS_TO_WIN) {
        this.endMatch(shooter.slot, "kills");
      } else {
        this.broadcastRoomInfo();
      }
    }
  }

  respawn(p) {
    const enemy = this.other(p.slot);
    resetForSpawn(p, pickSpawn(p.slot, enemy));
    p.readyAt = this.time + 0.4;
    p.nextFireAt = this.time + 0.4;
    if (p.bot) this.resetBotState(p);
    this.pushEvent({ type: "respawn", slot: p.slot });
  }

  recordHistory() {
    const entry = { t: this.time, slots: [] };
    for (const p of this.seats) {
      if (!p) continue;
      entry.slots.push({
        slot: p.slot,
        x: p.x,
        y: p.y,
        z: p.z,
        crouch: p.crouch,
        alive: p.alive,
      });
    }
    this.history.push(entry);
    while (this.history.length > TICK_RATE * 2) this.history.shift();
  }

  // 取 t 时刻的位置：在前后两条历史之间线性插值（旧版直接取前一帧，最多差 33ms）。
  positionAt(slot, t) {
    let after = null;
    let afterT = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const entry = this.history[i];
      const found = entry.slots.find((s) => s.slot === slot);
      if (!found) continue;
      if (entry.t <= t) {
        if (!after || afterT - entry.t < 1e-6) return found;
        // 重生瞬移不插值
        if (Math.hypot(after.x - found.x, after.z - found.z) > 3 || found.alive !== after.alive) {
          return t - entry.t < afterT - t ? found : after;
        }
        const k = (t - entry.t) / (afterT - entry.t);
        return {
          slot,
          x: found.x + (after.x - found.x) * k,
          y: found.y + (after.y - found.y) * k,
          z: found.z + (after.z - found.z) * k,
          crouch: k < 0.5 ? found.crouch : after.crouch,
          alive: found.alive,
        };
      }
      after = found;
      afterT = entry.t;
    }
    return after;
  }

  pushEvent(ev) {
    this.pendingEvents.push(ev);
    if (this.pendingEvents.length > 48) this.pendingEvents.splice(0, this.pendingEvents.length - 48);
  }

  pushSnapshot(force = false) {
    if (this.state === "waiting") return;
    if (!force && this.time - this.lastSnapshotAt < SNAPSHOT_DT - 1e-6) return;
    this.lastSnapshotAt = this.time;
    const events = this.pendingEvents;
    this.pendingEvents = [];
    let sent = 0;
    for (const p of this.seats) {
      if (!p?.conn || p.connected === false) continue;
      const base = serializePlayer(p);
      p.conn.send({
        t: "snapshot",
        now: Date.now() / 1000,
        st: +this.time.toFixed(4),
        state: this.state,
        countdown: this.state === "countdown" ? Math.max(0, +(this.countdownEnd - this.time).toFixed(2)) : 0,
        score: [this.seats[0]?.kills || 0, this.seats[1]?.kills || 0],
        target: KILLS_TO_WIN,
        winner: this.winner,
        reason: this.endReason,
        players: this.seats.filter(Boolean).map((s) => {
          const info = serializePlayer(s);
          info.respawn = s.alive ? 0 : Math.max(0, +(s.respawnAt - this.time).toFixed(2));
          return info;
        }),
        you: {
          ...base,
          ack: p.lastAck || 0,
          rtt: +(p.rtt || 0.08).toFixed(3),
          reload: p.reloadEnd > this.time ? +(p.reloadEnd - this.time).toFixed(2) : 0,
          respawn: p.alive ? 0 : Math.max(0, +(p.respawnAt - this.time).toFixed(2)),
          armor: 0,
        },
        events,
      });
      sent++;
    }
    if (!sent) {
      this.pendingEvents = events.slice(-12);
    }
  }

  resetBotState(p) {
    const enemy = this.other(p.slot);
    p.botState = {
      skill: 0.46,
      phase: Math.random() * 10,
      noiseYaw: 0,
      noisePitch: 0,
      strafe: Math.random() < 0.5 ? -1 : 1,
      strafeUntil: 0,
      burstEnd: 0,
      restUntil: 0,
      hadLos: false,
      acquireAt: 0,
      lastX: p.x,
      lastZ: p.z,
      stuck: 0,
    };
    if (enemy) p.pitch = 0;
    p.lastAck = 0;
    p.prevFire = false;
  }

  botStep(p) {
    const enemy = this.other(p.slot);
    const bs = p.botState;
    if (!bs) {
      this.resetBotState(p);
      return;
    }
    if (p.reloadEnd > 0 && this.time >= p.reloadEnd) this.finishReload(p);

    const eye = eyePosition(p);
    let wantFire = false;
    let keys = 0;

    if (enemy && enemy.alive) {
      const eEye = eyePosition(enemy);
      const dx = enemy.x - p.x;
      const dz = enemy.z - p.z;
      const flatDist = Math.hypot(dx, dz) || 0.001;
      const vertical = eEye.y - eye.y;
      const dist = Math.hypot(dx, dz, vertical);

      const mapT = raycastMap(
        eye.x, eye.y, eye.z,
        dx / dist, vertical / dist, dz / dist,
        dist
      );
      const los = mapT > dist - 0.25;
      if (los && !bs.hadLos) {
        // 人类视觉反应约 250ms，再加上判断时间；刚看到时准星偏差大，之后逐渐收敛
        bs.acquireAt = this.time + 0.45 + (1 - bs.skill) * 0.5 + Math.random() * 0.25;
        bs.errMag = 0.1 + (1 - bs.skill) * 0.06;
        bs.errAng = Math.random() * Math.PI * 2;
      }
      bs.hadLos = los;

      // 瞄准用的是 BOT_REACT 秒前看到的位置：对横移目标会自然“跟慢半拍”，像真人一样需要预判
      const seen = this.positionAt(enemy.slot, this.time - BOT_REACT) || enemy;
      const sdx = seen.x - p.x;
      const sdz = seen.z - p.z;
      const chestY = seen.y + (seen.crouch ? 0.7 : 0.98);
      const chestDy = chestY - eye.y;
      let wantYaw = Math.atan2(-sdx, -sdz);
      let wantPitch = Math.atan2(chestDy, Math.hypot(sdx, sdz) || 0.001);

      // 误差：时间常数约 0.75s 收敛到下限；被打中时会“受惊”放大（类似真人的 aim punch）
      bs.phase += TICK_DT * (2.1 + bs.skill * 2.6);
      const floor = 0.03 + (1 - bs.skill) * 0.02;
      bs.errMag = Math.max(floor, (bs.errMag || floor) * Math.exp(-TICK_DT / 0.75));
      if (this.time - (p.lastHurtAt || -10) < TICK_DT * 1.5) bs.errMag = Math.min(0.16, bs.errMag + 0.05);
      bs.errAng = (bs.errAng || 0) + TICK_DT * (1.1 + Math.sin(bs.phase) * 0.6);
      wantYaw += Math.cos(bs.errAng) * bs.errMag;
      wantPitch += Math.sin(bs.errAng) * bs.errMag * 0.6;

      const turn = (2.8 + bs.skill * 4.2) * TICK_DT;
      p.yaw = wrapAngle(p.yaw + clamp(wrapAngle(wantYaw - p.yaw), -turn, turn));
      p.pitch = clamp(p.pitch + clamp(wantPitch - p.pitch, -turn * 0.8, turn * 0.8), -1.2, 1.2);

      let mx = 0;
      let mz = 0;
      const nx = dx / flatDist;
      const nz = dz / flatDist;
      if (!los) {
        mx = nx;
        mz = nz;
      } else if (flatDist > 15) {
        mx = nx;
        mz = nz;
        mx += -nz * bs.strafe * 0.35;
        mz += nx * bs.strafe * 0.35;
      } else if (flatDist < 5) {
        mx = -nx;
        mz = -nz;
        mx += -nz * bs.strafe * 0.6;
        mz += nx * bs.strafe * 0.6;
      } else {
        if (this.time > bs.strafeUntil) {
          bs.strafe = Math.random() < 0.5 ? -1 : 1;
          bs.strafeUntil = this.time + 0.8 + Math.random() * 1.1;
        }
        mx = -nz * bs.strafe + nx * 0.22;
        mz = nx * bs.strafe + nz * 0.22;
      }
      const safe = this.avoid(p, mx, mz);
      mx = safe.x;
      mz = safe.z;

      const fwdX = -Math.sin(p.yaw);
      const fwdZ = -Math.cos(p.yaw);
      const rightX = Math.cos(p.yaw);
      const rightZ = -Math.sin(p.yaw);
      const f = mx * fwdX + mz * fwdZ;
      const r = mx * rightX + mz * rightZ;
      if (f > 0.25) keys |= KEY.FORWARD;
      else if (f < -0.25) keys |= KEY.BACK;
      if (r > 0.25) keys |= KEY.RIGHT;
      else if (r < -0.25) keys |= KEY.LEFT;

      if (Math.hypot(mx, mz) > 0.2) {
        if (Math.hypot(p.x - bs.lastX, p.z - bs.lastZ) < 0.02) bs.stuck += TICK_DT;
        else bs.stuck = 0;
        bs.lastX = p.x;
        bs.lastZ = p.z;
        if (bs.stuck > 0.5 && p.onGround && Math.random() < 0.08) {
          keys |= KEY.JUMP;
          bs.stuck = 0;
        }
      }

      const aimErr = Math.abs(wrapAngle(wantYaw - p.yaw)) + Math.abs(wantPitch - p.pitch) * 0.7;
      if (los && dist < 62 && this.time > bs.restUntil && this.time >= bs.acquireAt) {
        if (this.time > bs.burstEnd) {
          bs.burstEnd = this.time + 0.16 + Math.random() * 0.24;
        }
        if (aimErr < 0.07) wantFire = true;
        if (this.time >= bs.burstEnd) {
          bs.restUntil = this.time + 0.6 + Math.random() * 0.85;
        }
      }
    } else {
      bs.hadLos = false;
      if (this.time > bs.strafeUntil) {
        bs.strafe = Math.random() < 0.5 ? -1 : 1;
        bs.strafeUntil = this.time + 0.8 + Math.random();
      }
      keys |= bs.strafe > 0 ? KEY.LEFT : KEY.RIGHT;
    }

    if (p.reloadEnd <= 0 && p.ammo[p.weapon].mag <= 0) this.startReload(p);
    if (p.reloadEnd > 0 && this.time >= p.reloadEnd) this.finishReload(p);

    if (wantFire || this.time < bs.burstEnd) keys |= KEY.WALK;

    const seq = ++p.botSeq;
    stepPlayer(p, { keys, yaw: p.yaw, pitch: p.pitch }, TICK_DT);
    if (wantFire) this.tryFire(p, seq);
    if (p.reloadEnd > 0 && this.time >= p.reloadEnd) this.finishReload(p);
  }

  avoid(p, mx, mz) {
    const len = Math.hypot(mx, mz);
    if (len < 1e-4) return { x: 0, z: 0 };
    mx /= len;
    mz /= len;
    const angles = [0, 0.55, -0.55, 1.1, -1.1, 1.7, -1.7, 2.4, -2.4];
    for (const a of angles) {
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const nx = mx * ca - mz * sa;
      const nz = mx * sa + mz * ca;
      const probe = { x: p.x + nx * 1.25, y: p.y + 0.05, z: p.z + nz * 1.25, crouch: false };
      if (!collides(probe)) return { x: nx, z: nz };
      probe.y = p.y + 0.6;
      if (!collides(probe)) return { x: nx, z: nz };
    }
    return { x: 0, z: 0 };
  }
}
