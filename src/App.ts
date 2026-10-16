import * as THREE from "three";
import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import { AudioEngine } from "./audio/AudioEngine";
import { TimeFx } from "./core/TimeFx";
import { Game, type GameResult } from "./game/Game";
import { getCatalogue } from "./game/fruitModels";
import { Menu } from "./game/Menu";
import { World } from "./game/World";
import { Blade } from "./input/Blade";
import { Background } from "./render/Background";
import { BladeTrail } from "./render/BladeTrail";
import { Particles } from "./render/Particles";
import { Renderer } from "./render/Renderer";
import { Splatters } from "./render/Splatters";
import { type GameMode, loadBest, settings, type Settings } from "./settings";
import { HandTracker } from "./tracking/HandTracker";
import { coverScale, pixelsToHeightUnits, videoToHeightUnits } from "./tracking/mapping";
import { Popups } from "./ui/Popups";
import { UI } from "./ui/UI";

type AppState = "splash" | "loading" | "title" | "playing" | "paused" | "results";

const TIP_INDEX: Record<Settings["bladeLandmark"], number> = { index: 8, middle: 12, palm: -1 };
const PALM = [0, 5, 9, 13, 17];
const HAND_LOST_PAUSE = 1.2; // s without a hand before auto-pausing

export class App {
  private renderer: Renderer;
  private background = new Background();
  private droplets = new Particles(4000, "droplet");
  private glow = new Particles(3000, "glow");
  private embers = new Particles(300, "glow");
  private splats = new Splatters();
  private trail = new BladeTrail();
  private blade = new Blade();
  private tracker: HandTracker;
  private audio = new AudioEngine();
  private ui = new UI();
  private popups: Popups;
  private timeFx = new TimeFx();
  private world: World;
  private menu: Menu;
  private game: Game | null = null;

  private state: AppState = "splash";
  private lastMode: GameMode = "classic";
  private last = performance.now() / 1000;
  private handMissing = 0;
  private wasLive = false;
  private emberClock = 0;
  private fps = 60;
  private hu = { x: 0, y: 0 };
  private quality = { high: true, bloom: true };
  private emberColor = new THREE.Color("#ff8a3a");

