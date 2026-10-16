// Runs MediaPipe hand tracking off the main thread so inference never stalls
// rendering. The main thread posts one camera frame at a time (an
// ImageBitmap of the displayed video frame); results come back tagged with
// that frame's capture time.
//
// With the "auto" preference the worker loads the model on both the CPU and
// the GPU, alternates between them on the first real camera frames, keeps
// whichever is faster on this device, and closes the other.

import type { HandLandmarker } from "@mediapipe/tasks-vision";
import { implausible, handScale, type SanityState } from "./handSanity";
import { type Delegate, type DelegatePref, loadVision, makeLandmarker, type Point3 } from "./landmarkerOptions";

export type WorkerRequest =
  | { type: "init"; wasmBase: string; modelPath: string; pref: DelegatePref }
  | { type: "frame"; frame: ImageBitmap; t: number };

export type Bench = { cpu?: number; gpu?: number };

export type WorkerResponse =
  | { type: "ready"; delegate: Delegate; choosing: boolean }
  | { type: "chosen"; delegate: Delegate; bench: Bench }
  | { type: "error"; message: string }
  | { type: "result"; t: number; landmarks: Point3[] | null; ms: number; rejected?: string };

interface Runner {
  lm: HandLandmarker;
  delegate: Delegate;
  lastTs: number;
  times: number[];
}

/** Real frames used to compare the delegates (alternating). */
const TRIAL_FRAMES = 40;
/** Stop the trial early once one delegate is this many times slower (it would just add lag). */
const TRIAL_CLEAR_RATIO = 2;
/** Never let the trial run longer than this (ms). */
const TRIAL_MAX_MS = 5000;
/** Frames per delegate ignored at the start of the trial (lazy init, caches). */
const TRIAL_SKIP = 3;
/**
 * The GPU must be clearly faster to win: it is also busy rendering the game,
 * and sharing it has costs (synchronous read-backs, contention) that a
 * per-inference timing doesn't show.
 */
const GPU_ADVANTAGE = 0.75;

const ctx = self as unknown as {
  postMessage(msg: WorkerResponse): void;
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
};
let runners: Runner[] = [];
let chosen: Runner | null = null;
let trialCount = 0;
let trialStart = 0;
let lastHand: SanityState | null = null;

const reply = (msg: WorkerResponse) => ctx.postMessage(msg);

ctx.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === "init") {
    try {
      const fileset = await loadVision(msg.wasmBase, true);
      const order: Delegate[] = msg.pref === "gpu" ? ["GPU", "CPU"] : ["CPU", "GPU"];
      for (const delegate of order) {
        const lm = await makeLandmarker(fileset, msg.modelPath, delegate, true);
        if (lm) runners.push({ lm, delegate, lastTs: 0, times: [] });
        // A forced preference only needs one working delegate.
        if (msg.pref !== "auto" && runners.length) break;
      }
      if (!runners.length) throw new Error("Hand tracking could not start on this device.");
      if (runners.length === 1) chosen = runners[0];
      reply({ type: "ready", delegate: runners[0].delegate, choosing: !chosen });
      if (chosen) reply({ type: "chosen", delegate: chosen.delegate, bench: {} });
    } catch (err) {
      reply({ type: "error", message: (err as Error)?.message ?? String(err) });
    }
    return;
  }

  const { frame, t } = msg;
  const runner = chosen ?? runners[trialCount++ % runners.length];
  const t0 = performance.now();
  const aspect = frame.width / frame.height;
  let landmarks: Point3[] | null = null;
  let rejected: string | undefined;
  try {
    // MediaPipe needs strictly increasing timestamps (per landmarker).
    const ts = Math.max(runner.lastTs + 1, t);
    runner.lastTs = ts;
    const lm = runner.lm.detectForVideo(frame, ts).landmarks?.[0];
    if (lm) {
      const pts = lm.map((p) => ({ x: p.x, y: p.y, z: p.z }));
      rejected = implausible(pts, aspect, t, lastHand) ?? undefined;
      if (!rejected) {
        landmarks = pts;
        lastHand = { scale: handScale(pts, aspect), t };
      }
    }
  } catch (err) {
    console.warn("[hand worker] detect failed", err);
  } finally {
    frame.close();
  }
  const ms = performance.now() - t0;
  reply({ type: "result", t, landmarks, ms, rejected });

  if (!chosen) {
    if (trialStart === 0) trialStart = t0;
    runner.times.push(ms);
    if (trialDone(t0)) choose();
  }
};

function trialDone(now: number) {
  if (trialCount >= TRIAL_FRAMES) return true;
  const enough = (n: number) => runners.every((r) => r.times.length >= TRIAL_SKIP + n);
  if (now - trialStart > TRIAL_MAX_MS && enough(1)) return true;
  if (!enough(3)) return false;
  const [a, b] = runners.map((r) => median(r.times));
  return Math.max(a, b) > TRIAL_CLEAR_RATIO * Math.min(a, b);
}

function median(xs: number[]) {
  const s = xs.slice(TRIAL_SKIP).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : Infinity;
}

function choose() {
  const cpu = runners.find((r) => r.delegate === "CPU");
  const gpu = runners.find((r) => r.delegate === "GPU");
  const cpuMs = cpu ? median(cpu.times) : Infinity;
  const gpuMs = gpu ? median(gpu.times) : Infinity;
  chosen = gpu && (!cpu || gpuMs < cpuMs * GPU_ADVANTAGE) ? gpu : cpu ?? gpu!;
  for (const r of runners) if (r !== chosen) r.lm.close();
  runners = [chosen];
  reply({ type: "chosen", delegate: chosen.delegate, bench: { cpu: cpuMs, gpu: gpuMs } });
}
