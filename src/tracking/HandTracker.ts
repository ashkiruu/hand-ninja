import type { HandLandmarker } from "@mediapipe/tasks-vision";
import { createHandLandmarker, type DelegatePref, type Point3 } from "./landmarkerOptions";
import type { Bench, WorkerRequest, WorkerResponse } from "./handWorker";

export interface HandFrame {
  /** performance.now() / 1000 when the camera frame was captured for detection */
  t: number;
  /** Landmarks of the first hand (normalized to the raw, un-mirrored video frame), or null if no hand. */
  landmarks: Point3[] | null;
}

export type TrackerStatus = "idle" | "camera" | "model" | "ready" | "no-camera" | "error";

/** Frames sent to the worker are downscaled to this width; MediaPipe's own inputs are ≤ 224 px. */
const WORKER_FRAME_WIDTH = 960;
/**
 * When CPU inference is this slow (ms), a second CPU worker takes alternate
 * camera frames. Latency per frame is unchanged but the tracking rate roughly
 * doubles, which makes the blade much smoother. Needs a 4+ core CPU.
 */
const HELPER_MIN_MS = 40;

interface Slot {
  worker: Worker;
  busy: boolean;
}

/**
 * Webcam + MediaPipe HandLandmarker.
 *
 * Preferred path: detection runs in a Web Worker. Each new camera frame is
 * captured as an ImageBitmap and transferred to the worker, one frame in
 * flight at a time (newer frames are skipped while busy, which keeps latency
 * minimal). Rendering never waits for inference.
 *
 * Fallback path (no module workers / OffscreenCanvas, or the worker failed to
 * start): detection runs synchronously on the main thread once per new frame.
 *
 * Either way, results are stamped with the frame's capture time so the blade's
 * prediction compensates for inference latency.
 */
export class HandTracker {
  readonly video: HTMLVideoElement;
  status: TrackerStatus = "idle";
  error = "";
  delegate: "GPU" | "CPU" | "" = "";
  mode: "worker" | "main" | "" = "";
  /** Median ms per inference on real frames, from automatic CPU/GPU selection. */
  bench: Bench = {};
  /** True while the worker is still comparing CPU and GPU. */
  choosing = false;
  inferenceMs = 0;
  detectFps = 0;
  latest: HandFrame | null = null;
  /** performance.now() when `latest` arrived. */
  latestAt = 0;

  private landmarker: HandLandmarker | null = null;
  private slots: Slot[] = [];
  private lastDeliveredT = -1;
  private paths = { wasmBase: "", modelPath: "" };
  private useVideoFrame = typeof VideoFrame !== "undefined";
  private inbox: HandFrame | null = null;
  private lastVideoTime = -1;
  private fpsFrames = 0;
  private fpsStart = 0;

  constructor(video: HTMLVideoElement) {
    this.video = video;
  }

  get videoAspect() {
    return this.video.videoWidth && this.video.videoHeight ? this.video.videoWidth / this.video.videoHeight : 16 / 9;
  }

  get ready() {
    return this.status === "ready";
  }

