import { FilesetResolver, HandLandmarker, type NormalizedLandmark } from "@mediapipe/tasks-vision";

export interface HandFrame {
  /** performance.now() / 1000 when the frame was processed */
  t: number;
  /** Landmarks of the first hand (normalized to the raw, un-mirrored video frame), or null if no hand. */
  landmarks: NormalizedLandmark[] | null;
}

export type TrackerStatus = "idle" | "camera" | "model" | "ready" | "no-camera" | "error";

/**
 * Webcam + MediaPipe HandLandmarker. Detection runs once per new camera
 * frame (not per render frame), so the game loop can render at 60–120 Hz
 * while tracking runs at the camera's rate.
 */
export class HandTracker {
  readonly video: HTMLVideoElement;
  status: TrackerStatus = "idle";
  error = "";
  delegate: "GPU" | "CPU" | "" = "";
  inferenceMs = 0;
  detectFps = 0;
  latest: HandFrame | null = null;

  private landmarker: HandLandmarker | null = null;
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
    try {
      const wasmBase = new URL("mediapipe/wasm", document.baseURI).href;
      const modelPath = new URL("models/hand_landmarker.task", document.baseURI).href;
      const fileset = await FilesetResolver.forVisionTasks(wasmBase);
      const create = (delegate: "GPU" | "CPU") =>
        HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: modelPath, delegate },
          runningMode: "VIDEO",
          numHands: 1,
          minHandDetectionConfidence: 0.55,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
      try {
        this.landmarker = await create("GPU");
        this.delegate = "GPU";
      } catch (gpuErr) {
        console.warn("[HandTracker] GPU delegate failed, falling back to CPU", gpuErr);
        this.landmarker = await create("CPU");
        this.delegate = "CPU";
      }
      this.status = "ready";
      return true;
    } catch (e) {
      console.error(e);
      this.status = "error";
      this.error = `Could not load the hand model: ${(e as Error)?.message ?? e}`;
      return false;
    }
  }

  /** Runs detection if the camera produced a new frame. Returns the new frame, or null if nothing new. */
  update(nowMs: number): HandFrame | null {
    if (!this.landmarker || this.video.readyState < 2) return null;
    const vt = this.video.currentTime;
    if (vt === this.lastVideoTime) return null;
    this.lastVideoTime = vt;

    const t0 = performance.now();
    let landmarks: NormalizedLandmark[] | null = null;
    try {
      const res = this.landmarker.detectForVideo(this.video, nowMs);
      landmarks = res.landmarks?.[0] ?? null;
    } catch (e) {
      console.warn("[HandTracker] detect failed", e);
      return null;
    }
    const t1 = performance.now();
    this.inferenceMs += (t1 - t0 - this.inferenceMs) * 0.1;

    this.fpsFrames++;
    if (t1 - this.fpsStart > 1000) {
      this.detectFps = (this.fpsFrames * 1000) / (t1 - this.fpsStart);
      this.fpsFrames = 0;
      this.fpsStart = t1;
    }

    this.latest = { t: t1 / 1000, landmarks };
    return this.latest;
  }
}

/** MediaPipe hand skeleton connections (pairs of landmark indices). */
export const HAND_CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];
