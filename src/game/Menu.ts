import * as THREE from "three";
import gsap from "gsap";
import type { Blade } from "../input/Blade";
import type { Renderer } from "../render/Renderer";
import { ringTexture } from "../render/textures";
import { getCatalogue, type FruitAsset } from "./fruitModels";
import type { World } from "./World";
import type { AudioEngine } from "../audio/AudioEngine";
import type { TimeFx } from "../core/TimeFx";

export interface RingSpec {
  id: string;
  label: string;
  fruit: string;
  /** Position as a fraction of the view: x ∈ [-0.5, 0.5] of width, y ∈ [-0.5, 0.5] of height. */
  x: number;
  y: number;
  scale?: number;
  color?: string;
  glow?: string;
  /** Small HTML caption under the ring. */
  caption?: string;
}

interface Item {
  spec: RingSpec;
  asset: FruitAsset;
  fruit: THREE.Object3D;
  ring: THREE.Mesh;
  ringMat: THREE.MeshBasicMaterial;
  label: HTMLDivElement;
  radius: number;
  scale: number;
  sliced: boolean;
  phase: number;
}

const ringCache = new Map<string, THREE.Texture>();

/**
 * Fruit Ninja-style menus: each option is a fruit inside a rotating ring of
 * text. Slice the fruit (or click it) to choose.
 */
export class Menu {
  readonly group = new THREE.Group();
  onSelect: ((id: string) => void) | null = null;
  private items: Item[] = [];
  private time = 0;
  private locked = false;

  constructor(
    private renderer: Renderer,
    private world: World,
    private audio: AudioEngine,
    private timeFx: TimeFx,
    private labelRoot: HTMLElement,
  ) {}

  get active() {
    return this.items.length > 0;
  }

  show(specs: RingSpec[]) {
    this.hide(true);
    this.locked = false;
    const cat = getCatalogue();
    specs.forEach((spec, i) => {
      const asset = cat.byId[spec.fruit] ?? cat.fruits[0];
      const scale = spec.scale ?? 1;
      const key = `${spec.label}|${spec.color}`;
      let tex = ringCache.get(key);
      if (!tex) {
        tex = ringTexture(spec.label.toUpperCase(), spec.color ?? "#ffe7b0", spec.glow ?? "#ff9d2e");
        ringCache.set(key, tex);
      }
      const ringMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 1, color: new THREE.Color(1.6, 1.6, 1.6) });
      const ring = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), ringMat);
      ring.renderOrder = -5;
      const fruit = asset.whole();
      const label = document.createElement("div");
      label.className = "ring-caption";
      label.innerHTML = spec.caption ?? "";
      this.labelRoot.appendChild(label);
      this.group.add(ring, fruit);
      const item: Item = { spec, asset, fruit, ring, ringMat, label, radius: 0, scale, sliced: false, phase: i * 1.3 };
      this.items.push(item);
      this.layoutItem(item);
      ring.scale.setScalar(0.001);
      fruit.visible = false;
      gsap.to(ring.scale, { x: item.radius * 2.5, y: item.radius * 2.5, duration: 0.6, delay: 0.1 + i * 0.1, ease: "back.out(1.8)" });
      gsap.delayedCall(0.25 + i * 0.1, () => (fruit.visible = true));
      gsap.fromTo(label, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.5, delay: 0.4 + i * 0.1 });
    });
  }

  hide(immediate = false) {
    for (const it of this.items) {
      gsap.killTweensOf(it.ring.scale);
      gsap.killTweensOf(it.label);
      if (immediate) {
        this.group.remove(it.ring, it.fruit);
        it.label.remove();
      } else {
        gsap.to(it.ring.scale, { x: 0.001, y: 0.001, duration: 0.3, ease: "back.in(2)", onComplete: () => this.group.remove(it.ring) });
        gsap.to(it.label, { opacity: 0, duration: 0.2, onComplete: () => it.label.remove() });
        if (!it.sliced) this.group.remove(it.fruit);
      }
    }
    this.items = [];
  }

  layout() {
    for (const it of this.items) {
      this.layoutItem(it);
      if (!gsap.isTweening(it.ring.scale)) it.ring.scale.setScalar(it.radius * 2.5);
    }
  }

  private layoutItem(it: Item) {
    const { viewW, viewH } = this.renderer;
    // Keep rings inside the screen on narrow (portrait) displays.
    const unit = Math.min(viewH, viewW * 0.62) / 14.5;
    it.radius = 1.9 * it.scale * unit;
    const x = it.spec.x * viewW;
    const y = it.spec.y * viewH;
    it.ring.position.set(x, y, -0.5);
    it.fruit.position.set(x, y, 0);
    // Round fruit fill the ring's inner circle; the long, thin banana can be bigger.
    const display = it.asset.power ? 1.4 : 1.12;
    it.fruit.scale.setScalar(it.asset.size * display * it.scale * unit);
    const p = this.renderer.worldToPixels(x, y - it.radius * 1.12);
    it.label.style.left = `${p.x}px`;
    it.label.style.top = `${p.y}px`;
  }

  update(dt: number, blade: Blade) {
    this.time += dt;
    for (const it of this.items) {
      it.ring.rotation.z -= dt * 0.35;
      if (!it.sliced) {
        it.fruit.rotation.y += dt * 0.9;
        it.fruit.rotation.x = Math.sin(this.time * 0.8 + it.phase) * 0.25;
        it.fruit.position.y = it.spec.y * this.renderer.viewH + Math.sin(this.time * 1.6 + it.phase) * 0.12;
      }
    }
    if (!this.locked && blade.cutting) {
      for (const it of this.items) {
        const p = it.fruit.position;
        if (blade.hits(p.x, p.y, it.radius * 0.8)) {
          this.select(it, blade.dir.x, blade.dir.y, Math.max(blade.speed, 2));
          break;
        }
      }
    }
  }

  /** Mouse/touch click selection (world coordinates). */
  clickAt(x: number, y: number) {
    if (this.locked) return;
    for (const it of this.items) {
      const p = it.fruit.position;
      if (Math.hypot(p.x - x, p.y - y) <= it.radius * 0.9) {
        this.select(it, Math.SQRT1_2, -Math.SQRT1_2, 3);
        return;
      }
    }
  }

  /** Item under a world-space point (for hover feedback). */
  hovering(x: number, y: number) {
    return this.items.find((it) => Math.hypot(it.fruit.position.x - x, it.fruit.position.y - y) <= it.radius * 0.9) ?? null;
  }

  private select(it: Item, dx: number, dy: number, speed: number) {
    this.locked = true;
    it.sliced = true;
    this.world.slice(it.asset, it.fruit, new THREE.Vector3(0, 1.5, 0), { dx, dy, speed });
    this.audio.whoosh(speed, 0);
    this.audio.slice(0, true);
    this.audio.uiSelect();
    this.timeFx.hitStop(0.06);
    this.renderer.addTrauma(0.25);
    gsap.to(it.ring.scale, { x: it.radius * 3.4, y: it.radius * 3.4, duration: 0.45, ease: "power2.out" });
    gsap.to(it.ringMat, { opacity: 0, duration: 0.45 });
    const id = it.spec.id;
    gsap.delayedCall(0.5, () => this.onSelect?.(id));
  }
}
