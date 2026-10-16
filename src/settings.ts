// Player-tunable settings, persisted to localStorage.

export interface Settings {
  /** Opacity of the webcam feed behind the scene (0 = pure dojo). */
  cameraOpacity: number;
  /** Zoom applied to both the camera feed and the hand mapping. >1 means less arm travel. */
  reach: number;
  /** Blade must move faster than this (screen heights / second) to cut. */
  sliceSpeed: number;
  /** One Euro filter: cutoff at rest (Hz). Lower = steadier but laggier when slow. */
  minCutoff: number;
  /** One Euro filter: speed coefficient. Higher = less lag on fast swipes. */
  beta: number;
  /** How far ahead (ms) to extrapolate the fingertip to hide camera latency. */
  predictionMs: number;
  /** What drives the blade: steady blend along the index finger, the raw fingertip, or the palm. */
  bladeLandmark: "index" | "tip" | "palm";
  bloom: boolean;
  highQuality: boolean;
  sfxVolume: number;
  musicVolume: number;
  showCameraPreview: boolean;
  showDebug: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  cameraOpacity: 0.35,
  reach: 1.3,
  sliceSpeed: 1.1,
  minCutoff: 1.6,
  beta: 6,
  predictionMs: 22,
  bladeLandmark: "index",
  bloom: true,
  highQuality: true,
  sfxVolume: 0.9,
  musicVolume: 0.45,
  showCameraPreview: true,
  showDebug: false,
};

const KEY = "handninja.settings.v2";

type Listener = (s: Settings) => void;

class SettingsStore {
  value: Settings;
  private listeners = new Set<Listener>();

  constructor() {
    this.value = { ...DEFAULT_SETTINGS, ...load() };
  }

  set<K extends keyof Settings>(key: K, v: Settings[K]) {
    this.value[key] = v;
    save(this.value);
    this.listeners.forEach((l) => l(this.value));
  }

  reset() {
    this.value = { ...DEFAULT_SETTINGS };
    save(this.value);
    this.listeners.forEach((l) => l(this.value));
  }

  subscribe(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

function load(): Partial<Settings> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Partial<Settings>) : {};
  } catch {
    return {};
  }
}

function save(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable (private mode) — settings just won't persist */
  }
}

export const settings = new SettingsStore();

export type GameMode = "classic" | "arcade";

export function loadBest(mode: GameMode): number {
  try {
    return Number(localStorage.getItem(`handninja.best.${mode}`) ?? 0) || 0;
  } catch {
    return 0;
  }
}

export function saveBest(mode: GameMode, score: number) {
  try {
    localStorage.setItem(`handninja.best.${mode}`, String(score));
  } catch {
    /* ignore */
  }
}
