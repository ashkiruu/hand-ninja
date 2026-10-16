// Procedural audio: every sound effect and the music are synthesized with the
// Web Audio API at runtime, so there are no audio files to ship or license.

type Ctx = AudioContext;

export class AudioEngine {
  ctx: Ctx | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private music!: GainNode;
  private reverbSend!: GainNode;
  private noise!: AudioBuffer;
  private crackle!: AudioBuffer;
  private fuse: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private musicPlayer: MusicPlayer | null = null;
  private sfxVol = 0.9;
  private musicVol = 0.45;
  private lastWhoosh = 0;

  /** Must be called from a user gesture (browsers block audio until then). */
  async unlock() {
    if (!this.ctx) this.init();
    if (this.ctx!.state !== "running") await this.ctx!.resume();
  }

  private init() {
    const ctx = new AudioContext({ latencyHint: "interactive" });
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.2;
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(comp);

    this.sfx = ctx.createGain();
    this.sfx.gain.value = this.sfxVol;
    this.sfx.connect(this.master);
    this.music = ctx.createGain();
    this.music.gain.value = this.musicVol;
    this.music.connect(this.master);

    const reverb = ctx.createConvolver();
    reverb.buffer = impulse(ctx, 2.2, 2.5);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.35;
    this.reverbSend.connect(reverb);
    reverb.connect(this.master);

    this.noise = noiseBuffer(ctx, 2);
    this.crackle = crackleBuffer(ctx, 1.5);
    this.musicPlayer = new MusicPlayer(ctx, this.music, this.reverbSend);
  }

  setVolumes(sfx: number, music: number) {
    this.sfxVol = sfx;
    this.musicVol = music;
    if (!this.ctx) return;
    this.sfx.gain.setTargetAtTime(sfx, this.ctx.currentTime, 0.05);
    this.music.gain.setTargetAtTime(music, this.ctx.currentTime, 0.05);
  }

  setMusic(mode: "off" | "menu" | "game") {
    this.musicPlayer?.setMode(mode);
  }

  setMusicIntensity(v: number) {
    if (this.musicPlayer) this.musicPlayer.intensity = v;
  }

  // ---------------------------------------------------------------- helpers

  private get ready() {
    return !!this.ctx && this.ctx.state === "running";
  }

  private out(pan = 0, reverb = 0) {
    const ctx = this.ctx!;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    p.connect(this.sfx);
    if (reverb > 0) {
      const r = ctx.createGain();
      r.gain.value = reverb;
      p.connect(r);
      r.connect(this.reverbSend);
    }
    return p;
  }

  private noiseSrc(rate = 1) {
    const s = this.ctx!.createBufferSource();
    s.buffer = this.noise;
    s.playbackRate.value = rate;
    s.loop = true;
    return s;
  }

  private env(g: GainNode, t: number, peak: number, attack: number, decay: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  private tone(type: OscillatorType, f0: number, f1: number, t: number, dur: number, peak: number, dest: AudioNode, attack = 0.005) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    this.env(g, t, peak, attack, dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + attack + dur + 0.05);
  }

  // ---------------------------------------------------------------- SFX

  /** Air swish for a blade swing. `speed` in screen heights / s. */
  whoosh(speed: number, pan: number) {
    if (!this.ready) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    if (t - this.lastWhoosh < 0.22) return;
    this.lastWhoosh = t;
    const k = Math.min(1, (speed - 1) / 4);
    const src = this.noiseSrc(0.8 + Math.random() * 0.4);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(500 + k * 500, t);
    bp.frequency.exponentialRampToValueAtTime(1800 + k * 2400, t + 0.09);
    bp.frequency.exponentialRampToValueAtTime(700, t + 0.22);
    const g = ctx.createGain();
    this.env(g, t, 0.18 + k * 0.25, 0.04, 0.2);
    src.connect(bp).connect(g).connect(this.out(pan));
    src.start(t, Math.random());
    src.stop(t + 0.3);
  }

