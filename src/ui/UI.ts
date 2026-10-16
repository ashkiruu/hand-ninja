import gsap from "gsap";
import type { Point3 } from "../tracking/landmarkerOptions";
import { HAND_CONNECTIONS } from "../tracking/HandTracker";
import { settings, type Settings } from "../settings";
import type { Game, GameResult } from "../game/Game";
import type { PowerUp } from "../game/fruitModels";

export type ScreenId = "splash" | "loading" | "title" | "pause" | "results";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** All DOM-side UI: screens, HUD, settings, hand status and the camera preview. */
export class UI {
  readonly popupRoot = $("popups");
  readonly ringLabelRoot = $("ring-labels");
  onSettingsChange: ((s: Settings) => void) | null = null;
  onPauseClick: (() => void) | null = null;
  onSettingsOpen: ((open: boolean) => void) | null = null;

  private screens: Record<ScreenId, HTMLElement> = {
    splash: $("screen-splash"),
    loading: $("screen-loading"),
    title: $("screen-title"),
    pause: $("screen-pause"),
    results: $("screen-results"),
  };
  private current: ScreenId | null = "splash";
  private hud = $("hud");
  private scoreEl = $("score");
  private bestEl = $("best");
  private lives = Array.from($("lives").querySelectorAll("svg"));
  private livesWrap = $("lives");
  private timer = $("timer");
  private timerArc = $("timer-arc");
  private timerText = $("timer-text");
  private powers = $("powers");
  private settingsModal = $("settings");
  private pip = $<HTMLCanvasElement>("pip");
  private pipCtx = this.pip.getContext("2d")!;
  private handPanel = $("hand-panel");
  private handChip = $("hand-status");
  private handText = $("hand-status-text");
  private debugEl = $("debug");
  private flashEl = $("flash");
  private frostEl = $("frost");
  private shown = { score: -1, misses: -1, time: -1, powers: "" };

  constructor() {
    $("pause-btn").addEventListener("click", () => this.onPauseClick?.());
    $("settings-btn").addEventListener("click", () => this.openSettings(true));
    $("settings-close").addEventListener("click", () => this.openSettings(false));
    $("settings-done").addEventListener("click", () => this.openSettings(false));
    $("settings-reset").addEventListener("click", () => {
      settings.reset();
      this.syncSettings();
    });
    this.settingsModal.addEventListener("pointerdown", (e) => {
      if (e.target === this.settingsModal) this.openSettings(false);
    });
    this.bindSettings();
  }

  // ------------------------------------------------------------------ screens

  show(id: ScreenId | null) {
    if (this.current === id) return;
    const prev = this.current ? this.screens[this.current] : null;
    if (prev) {
      gsap.to(prev, {
        opacity: 0,
        duration: 0.25,
        onComplete: () => {
          prev.classList.add("hidden");
          prev.style.opacity = "";
        },
      });
    }
    this.current = id;
    if (id) {
      const el = this.screens[id];
      el.classList.remove("hidden");
      gsap.fromTo(el, { opacity: 0 }, { opacity: 1, duration: 0.35, delay: prev ? 0.1 : 0 });
    }
  }

  get screen() {
    return this.current;
  }

  setStep(step: "camera" | "model" | "assets", state: "active" | "done" | "failed") {
    const el = $(`step-${step}`);
    el.classList.remove("active", "done", "failed");
    el.classList.add(state);
  }

  showError(msg: string) {
    const el = $("loading-error");
    el.textContent = msg;
    el.classList.remove("hidden");
  }

  setTitleHint(html: string) {
    $("title-hint").innerHTML = html;
  }

  setPauseHint(html: string) {
    $("pause-hint").innerHTML = html;
  }

  // ------------------------------------------------------------------ HUD

  showHud(game: Game | null) {
    if (!game) {
      this.hud.classList.add("hidden");
      this.frost(false);
      return;
    }
    this.hud.classList.remove("hidden");
    this.shown = { score: -1, misses: -1, time: -1, powers: "" };
    this.bestEl.textContent = String(game.best);
    this.livesWrap.classList.toggle("hidden", game.mode !== "classic");
    this.timer.classList.toggle("hidden", game.mode !== "arcade");
    this.lives.forEach((l) => l.classList.remove("lost"));
    this.powers.innerHTML = "";
    gsap.fromTo(this.hud, { opacity: 0, y: -12 }, { opacity: 1, y: 0, duration: 0.4 });
  }

