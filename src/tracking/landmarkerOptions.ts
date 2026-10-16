import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";

/**
 * Creates the HandLandmarker, preferring the GPU delegate and falling back to
 * CPU. Shared by the main-thread and Web Worker tracking paths.
 *
 * `useModule` must be true inside module workers, where the classic WASM
 * loader (importScripts) is unavailable.
 */
export async function createHandLandmarker(wasmBase: string, modelPath: string, useModule: boolean, preferCpu = false) {
  const fileset = await FilesetResolver.forVisionTasks(wasmBase, useModule);
  const create = (delegate: "GPU" | "CPU") =>
    HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: modelPath, delegate },
      runningMode: "VIDEO",
      numHands: 1,
      minHandDetectionConfidence: 0.55,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  let landmarker: HandLandmarker;
  let delegate: "GPU" | "CPU" = preferCpu ? "CPU" : "GPU";
  try {
    landmarker = await create(delegate);
  } catch (gpuErr) {
    if (delegate === "CPU") throw gpuErr;
    console.warn("[hand tracking] GPU delegate failed, falling back to CPU", gpuErr);
    landmarker = await create("CPU");
    delegate = "CPU";
  }
  // Warm-up: the first inference compiles GPU shaders and can take a while.
  // Do it now, behind the loading screen, instead of on the first real frame.
  try {
    landmarker.detectForVideo(new ImageData(256, 256), 1);
  } catch {
    /* warm-up is best effort */
  }
  return { landmarker, delegate };
}

/** Plain landmark data that can cross the worker boundary. */
export interface Point3 {
  x: number;
  y: number;
  z: number;
}
