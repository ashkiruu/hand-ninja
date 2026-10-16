import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";

export type DelegatePref = "auto" | "cpu" | "gpu";
export type Delegate = "CPU" | "GPU";
type Fileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;

let warmTs = 1;

export function loadVision(wasmBase: string, useModule: boolean): Promise<Fileset> {
  return FilesetResolver.forVisionTasks(wasmBase, useModule);
}

/**
 * Creates and warms up a HandLandmarker on one delegate, or returns null if
 * that delegate isn't available on this device.
 *
 * `useModule` must be true inside module workers, where the classic WASM
 * loader (importScripts) is unavailable.
 */
export async function makeLandmarker(fileset: Fileset, modelPath: string, delegate: Delegate, useModule: boolean): Promise<HandLandmarker | null> {
  try {
    // MediaPipe clears the global ModuleFactory after creating a task, and an
    // ES module only executes once, so a second task in the same module
    // worker would fail with "ModuleFactory not set". Restore it from the
    // (cached) module's default export.
    const g = self as unknown as { ModuleFactory?: unknown };
    if (useModule && !g.ModuleFactory) g.ModuleFactory = (await import(/* @vite-ignore */ fileset.wasmLoaderPath)).default;
    const lm = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: modelPath, delegate },
      runningMode: "VIDEO",
      numHands: 1,
      // Lenient thresholds keep the hand tracked through motion blur and dim
      // light, instead of dropping out and re-running palm detection.
      minHandDetectionConfidence: 0.45,
      minHandPresenceConfidence: 0.4,
      minTrackingConfidence: 0.3,
    });
    // Warm-up: the first inferences compile GPU shaders / allocate buffers.
    // Do it now, behind the loading screen, not on the first real frame.
    const img = new ImageData(640, 360);
    for (let i = 0; i < 2; i++) {
      try {
        lm.detectForVideo(img, warmTs++);
      } catch {
        /* best effort */
      }
    }
    return lm;
  } catch (e) {
    console.warn(`[hand tracking] ${delegate} delegate unavailable`, e);
    return null;
  }
}

/** Creates a landmarker on the preferred delegate, falling back to the other. */
export async function createHandLandmarker(wasmBase: string, modelPath: string, useModule: boolean, prefer: Delegate) {
  const fileset = await loadVision(wasmBase, useModule);
  const other: Delegate = prefer === "CPU" ? "GPU" : "CPU";
  for (const delegate of [prefer, other]) {
    const landmarker = await makeLandmarker(fileset, modelPath, delegate, useModule);
    if (landmarker) return { landmarker, delegate };
  }
  throw new Error("Hand tracking could not start on this device.");
}

/** Plain landmark data that can cross the worker boundary. */
export interface Point3 {
  x: number;
  y: number;
  z: number;
}