  updateHud(game: Game) {
    if (game.score !== this.shown.score) {
      const up = game.score > this.shown.score && this.shown.score >= 0;
      this.shown.score = game.score;
      this.scoreEl.textContent = String(game.score);
      if (up) gsap.fromTo(this.scoreEl, { scale: 1.35 }, { scale: 1, duration: 0.3, ease: "back.out(3)" });
      if (game.score > game.best) this.bestEl.textContent = String(game.score);
    }
    if (game.misses !== this.shown.misses) {
      this.shown.misses = game.misses;
      // Fill X marks from the right-most (biggest) one.
      this.lives.forEach((l, i) => l.classList.toggle("lost", i >= this.lives.length - game.misses));
    }
    if (game.mode === "arcade") {
      const t = Math.ceil(game.timeLeft);
      if (t !== this.shown.time) {
        this.shown.time = t;
        this.timerText.textContent = String(t);
        this.timer.classList.toggle("low", t <= 10);
      }
      this.timerArc.style.strokeDashoffset = String(276.46 * (1 - game.timeLeft / 60));
      this.timer.classList.toggle("frozen", game.isFrozen);
    }
    // power-up chips
    const active = (Object.keys(game.power) as PowerUp[]).filter((k) => game.power[k] > 0);
    const key = active.join(",");
    if (key !== this.shown.powers) {
      this.shown.powers = key;
      const labels: Record<PowerUp, string> = { freeze: "Freeze", frenzy: "Frenzy", double: "2× Score" };
      this.powers.innerHTML = active.map((k) => `<div class="power-chip ${k}">${labels[k]}<span class="bar"><i data-p="${k}"></i></span></div>`).join("");
    }
    const max: Record<PowerUp, number> = { freeze: 5, frenzy: 5, double: 7 };
    this.powers.querySelectorAll<HTMLElement>("i[data-p]").forEach((i) => {
      const k = i.dataset.p as PowerUp;
      i.style.width = `${(game.power[k] / max[k]) * 100}%`;
    });
    this.frost(game.isFrozen);
  }

  private handHintOn = false;
  handHint(on: boolean) {
    if (on === this.handHintOn) return;
    this.handHintOn = on;
    $("hand-hint").classList.toggle("on", on);
  }

  frost(on: boolean) {
    this.frostEl.classList.toggle("on", on);
  }

  // ------------------------------------------------------------------ results

  showResults(r: GameResult) {
    $("results-title").textContent = r.reason === "time" ? "Time's Up" : r.reason === "bomb" ? "Kaboom!" : "Game Over";
    const scoreEl = $("result-score");
    const counter = { v: 0 };
    gsap.to(counter, {
      v: r.score,
      duration: Math.min(1.6, 0.4 + r.score * 0.02),
      delay: 0.3,
      ease: "power2.out",
      onUpdate: () => (scoreEl.textContent = String(Math.round(counter.v))),
    });
    scoreEl.textContent = "0";
    $("result-best").textContent = `Best ${r.best}`;
    $("new-best").classList.toggle("hidden", !r.newBest);
    $("stat-sliced").textContent = String(r.sliced);
    $("stat-combo").textContent = r.maxCombo >= 3 ? `${r.maxCombo}×` : "—";
    $("stat-accuracy").textContent = r.thrown ? `${Math.round((r.sliced / r.thrown) * 100)}%` : "—";
    $("stat-crit").textContent = String(r.criticals);
    this.show("results");
    gsap.fromTo(".result-card", { y: 30, opacity: 0 }, { y: 0, opacity: 1, duration: 0.5, delay: 0.15, ease: "power3.out" });
  }

  // ------------------------------------------------------------------ settings

  get settingsOpen() {
    return !this.settingsModal.classList.contains("hidden");
  }

  openSettings(open: boolean) {
    this.settingsModal.classList.toggle("hidden", !open);
    if (open) {
      this.syncSettings();
      gsap.fromTo(".modal-card", { y: 20, opacity: 0, scale: 0.97 }, { y: 0, opacity: 1, scale: 1, duration: 0.3, ease: "power3.out" });
    }
    this.onSettingsOpen?.(open);
  }

