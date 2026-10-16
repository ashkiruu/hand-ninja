import { OneEuroFilter2D } from "../tracking/OneEuroFilter";

export interface TrailPoint {
  x: number;
  y: number;
  t: number;
  /** 0..1, how "hot" the blade was at this point (drives trail width/brightness). */
  heat: number;
}

export type BladeSource = "hand" | "pointer";

interface PointerSample {
  x: number;
  y: number;
  down: boolean;
  /** First sample of a new press. */
  press: boolean;
}

// How long without a detection before the blade disappears: a few detection
// intervals (measured), so slower machines don't flicker, within these bounds.
const HAND_TIMEOUT_MIN = 0.25;
const HAND_TIMEOUT_MAX = 0.8;
const TRAIL_LIFE = 0.13; // s
/** Max look-ahead for hand prediction (s). Longer leads overshoot when a swipe stops or turns. */
const MAX_LEAD = 0.05;
/** Output smoothing rate (1/s) for the hand blade: hides the camera's frame steps between detections. */
const HAND_SMOOTH_RATE = 45;
const MAX_HAND_JUMP = 0.6; // height units per frame; bigger hand jumps are tracking glitches, not swipes

/**
 * The player's blade. Works in "height units" internally (1 = screen height,
 * origin at the center, y up) so tuning is independent of resolution, and
 * exposes world-space positions for rendering and collision.
 *
 * Hand input pipeline: raw fingertip → One Euro filter → velocity estimate →
 * extrapolation to the current render time (+ a small lead to hide camera
 * latency). Pointer input is used raw, and every pointer sample between two
 * frames is queued, so fast flicks on slow machines still cut along their
 * full path.
 */
export class Blade {
  /** Head position and previous-frame head position, in world units. */
  readonly head = { x: 0, y: 0 };
  readonly prev = { x: 0, y: 0 };
  /** Normalized direction of travel this frame. */
  readonly dir = { x: 1, y: 0 };
  readonly trail: TrailPoint[] = [];

  visible = false;
  live = false;
  /** Smoothed speed in screen heights per second. */
  speed = 0;
  source: BladeSource | null = null;

  sliceSpeed = 1.5;
  predictionMs = 22;
  readonly filter = new OneEuroFilter2D();

  /** Cut segments travelled this frame, flattened [ax, ay, bx, by, ...] in world units. */
  private segs: number[] = [];
  private teleported = true;
  private filtered = { x: 0, y: 0 };
  private lastFiltered = { x: 0, y: 0 };
  private vel = { x: 0, y: 0 };
  /** Capture time of the latest hand sample (drives filtering and prediction). */
  private lastHandT = -1;
  /** When the latest hand sample arrived (drives "is the hand still there" checks). */
  private lastHandSeen = -1;
  /** Smoothed time between hand samples (s). */
  private handInterval = 1 / 30;
  private pointer = { x: 0, y: 0, t: -1, down: false };
  private samples: PointerSample[] = [];
  private pointerWasDown = false;
  private liveHold = 0;
  private smooth = { x: 0, y: 0 };

  /**
   * Feed a new fingertip sample (height units) captured at time `t` (s) and
   * delivered at time `seen` (s). They differ by the inference latency.
   */
  feedHand(hx: number, hy: number, t: number, seen = t) {
    const gap = seen - this.lastHandSeen;
    if (this.source === "hand" && gap < HAND_TIMEOUT_MAX) this.handInterval += (gap - this.handInterval) * 0.2;
    const reacquired = this.source !== "hand" || gap > this.handTimeout;
    this.lastHandSeen = seen;
    if (reacquired) {
      this.filter.reset();
      this.vel.x = this.vel.y = 0;
    }
    const prevT = this.lastHandT;
    this.filter.filter(hx, hy, t, this.filtered);
    if (!reacquired && t > prevT) {
      const dt = t - prevT;
      const vx = (this.filtered.x - this.lastFiltered.x) / dt;
      const vy = (this.filtered.y - this.lastFiltered.y) / dt;
      this.vel.x += (vx - this.vel.x) * 0.65;
      this.vel.y += (vy - this.vel.y) * 0.65;
    }
    this.lastFiltered.x = this.filtered.x;
    this.lastFiltered.y = this.filtered.y;
    this.lastHandT = t;
  }

  feedPointer(hx: number, hy: number, t: number, down: boolean) {
    this.samples.push({ x: hx, y: hy, down, press: down && !this.pointer.down });
    if (this.samples.length > 256) this.samples.shift();
    this.pointer.x = hx;
    this.pointer.y = hy;
    this.pointer.t = t;
    this.pointer.down = down;
    if (this.source !== "pointer") {
      this.source = "pointer";
      this.teleported = true;
    }
  }

