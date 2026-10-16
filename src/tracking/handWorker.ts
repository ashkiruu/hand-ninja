// Runs MediaPipe hand tracking off the main thread so inference never stalls
// rendering. The main thread posts one camera frame at a time (a zero-copy
// VideoFrame where supported, otherwise an ImageBitmap); results come back
// tagged with that frame's capture time.

import type { HandLandmarker } from "@mediapipe/tasks-vision";
import { createHandLandmarker, type DelegatePref, type Point3 } from "./landmarkerOptions";

export type WorkerRequest =
  | { type: "init"; wasmBase: string; modelPath: string; pref: DelegatePref }
  | { type: "frame"; frame: ImageBitmap | VideoFrame; t: number };

export type WorkerResponse =
  | { type: "ready"; delegate: "GPU" | "CPU"; bench: { cpu?: number; gpu?: number } }
  | { type: "error"; message: string }
  | { type: "result"; t: number; landmarks: Point3[] | null; ms: number };

const ctx = self as unknown as {
  postMessage(msg: WorkerResponse): void;
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
};
let landmarker: HandLandmarker | null = null;
let lastTs = 0;

const reply = (msg: WorkerResponse) => ctx.postMessage(msg);

ctx.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === "init") {
    try {
      const res = await createHandLandmarker(msg.wasmBase, msg.modelPath, true, msg.pref);
      landmarker = res.landmarker;
      reply({ type: "ready", delegate: res.delegate, bench: res.bench });
    } catch (err) {
      reply({ type: "error", message: (err as Error)?.message ?? String(err) });
    }
    return;
  }

  const { frame, t } = msg;
  const t0 = performance.now();
  let landmarks: Point3[] | null = null;
  try {
    if (landmarker) {
      // MediaPipe needs strictly increasing timestamps.
      const ts = Math.max(lastTs + 1, t);
      lastTs = ts;
      const lm = landmarker.detectForVideo(frame, ts).landmarks?.[0];
      if (lm) landmarks = lm.map((p) => ({ x: p.x, y: p.y, z: p.z }));
    }
  } catch (err) {
    console.warn("[hand worker] detect failed", err);
  } finally {
    frame.close();
  }
  reply({ type: "result", t, landmarks, ms: performance.now() - t0 });
};
