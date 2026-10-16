import * as THREE from "three";
import type { FruitAsset } from "./fruitModels";
import type { Particles } from "../render/Particles";
import type { Splatters } from "../render/Splatters";
import type { Renderer } from "../render/Renderer";

/** A sliced half (or any other debris) tumbling under gravity. */
interface Piece {
  obj: THREE.Object3D;
  vel: THREE.Vector3;
  axis: THREE.Vector3;
  spin: number;
  age: number;
}

const _q = new THREE.Quaternion();
const _a = new THREE.Vector3();
const _n = new THREE.Vector3();
const WHITE = new THREE.Color(1, 1, 1);

export interface SliceInfo {
  /** swipe direction (unit, world xy) */
  dx: number;
  dy: number;
  /** blade speed in screen heights / s */
  speed: number;
}

/**
 * Shared physics + effects for things being cut: spawns the two halves
 * oriented along the cut, juice spray, sparks and stains. Used by both the
 * game and the slice-to-select menus.
 */
export class World {
  readonly root = new THREE.Group();
  gravity = 15;
  private pieces: Piece[] = [];

  constructor(
    readonly renderer: Renderer,
    readonly droplets: Particles,
    readonly glow: Particles,
    readonly smoke: Particles,
    readonly splats: Splatters,
  ) {}

  /**
   * Replace a whole fruit object with its two halves, split along the swipe.
   * The fruit's current rotation is preserved as much as possible (minimal
   * rotation that brings the model's cut plane in line with the swipe), so
   * there's no visible pop when the halves appear.
   */
  slice(asset: FruitAsset, whole: THREE.Object3D, vel: THREE.Vector3, info: SliceInfo) {
    const pos = whole.position;
    // Cut plane normal: perpendicular to the swipe, in the screen plane.
    _n.set(-info.dy, info.dx, 0).normalize();
    _a.set(1, 0, 0).applyQuaternion(whole.quaternion);
    _q.setFromUnitVectors(_a, _n).multiply(whole.quaternion);

    const [ha, hb] = asset.halves();
    // Menu fruits are displayed larger than in-game ones; keep the halves the same size.
    const k = whole.scale.x / asset.size;
    if (Math.abs(k - 1) > 1e-3) {
      ha.scale.multiplyScalar(k);
      hb.scale.multiplyScalar(k);
    }
    const off = asset.halfOffset * asset.size * k;
    const sep = 2.2 + Math.min(info.speed, 6) * 0.45;
    const spin = 4 + Math.random() * 3;
    const swipe = new THREE.Vector3(info.dx, info.dy, 0);

    for (const [obj, side] of [[ha, 1], [hb, -1]] as const) {
      obj.quaternion.copy(_q);
      obj.position.copy(pos).addScaledVector(_n, side * off);
      this.root.add(obj);
      const v = vel.clone().multiplyScalar(0.55).addScaledVector(_n, side * sep).addScaledVector(swipe, 1.4);
      v.z = (Math.random() - 0.5) * 1.5;
      // Spin about the swipe axis so each cut face turns towards the camera.
      this.pieces.push({ obj, vel: v, axis: swipe.clone(), spin: -side * spin, age: 0 });
    }

    whole.parent?.remove(whole);
    this.juice(pos.x, pos.y, info, asset.juice, asset.size * k);
    this.splats.add(pos.x, pos.y, asset.splat, asset.size * k * (2.3 + Math.random() * 0.9));
  }

  /** Juice spray: droplets flung mostly along the swipe plus a radial burst and fine mist. */
  juice(x: number, y: number, info: SliceInfo, color: THREE.Color, size: number) {
    const s = Math.min(info.speed, 6);
    const n = 42 + Math.floor(s * 6);
    for (let i = 0; i < n; i++) {
      const along = Math.random() < 0.55;
      let vx: number;
      let vy: number;
      if (along) {
        const sgn = Math.random() < 0.75 ? 1 : -1;
        const sp = (2 + Math.random() * 6 + s) * sgn;
        const spread = (Math.random() - 0.5) * 2.4;
        vx = info.dx * sp - info.dy * spread;
        vy = info.dy * sp + info.dx * spread;
      } else {
        const a = Math.random() * Math.PI * 2;
        const sp = 1.5 + Math.random() * 5;
        vx = Math.cos(a) * sp;
        vy = Math.sin(a) * sp;
      }
      this.droplets.emit({
        x: x + (Math.random() - 0.5) * size * 0.6,
        y: y + (Math.random() - 0.5) * size * 0.6,
        z: 0.6,
        vx,
        vy: vy + 2,
        vz: (Math.random() - 0.3) * 3,
        life: 0.5 + Math.random() * 0.6,
        size: (0.07 + Math.random() * 0.17) * (0.8 + size * 0.4),
        sizeEnd: 0.03,
        color,
        intensity: 1.15,
        gravity: this.gravity * 0.9,
        drag: 1.4,
      });
    }
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2;
      this.glow.emit({
        x,
        y,
        z: 0.8,
        vx: Math.cos(a) * 1.4,
        vy: Math.sin(a) * 1.4,
        life: 0.35 + Math.random() * 0.25,
        size: size * (1.0 + Math.random() * 1.1),
        sizeEnd: size * 2.1,
        color,
        intensity: 0.22,
        drag: 3,
      });
    }
    // white-hot flash at the cut
    this.glow.emit({ x, y, z: 1, vx: 0, vy: 0, life: 0.1, size: size * 1.7, sizeEnd: size * 2.3, color: WHITE, intensity: 0.75 });
  }

  /** Bright sparks (criticals, bomb fuse, power-ups). */
  sparks(x: number, y: number, color: THREE.Color, count: number, speed = 8, intensity = 3) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = speed * (0.3 + Math.random() * 0.9);
      this.glow.emit({
        x,
        y,
        z: 1,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0.3 + Math.random() * 0.5,
        size: 0.12 + Math.random() * 0.2,
        sizeEnd: 0.02,
        color,
        intensity,
        gravity: this.gravity * 0.4,
        drag: 2.2,
      });
    }
  }

  explosion(x: number, y: number) {
    const fire = new THREE.Color("#ff7a1a");
    const hot = new THREE.Color("#ffe2a0");
    const smoke = new THREE.Color("#2a2420");
    this.sparks(x, y, hot, 90, 18, 4);
    this.sparks(x, y, fire, 60, 10, 3);
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 1 + Math.random() * 3.5;
      this.smoke.emit({
        x: x + Math.cos(a) * 0.3,
        y: y + Math.sin(a) * 0.3,
        z: 0.5,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp + 0.8,
        life: 1.2 + Math.random() * 1,
        size: 1.4 + Math.random() * 1.6,
        sizeEnd: 4 + Math.random() * 2,
        color: smoke,
        alpha: 0.5,
        drag: 1.8,
        gravity: -0.6,
      });
    }
    this.glow.emit({ x, y, z: 1, vx: 0, vy: 0, life: 0.5, size: 6, sizeEnd: 12, color: hot, intensity: 2.5 });
  }

  update(dt: number) {
    const bottom = -this.renderer.viewH / 2 - 3;
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const p = this.pieces[i];
      p.age += dt;
      p.vel.y -= this.gravity * dt;
      p.obj.position.addScaledVector(p.vel, dt);
      p.obj.rotateOnWorldAxis(p.axis, p.spin * dt);
      if (p.obj.position.y < bottom || p.age > 6) {
        this.root.remove(p.obj);
        this.pieces.splice(i, 1);
      }
    }
  }

  clear() {
    for (const p of this.pieces) this.root.remove(p.obj);
    this.pieces.length = 0;
  }
}