  /** Advance the blade to render time `now` (s). `viewH` = world-space height of the screen. */
  update(now: number, dt: number, viewH: number) {
    this.prev.x = this.head.x;
    this.prev.y = this.head.y;
    this.segs.length = 0;

    // A fresh hand detection takes over unless the mouse button is held.
    if (this.source !== "hand" && now - this.lastHandSeen < 0.1 && !this.pointer.down && this.lastHandSeen > this.pointer.t) {
      this.source = "hand";
      this.teleported = true;
    }

    const isPointer = this.source === "pointer";
    let visible = false;
    let hx = 0;
    let hy = 0;
    if (this.source === "hand") {
      visible = now - this.lastHandSeen < this.handTimeout;
      // Predict only while the hand is clearly moving: extrapolating a slow or
      // resting hand just amplifies jitter.
      const sp = Math.hypot(this.vel.x, this.vel.y);
      const gate = Math.min(1, Math.max(0, (sp - 0.4) / 1.2));
      const lead = Math.min(MAX_LEAD, Math.max(0, now - this.lastHandT + this.predictionMs / 1000)) * gate;
      hx = this.filtered.x + this.vel.x * lead;
      hy = this.filtered.y + this.vel.y * lead;
      if (this.visible && !this.teleported) {
        const k = 1 - Math.exp(-dt * HAND_SMOOTH_RATE);
        hx = this.smooth.x + (hx - this.smooth.x) * k;
        hy = this.smooth.y + (hy - this.smooth.y) * k;
      }
      this.smooth.x = hx;
      this.smooth.y = hy;
    } else if (isPointer) {
      visible = now - this.pointer.t < 2.5 || this.pointer.down || this.samples.length > 0;
      hx = this.pointer.x;
      hy = this.pointer.y;
    }

    if (!visible) {
      this.samples.length = 0;
      this.visible = false;
      this.live = false;
      this.speed = 0;
      this.teleported = true;
      this.ageTrail(now);
      return;
    }

    this.head.x = hx * viewH;
    this.head.y = hy * viewH;

    if (!this.visible || this.teleported) {
      // (Re)appeared: start fresh with no cut across the jump.
      this.prev.x = this.head.x;
      this.prev.y = this.head.y;
      this.samples.length = 0;
      this.pointerWasDown = this.pointer.down;
      this.trail.length = 0;
      this.speed = 0;
      this.teleported = false;
      this.visible = true;
      this.live = false;
      return;
    }
    this.visible = true;

    let len = 0;
    if (isPointer) {
      // Replay every queued pointer sample; only drags (button held) cut.
      let ax = this.prev.x;
      let ay = this.prev.y;
      let aDown = this.pointerWasDown;
      for (const s of this.samples) {
        const bx = s.x * viewH;
        const by = s.y * viewH;
        if (s.press) this.trail.length = 0;
        if (s.down && aDown && !s.press) {
          this.segs.push(ax, ay, bx, by);
          len += Math.hypot(bx - ax, by - ay);
        }
        ax = bx;
        ay = by;
        aDown = s.down;
      }
      this.pointerWasDown = aDown;
      this.samples.length = 0;
    } else {
      len = Math.hypot(this.head.x - this.prev.x, this.head.y - this.prev.y);
      if (len / viewH > MAX_HAND_JUMP) {
        // Tracking glitch (e.g. jumped to another hand): don't cut across it.
        this.trail.length = 0;
        this.live = false;
        this.speed = 0;
        return;
      }
      if (len > 0) this.segs.push(this.prev.x, this.prev.y, this.head.x, this.head.y);
    }

    // Direction from the last segment (the most recent motion).
    const n = this.segs.length;
    if (n >= 4) {
      const dx = this.segs[n - 2] - this.segs[n - 4];
      const dy = this.segs[n - 1] - this.segs[n - 3];
      const d = Math.hypot(dx, dy);
      if (d > 1e-6) {
        this.dir.x = dx / d;
        this.dir.y = dy / d;
      }
    }

    const inst = len / viewH / Math.max(dt, 1e-3);
    this.speed += (inst - this.speed) * (1 - Math.exp(-dt * 30));

    const threshold = isPointer ? 0.35 : this.sliceSpeed;
    const armed = isPointer ? n > 0 : true;
    const fast = isPointer ? Math.max(this.speed, inst) : this.speed;
    if (armed && fast > threshold) {
      this.live = true;
      this.liveHold = 0.07;
    } else if (armed && this.live && fast > threshold * 0.5) {
      this.liveHold = 0.07;
    } else {
      this.liveHold -= dt;
      if (this.liveHold <= 0 || (isPointer && !this.pointer.down && n === 0)) this.live = false;
    }

    const heat = this.live ? Math.min(1, 0.55 + (this.speed - threshold) / (threshold * 2)) : 0;
    for (let i = 0; i < n; i += 4) this.trail.push({ x: this.segs[i + 2], y: this.segs[i + 3], t: now, heat });
    if (n === 0) this.trail.push({ x: this.head.x, y: this.head.y, t: now, heat });
    this.ageTrail(now);
  }

  private get handTimeout() {
    return Math.min(HAND_TIMEOUT_MAX, Math.max(HAND_TIMEOUT_MIN, this.handInterval * 3));
  }

  /** Whether the blade can cut this frame. */
  get cutting() {
    return this.visible && this.live && this.segs.length >= 4;
  }

  /** True if this frame's blade path passes within `r` of (px, py). */
  hits(px: number, py: number, r: number) {
    const r2 = r * r;
    const s = this.segs;
    for (let i = 0; i < s.length; i += 4) {
      if (segmentDistSq(s[i], s[i + 1], s[i + 2], s[i + 3], px, py) <= r2) return true;
    }
    return false;
  }

  private ageTrail(now: number) {
    let i = 0;
    while (i < this.trail.length && now - this.trail[i].t > TRAIL_LIFE) i++;
    if (i > 0) this.trail.splice(0, i);
  }
}

/** Squared distance from point P to segment AB. */
export function segmentDistSq(ax: number, ay: number, bx: number, by: number, px: number, py: number) {
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = abx * abx + aby * aby;
  let t = len2 > 0 ? ((px - ax) * abx + (py - ay) * aby) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + abx * t - px;
  const cy = ay + aby * t - py;
  return cx * cx + cy * cy;
}