  private bindSettings() {
    this.settingsModal.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-key]").forEach((input) => {
      const key = input.dataset.key as keyof Settings;
      input.addEventListener("input", () => {
        let v: unknown;
        if (input instanceof HTMLInputElement && input.type === "checkbox") v = input.checked;
        else if (input instanceof HTMLInputElement && input.type === "range") v = Number(input.value);
        else v = input.value;
        settings.set(key, v as never);
        this.syncOutputs();
        this.onSettingsChange?.(settings.value);
      });
    });
    this.syncSettings();
  }

  private syncSettings() {
    const s = settings.value;
    this.settingsModal.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-key]").forEach((input) => {
      const v = s[input.dataset.key as keyof Settings];
      if (input instanceof HTMLInputElement && input.type === "checkbox") input.checked = Boolean(v);
      else input.value = String(v);
    });
    this.syncOutputs();
    this.onSettingsChange?.(s);
  }

  private syncOutputs() {
    const s = settings.value;
    const fmt: Partial<Record<keyof Settings, (v: number) => string>> = {
      sliceSpeed: (v) => v.toFixed(1),
      reach: (v) => `${v.toFixed(2)}×`,
      fruitSize: (v) => `${Math.round(v * 100)}%`,
      minCutoff: (v) => `${v.toFixed(1)} Hz`,
      beta: (v) => v.toFixed(1),
      predictionMs: (v) => `${v} ms`,
      cameraOpacity: (v) => `${Math.round(v * 100)}%`,
      sfxVolume: (v) => `${Math.round(v * 100)}%`,
      musicVolume: (v) => `${Math.round(v * 100)}%`,
    };
    this.settingsModal.querySelectorAll<HTMLOutputElement>("output[data-for]").forEach((o) => {
      const k = o.dataset.for as keyof Settings;
      const f = fmt[k];
      o.textContent = f ? f(s[k] as number) : String(s[k]);
    });
  }

  // ------------------------------------------------------------------ hand status / preview

  handStatus(state: "ok" | "searching" | "off", text: string) {
    this.handChip.classList.remove("ok", "searching", "off");
    this.handChip.classList.add(state);
    if (this.handText.textContent !== text) this.handText.textContent = text;
  }

  setPreviewVisible(v: boolean) {
    this.pip.classList.toggle("hidden", !v);
  }

  setHandPanelVisible(v: boolean) {
    this.handPanel.classList.toggle("hidden", !v);
  }

  /** `blade` is the point driving the blade, in raw normalized video coordinates. */
  drawPreview(video: HTMLVideoElement, landmarks: Point3[] | null, blade: { x: number; y: number } | null) {
    if (this.pip.classList.contains("hidden") || video.readyState < 2) return;
    const ctx = this.pipCtx;
    const w = this.pip.width;
    const h = this.pip.height;
    ctx.save();
    ctx.clearRect(0, 0, w, h);
    // cover-fit, mirrored
    const va = video.videoWidth / video.videoHeight;
    const ca = w / h;
    let sw = video.videoWidth;
    let sh = video.videoHeight;
    let sx = 0;
    let sy = 0;
    if (va > ca) {
      sw = sh * ca;
      sx = (video.videoWidth - sw) / 2;
    } else {
      sh = sw / ca;
      sy = (video.videoHeight - sh) / 2;
    }
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.globalAlpha = 0.85;
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
    ctx.globalAlpha = 1;
    if (landmarks) {
      const px = (l: Point3) => ((l.x * video.videoWidth - sx) / sw) * w;
      const py = (l: Point3) => ((l.y * video.videoHeight - sy) / sh) * h;
      ctx.strokeStyle = "rgba(255, 210, 94, 0.9)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (const [a, b] of HAND_CONNECTIONS) {
        ctx.moveTo(px(landmarks[a]), py(landmarks[a]));
        ctx.lineTo(px(landmarks[b]), py(landmarks[b]));
      }
      ctx.stroke();
      ctx.fillStyle = "#fff";
      for (const l of landmarks) {
        ctx.beginPath();
        ctx.arc(px(l), py(l), 2, 0, Math.PI * 2);
        ctx.fill();
      }
      if (blade) {
        const b = { x: blade.x, y: blade.y, z: 0 };
        ctx.fillStyle = "rgba(95, 220, 255, 0.35)";
        ctx.beginPath();
        ctx.arc(px(b), py(b), 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#5fdcff";
        ctx.beginPath();
        ctx.arc(px(b), py(b), 4.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // ------------------------------------------------------------------ misc

  debug(text: string | null) {
    this.debugEl.classList.toggle("hidden", text === null);
    if (text !== null) this.debugEl.textContent = text;
  }

  flash(strength: number) {
    gsap.killTweensOf(this.flashEl);
    gsap.fromTo(this.flashEl, { opacity: strength }, { opacity: 0, duration: 0.25 + strength * 0.9, ease: "power2.out" });
  }
}
