import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";

export type DelegatePref = "auto" | "cpu" | "gpu";

export interface LandmarkerChoice {
  landmarker: HandLandmarker;
  delegate: "GPU" | "CPU";
  /** Benchmark results (ms per inference) when the delegate was chosen automatically. */
  bench: { cpu?: number; gpu?: number };
}

/** Below this CPU inference time, the CPU easily keeps up with a 30–60 fps camera. */
const CPU_GOOD_ENOUGH_MS = 28;

let benchTs = 1;

/**
 * Creates the HandLandmarker.
 *
 * "auto" (used in the worker) benchmarks the CPU first and keeps it if it is
 * fast enough: the GPU is busy rendering the game, and sharing it with
 * MediaPipe (including its synchronous read-backs) causes frame hitches. The
 * GPU is only used when the CPU is too slow and the GPU is clearly faster.
 *
 * `useModule` must be true inside module workers, where the classic WASM
 * loader (importScripts) is unavailable.
 */
export async function createHandLandmarker(wasmBase: string, modelPath: string, useModule: boolean, pref: DelegatePref): Promise<LandmarkerChoice> {
  const fileset = await FilesetResolver.forVisionTasks(wasmBase, useModule);
  const create = async (delegate: "GPU" | "CPU") => {
    try {
      // MediaPipe clears the global ModuleFactory after creating a task, and an
      // ES module only executes once, so a second task in the same module
      // worker would fail with "ModuleFactory not set". Restore it from the
      // (cached) module's default export.
      const g = self as unknown as { ModuleFactory?: unknown };
      if (useModule && !g.ModuleFactory) g.ModuleFactory = (await import(/* @vite-ignore */ fileset.wasmLoaderPath)).default;
      return await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: modelPath, delegate },
        runningMode: "VIDEO",
        numHands: 1,
        // Lenient thresholds keep the hand tracked through motion blur during
        // fast swipes, instead of dropping out and re-running palm detection.
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.4,
        minTrackingConfidence: 0.35,
      });
    } catch (e) {
      console.warn(`[hand tracking] ${delegate} delegate unavailable`, e);
      return null;
    }
  };

  if (pref !== "auto") {
    const first = pref === "cpu" ? "CPU" : "GPU";
    const second = first === "CPU" ? "GPU" : "CPU";
    let delegate: "GPU" | "CPU" = first;
    let lm = await create(first);
    if (!lm) {
      delegate = second;
      lm = await create(second);
    }
    if (!lm) throw new Error("Hand tracking could not start on this device.");
    benchmark(lm, 2); // warm-up: compile shaders / allocate now, not on the first real frame
    return { landmarker: lm, delegate, bench: {} };
  }

  const cpu = await create("CPU");
  const cpuMs = cpu ? benchmark(cpu) : Infinity;
  if (cpu && cpuMs <= CPU_GOOD_ENOUGH_MS) return { landmarker: cpu, delegate: "CPU", bench: { cpu: cpuMs } };

  const gpu = await create("GPU");
  const gpuMs = gpu ? benchmark(gpu) : Infinity;
  if (gpu && (!cpu || gpuMs < cpuMs * 0.7)) {
    cpu?.close();
    return { landmarker: gpu, delegate: "GPU", bench: { cpu: cpuMs, gpu: gpuMs } };
  }
  gpu?.close();
  if (!cpu) throw new Error("Hand tracking could not start on this device.");
  return { landmarker: cpu, delegate: "CPU", bench: { cpu: cpuMs, gpu: gpuMs } };
}

/**
 * Median inference time (ms) on a blank frame. With no hand present the palm
 * detector runs every call, so this is the worst case. The first runs double
 * as warm-up (shader compilation, buffer allocation).
 */
function benchmark(lm: HandLandmarker, runs = 7): number {
  const img = new ImageData(640, 360);
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    try {
      lm.detectForVideo(img, benchTs++);
    } catch (e) {
      console.warn("[hand tracking] benchmark failed", e);
      return Infinity;
    }
    if (i >= 2) times.push(performance.now() - t0);
  }
  if (times.length === 0) return Infinity;
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

/** Plain landmark data that can cross the worker boundary. */
export interface Point3 {
  x: number;
  y: number;
  z: number;
}
