import type { HandLandmarker } from "@mediapipe/tasks-vision";
import { createHandLandmarker, type DelegatePref, type Point3 } from "./landmarkerOptions";
import type { WorkerRequest, WorkerResponse } from "./handWorker";

export interface HandFrame {
  /** performance.now() / 1000 when the camera frame was captured for detection */
  t: number;
  /** Landmarks of the first hand (normalized to the raw, un-mirrored video frame), or null if no hand. */
  landmarks: Point3[] | null;
}

export type TrackerStatus = "idle" | "camera" | "model" | "ready" | "no-camera" | "error";

/** Frames sent to the worker are downscaled to this width; MediaPipe's own inputs are ≤ 224 px. */
const WORKER_FRAME_WIDTH = 640;

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
  /** Delegate benchmark (ms per inference) from automatic selection. */
  bench: { cpu?: number; gpu?: number } = {};
  inferenceMs = 0;
  detectFps = 0;
  latest: HandFrame | null = null;
  /** performance.now() when `latest` arrived. */
  latestAt = 0;

  private landmarker: HandLandmarker | null = null;
  private worker: Worker | null = null;
  private busy = false;
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
          // MediaPipe works on ≤ 224 px crops, so 640×360 loses nothing for
          // tracking, and webcams can usually deliver it at a higher frame
          // rate (= lower latency) than 720p.
          width: { ideal: 640 },
          height: { ideal: 360 },
          frameRate: { ideal: 60 },
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

    // In the worker, "auto" benchmarks and usually picks the CPU so the GPU
    // stays free for rendering.
    if (!forceMain && workerSupported() && (await this.startWorker(wasmBase, modelPath, pref ?? "auto"))) {
      this.mode = "worker";
      this.status = "ready";
      return true;
    }

    try {
      // On the main thread a slow CPU inference would block rendering, so prefer the GPU there.
      const res = await createHandLandmarker(wasmBase, modelPath, false, pref ?? "gpu");
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

  private startWorker(wasmBase: string, modelPath: string, pref: DelegatePref): Promise<boolean> {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./handWorker.ts", import.meta.url), { type: "module" });
    } catch (e) {
      console.warn("[HandTracker] could not create worker, using main thread", e);
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      const fail = (why: unknown) => {
        console.warn("[HandTracker] worker unavailable, using main thread:", why);
        worker.terminate();
        resolve(false);
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
          this.worker = worker;
          this.delegate = msg.delegate;
          this.bench = msg.bench;
          worker.onmessage = (ev: MessageEvent<WorkerResponse>) => this.onWorkerMessage(ev.data);
          worker.onerror = (ev) => console.warn("[HandTracker] worker error", ev.message);
          resolve(true);
        } else if (msg.type === "error") {
          window.clearTimeout(timer);
          fail(msg.message);
        }
      };
      worker.postMessage({ type: "init", wasmBase, modelPath, pref } satisfies WorkerRequest);
    });
  }

  private onWorkerMessage(msg: WorkerResponse) {
    if (msg.type !== "result") return;
    this.busy = false;
    this.inferenceMs += (msg.ms - this.inferenceMs) * 0.1;
    this.countFrame();
    this.inbox = { t: msg.t / 1000, landmarks: msg.landmarks };
  }

  /**
   * Call once per render frame. Kicks off detection on a new camera frame if
   * possible and returns a newly finished result, or null if there is none.
   */
  update(nowMs: number): HandFrame | null {
    if (this.status !== "ready" || this.video.readyState < 2) return null;
    return this.worker ? this.updateWorker(nowMs) : this.updateMain(nowMs);
  }

  private updateWorker(nowMs: number): HandFrame | null {
    // Never queue a second frame while one is in flight: a backlog of stale
    // frames would only add latency.
    const vt = this.video.currentTime;
    if (!this.busy && vt !== this.lastVideoTime) {
      this.lastVideoTime = vt;
      this.busy = true;
      if (!this.sendVideoFrame(nowMs)) this.sendBitmap(nowMs);
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
  private sendVideoFrame(nowMs: number) {
    if (!this.useVideoFrame || !this.worker) return false;
    let frame: VideoFrame | null = null;
    try {
      frame = new VideoFrame(this.video, { timestamp: Math.round(nowMs * 1000) });
      this.worker.postMessage({ type: "frame", frame, t: nowMs } satisfies WorkerRequest, [frame]);
      return true;
    } catch (e) {
      console.warn("[HandTracker] VideoFrame transfer unsupported, using ImageBitmap", e);
      frame?.close();
      this.useVideoFrame = false;
      return false;
    }
  }

  private sendBitmap(nowMs: number) {
    const w = this.video.videoWidth;
    const h = this.video.videoHeight;
    const scale = Math.min(1, WORKER_FRAME_WIDTH / w);
    const opts: ImageBitmapOptions = scale < 1 ? { resizeWidth: Math.round(w * scale), resizeHeight: Math.round(h * scale), resizeQuality: "low" } : {};
    createImageBitmap(this.video, opts)
      .then((frame) => {
        if (!this.worker) return frame.close();
        this.worker.postMessage({ type: "frame", frame, t: nowMs } satisfies WorkerRequest, [frame]);
      })
      .catch(() => (this.busy = false));
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
