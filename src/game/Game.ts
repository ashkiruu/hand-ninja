import * as THREE from "three";
import type { Blade } from "../input/Blade";
import type { AudioEngine } from "../audio/AudioEngine";
import type { Background } from "../render/Background";
import type { Renderer } from "../render/Renderer";
import type { TimeFx } from "../core/TimeFx";
import type { Popups } from "../ui/Popups";
import { type GameMode, loadBest, saveBest } from "../settings";
import { BOMB_SIZE, type BombParts, buildBomb, type FruitAsset, getCatalogue, POWER_COLORS, type PowerUp } from "./fruitModels";
import type { World } from "./World";

interface Thrown {
  obj: THREE.Object3D;
  vel: THREE.Vector3;
  axis: THREE.Vector3;
  spin: number;
  radius: number;
  asset: FruitAsset | null; // null = bomb
  bomb?: BombParts;
  /** Thrown in from the side during frenzy; doesn't count as a miss. */
  bonus: boolean;
}

interface PendingSpawn {
  at: number;
  kind: "fruit" | "bomb" | PowerUp;
  side?: -1 | 1;
}

export interface GameResult {
  mode: GameMode;
  reason: "bomb" | "misses" | "time";
  score: number;
  best: number;
  newBest: boolean;
  sliced: number;
  thrown: number;
  maxCombo: number;
  criticals: number;
  bombs: number;
  duration: number;
}

export type GameState = "countdown" | "playing" | "ending" | "done";

const ARCADE_TIME = 60;
const MAX_MISSES = 3;
const POWER_TIME: Record<PowerUp, number> = { freeze: 5, frenzy: 5, double: 7 };

export interface GameDeps {
  world: World;
  renderer: Renderer;
  audio: AudioEngine;
  popups: Popups;
  time: TimeFx;
  background: Background;
  flash: (strength: number) => void;
  onEnd: (r: GameResult) => void;
}

export class Game {
  readonly mode: GameMode;
  state: GameState = "countdown";
  score = 0;
  misses = 0;
  timeLeft = ARCADE_TIME;
  readonly best: number;
  readonly power: Record<PowerUp, number> = { freeze: 0, frenzy: 0, double: 0 };

  private thrown: Thrown[] = [];
  private pending: PendingSpawn[] = [];
  private elapsed = 0;
  private countdown = 1.9;
  private countdownStage = 0;
  private waveTimer = 0.4;
  private frenzyTimer = 0;
  private endTimer = 0;
  private endReason: GameResult["reason"] = "misses";
  private swipe = { count: 0, x: 0, y: 0, idle: 0 };
  private stats = { sliced: 0, thrown: 0, maxCombo: 0, criticals: 0, bombs: 0 };
  private catalogue = getCatalogue();
  private fuseActive = false;
  private dangerPulse = 0;

  constructor(
    mode: GameMode,
    private deps: GameDeps,
  ) {
    this.mode = mode;
    this.best = loadBest(mode);
    deps.world.gravity = deps.renderer.viewH * 1.05;
  }

  get isFrozen() {
    return this.power.freeze > 0;
  }

