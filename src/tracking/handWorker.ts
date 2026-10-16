// Runs MediaPipe hand tracking off the main thread so slow inference never
// stalls rendering. The main thread posts one camera frame (ImageBitmap) at a
// time; results come back tagged with that frame's capture time.

import type { HandLandmarker } from "@mediapipe/tasks-vision";
import { createHandLandmarker, type Point3 } from "./landmarkerOptions";

export type WorkerRequest =
  | { type: "init"; wasmBase: string; modelPath: string; preferCpu: boolean }
  | { type: "frame"; bitmap: ImageBitmap; t: number };

export type WorkerResponse =
  | { type: "ready"; delegate: "GPU" | "CPU" }
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
      const res = await createHandLandmarker(msg.wasmBase, msg.modelPath, true, msg.preferCpu);
      landmarker = res.landmarker;
      reply({ type: "ready", delegate: res.delegate });
    } catch (err) {
      reply({ type: "error", message: (err as Error)?.message ?? String(err) });
    }
    return;
  }

  const { bitmap, t } = msg;
  const t0 = performance.now();
  let landmarks: Point3[] | null = null;
  try {
    if (landmarker) {
      // MediaPipe needs strictly increasing timestamps.
      const ts = Math.max(lastTs + 1, t);
      lastTs = ts;
      const lm = landmarker.detectForVideo(bitmap, ts).landmarks?.[0];
      if (lm) landmarks = lm.map((p) => ({ x: p.x, y: p.y, z: p.z }));
    }
  } catch (err) {
    console.warn("[hand worker] detect failed", err);
  } finally {
    bitmap.close();
  }
  reply({ type: "result", t, landmarks, ms: performance.now() - t0 });
};