  async startCamera(): Promise<boolean> {
    this.status = "camera";
    if (!navigator.mediaDevices?.getUserMedia) {
      this.status = "no-camera";
      this.error = "This browser has no camera API (use https or localhost).";
      return false;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: "user",
          // 960×540: enough pixels that a hand at arm's length still gives
          // MediaPipe's 224 px landmark crop real detail, without the cost of
          // 720p. 30 fps rather than 60: in high-fps modes webcams cap the
          // exposure time, so in ordinary indoor light the image gets darker
          // and noisier, and detection gets less reliable.
          width: { ideal: 960 },
          height: { ideal: 540 },
          frameRate: { ideal: 30 },
        },
      });
      this.video.srcObject = stream;
      this.video.muted = true;
      this.video.playsInline = true;
      await this.video.play();
      if (this.video.readyState < 2) {
        await new Promise<void>((resolve) => this.video.addEventListener("loadeddata", () => resolve(), { once: true }));
      }
      return true;
    } catch (e) {
      const err = e as DOMException;
      this.status = "no-camera";
      this.error =
        err?.name === "NotAllowedError"
          ? "Camera permission was denied."
          : err?.name === "NotFoundError"
            ? "No camera was found."
            : `Camera error: ${err?.message ?? err}`;
      return false;
    }
  }

  async loadModel(): Promise<boolean> {
    this.status = "model";
    const wasmBase = new URL("mediapipe/wasm", document.baseURI).href;
    const modelPath = new URL("models/hand_landmarker.task", document.baseURI).href;
    // Diagnostics / escape hatches: ?delegate=cpu|gpu|auto, ?thread=main
    const params = new URLSearchParams(location.search);
    const asked = params.get("delegate")?.toLowerCase();
    const pref: DelegatePref | null = asked === "cpu" || asked === "gpu" || asked === "auto" ? asked : null;
    const forceMain = params.get("thread")?.toLowerCase() === "main";

    // In the worker, "auto" compares CPU and GPU on real frames and keeps the
    // faster one (the CPU unless the GPU is clearly faster).
    this.paths = { wasmBase, modelPath };
    const slot = !forceMain && workerSupported() ? await this.startWorker(pref ?? "auto", true) : null;
    if (slot) {
      this.slots.push(slot);
      this.mode = "worker";
      this.status = "ready";
      return true;
    }

    try {
      // On the main thread a slow CPU inference would block rendering, so prefer the GPU there.
      const res = await createHandLandmarker(wasmBase, modelPath, false, pref === "cpu" ? "CPU" : "GPU");
      this.landmarker = res.landmarker;
      this.delegate = res.delegate;
      this.mode = "main";
      this.status = "ready";
      return true;
    } catch (e) {
      console.error(e);
      this.status = "error";
      this.error = `Could not load the hand model: ${(e as Error)?.message ?? e}`;
      return false;
    }
  }

  get workerCount() {
    return this.slots.length;
  }

  /** Starts a tracking worker. The primary one reports the delegate choice; helpers only add throughput. */
  private startWorker(pref: DelegatePref, primary: boolean): Promise<Slot | null> {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./handWorker.ts", import.meta.url), { type: "module" });
    } catch (e) {
      console.warn("[HandTracker] could not create worker, using main thread", e);
      return Promise.resolve(null);
    }
    const { wasmBase, modelPath } = this.paths;
    return new Promise<Slot | null>((resolve) => {
      const fail = (why: unknown) => {
        console.warn(`[HandTracker] ${primary ? "worker unavailable, using main thread" : "helper worker unavailable"}:`, why);
        worker.terminate();
        resolve(null);
      };
      const timer = window.setTimeout(() => fail("timed out loading the model"), 45000);
      worker.onerror = (e) => {
        window.clearTimeout(timer);
        fail(e.message || e);
      };
      worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const msg = e.data;
        if (msg.type === "ready") {
          window.clearTimeout(timer);
          const slot: Slot = { worker, busy: false };
          if (primary) {
            this.delegate = msg.delegate;
            this.choosing = msg.choosing;
          }
          worker.onmessage = (ev: MessageEvent<WorkerResponse>) => this.onWorkerMessage(slot, ev.data, primary);
          worker.onerror = (ev) => console.warn("[HandTracker] worker error", ev.message);
          resolve(slot);
        } else if (msg.type === "error") {
          window.clearTimeout(timer);
          fail(msg.message);
        }
      };
      worker.postMessage({ type: "init", wasmBase, modelPath, pref } satisfies WorkerRequest);
    });
  }

  private onWorkerMessage(slot: Slot, msg: WorkerResponse, primary: boolean) {
    if (msg.type === "chosen") {
      if (!primary) return;
      this.delegate = msg.delegate;
      this.bench = msg.bench;
      this.choosing = false;
      this.maybeAddHelper();
      return;
    }
    if (msg.type !== "result") return;
    slot.busy = false;
    this.inferenceMs += (msg.ms - this.inferenceMs) * 0.1;
    this.countFrame();
    // With two workers, results can arrive out of order: keep only newer ones.
    if (msg.t <= this.lastDeliveredT) return;
    this.lastDeliveredT = msg.t;
    this.inbox = { t: msg.t / 1000, landmarks: msg.landmarks };
  }

  private async maybeAddHelper() {
    const cores = navigator.hardwareConcurrency ?? 2;
    if (this.delegate !== "CPU" || (this.bench.cpu ?? 0) < HELPER_MIN_MS || cores < 4 || this.slots.length !== 1) return;
    const helper = await this.startWorker("cpu", false);
    if (helper) this.slots.push(helper);
  }

  /**
   * Call once per render frame. Kicks off detection on a new camera frame if
   * possible and returns a newly finished result, or null if there is none.
   */
  update(nowMs: number): HandFrame | null {
    if (this.status !== "ready" || this.video.readyState < 2) return null;
    return this.slots.length ? this.updateWorker(nowMs) : this.updateMain(nowMs);
  }

  private updateWorker(nowMs: number): HandFrame | null {
    // Never queue a frame on a busy worker: a backlog of stale frames would
    // only add latency. New camera frames go to an idle worker, if any.
    const vt = this.video.currentTime;
    const slot = vt !== this.lastVideoTime ? this.slots.find((s) => !s.busy) : undefined;
    if (slot) {
      this.lastVideoTime = vt;
      slot.busy = true;
      if (!this.sendVideoFrame(slot, nowMs)) this.sendBitmap(slot, nowMs);
    }
    const res = this.inbox;
    this.inbox = null;
    if (res) {
      this.latest = res;
      this.latestAt = performance.now();
    }
    return res;
  }

  /** Zero-copy path: wrap the current camera frame in a VideoFrame and transfer it. */
  private sendVideoFrame(slot: Slot, nowMs: number) {
    if (!this.useVideoFrame) return false;
    let frame: VideoFrame | null = null;
    try {
      frame = new VideoFrame(this.video, { timestamp: Math.round(nowMs * 1000) });
      slot.worker.postMessage({ type: "frame", frame, t: nowMs } satisfies WorkerRequest, [frame]);
      return true;
    } catch (e) {
      console.warn("[HandTracker] VideoFrame transfer unsupported, using ImageBitmap", e);
      frame?.close();
      this.useVideoFrame = false;
      return false;
    }
  }

  private sendBitmap(slot: Slot, nowMs: number) {
    const w = this.video.videoWidth;
    const h = this.video.videoHeight;
    const scale = Math.min(1, WORKER_FRAME_WIDTH / w);
    const opts: ImageBitmapOptions = scale < 1 ? { resizeWidth: Math.round(w * scale), resizeHeight: Math.round(h * scale), resizeQuality: "low" } : {};
    createImageBitmap(this.video, opts)
      .then((frame) => slot.worker.postMessage({ type: "frame", frame, t: nowMs } satisfies WorkerRequest, [frame]))
      .catch(() => (slot.busy = false));
  }

  private updateMain(nowMs: number): HandFrame | null {
    if (!this.landmarker) return null;
    const vt = this.video.currentTime;
    if (vt === this.lastVideoTime) return null;
    this.lastVideoTime = vt;

    let landmarks: Point3[] | null = null;
    try {
      landmarks = this.landmarker.detectForVideo(this.video, nowMs).landmarks?.[0] ?? null;
    } catch (e) {
      console.warn("[HandTracker] detect failed", e);
      return null;
    }
    this.inferenceMs += (performance.now() - nowMs - this.inferenceMs) * 0.1;
    this.countFrame();
    this.latest = { t: nowMs / 1000, landmarks };
    this.latestAt = performance.now();
    return this.latest;
  }

  private countFrame() {
    const now = performance.now();
    this.fpsFrames++;
    if (now - this.fpsStart > 1000) {
      this.detectFps = (this.fpsFrames * 1000) / (now - this.fpsStart);
      this.fpsFrames = 0;
      this.fpsStart = now;
    }
  }
}

function workerSupported() {
  return typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap === "function";
}

/** MediaPipe hand skeleton connections (pairs of landmark indices). */
export const HAND_CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];