  /** Called every frame. `realDt` is wall time, `dt` is scaled game time. */
  update(realDt: number, dt: number, blade: Blade) {
    const { renderer, world } = this.deps;
    const g = renderer.viewH * 1.05;
    world.gravity = g;

    if (this.state === "countdown") this.updateCountdown(realDt);

    const simDt = dt * (this.isFrozen ? 0.4 : 1);

    if (this.state === "playing") {
      this.elapsed += simDt;
      this.updateSpawning(simDt);
      if (this.mode === "arcade" && !this.isFrozen) {
        this.timeLeft = Math.max(0, this.timeLeft - realDt);
        if (this.timeLeft <= 0) this.finish("time", 2.2);
      }
    }

    for (const k of Object.keys(this.power) as PowerUp[]) {
      if (this.power[k] > 0) this.power[k] = Math.max(0, this.power[k] - realDt);
    }
    this.deps.background.freeze = Math.min(1, this.power.freeze * 2);

    // --- physics
    for (const t of this.thrown) {
      t.vel.y -= g * simDt;
      t.obj.position.addScaledVector(t.vel, simDt);
      t.obj.rotateOnWorldAxis(t.axis, t.spin * simDt);
      if (t.bomb) this.animateBomb(t, realDt);
    }

    // --- slicing
    if (blade.cutting && (this.state === "playing" || (this.state === "ending" && this.endReason === "time"))) {
      this.handleCuts(blade);
    }

    // --- swipe / combo bookkeeping
    if (blade.live) {
      this.swipe.idle = 0;
    } else {
      this.swipe.idle += realDt;
      if (this.swipe.count > 0 && this.swipe.idle > 0.12) this.endSwipe();
    }

    // --- off-screen
    const bottom = -renderer.viewH / 2 - 2;
    const sideLimit = renderer.viewW / 2 + 4;
    for (let i = this.thrown.length - 1; i >= 0; i--) {
      const t = this.thrown[i];
      const p = t.obj.position;
      if ((p.y < bottom && t.vel.y < 0) || Math.abs(p.x) > sideLimit) {
        world.root.remove(t.obj);
        this.thrown.splice(i, 1);
        if (t.asset && !t.asset.power && !t.bonus && this.mode === "classic" && this.state === "playing") this.miss(p.x);
      }
    }

    // --- bomb ambience
    const hasBomb = this.thrown.some((t) => t.bomb);
    if (hasBomb !== this.fuseActive) {
      this.fuseActive = hasBomb;
      if (hasBomb) this.deps.audio.startFuse();
      else this.deps.audio.stopFuse();
    }
    this.dangerPulse += realDt;
    this.deps.background.danger = hasBomb ? 0.5 + 0.5 * Math.sin(this.dangerPulse * 8) : 0;

    // --- ending
    if (this.state === "ending") {
      this.endTimer -= realDt;
      if (this.endTimer <= 0) this.complete();
    }

    const intensity = this.mode === "arcade" ? 0.4 + (1 - this.timeLeft / ARCADE_TIME) * 0.6 : Math.min(1, this.elapsed / 60);
    this.deps.audio.setMusicIntensity(this.state === "playing" ? intensity : 0);
  }

  private updateCountdown(realDt: number) {
    const { popups, audio } = this.deps;
    this.countdown -= realDt;
    if (this.countdownStage === 0) {
      this.countdownStage = 1;
      popups.banner(`<span>Ready?</span>`, "ready", 0.55);
      audio.countdown(false);
    }
    if (this.countdown < 0.75 && this.countdownStage === 1) {
      this.countdownStage = 2;
      popups.banner(`<span>Slice!</span>`, "go", 0.35);
      audio.countdown(true);
    }
    if (this.countdown <= 0) this.state = "playing";
  }

  // ------------------------------------------------------------------ spawning

