import * as THREE from "three";

export interface ParticleSpec {
  x: number;
  y: number;
  z?: number;
  vx: number;
  vy: number;
  vz?: number;
  life: number;
  size: number;
  sizeEnd?: number;
  color: THREE.Color;
  /** Multiplier on color (HDR > 1 makes it bloom). */
  intensity?: number;
  gravity?: number;
  drag?: number;
  alpha?: number;
  /** Sideways flutter amplitude (embers). */
  flutter?: number;
}

const vert = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
uniform float uScale;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = max(1.0, aSize * uScale / -mv.z);
  gl_Position = projectionMatrix * mv;
  vColor = aColor;
  vAlpha = aAlpha;
}`;

const fragDroplet = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float a = smoothstep(0.5, 0.38, d);
  // tiny specular highlight so droplets read as liquid
  float spec = smoothstep(0.16, 0.0, length(c - vec2(-0.14, -0.14)));
  vec3 col = vColor * (0.75 + 0.25 * smoothstep(0.5, 0.0, d)) + spec * 0.9;
  if (a * vAlpha < 0.01) discard;
  gl_FragColor = vec4(col, a * vAlpha);
}`;

const fragGlow = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d);
  a *= a;
  gl_FragColor = vec4(vColor * a * vAlpha, 1.0);
}`;

const fragSmoke = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = pow(smoothstep(0.5, 0.0, d), 1.6) * vAlpha;
  if (a < 0.005) discard;
  gl_FragColor = vec4(vColor, a);
}`;

/**
 * CPU-simulated particle pool rendered as a single THREE.Points draw call.
 * Dead particles are swap-removed so the live set is always [0, count).
 */
export class Particles {
  readonly points: THREE.Points;
  private readonly max: number;
  private count = 0;
  private time = 0;

  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;

  private vel: Float32Array;
  private baseCol: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private size0: Float32Array;
  private size1: Float32Array;
  private grav: Float32Array;
  private drag: Float32Array;
  private alpha0: Float32Array;
  private flutter: Float32Array;
  private material: THREE.ShaderMaterial;

  constructor(max: number, kind: "droplet" | "glow" | "smoke") {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.vel = new Float32Array(max * 3);
    this.baseCol = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.size0 = new Float32Array(max);
    this.size1 = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.alpha0 = new Float32Array(max);
    this.flutter = new Float32Array(max);

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("aColor", new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("aSize", new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("aAlpha", new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);

    this.material = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: kind === "droplet" ? fragDroplet : kind === "smoke" ? fragSmoke : fragGlow,
      uniforms: { uScale: { value: 500 } },
      transparent: true,
      depthWrite: false,
      blending: kind === "glow" ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = kind === "smoke" ? 4 : kind === "droplet" ? 5 : 10;
  }

  /** Call on resize: pixels-per-world-unit at distance 1 in drawing-buffer pixels. */
  setScale(bufferHeight: number, fovDeg: number) {
    this.material.uniforms.uScale.value = bufferHeight / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg / 2)));
  }

  emit(p: ParticleSpec) {
    if (this.count >= this.max) return;
    const i = this.count++;
    const i3 = i * 3;
    this.pos[i3] = p.x;
    this.pos[i3 + 1] = p.y;
    this.pos[i3 + 2] = p.z ?? 0;
    this.vel[i3] = p.vx;
    this.vel[i3 + 1] = p.vy;
    this.vel[i3 + 2] = p.vz ?? 0;
    const k = p.intensity ?? 1;
    this.baseCol[i3] = p.color.r * k;
    this.baseCol[i3 + 1] = p.color.g * k;
    this.baseCol[i3 + 2] = p.color.b * k;
    this.life[i] = p.life;
    this.maxLife[i] = p.life;
    this.size0[i] = p.size;
    this.size1[i] = p.sizeEnd ?? p.size * 0.3;
    this.grav[i] = p.gravity ?? 0;
    this.drag[i] = p.drag ?? 0;
    this.alpha0[i] = p.alpha ?? 1;
    this.flutter[i] = p.flutter ?? 0;
  }

  update(dt: number) {
    this.time += dt;
    let i = 0;
    while (i < this.count) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.kill(i);
        continue;
      }
      const i3 = i * 3;
      const d = Math.exp(-this.drag[i] * dt);
      this.vel[i3] *= d;
      this.vel[i3 + 1] = this.vel[i3 + 1] * d - this.grav[i] * dt;
      this.vel[i3 + 2] *= d;
      if (this.flutter[i] > 0) this.vel[i3] += Math.sin(this.time * 3 + i * 1.7) * this.flutter[i] * dt;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;

      const t = 1 - this.life[i] / this.maxLife[i]; // 0 → 1
      this.size[i] = this.size0[i] + (this.size1[i] - this.size0[i]) * t;
      const fadeIn = Math.min(1, t * 12);
      const fadeOut = 1 - t * t;
      this.alpha[i] = this.alpha0[i] * fadeIn * fadeOut;
      this.col[i3] = this.baseCol[i3];
      this.col[i3 + 1] = this.baseCol[i3 + 1];
      this.col[i3 + 2] = this.baseCol[i3 + 2];
      i++;
    }
    const g = this.points.geometry;
    g.setDrawRange(0, this.count);
    for (const name of ["position", "aColor", "aSize", "aAlpha"]) {
      (g.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  clear() {
    this.count = 0;
    this.points.geometry.setDrawRange(0, 0);
  }

  private kill(i: number) {
    const last = --this.count;
    if (i === last) return;
    const i3 = i * 3;
    const l3 = last * 3;
    for (let k = 0; k < 3; k++) {
      this.pos[i3 + k] = this.pos[l3 + k];
      this.vel[i3 + k] = this.vel[l3 + k];
      this.baseCol[i3 + k] = this.baseCol[l3 + k];
      this.col[i3 + k] = this.col[l3 + k];
    }
    this.life[i] = this.life[last];
    this.maxLife[i] = this.maxLife[last];
    this.size0[i] = this.size0[last];
    this.size1[i] = this.size1[last];
    this.size[i] = this.size[last];
    this.grav[i] = this.grav[last];
    this.drag[i] = this.drag[last];
    this.alpha0[i] = this.alpha0[last];
    this.alpha[i] = this.alpha[last];
    this.flutter[i] = this.flutter[last];
  }
}
