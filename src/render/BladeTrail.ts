import * as THREE from "three";
import type { Blade } from "../input/Blade";
import { glowTexture } from "./textures";

const MAX = 200;
const SUBDIV = 4;
const Z = 1.5;

const vert = /* glsl */ `
attribute float aT;
attribute float aSide;
attribute float aHeat;
varying float vT;
varying float vSide;
varying float vHeat;
void main() {
  vT = aT; vSide = aSide; vHeat = aHeat;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const frag = /* glsl */ `
uniform vec3 uColor;
varying float vT;
varying float vSide;
varying float vHeat;
void main() {
  float e = abs(vSide);
  float core = smoothstep(0.42, 0.0, e);
  float glow = smoothstep(1.0, 0.1, e);
  vec3 col = mix(uColor * 2.4, vec3(3.2, 3.2, 3.4), core);
  float a = glow * pow(clamp(vT, 0.0, 1.0), 1.3) * clamp(vHeat, 0.0, 1.0);
  gl_FragColor = vec4(col * a, 1.0);
}`;

/**
 * The blade's light trail: a tapered ribbon through the recent blade
 * positions, smoothed with a Catmull-Rom spline, additive + HDR so it blooms.
 */
export class BladeTrail {
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh;
  private geo: THREE.BufferGeometry;
  private pos = new Float32Array(MAX * 2 * 3);
  private t = new Float32Array(MAX * 2);
  private side = new Float32Array(MAX * 2);
  private heat = new Float32Array(MAX * 2);
  private tip: THREE.Sprite;
  private tipMat: THREE.SpriteMaterial;
  private uniforms = { uColor: { value: new THREE.Color("#5fdcff") } };
  private smoothed: { x: number; y: number; h: number }[] = [];

  constructor() {
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("aT", new THREE.BufferAttribute(this.t, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("aSide", new THREE.BufferAttribute(this.side, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("aHeat", new THREE.BufferAttribute(this.heat, 1).setUsage(THREE.DynamicDrawUsage));
    const idx: number[] = [];
    for (let i = 0; i < MAX - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.geo.setIndex(idx);
    this.geo.setDrawRange(0, 0);

    const mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 100;
    this.group.add(this.mesh);

    this.tipMat = new THREE.SpriteMaterial({
      map: glowTexture(),
      color: this.uniforms.uColor.value.clone().multiplyScalar(2),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      transparent: true,
    });
    this.tip = new THREE.Sprite(this.tipMat);
    this.tip.renderOrder = 101;
    this.group.add(this.tip);
  }

  set color(c: string) {
    this.uniforms.uColor.value.set(c);
    this.tipMat.color.set(c).multiplyScalar(2);
  }

  update(blade: Blade, viewH: number) {
    // Tip / cursor: always shown while the blade is tracked, so the player
    // can see where their finger is even when not cutting.
    this.tip.visible = blade.visible;
    if (blade.visible) {
      const k = (20 - Z) / 20;
      this.tip.position.set(blade.head.x * k, blade.head.y * k, Z);
      const s = blade.live ? 1.1 : 0.7;
      this.tip.scale.setScalar(s * (viewH / 14.5));
      // Fade the tip while tracking has briefly lost the hand, instead of
      // leaving it frozen where the hand used to be.
      const fade = 1 - 0.75 * blade.staleness * blade.staleness;
      this.tipMat.opacity = (blade.live ? 1 : 0.65) * fade;
    }

    const pts = blade.trail;
    if (pts.length < 2) {
      this.geo.setDrawRange(0, 0);
      return;
    }

    // Catmull-Rom subdivision for a smooth arc even at camera frame rates.
    const sm = this.smoothed;
    sm.length = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(pts.length - 1, i + 2)];
      for (let s = 0; s < SUBDIV; s++) {
        const u = s / SUBDIV;
        const u2 = u * u;
        const u3 = u2 * u;
        const cr = (a: number, b: number, c: number, d: number) =>
          0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u2 + (-a + 3 * b - 3 * c + d) * u3);
        sm.push({ x: cr(p0.x, p1.x, p2.x, p3.x), y: cr(p0.y, p1.y, p2.y, p3.y), h: p1.heat + (p2.heat - p1.heat) * u });
      }
    }
    const last = pts[pts.length - 1];
    sm.push({ x: last.x, y: last.y, h: last.heat });
    if (sm.length > MAX) sm.splice(0, sm.length - MAX);

    const n = sm.length;
    const maxW = 0.2 * (viewH / 14.5);
    const k = (20 - Z) / 20;
    for (let i = 0; i < n; i++) {
      const p = sm[i];
      const a = sm[Math.max(0, i - 1)];
      const b = sm[Math.min(n - 1, i + 1)];
      let tx = b.x - a.x;
      let ty = b.y - a.y;
      const len = Math.hypot(tx, ty) || 1;
      tx /= len;
      ty /= len;
      const tt = i / (n - 1);
      const w = maxW * Math.pow(tt, 0.6) * (0.35 + 0.65 * p.h);
      const nx = -ty * w;
      const ny = tx * w;
      const v = i * 2;
      this.pos.set([(p.x + nx) * k, (p.y + ny) * k, Z, (p.x - nx) * k, (p.y - ny) * k, Z], v * 3);
      this.t[v] = this.t[v + 1] = tt;
      this.side[v] = 1;
      this.side[v + 1] = -1;
      this.heat[v] = this.heat[v + 1] = p.h;
    }
    this.geo.setDrawRange(0, (n - 1) * 6);
    for (const name of ["position", "aT", "aSide", "aHeat"]) {
      (this.geo.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
    }
  }
}