  /** Wet fruit splat + blade "shing". */
  slice(pan: number, big = false) {
    if (!this.ready) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const o = this.out(pan, 0.15);
    // splat body
    const src = this.noiseSrc(0.6 + Math.random() * 0.3);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(3200, t);
    lp.frequency.exponentialRampToValueAtTime(400, t + 0.16);
    const g = ctx.createGain();
    this.env(g, t, big ? 0.7 : 0.5, 0.004, 0.16);
    src.connect(lp).connect(g).connect(o);
    src.start(t, Math.random());
    src.stop(t + 0.25);
    // squelch: quick resonant sweep
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 9;
    bp.frequency.setValueAtTime(1400 + Math.random() * 600, t + 0.01);
    bp.frequency.exponentialRampToValueAtTime(300, t + 0.12);
    const g2 = ctx.createGain();
    this.env(g2, t + 0.01, 0.6, 0.004, 0.11);
    const src2 = this.noiseSrc(1);
    src2.connect(bp).connect(g2).connect(o);
    src2.start(t, Math.random());
    src2.stop(t + 0.2);
    // thump
    this.tone("sine", 190, 70, t, 0.1, 0.35, o);
    // metallic shing
    const base = 2600 + Math.random() * 500;
    for (const [m, a] of [[1, 0.05], [1.51, 0.035], [2.13, 0.025]] as const) {
      this.tone("sine", base * m, base * m * 0.98, t, 0.22, a, o, 0.002);
    }
  }

  critical(pan: number) {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    const o = this.out(pan, 0.6);
    for (const [f, a] of [[1760, 0.12], [2637, 0.08], [3520, 0.05]] as const) this.tone("triangle", f, f, t, 0.7, a, o, 0.002);
  }

  combo(n: number) {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    const o = this.out(0, 0.5);
    const scale = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22];
    const notes = Math.min(n, 8);
    for (let i = 0; i < notes; i++) {
      const f = 523.25 * Math.pow(2, scale[i] / 12);
      this.tone("triangle", f, f, t + i * 0.055, 0.35, 0.12, o, 0.003);
      this.tone("sine", f * 2, f * 2, t + i * 0.055, 0.25, 0.04, o, 0.003);
    }
  }

  miss() {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    const o = this.out(0, 0.2);
    this.tone("sine", 220, 110, t, 0.35, 0.35, o);
    this.tone("triangle", 330, 160, t + 0.05, 0.3, 0.12, o);
  }

  explosion() {
    if (!this.ready) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const o = this.out(0, 0.5);
    const src = this.noiseSrc(0.5);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(6000, t);
    lp.frequency.exponentialRampToValueAtTime(120, t + 1.6);
    const shaper = ctx.createWaveShaper();
    shaper.curve = distortionCurve(30);
    const g = ctx.createGain();
    this.env(g, t, 1.2, 0.005, 1.8);
    src.connect(lp).connect(shaper).connect(g).connect(o);
    src.start(t);
    src.stop(t + 2);
    this.tone("sine", 90, 30, t, 1.2, 0.9, o);
    this.tone("sine", 140, 40, t, 0.5, 0.5, o);
  }

  startFuse() {
    if (!this.ready || this.fuse) return;
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.crackle;
    src.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 2500;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.gain.setTargetAtTime(0.2, ctx.currentTime, 0.05);
    src.connect(hp).connect(gain).connect(this.sfx);
    src.start();
    this.fuse = { src, gain };
  }

  stopFuse() {
    if (!this.fuse || !this.ctx) return;
    const { src, gain } = this.fuse;
    gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
    src.stop(this.ctx.currentTime + 0.3);
    this.fuse = null;
  }

  powerUp(kind: "freeze" | "frenzy" | "double") {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    const o = this.out(0, 0.8);
    if (kind === "freeze") {
      for (const f of [1318.5, 1567.98, 1975.53, 2637]) this.tone("sine", f, f * 1.01, t, 1.2, 0.07, o, 0.02);
      this.tone("triangle", 2637, 5274, t, 0.6, 0.03, o);
    } else if (kind === "frenzy") {
      for (let i = 0; i < 6; i++) this.taiko(t + i * 0.07, 0.5 + i * 0.05);
      this.tone("sawtooth", 220, 880, t, 0.5, 0.06, o);
    } else {
      this.tone("square", 987.77, 987.77, t, 0.08, 0.06, o);
      this.tone("square", 1318.5, 1318.5, t + 0.08, 0.4, 0.06, o);
    }
  }

  private taiko(t: number, amp: number) {
    const o = this.out(0, 0.4);
    this.tone("sine", 120, 50, t, 0.3, amp, o);
    const src = this.noiseSrc(1);
    const lp = this.ctx!.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 900;
    const g = this.ctx!.createGain();
    this.env(g, t, amp * 0.4, 0.002, 0.06);
    src.connect(lp).connect(g).connect(o);
    src.start(t);
    src.stop(t + 0.1);
  }

  uiSelect() {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    const o = this.out(0, 0.5);
    this.tone("triangle", 880, 880, t, 0.25, 0.1, o);
    this.tone("triangle", 1318.5, 1318.5, t + 0.07, 0.4, 0.1, o);
  }

  countdown(final: boolean) {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    if (final) {
      this.taiko(t, 1);
      this.taiko(t + 0.12, 0.8);
    } else {
      this.taiko(t, 0.6);
    }
  }

  gameOver() {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    const o = this.out(0, 0.7);
    this.taiko(t, 1);
    const notes = [587.33, 523.25, 466.16, 392];
    notes.forEach((f, i) => pluck(this.ctx!, f, t + 0.2 + i * 0.18, 0.18, o));
  }

  fanfare() {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    const o = this.out(0, 0.7);
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      pluck(this.ctx!, f, t + i * 0.09, 0.2, o);
      this.tone("triangle", f, f, t + i * 0.09, 0.5, 0.05, o);
    });
  }
}