  constructor() {
    const canvas = document.getElementById("gl") as HTMLCanvasElement;
    this.renderer = new Renderer(canvas);
    this.tracker = new HandTracker(document.getElementById("cam") as HTMLVideoElement);
    this.popups = new Popups(this.ui.popupRoot, this.renderer);
    this.world = new World(this.renderer, this.droplets, this.glow, this.splats);
    this.menu = new Menu(this.renderer, this.world, this.audio, this.timeFx, this.ui.ringLabelRoot);
    this.menu.onSelect = (id) => this.onMenuSelect(id);

    const { scene } = this.renderer;
    this.embers.points.position.z = -1.5;
    scene.add(this.background.mesh, this.splats.group, this.embers.points, this.world.root, this.menu.group, this.droplets.points, this.glow.points, this.trail.group);

    this.ui.onSettingsChange = (s) => this.applySettings(s);
    this.ui.onPauseClick = () => this.pause("Slice <b>Resume</b> to continue");
    this.ui.onSettingsOpen = (open) => {
      if (open && this.state === "playing") this.pause("Slice <b>Resume</b> to continue");
      if (!open && this.state === "title") this.showTitle();
    };
    this.applySettings(settings.value);
    this.ui.setHandPanelVisible(false);

    this.bindInput(canvas);
    window.addEventListener("resize", () => this.onResize());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && this.state === "playing") this.pause("Slice <b>Resume</b> to continue");
    });
    this.onResize();
    requestAnimationFrame(this.frame);
  }

  // ------------------------------------------------------------------ boot

  private async boot() {
    if (this.state !== "splash") return;
    this.state = "loading";
    await this.audio.unlock().catch(() => undefined);
    this.audio.setVolumes(settings.value.sfxVolume, settings.value.musicVolume);
    this.ui.show("loading");

    this.ui.setStep("camera", "active");
    const cam = await this.tracker.startCamera();
    this.ui.setStep("camera", cam ? "done" : "failed");
    let problem = cam ? "" : this.tracker.error;
    if (cam) {
      this.background.setVideo(this.tracker.video);
      this.ui.setStep("model", "active");
      const ok = await this.tracker.loadModel();
      this.ui.setStep("model", ok ? "done" : "failed");
      if (!ok) problem = this.tracker.error;
    } else {
      this.ui.setStep("model", "failed");
    }

    this.ui.setStep("assets", "active");
    await document.fonts.load('52px "Shojumaru"').catch(() => undefined);
    await nextFrame();
    this.warmUp();
    this.ui.setStep("assets", "done");

    if (problem) {
      this.ui.showError(`${problem} You can still play by dragging with a mouse or finger.`);
      await wait(3200);
    } else {
      await wait(350);
    }
    this.ui.setHandPanelVisible(true);
    this.applySettings(settings.value);
    this.showTitle();
  }

  /** Build every fruit once and compile all shaders up front so the first slice doesn't hitch. */
  private warmUp() {
    const cat = getCatalogue();
    const tmp = new THREE.Group();
    for (const a of [...cat.fruits, ...Object.values(cat.bananas)]) {
      tmp.add(a.whole(), ...a.halves());
    }
    tmp.position.set(0, -1000, 0);
    this.renderer.scene.add(tmp);
    this.renderer.gl.compile(this.renderer.scene, this.renderer.camera);
    this.renderer.render(0.016);
    this.renderer.scene.remove(tmp);
  }

  // ------------------------------------------------------------------ states

  private showTitle() {
    this.state = "title";
    this.endGame();
    this.ui.show("title");
    this.audio.setMusic("menu");
    this.ui.setTitleHint(
      this.tracker.ready ? "Raise your hand and <b>slice a fruit</b> to choose" : "<b>Click and drag</b> through a fruit to choose",
    );
    const bc = loadBest("classic");
    const ba = loadBest("arcade");
    this.menu.show([
      { id: "classic", label: "Classic", fruit: "watermelon", x: -0.25, y: -0.1, caption: `Best <b>${bc}</b>` },
      { id: "arcade", label: "Arcade", fruit: "banana-double", x: 0.08, y: -0.1, caption: `60 seconds · Best <b>${ba}</b>`, color: "#ffe9b8", glow: "#ff6a1f" },
      { id: "settings", label: "Settings", fruit: "orange", x: 0.34, y: 0.03, scale: 0.62, caption: "Tune tracking", color: "#d9f4ff", glow: "#3fb8ff" },
    ]);
  }

  private onMenuSelect(id: string) {
    switch (id) {
      case "classic":
      case "arcade":
        this.startGame(id);
        break;
      case "retry":
        this.startGame(this.lastMode);
        break;
      case "menu":
        this.showTitle();
        break;
      case "settings":
        this.ui.openSettings(true);
        break;
      case "resume":
        this.resume();
        break;
      case "quit":
        this.showTitle();
        break;
    }
  }

  private startGame(mode: GameMode) {
    this.endGame();
    this.menu.hide();
    this.ui.show(null);
    this.lastMode = mode;
    this.timeFx.reset();
    this.game = new Game(mode, {
      world: this.world,
      renderer: this.renderer,
      audio: this.audio,
      popups: this.popups,
      time: this.timeFx,
      background: this.background,
      flash: (s) => this.ui.flash(s),
      onEnd: (r) => this.onGameEnd(r),
    });
    this.ui.showHud(this.game);
    this.state = "playing";
    this.handMissing = 0;
    this.audio.setMusic("game");
  }

  private endGame() {
    if (this.game) {
      this.game.dispose();
      this.game = null;
    }
    this.ui.showHud(null);
  }

  private onGameEnd(r: GameResult) {
    this.state = "results";
    this.endGame();
    if (r.newBest && r.score > 0) this.audio.fanfare();
    else this.audio.gameOver();
    this.audio.setMusic("menu");
    this.ui.showResults(r);
    this.menu.show([
      { id: "retry", label: "Retry", fruit: "apple", x: -0.14, y: -0.27, scale: 0.78, color: "#ffe7b0" },
      { id: "menu", label: "Menu", fruit: "lemon", x: 0.14, y: -0.27, scale: 0.78, color: "#d9f4ff", glow: "#3fb8ff" },
    ]);
  }

  private pause(hint: string) {
    if (this.state !== "playing" || !this.game) return;
    this.state = "paused";
    this.audio.stopFuse();
    this.audio.setMusic("menu");
    this.ui.setPauseHint(hint);
    this.ui.show("pause");
    this.menu.show([
      { id: "resume", label: "Resume", fruit: "orange", x: -0.14, y: -0.06, scale: 0.85 },
      { id: "quit", label: "Quit", fruit: "plum", x: 0.14, y: -0.06, scale: 0.85, color: "#ffd0c8", glow: "#ff3a2a" },
    ]);
  }

  private resume() {
    if (this.state !== "paused") return;
    this.menu.hide();
    this.ui.show(null);
    this.state = "playing";
    this.handMissing = 0;
    this.audio.setMusic("game");
    this.popups.banner("<span>Go!</span>", "go", 0.25);
  }

  // ------------------------------------------------------------------ input

  private bindInput(canvas: HTMLCanvasElement) {
    let down = false;
    const feed = (e: PointerEvent, isDown: boolean) => {
      pixelsToHeightUnits(e.clientX, e.clientY, this.renderer.width, this.renderer.height, this.hu);
      this.blade.feedPointer(this.hu.x, this.hu.y, performance.now() / 1000, isDown);
    };
    canvas.addEventListener("pointerdown", (e) => {
      down = true;
      canvas.setPointerCapture(e.pointerId);
      feed(e, true);
      if (this.menu.active) {
        const vh = this.renderer.viewH;
        this.menu.clickAt(this.hu.x * vh, this.hu.y * vh);
      }
    });
    canvas.addEventListener("pointermove", (e) => feed(e, down));
    const up = (e: PointerEvent) => {
      down = false;
      feed(e, false);
    };
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);

    document.getElementById("start-btn")!.addEventListener("click", () => this.boot());
    window.addEventListener("keydown", (e) => {
      if (this.ui.settingsOpen) {
        if (e.key === "Escape") this.ui.openSettings(false);
        return;
      }
      if (this.state === "splash" && (e.key === "Enter" || e.key === " ")) this.boot();
      else if (e.key === "Escape" || e.key === "p" || e.key === "P") {
        if (this.state === "playing") this.pause("Slice <b>Resume</b> to continue");
        else if (this.state === "paused") this.resume();
      } else if (e.key === "s" || e.key === "S") {
        if (this.state !== "splash" && this.state !== "loading") this.ui.openSettings(true);
      } else if (e.key === "d" || e.key === "D") {
        settings.set("showDebug", !settings.value.showDebug);
      }
    });
  }

  private applySettings(s: Settings) {
    this.blade.sliceSpeed = s.sliceSpeed;
    this.blade.predictionMs = s.predictionMs;
    this.blade.filter.minCutoff = s.minCutoff;
    this.blade.filter.beta = s.beta;
    if (s.highQuality !== this.quality.high || s.bloom !== this.quality.bloom) {
      this.quality = { high: s.highQuality, bloom: s.bloom };
      this.renderer.setQuality(s.highQuality, s.bloom);
      this.onResize();
    }
    this.audio.setVolumes(s.sfxVolume, s.musicVolume);
    this.ui.setPreviewVisible(s.showCameraPreview && this.tracker.video.readyState >= 2);
  }

  private onResize() {
    const size = this.renderer.gl.getDrawingBufferSize(new THREE.Vector2());
    for (const p of [this.droplets, this.glow, this.embers]) p.setScale(size.y, this.renderer.camera.fov);
    this.menu.layout();
  }

  // ------------------------------------------------------------------ frame loop

  private frame = (ms: number) => {
    requestAnimationFrame(this.frame);
    const now = ms / 1000;
    const realDt = Math.min(0.05, Math.max(0, now - this.last));
    this.last = now;
    if (realDt > 0) this.fps += (1 / realDt - this.fps) * 0.05;
    const s = settings.value;
    const r = this.renderer;

    // 1. Hand tracking → blade
    const cover = coverScale(this.tracker.videoAspect, r.aspect, s.reach);
    const hf = this.tracker.update(ms);
    if (hf?.landmarks) {
      const p = bladePoint(hf.landmarks, s.bladeLandmark);
      videoToHeightUnits(p.x, p.y, cover, r.aspect, this.hu);
      this.blade.feedHand(this.hu.x, this.hu.y, hf.t);
    }
    this.blade.update(now, realDt, r.viewH);

    // Every swing gets a swish, whether or not it hits anything.
    if (this.blade.live && !this.wasLive) this.audio.whoosh(this.blade.speed, this.blade.head.x / (r.viewW / 2));
    this.wasLive = this.blade.live;

    // 2. Simulation
    this.timeFx.update(realDt);
    const dt = realDt * this.timeFx.scale;

    if (this.state === "playing" && this.game) {
      this.game.update(realDt, dt, this.blade);
      if (this.game) this.ui.updateHud(this.game);
      this.checkHandLost(realDt);
    }
    if (this.state === "title" || this.state === "paused" || this.state === "results") {
      if (!this.ui.settingsOpen) this.menu.update(realDt, this.blade);
    } else if (this.menu.active) {
      this.menu.update(realDt, this.blade);
    }

    this.world.update(dt);
    this.droplets.update(dt);
    this.glow.update(dt);
    this.updateEmbers(realDt);
    this.splats.update(realDt);
    this.trail.update(this.blade, r.viewH);
    this.background.update(now, r.aspect, cover, this.tracker.ready || this.tracker.video.readyState >= 2 ? s.cameraOpacity : 0);

    // 3. UI
    this.updateHandStatus();
    if (s.showCameraPreview) this.ui.drawPreview(this.tracker.video, this.tracker.latest?.landmarks ?? null, TIP_INDEX[s.bladeLandmark]);
    this.ui.debug(
      s.showDebug
        ? [
            `render   ${this.fps.toFixed(0)} fps`,
            `tracking ${this.tracker.detectFps.toFixed(0)} fps  ${this.tracker.inferenceMs.toFixed(1)} ms  ${this.tracker.delegate || "-"}`,
            `blade    ${this.blade.source ?? "-"}  ${this.blade.speed.toFixed(2)} h/s  ${this.blade.live ? "LIVE" : "idle"}`,
            `time     ×${this.timeFx.scale.toFixed(2)}`,
          ].join("\n")
        : null,
    );

    // 4. Render
    r.render(realDt);
  };

  private checkHandLost(dt: number) {
    if (!this.tracker.ready || this.blade.source !== "hand") {
      this.handMissing = 0;
      return;
    }
    if (this.blade.visible) {
      this.handMissing = 0;
      return;
    }
    this.handMissing += dt;
    if (this.handMissing > HAND_LOST_PAUSE && this.game?.state === "playing") {
      this.pause("Hand lost: <b>show your hand</b> to the camera, then slice <b>Resume</b>");
    }
  }

  private updateHandStatus() {
    const t = this.tracker;
    if (this.state === "splash") return;
    if (t.status === "camera") this.ui.handStatus("searching", "Starting camera…");
    else if (t.status === "model") this.ui.handStatus("searching", "Loading hand model…");
    else if (t.status === "no-camera" || t.status === "error") this.ui.handStatus("off", "No camera · mouse mode");
    else if (t.ready) {
      if (t.latest?.landmarks && performance.now() / 1000 - t.latest.t < 0.5) this.ui.handStatus("ok", `Hand tracked · ${t.detectFps.toFixed(0)} fps`);
      else this.ui.handStatus("searching", "Show your hand to the camera");
    }
  }

  private updateEmbers(dt: number) {
    const r = this.renderer;
    this.emberClock += dt;
    while (this.emberClock > 0.12) {
      this.emberClock -= 0.12;
      this.embers.emit({
        x: (Math.random() - 0.5) * r.viewW * 1.1,
        y: -r.viewH / 2 - 0.5,
        vx: (Math.random() - 0.5) * 0.4,
        vy: 0.5 + Math.random() * 1.1,
        life: 6 + Math.random() * 5,
        size: 0.05 + Math.random() * 0.09,
        sizeEnd: 0.02,
        color: this.emberColor,
        intensity: 2.2 + Math.random() * 2,
        flutter: 0.6,
        alpha: 0.9,
      });
    }
    this.embers.update(dt);
  }
}

/** The landmark that drives the blade, in normalized (raw video) coordinates. */
function bladePoint(lm: NormalizedLandmark[], which: Settings["bladeLandmark"]) {
  if (which === "palm") {
    let x = 0;
    let y = 0;
    for (const i of PALM) {
      x += lm[i].x;
      y += lm[i].y;
    }
    return { x: x / PALM.length, y: y / PALM.length };
  }
  const l = lm[TIP_INDEX[which]];
  return { x: l.x, y: l.y };
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
