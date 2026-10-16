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
 * Three.js renderer + HDR post-processing stack (bloom, tone mapping,
 * vignette, shock wave, chromatic aberration) and screen shake.
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

  private readonly camZ = 20;
  private bloom: BloomEffect;
  private chroma: ChromaticAberrationEffect;
  private shock: ShockWaveEffect;
  private bloomPass: EffectPass;
  private trauma = 0;
  private shakeTime = 0;
  private chromaAmount = 0;
  private highQuality = true;

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

    this.composer = new EffectComposer(this.gl, { frameBufferType: THREE.HalfFloatType, multisampling: 4 });
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    this.bloom = new BloomEffect({ intensity: 1.15, luminanceThreshold: 0.72, luminanceSmoothing: 0.25, mipmapBlur: true, radius: 0.72 });
    const vignette = new VignetteEffect({ offset: 0.3, darkness: 0.62 });
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    this.bloomPass = new EffectPass(this.camera, this.bloom, vignette, tone);
    this.composer.addPass(this.bloomPass);

    this.shock = new ShockWaveEffect(this.camera, new THREE.Vector3(), { speed: 1.6, maxRadius: 0.9, waveSize: 0.22, amplitude: 0.09 });
    this.composer.addPass(new EffectPass(this.camera, this.shock));

    this.chroma = new ChromaticAberrationEffect({
      offset: new THREE.Vector2(0.0005, 0.0005),
      radialModulation: true,
      modulationOffset: 0.2,
    });
    this.composer.addPass(new EffectPass(this.camera, this.chroma));

    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  setQuality(high: boolean, bloom: boolean) {
    this.highQuality = high;
    this.bloom.intensity = bloom ? 1.15 : 0;
    this.composer.multisampling = high ? 4 : 0;
    this.resize();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.width = w;
    this.height = h;
    const dpr = this.highQuality ? Math.min(window.devicePixelRatio, 2) : Math.min(window.devicePixelRatio, 1);
    this.gl.setPixelRatio(dpr);
    this.gl.setSize(w, h, false);
    this.composer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.viewH = 2 * this.camZ * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    this.viewW = this.viewH * this.camera.aspect;
  }

  get aspect() {
    return this.width / this.height;
  }

  /** Pixels-per-world-unit at z = 0 (CSS px). */
  get pxPerUnit() {
    return this.height / this.viewH;
  }

  addTrauma(amount: number) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  shockwave(x: number, y: number) {
    this.shock.position.set(x, y, 0);
    this.shock.explode();
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
    const c = 0.0005 + this.chromaAmount * 0.012;
    this.chroma.offset.set(c, c * 0.6);

    this.composer.render(dt);
  }
}

const _v = new THREE.Vector3();