// ------------------------------------------------------------------ music

/**
 * Generative koto + taiko groove in the Japanese "In" scale (D Eb G A Bb).
 * Notes are scheduled slightly ahead with the audio clock for tight timing.
 */
class MusicPlayer {
  intensity = 0;
  private mode: "off" | "menu" | "game" = "off";
  private step = 0;
  private nextTime = 0;
  private timer: number | null = null;
  private bus: GainNode;
  private readonly bpm = 92;
  private melody: number[] = [];

  constructor(
    private ctx: AudioContext,
    out: AudioNode,
    reverb: AudioNode,
  ) {
    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    this.bus.connect(out);
    const send = ctx.createGain();
    send.gain.value = 0.5;
    this.bus.connect(send).connect(reverb);
    this.newPhrase();
  }

  setMode(mode: "off" | "menu" | "game") {
    if (mode === this.mode) return;
    this.mode = mode;
    const t = this.ctx.currentTime;
    this.bus.gain.cancelScheduledValues(t);
    this.bus.gain.setTargetAtTime(mode === "off" ? 0 : 1, t, mode === "off" ? 0.3 : 0.6);
    if (mode !== "off" && this.timer === null) {
      this.nextTime = this.ctx.currentTime + 0.1;
      this.timer = window.setInterval(() => this.schedule(), 50);
    }
    if (mode === "off" && this.timer !== null) {
      const timer = this.timer;
      this.timer = null;
      window.setTimeout(() => window.clearInterval(timer), 1500);
    }
  }

  private newPhrase() {
    // D minor-ish In scale across two octaves (Hz)
    const scale = [146.83, 155.56, 196.0, 220.0, 233.08, 293.66, 311.13, 392.0, 440.0, 466.16, 587.33];
    this.melody = [];
    let idx = 5;
    for (let i = 0; i < 16; i++) {
      idx = Math.max(3, Math.min(scale.length - 1, idx + Math.round((Math.random() - 0.5) * 4)));
      this.melody.push(Math.random() < 0.62 ? scale[idx] : 0);
    }
  }

