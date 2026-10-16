import * as THREE from "three";
import { splatTextures } from "./textures";

interface Splat {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  age: number;
  life: number;
}

const Z = -2.5;

/** Juice stains left on the dojo wall behind the fruit. They fade out after a few seconds. */
export class Splatters {
  readonly group = new THREE.Group();
  private pool: Splat[] = [];
  private textures = splatTextures(6);
  private geo = new THREE.PlaneGeometry(1, 1);
  private next = 0;

  constructor(max = 24) {
    for (let i = 0; i < max; i++) {
      const mat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, opacity: 0 });
      const mesh = new THREE.Mesh(this.geo, mat);
      mesh.visible = false;
      mesh.renderOrder = -10;
      this.group.add(mesh);
      this.pool.push({ mesh, mat, age: 0, life: 0 });
    }
  }

  add(x: number, y: number, color: THREE.Color, scale: number) {
    const s = this.pool[this.next];
    this.next = (this.next + 1) % this.pool.length;
    s.mat.map = this.textures[Math.floor(Math.random() * this.textures.length)];
    s.mat.color.copy(color).multiplyScalar(0.9);
    s.mat.needsUpdate = true;
    const k = (20 - Z) / 20; // compensate for perspective so size matches the fruit plane
    s.mesh.position.set(x * k, y * k, Z);
    s.mesh.rotation.z = Math.random() * Math.PI * 2;
    s.mesh.scale.setScalar(scale * k);
    s.mesh.visible = true;
    s.age = 0;
    s.life = 3.2 + Math.random();
    s.mesh.userData.targetScale = scale * k;
  }

  update(dt: number) {
    for (const s of this.pool) {
      if (!s.mesh.visible) continue;
      s.age += dt;
      const pop = Math.min(1, s.age / 0.08);
      const fade = s.age > s.life ? Math.max(0, 1 - (s.age - s.life) / 1.2) : 1;
      s.mat.opacity = 0.85 * fade;
      s.mesh.scale.setScalar(s.mesh.userData.targetScale * (0.6 + 0.4 * pop));
      // stains slowly drip down
      s.mesh.position.y -= dt * 0.04;
      if (fade <= 0) s.mesh.visible = false;
    }
  }

  clear() {
    for (const s of this.pool) s.mesh.visible = false;
  }
}
