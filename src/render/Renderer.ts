import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import {
  BloomEffect,
  ChromaticAberrationEffect,
  EffectComposer,
  EffectPass,
  RenderPass,
  ShockWaveEffect,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from "postprocessing";

/**
 * Three.js renderer + HDR post-processing and screen shake.
 *
 * Performance notes:
 * - Bloom, chromatic aberration, vignette and tone mapping share ONE
 *   full-screen pass. The shock-wave distortion has its own pass that is only
 *   enabled for the second after a bomb goes off.
 * - Resolution and MSAA are chosen by the adaptive quality governor
 *   (see setQuality).
 *
 * Gameplay happens on the z = 0 plane. `viewW` × `viewH` is the size of the
 * visible area on that plane in world units.
 */
export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly composer: EffectComposer;
  viewW = 1;
  viewH = 1;
  width = 1;
  height = 1;
  pixelRatio = 1;
  onResize: (() => void) | null = null;

  private readonly camZ = 20;
  private bloom: BloomEffect;
  private chroma: ChromaticAberrationEffect;
  private shock: ShockWaveEffect;
  private mainPass: EffectPass;
  private shockPass: EffectPass;
  private shockLeft = 0;
  private trauma = 0;
  private shakeTime = 0;
  private chromaAmount = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.gl = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: "high-performance",
      stencil: false,
      depth: true,
    });
    this.gl.setClearColor(0x0b0705, 1);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    this.camera.position.set(0, 0, this.camZ);

    // Image-based lighting for nice reflections on glossy fruit skins.
    const pmrem = new THREE.PMREMGenerator(this.gl);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();

    const key = new THREE.DirectionalLight(0xfff1dc, 2.4);
    key.position.set(-6, 9, 12);
    const rim = new THREE.DirectionalLight(0x9fd8ff, 1.6);
    rim.position.set(8, 4, -10);
    const fill = new THREE.HemisphereLight(0xffe2c4, 0x2a1408, 0.7);
    this.scene.add(key, rim, fill);

    this.composer = new EffectComposer(this.gl, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    this.chroma = new ChromaticAberrationEffect({ offset: new THREE.Vector2(0, 0), radialModulation: true, modulationOffset: 0.2 });
    this.bloom = new BloomEffect({ intensity: 1.15, luminanceThreshold: 0.72, luminanceSmoothing: 0.25, mipmapBlur: true, radius: 0.72, levels: 6 });
    const vignette = new VignetteEffect({ offset: 0.3, darkness: 0.62 });
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    // Chromatic aberration samples the input buffer, so it goes first.
    this.mainPass = new EffectPass(this.camera, this.chroma, this.bloom, vignette, tone);
    this.composer.addPass(this.mainPass);

    this.shock = new ShockWaveEffect(this.camera, new THREE.Vector3(), { speed: 1.6, maxRadius: 0.9, waveSize: 0.22, amplitude: 0.09 });
    this.shockPass = new EffectPass(this.camera, this.shock);
    this.composer.addPass(this.shockPass);
    this.setShockPass(false);

    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  /** Render one frame with the shock-wave pass on and off, so both shader variants are compiled up front. */
  prewarm() {
    this.setShockPass(true);
    this.composer.render(0.016);
    this.setShockPass(false);
    this.composer.render(0.016);
  }

  setBloom(on: boolean) {
    this.bloom.intensity = on ? 1.15 : 0;
  }

  /** Applies a quality level from the adaptive governor. */
  setQuality(pixelRatio: number, msaa: number) {
    if (this.composer.multisampling !== msaa) this.composer.multisampling = msaa;
    if (Math.abs(pixelRatio - this.pixelRatio) < 0.01) return;
    this.pixelRatio = pixelRatio;
    this.resize();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.width = w;
    this.height = h;
    this.gl.setPixelRatio(this.pixelRatio);
    this.gl.setSize(w, h, false);
    this.composer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.viewH = 2 * this.camZ * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    this.viewW = this.viewH * this.camera.aspect;
    this.onResize?.();
  }

  get aspect() {
    return this.width / this.height;
  }

  get bufferHeight() {
    return Math.round(this.height * this.pixelRatio);
  }

  addTrauma(amount: number) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  shockwave(x: number, y: number) {
    this.shock.position.set(x, y, 0);
    this.shock.explode();
    this.shockLeft = 1.4;
    this.setShockPass(true);
  }

  private setShockPass(on: boolean) {
    this.shockPass.enabled = on;
    this.shockPass.renderToScreen = on;
    this.mainPass.renderToScreen = !on;
  }

  pulseChroma(amount: number) {
    this.chromaAmount = Math.max(this.chromaAmount, amount);
  }

  worldToPixels(x: number, y: number, z = 0, out = { x: 0, y: 0 }) {
    const v = _v.set(x, y, z).project(this.camera);
    out.x = (v.x * 0.5 + 0.5) * this.width;
    out.y = (-v.y * 0.5 + 0.5) * this.height;
    return out;
  }

  render(dt: number) {
    // Screen shake: offset ∝ trauma², smooth noise so it feels physical.
    this.shakeTime += dt;
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    const s = this.trauma * this.trauma;
    const t = this.shakeTime * 28;
    this.camera.position.x = (Math.sin(t * 1.1) + Math.sin(t * 2.3) * 0.5) * 0.35 * s;
    this.camera.position.y = (Math.cos(t * 1.3) + Math.sin(t * 2.9) * 0.5) * 0.35 * s;
    this.camera.rotation.z = Math.sin(t * 0.9) * 0.025 * s;

    this.chromaAmount = Math.max(0, this.chromaAmount - dt * 2.2);
    const c = this.chromaAmount * 0.012;
    this.chroma.offset.set(c, c * 0.6);

    if (this.shockLeft > 0) {
      this.shockLeft -= dt;
      if (this.shockLeft <= 0) this.setShockPass(false);
    }

    this.composer.render(dt);
  }
}

const _v = new THREE.Vector3();