  private schedule() {
    if (this.timer === null) return;
    const spb = 60 / this.bpm / 4; // 16th notes
    while (this.nextTime < this.ctx.currentTime + 0.15) {
      this.playStep(this.step, this.nextTime);
      this.nextTime += spb;
      this.step = (this.step + 1) % 64;
      if (this.step === 0) this.newPhrase();
    }
  }

  private playStep(step: number, t: number) {
    const s16 = step % 16;
    const game = this.mode === "game";
    // drone bass on the bar
    if (s16 === 0) {
      pluck(this.ctx, step % 32 === 0 ? 73.42 : 98.0, t, 1.6, this.bus, 0.22, 600);
    }
    // koto melody on 8ths (16ths when intense)
    const dense = game && this.intensity > 0.5;
    if (s16 % 2 === 0 || dense) {
      const f = this.melody[s16];
      if (f) pluck(this.ctx, f, t, 0.5, this.bus, game ? 0.08 : 0.06, 2800);
    }
    if (game) {
      // taiko pattern
      if (s16 === 0 || s16 === 10) drum(this.ctx, t, 0.55, this.bus);
      if (s16 === 4 || s16 === 12) drum(this.ctx, t, 0.3, this.bus, 180);
      if (this.intensity > 0.3 && s16 % 2 === 1) hat(this.ctx, t, 0.05, this.bus);
    } else if (s16 === 0 && step % 32 === 0) {
      drum(this.ctx, t, 0.25, this.bus);
    }
  }
}

// ------------------------------------------------------------------ synth voices

function pluck(ctx: AudioContext, f: number, t: number, dur: number, out: AudioNode, amp = 0.1, bright = 3500) {
  const o1 = ctx.createOscillator();
  const o2 = ctx.createOscillator();
  o1.type = "sawtooth";
  o2.type = "triangle";
  o1.frequency.value = f;
  o2.frequency.value = f * 1.003;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.Q.value = 2;
  lp.frequency.setValueAtTime(bright, t);
  lp.frequency.exponentialRampToValueAtTime(Math.max(200, f * 1.5), t + dur * 0.6);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(amp, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o1.connect(lp);
  o2.connect(lp);
  lp.connect(g).connect(out);
  o1.start(t);
  o2.start(t);
  o1.stop(t + dur + 0.05);
  o2.stop(t + dur + 0.05);
}

function drum(ctx: AudioContext, t: number, amp: number, out: AudioNode, f = 110) {
  const o = ctx.createOscillator();
  o.type = "sine";
  o.frequency.setValueAtTime(f, t);
  o.frequency.exponentialRampToValueAtTime(f * 0.42, t + 0.25);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(amp, t + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + 0.4);
}

let hatBuf: AudioBuffer | null = null;
function hat(ctx: AudioContext, t: number, amp: number, out: AudioNode) {
  hatBuf ??= noiseBuffer(ctx, 0.1);
  const s = ctx.createBufferSource();
  s.buffer = hatBuf;
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 7000;
  const g = ctx.createGain();
  g.gain.setValueAtTime(amp, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
  s.connect(hp).connect(g).connect(out);
  s.start(t);
  s.stop(t + 0.06);
}

function noiseBuffer(ctx: AudioContext, seconds: number) {
  const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

function crackleBuffer(ctx: AudioContext, seconds: number) {
  const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) {
    d[i] = Math.random() < 0.004 ? (Math.random() * 2 - 1) * 0.9 : (Math.random() * 2 - 1) * 0.05;
  }
  return b;
}

function impulse(ctx: AudioContext, seconds: number, decay: number) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const b = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return b;
}

function distortionCurve(k: number) {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}
