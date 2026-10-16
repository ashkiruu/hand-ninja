import type { HandLandmarker } from "@mediapipe/tasks-vision";
import { createHandLandmarker, type Point3 } from "./landmarkerOptions";
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
  inferenceMs = 0;
  detectFps = 0;
  latest: HandFrame | null = null;
  /** performance.now() when `latest` arrived. */
  latestAt = 0;

  private landmarker: HandLandmarker | null = null;
  private worker: Worker | null = null;
  private busy = false;
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
          width: { ideal: 1280 },
          height: { ideal: 720 },
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
    // Diagnostics / escape hatches for unusual GPUs: ?delegate=cpu, ?thread=main
    const params = new URLSearchParams(location.search);
    const preferCpu = params.get("delegate")?.toLowerCase() === "cpu";
    const forceMain = params.get("thread")?.toLowerCase() === "main";

    if (!forceMain && workerSupported() && (await this.startWorker(wasmBase, modelPath, preferCpu))) {
      this.mode = "worker";
      this.status = "ready";
      return true;
    }

    try {
      const res = await createHandLandmarker(wasmBase, modelPath, false, preferCpu);
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

  private startWorker(wasmBase: string, modelPath: string, preferCpu: boolean): Promise<boolean> {
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
          worker.onmessage = (ev: MessageEvent<WorkerResponse>) => this.onWorkerMessage(ev.data);
          worker.onerror = (ev) => console.warn("[HandTracker] worker error", ev.message);
          resolve(true);
        } else if (msg.type === "error") {
          window.clearTimeout(timer);
          fail(msg.message);
        }
      };
      worker.postMessage({ type: "init", wasmBase, modelPath, preferCpu } satisfies WorkerRequest);
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
      const w = this.video.videoWidth;
      const h = this.video.videoHeight;
      const scale = Math.min(1, WORKER_FRAME_WIDTH / w);
      const opts: ImageBitmapOptions = scale < 1 ? { resizeWidth: Math.round(w * scale), resizeHeight: Math.round(h * scale), resizeQuality: "low" } : {};
      createImageBitmap(this.video, opts)
        .then((bitmap) => {
          if (!this.worker) return bitmap.close();
          this.worker.postMessage({ type: "frame", bitmap, t: nowMs } satisfies WorkerRequest, [bitmap]);
        })
        .catch(() => (this.busy = false));
    }
    const res = this.inbox;
    this.inbox = null;
    if (res) {
      this.latest = res;
      this.latestAt = performance.now();
    }
    return res;
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
