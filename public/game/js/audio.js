// 纯 WebAudio 合成音效：不依赖任何外部音频资源。

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.volume = 0.6;
    this.noiseBuffer = null;
    this.ready = false;
  }

  init() {
    if (this.ready) {
      if (this.ctx?.state === "suspended") this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.knee.value = 18;
      comp.ratio.value = 5;
      comp.attack.value = 0.003;
      comp.release.value = 0.25;
      this.master.connect(comp);
      comp.connect(this.ctx.destination);
      this.noiseBuffer = this._makeNoise(1.2);
      this.ready = true;
      if (this.ctx.state === "suspended") this.ctx.resume();
    } catch (err) {
      console.warn("[audio] init failed", err);
    }
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, Number(v) || 0));
    if (this.master) this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
  }

  _makeNoise(seconds) {
    const rate = this.ctx.sampleRate;
    const len = Math.max(1, Math.floor(rate * seconds));
    const buf = this.ctx.createBuffer(1, len, rate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  _pan(value) {
    const pan = Math.max(-1, Math.min(1, value || 0));
    if (!this.ctx.createStereoPanner) return null;
    const node = this.ctx.createStereoPanner();
    node.pan.value = pan;
    return node;
  }

  _out(pan) {
    const p = this._pan(pan);
    if (p) {
      p.connect(this.master);
      return p;
    }
    return this.master;
  }

  _noise({ dur = 0.1, gain = 0.2, freq = 900, q = 0.8, type = "bandpass", pan = 0, delay = 0, playbackRate = 1 }) {
    if (!this.ready) return;
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.playbackRate.value = playbackRate;
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter);
    filter.connect(env);
    env.connect(this._out(pan));
    src.start(t, Math.random() * 0.4, dur + 0.02);
    src.stop(t + dur + 0.05);
  }

  _tone({ freq = 440, to = freq, dur = 0.1, gain = 0.1, type = "sine", pan = 0, delay = 0 }) {
    if (!this.ready) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(1, freq), t);
    if (to !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + dur);
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(env);
    env.connect(this._out(pan));
    osc.start(t);
    osc.stop(t + dur + 0.04);
  }

  shot(weapon, { pan = 0, gain = 1 } = {}) {
    if (!this.ready) return;
    if (weapon === "sniper") {
      const g = gain * 1.15;
      this._noise({ dur: 0.3, gain: 0.44 * g, freq: 520, q: 0.6, pan });
      this._noise({ dur: 0.1, gain: 0.25 * g, freq: 1800, q: 0.7, pan, delay: 0.005 });
      this._tone({ freq: 120, to: 34, dur: 0.32, gain: 0.42 * g, type: "triangle", pan });
      this._tone({ freq: 58, to: 28, dur: 0.4, gain: 0.26 * g, type: "sine", pan });
      this._noise({ dur: 0.5, gain: 0.1 * g, freq: 900, q: 0.4, type: "lowpass", pan, delay: 0.12 });
      return;
    }
    const rifle = weapon !== "pistol";
    const g = gain * (rifle ? 0.9 : 0.7);
    this._noise({ dur: rifle ? 0.16 : 0.11, gain: 0.34 * g, freq: rifle ? 780 : 1500, q: 0.7, pan });
    this._noise({ dur: 0.06, gain: 0.2 * g, freq: rifle ? 2600 : 3800, q: 0.6, pan, delay: 0.004 });
    this._tone({ freq: rifle ? 150 : 220, to: rifle ? 52 : 90, dur: 0.13, gain: 0.32 * g, type: "triangle", pan });
    this._tone({ freq: rifle ? 70 : 110, to: 38, dur: 0.1, gain: 0.18 * g, type: "sine", pan });
  }

  impact(pan = 0) {
    this._noise({ dur: 0.05, gain: 0.09, freq: 2400, q: 1.4, pan });
  }

  hit(head = false) {
    this._tone({ freq: head ? 1900 : 1350, to: head ? 1600 : 1200, dur: 0.05, gain: 0.12, type: "square" });
    if (head) this._tone({ freq: 2600, to: 2200, dur: 0.04, gain: 0.06, delay: 0.02, type: "sine" });
  }

  hurt() {
    this._noise({ dur: 0.22, gain: 0.16, freq: 320, q: 0.6, pan: 0, type: "lowpass" });
    this._tone({ freq: 95, to: 55, dur: 0.28, gain: 0.22, type: "triangle" });
    this._tone({ freq: 1400, to: 800, dur: 0.12, gain: 0.03, type: "sawtooth" });
  }

  death() {
    this._tone({ freq: 420, to: 90, dur: 0.9, gain: 0.14, type: "sawtooth" });
    this._noise({ dur: 0.7, gain: 0.14, freq: 500, q: 0.5, type: "lowpass" });
  }

  kill() {
    this._tone({ freq: 880, dur: 0.09, gain: 0.09, type: "sine" });
    this._tone({ freq: 1320, dur: 0.14, gain: 0.08, type: "sine", delay: 0.07 });
  }

  win() {
    this._tone({ freq: 523, dur: 0.16, gain: 0.1 });
    this._tone({ freq: 659, dur: 0.16, gain: 0.1, delay: 0.13 });
    this._tone({ freq: 784, dur: 0.3, gain: 0.11, delay: 0.26 });
  }

  lose() {
    this._tone({ freq: 392, dur: 0.2, gain: 0.1 });
    this._tone({ freq: 311, dur: 0.2, gain: 0.1, delay: 0.16 });
    this._tone({ freq: 233, dur: 0.4, gain: 0.1, delay: 0.32 });
  }

  reloadStart() {
    this._noise({ dur: 0.045, gain: 0.12, freq: 1900, q: 2, type: "bandpass" });
    this._tone({ freq: 320, to: 240, dur: 0.05, gain: 0.06, type: "square", delay: 0.08 });
  }

  reloadEnd() {
    this._noise({ dur: 0.05, gain: 0.13, freq: 2400, q: 2 });
    this._tone({ freq: 520, to: 420, dur: 0.06, gain: 0.06, type: "square", delay: 0.03 });
  }

  empty() {
    this._noise({ dur: 0.03, gain: 0.1, freq: 3200, q: 3 });
  }

  switchWeapon() {
    this._noise({ dur: 0.04, gain: 0.08, freq: 1400, q: 2 });
    this._tone({ freq: 260, to: 380, dur: 0.05, gain: 0.04, type: "square", delay: 0.03 });
  }

  footstep(pan = 0, gain = 0.1) {
    this._noise({ dur: 0.055, gain, freq: 360 + Math.random() * 120, q: 1.1, type: "lowpass", pan });
  }

  beep(high = false) {
    this._tone({ freq: high ? 1040 : 780, dur: 0.07, gain: 0.06, type: "sine" });
  }

  spawn() {
    this._tone({ freq: 300, to: 620, dur: 0.18, gain: 0.06, type: "sine" });
  }

  ui() {
    this._tone({ freq: 640, to: 740, dur: 0.035, gain: 0.035, type: "triangle" });
  }
}