  private updateSpawning(dt: number) {
    const ramp = this.mode === "arcade" ? 40 : 100;
    const d = Math.min(1, this.elapsed / ramp);

    this.waveTimer -= dt;
    if (this.waveTimer <= 0 && this.pending.length === 0) {
      this.waveTimer = this.scheduleWave(d);
    }

    if (this.power.frenzy > 0) {
      this.frenzyTimer -= dt;
      if (this.frenzyTimer <= 0) {
        this.frenzyTimer = 0.13;
        this.spawn({ at: 0, kind: "fruit", side: Math.random() < 0.5 ? -1 : 1 });
      }
    }

    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      p.at -= dt;
      if (p.at <= 0) {
        this.pending.splice(i, 1);
        this.spawn(p);
      }
    }
  }

  /** Queues one wave; returns the delay before the next wave. */
  private scheduleWave(d: number): number {
    const arcade = this.mode === "arcade";
    const r = Math.random();
    const maxFruit = Math.round(1 + d * 4 + (arcade ? 1 : 0));
    const count = 1 + Math.floor(Math.random() * maxFruit);
    let pattern: "burst" | "stagger" | "single";
    if (count === 1) pattern = "single";
    else pattern = r < 0.55 ? "burst" : "stagger";

    const gap = pattern === "stagger" ? 0.16 + Math.random() * 0.1 : 0;
    for (let i = 0; i < count; i++) this.pending.push({ at: i * gap + Math.random() * 0.06, kind: "fruit" });

    const bombChance = arcade ? 0.25 + d * 0.25 : this.elapsed < 6 ? 0 : 0.14 + d * 0.3;
    if (Math.random() < bombChance) {
      const bombs = d > 0.6 && Math.random() < 0.35 ? 2 : 1;
      for (let i = 0; i < bombs; i++) this.pending.push({ at: Math.random() * (count * gap + 0.2), kind: "bomb" });
    }

    const powerActive = this.power.freeze > 0 || this.power.frenzy > 0 || this.power.double > 0;
    if (arcade && !powerActive && this.elapsed > 4 && Math.random() < 0.2) {
      const kinds: PowerUp[] = ["freeze", "frenzy", "double"];
      this.pending.push({ at: Math.random() * 0.3, kind: kinds[Math.floor(Math.random() * kinds.length)] });
    }

    const base = arcade ? 1.7 - d * 0.75 : 2.3 - d * 1.15;
    return base + count * gap;
  }

  private spawn(p: PendingSpawn) {
    const { renderer, world } = this.deps;
    const W = renderer.viewW;
    const H = renderer.viewH;
    const g = H * 1.05;

    let obj: THREE.Object3D;
    let asset: FruitAsset | null = null;
    let radius: number;
    let bomb: BombParts | undefined;
    if (p.kind === "bomb") {
      obj = buildBomb();
      radius = BOMB_SIZE * 1.05;
      bomb = obj.userData.parts as BombParts;
    } else if (p.kind === "fruit") {
      const list = this.catalogue.fruits;
      asset = list[Math.floor(Math.random() * list.length)];
      obj = asset.whole();
      radius = asset.hitRadius;
      this.stats.thrown++;
    } else {
      asset = this.catalogue.bananas[p.kind];
      obj = asset.whole();
      radius = asset.hitRadius;
    }

    const vel = new THREE.Vector3();
    if (p.side) {
      // frenzy: thrown in from the side
      obj.position.set(p.side * (W / 2 + 1.2), -H * (0.05 + Math.random() * 0.3), 0);
      vel.set(-p.side * H * (0.45 + Math.random() * 0.3), H * (0.5 + Math.random() * 0.35), 0);
    } else {
      const y0 = -H / 2 - 1.4;
      const x0 = (Math.random() - 0.5) * W * 0.8;
      const apex = H * (0.1 + Math.random() * 0.3);
      const vy = Math.sqrt(2 * g * (apex - y0));
      const tApex = vy / g;
      const xt = THREE.MathUtils.clamp(x0 + (Math.random() - 0.5) * W * 0.55, -W * 0.38, W * 0.38);
      obj.position.set(x0, y0, (Math.random() - 0.5) * 0.6);
      vel.set((xt - x0) / tApex, vy, 0);
    }
    obj.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    const axis = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    world.root.add(obj);
    this.thrown.push({ obj, vel, axis, spin: (Math.random() < 0.5 ? -1 : 1) * (1 + Math.random() * 2.5), radius, asset, bomb, bonus: !!p.side });
  }

  // ------------------------------------------------------------------ cutting

  private handleCuts(blade: Blade) {
    const { world, audio, renderer, time, popups } = this.deps;
    const slack = 0.12 * (renderer.viewH / 14.5);
    let whooshed = false;

    for (let i = this.thrown.length - 1; i >= 0; i--) {
      const t = this.thrown[i];
      const p = t.obj.position;
      if (!blade.hits(p.x, p.y, t.radius + slack)) continue;

      this.thrown.splice(i, 1);
      const pan = p.x / (renderer.viewW / 2);
      if (!whooshed) {
        audio.whoosh(blade.speed, pan);
        whooshed = true;
      }

      if (!t.asset) {
        this.hitBomb(t);
        continue;
      }

      world.slice(t.asset, t.obj, t.vel, { dx: blade.dir.x, dy: blade.dir.y, speed: blade.speed });
      audio.slice(pan);
      time.hitStop(0.035);
      renderer.addTrauma(0.12);

      if (t.asset.power) {
        this.activatePower(t.asset.power, p.x, p.y);
        continue;
      }

      const mult = this.power.double > 0 ? 2 : 1;
      let gained = 1 * mult;
      this.stats.sliced++;

      if (blade.speed > 2.4 && Math.random() < 0.08) {
        gained += 10 * mult;
        this.stats.criticals++;
        time.hitStop(0.09);
        renderer.addTrauma(0.3);
        renderer.pulseChroma(0.6);
        world.sparks(p.x, p.y, new THREE.Color("#ff5a3c"), 40, 12);
        audio.critical(pan);
        popups.text(p.x, p.y + 0.8, `Critical! <b>+${10 * mult}</b>`, "critical");
      }
      this.addScore(gained);

      this.swipe.count++;
      this.swipe.x += p.x;
      this.swipe.y += p.y;
    }
  }

  private endSwipe() {
    const n = this.swipe.count;
    if (n >= 3) {
      const { popups, audio, time, renderer } = this.deps;
      const mult = this.power.double > 0 ? 2 : 1;
      const bonus = n * mult;
      this.addScore(bonus);
      this.stats.maxCombo = Math.max(this.stats.maxCombo, n);
      popups.text(this.swipe.x / n, this.swipe.y / n + 1, `<small>${n} fruit</small>Combo <b>+${bonus}</b>`, `combo combo-${Math.min(n, 6)}`, { dur: 1.3 });
      audio.combo(n);
      renderer.addTrauma(0.15 + n * 0.04);
      if (n >= 4) time.slowMo(0.3, 0.35);
    } else if (n > 0) {
      this.stats.maxCombo = Math.max(this.stats.maxCombo, n);
    }
    this.swipe.count = 0;
    this.swipe.x = 0;
    this.swipe.y = 0;
  }

  private hitBomb(t: Thrown) {
    const { world, audio, renderer, time, popups, flash } = this.deps;
    const p = t.obj.position.clone();
    world.root.remove(t.obj);
    world.explosion(p.x, p.y);
    renderer.shockwave(p.x, p.y);
    renderer.addTrauma(1);
    renderer.pulseChroma(1);
    audio.explosion();
    this.stats.bombs++;

    if (this.mode === "classic") {
      flash(1);
      time.slowMo(0.12, 0.9);
      this.finish("bomb", 1.8);
    } else {
      flash(0.55);
      time.hitStop(0.12);
      const lost = Math.min(this.score, 10);
      this.score -= lost;
      popups.text(p.x, p.y + 0.6, `Bomb! <b>−${lost}</b>`, "bomb");
    }
  }

  private activatePower(kind: PowerUp, x: number, y: number) {
    const { popups, audio, world, renderer } = this.deps;
    this.power[kind] = POWER_TIME[kind];
    const labels: Record<PowerUp, string> = { freeze: "Freeze", frenzy: "Frenzy", double: "Double Score" };
    popups.banner(`<span>${labels[kind]}!</span>`, `power power-${kind}`, 0.6);
    world.sparks(x, y, new THREE.Color(POWER_COLORS[kind]), 70, 14, 3.5);
    renderer.addTrauma(0.25);
    audio.powerUp(kind);
    if (kind === "frenzy") this.frenzyTimer = 0;
  }

  private animateBomb(t: Thrown, dt: number) {
    const b = t.bomb!;
    const flicker = 0.7 + Math.random() * 0.6;
    b.spark.scale.setScalar(0.9 * flicker);
    (b.halo.material as THREE.SpriteMaterial).opacity = 0.35 + 0.3 * Math.sin(this.dangerPulse * 9);
    if (Math.random() < dt * 40) {
      const wp = b.fuseTip.getWorldPosition(_tmp);
      this.deps.world.sparks(wp.x, wp.y, _spark, 1, 3, 3);
    }
  }

  private addScore(n: number) {
    this.score += n;
  }

  private miss(x: number) {
    this.misses++;
    this.deps.popups.missMark(x);
    this.deps.audio.miss();
    this.deps.renderer.addTrauma(0.2);
    if (this.misses >= MAX_MISSES) this.finish("misses", 1.4);
  }

  private finish(reason: GameResult["reason"], delay: number) {
    if (this.state !== "playing") return;
    this.state = "ending";
    this.endReason = reason;
    this.endTimer = delay;
    this.pending.length = 0;
    this.power.frenzy = 0;
    if (reason === "time") this.deps.popups.banner(`<span>Time's up!</span>`, "over", 1.2);
    if (reason === "misses") this.deps.popups.banner(`<span>Game Over</span>`, "over", 0.9);
  }

  private complete() {
    this.state = "done";
    if (this.swipe.count > 0) this.endSwipe();
    const newBest = this.score > this.best;
    if (newBest) saveBest(this.mode, this.score);
    this.deps.onEnd({
      mode: this.mode,
      reason: this.endReason,
      score: this.score,
      best: Math.max(this.best, this.score),
      newBest,
      sliced: this.stats.sliced,
      thrown: this.stats.thrown,
      maxCombo: this.stats.maxCombo,
      criticals: this.stats.criticals,
      bombs: this.stats.bombs,
      duration: this.elapsed,
    });
  }

  /** Remove everything this game put in the scene. */
  dispose() {
    for (const t of this.thrown) this.deps.world.root.remove(t.obj);
    this.thrown.length = 0;
    this.deps.audio.stopFuse();
    this.deps.background.danger = 0;
    this.deps.background.freeze = 0;
  }
}

const _tmp = new THREE.Vector3();
const _spark = new THREE.Color("#ffc46b");
