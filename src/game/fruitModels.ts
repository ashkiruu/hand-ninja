import * as THREE from "three";
import { canvasTexture, fbm, glowTexture, hexRgb, makeCanvas, mix, paint, rand, valueNoise } from "../render/textures";

// Procedural 3D fruit.
//
// Every round fruit is a lathe (surface of revolution) around local Y. That
// makes slicing cheap and exact: cutting a lathe through its axis (the local
// plane x = 0) gives two half-lathes (phi 0..π and π..2π), and the cut face is
// just the 2D profile mirrored — a flat cap we texture with the fruit's flesh.
// At slice time the fruit is rotated so this local plane lines up with the
// swipe, so it always splits along the direction the player cut.

export type PowerUp = "freeze" | "frenzy" | "double";

/** Global size multiplier for everything thrown (fruit, bananas, bombs). */
export const FRUIT_SCALE = 1.4;

export interface FruitAsset {
  id: string;
  /** World scale applied to the unit-size model. */
  size: number;
  /** Collision radius in world units. */
  hitRadius: number;
  juice: THREE.Color;
  splat: THREE.Color;
  /** Builds a whole fruit. */
  whole(): THREE.Object3D;
  /** Builds the two halves: [+X side, −X side]. Each half's origin is its own centroid. */
  halves(): [THREE.Object3D, THREE.Object3D];
  /** Distance (unit model space) from the cut plane to each half's centroid. */
  halfOffset: number;
  power?: PowerUp;
}

type RGB = [number, number, number];
type Profile = THREE.Vector2[];

// ---------------------------------------------------------------------------
// Profiles (unit size, y up, bottom → top)
// ---------------------------------------------------------------------------

function lathe(fn: (th: number) => [number, number], n = 40): Profile {
  const pts: Profile = [];
  for (let i = 0; i <= n; i++) {
    const th = (i / n) * Math.PI;
    const [r, y] = fn(th);
    pts.push(new THREE.Vector2(i === 0 || i === n ? 0 : Math.max(0.001, r), y));
  }
  return pts;
}

const gauss = (x: number, w: number) => Math.exp(-(x / w) * (x / w));

const PROFILES = {
  sphere: (sy = 1) => lathe((t) => [Math.sin(t), -Math.cos(t) * sy]),
  watermelon: () => lathe((t) => [Math.sin(t), -Math.cos(t) * 1.25]),
  apple: () =>
    lathe((t) => {
      const y0 = -Math.cos(t);
      const r = Math.sin(t) * (1 + 0.1 * y0) * (1 - 0.06 * Math.sin(t * 3));
      const y = y0 * 0.88 - 0.3 * gauss(Math.PI - t, 0.32) + 0.16 * gauss(t, 0.28);
      return [r, y];
    }),
  lemon: (len: number) =>
    lathe((t) => {
      const tip = 0.18 * gauss(t, 0.22) + 0.18 * gauss(Math.PI - t, 0.22);
      return [Math.sin(t) * 0.82 * (1 - 0.25 * (gauss(t, 0.35) + gauss(Math.PI - t, 0.35))), -Math.cos(t) * (len + tip)];
    }),
  kiwi: () => lathe((t) => [Math.sin(t) * 0.9, -Math.cos(t) * 1.15]),
  strawberry: () =>
    lathe((t) => {
      const k = (1 - Math.cos(t)) / 2; // 0 bottom → 1 top
      const r = Math.pow(Math.sin(t), 0.75) * (0.42 + 0.62 * Math.pow(k, 0.8));
      return [r, -Math.cos(t) * 1.05 - 0.06];
    }),
};

function profileBounds(p: Profile) {
  let rmax = 0;
  let ymin = Infinity;
  let ymax = -Infinity;
  for (const v of p) {
    rmax = Math.max(rmax, v.x);
    ymin = Math.min(ymin, v.y);
    ymax = Math.max(ymax, v.y);
  }
  return { rmax, ymin, ymax };
}

function capGeometry(profile: Profile, side: 1 | -1) {
  const shape = new THREE.Shape();
  shape.moveTo(profile[0].x, profile[0].y);
  for (let i = 1; i < profile.length; i++) shape.lineTo(profile[i].x, profile[i].y);
  for (let i = profile.length - 2; i >= 1; i--) shape.lineTo(-profile[i].x, profile[i].y);
  const g = new THREE.ShapeGeometry(shape, 1);
  const { rmax, ymin, ymax } = profileBounds(profile);
  const pos = g.getAttribute("position");
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = (pos.getX(i) + rmax) / (2 * rmax);
    uv[i * 2 + 1] = (pos.getY(i) - ymin) / (ymax - ymin);
  }
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  // Shape lies in XY facing +Z. Turn it into the YZ plane facing away from its half.
  g.rotateY(side === 1 ? -Math.PI / 2 : Math.PI / 2);
  return g;
}

// ---------------------------------------------------------------------------
// Skin painters (lathe UV: u = around, v = bottom → top)
// ---------------------------------------------------------------------------

const SKIN_W = 512;
const SKIN_H = 256;

function skin(fn: (u: number, v: number) => RGB) {
  return canvasTexture(paint(SKIN_W, SKIN_H, (u, v) => fn(u, 1 - v)));
}

const pores = (u: number, v: number, f = 90) => {
  const n = valueNoise(u * f, v * f * 0.5, f);
  return n > 0.78 ? (n - 0.78) / 0.22 : 0;
};

const SKINS = {
  watermelon: () =>
    skin((u, v) => {
      const wob = (fbm(u * 6, v * 5, 3, 6) - 0.5) * 0.35 + Math.sin(v * 18) * 0.03;
      const s = Math.sin((u * 9 + wob) * Math.PI * 2);
      const stripe = Math.max(0, Math.min(1, (s - 0.05) * 3));
      const base = mix(hexRgb("#8fd157"), hexRgb("#5ea83a"), fbm(u * 20, v * 10, 3, 20));
      const c = mix(base, hexRgb("#1d4a17"), stripe * 0.92);
      const speck = valueNoise(u * 140, v * 70, 140) * 0.12;
      return mix(c, [255, 255, 220], speck * (1 - stripe));
    }),
  orange: () =>
    skin((u, v) => {
      const c = mix(hexRgb("#ff9a1f"), hexRgb("#f06b00"), fbm(u * 6, v * 3, 3, 6));
      return mix(c, hexRgb("#c44d00"), pores(u, v) * 0.5);
    }),
  apple: () =>
    skin((u, v) => {
      const streak = fbm(u * 36, v * 2.5, 4, 36);
      let c = mix(hexRgb("#9e0b16"), hexRgb("#e8322b"), streak);
      c = mix(c, hexRgb("#ffb347"), Math.pow(fbm(u * 5, v * 2, 3, 5), 3) * 0.6);
      c = mix(c, hexRgb("#c9b23c"), Math.max(0, (v - 0.86) / 0.14) * 0.55);
      const dot = valueNoise(u * 160, v * 80, 160);
      return mix(c, hexRgb("#ffd9a0"), dot > 0.9 ? 0.5 : 0);
    }),
  lemon: () =>
    skin((u, v) => {
      const c = mix(hexRgb("#ffe14a"), hexRgb("#f5bf00"), fbm(u * 6, v * 3, 3, 6));
      return mix(c, hexRgb("#d39a00"), pores(u, v, 110) * 0.45);
    }),
  lime: () =>
    skin((u, v) => {
      const c = mix(hexRgb("#8bd448"), hexRgb("#4f9a1f"), fbm(u * 6, v * 3, 3, 6));
      return mix(c, hexRgb("#2f6a12"), pores(u, v, 110) * 0.5);
    }),
  kiwi: () =>
    skin((u, v) => {
      const fuzz = valueNoise(u * 220, v * 110, 220);
      const c = mix(hexRgb("#8b5a30"), hexRgb("#5e3a1c"), fbm(u * 8, v * 4, 3, 8));
      return mix(c, hexRgb("#c9a06a"), fuzz * 0.35);
    }),
  peach: () =>
    skin((u, v) => {
      const blush = Math.max(0, Math.min(1, (fbm(u * 3, v * 2, 4, 3) - 0.3) * 2.6));
      const c = mix(hexRgb("#f7a440"), hexRgb("#d8283a"), blush);
      return mix(c, [255, 235, 210], valueNoise(u * 200, v * 100, 200) * 0.12);
    }),
  plum: () =>
    skin((u, v) => {
      const c = mix(hexRgb("#3d0f45"), hexRgb("#7b2a76"), fbm(u * 5, v * 3, 4, 5));
      return mix(c, hexRgb("#b994c4"), Math.pow(fbm(u * 18, v * 9, 3, 18), 2) * 0.35);
    }),
  strawberry: () =>
    skin((u, v) => {
      let c = mix(hexRgb("#c50f2a"), hexRgb("#ff2d45"), fbm(u * 8, v * 4, 3, 8));
      c = mix(c, hexRgb("#ffe0a0"), Math.max(0, (v - 0.9) / 0.1) * 0.4);
      // staggered seeds
      const cols = 26;
      const rows = 14;
      const cu = u * cols;
      const ci = Math.floor(cu);
      const cv = v * rows + (ci % 2) * 0.5;
      const dx = cu - ci - 0.5;
      const dy = cv - Math.floor(cv) - 0.5;
      const d = Math.hypot(dx * 1.3, dy);
      if (d < 0.2) return mix(hexRgb("#ffd45c"), hexRgb("#c98a1a"), d / 0.2);
      if (d < 0.3) return mix(c, hexRgb("#8a0718"), 0.5);
      return c;
    }),
  banana: () =>
    canvasTexture(
      paint(SKIN_W, SKIN_H, (u, vv) => {
        const v = 1 - vv;
        // u = along the banana, v = around it
        let c = mix(hexRgb("#ffe347"), hexRgb("#f4c51c"), fbm(u * 6, v * 3, 3));
        const ridge = Math.abs(Math.sin(v * Math.PI * 5));
        c = mix(c, hexRgb("#c99b12"), Math.pow(1 - ridge, 12) * 0.6);
        const fleck = valueNoise(u * 90, v * 40);
        if (fleck > 0.86) c = mix(c, hexRgb("#6b4a12"), (fleck - 0.86) * 4);
        const end = Math.max(0, Math.abs(u - 0.5) * 2 - 0.82) / 0.18;
        return mix(c, hexRgb("#4a3510"), end);
      }),
    ),
};

// ---------------------------------------------------------------------------
// Flesh (cut face) painters
// ---------------------------------------------------------------------------

const CAP = 256;

/** Draws a cut face. `outline(k)` is the fruit's cross-section scaled by k around its center. */
function cap(profile: Profile, draw: (ctx: CanvasRenderingContext2D, outline: (k: number) => Path2D, cx: number, cy: number) => void) {
  const { rmax, ymin, ymax } = profileBounds(profile);
  const { c, ctx } = makeCanvas(CAP, CAP);
  const toPx = (x: number, y: number): [number, number] => [((x + rmax) / (2 * rmax)) * CAP, (1 - (y - ymin) / (ymax - ymin)) * CAP];
  const [cx, cy] = toPx(0, (ymin + ymax) / 2);
  const outline = (k: number) => {
    const path = new Path2D();
    const pts: [number, number][] = [];
    for (const p of profile) pts.push(toPx(p.x, p.y));
    for (let i = profile.length - 2; i >= 1; i--) pts.push(toPx(-profile[i].x, profile[i].y));
    pts.forEach(([x, y], i) => {
      const px = cx + (x - cx) * k;
      const py = cy + (y - cy) * k;
      if (i === 0) path.moveTo(px, py);
      else path.lineTo(px, py);
    });
    path.closePath();
    return path;
  };
  draw(ctx, outline, cx, cy);
  return canvasTexture(c);
}

function radialFill(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, inner: string, outer: string) {
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0, inner);
  g.addColorStop(1, outer);
  return g;
}

function citrusCap(profile: Profile, rind: string, pith: string, flesh: string, fleshEdge: string) {
  return cap(profile, (ctx, outline, cx, cy) => {
    ctx.fillStyle = rind;
    ctx.fill(outline(1));
    ctx.fillStyle = pith;
    ctx.fill(outline(0.92));
    ctx.fillStyle = radialFill(ctx, cx, cy, CAP * 0.45, flesh, fleshEdge);
    ctx.fill(outline(0.87));
    // segment membranes
    ctx.save();
    ctx.clip(outline(0.87));
    ctx.strokeStyle = pith;
    ctx.lineWidth = 3;
    const n = 10;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * CAP, cy + Math.sin(a) * CAP);
      ctx.stroke();
    }
    // juice vesicles
    for (let i = 0; i < 260; i++) {
      const a = rand() * Math.PI * 2;
      const d = rand() * CAP * 0.5;
      ctx.fillStyle = `rgba(255,255,255,${0.06 + rand() * 0.12})`;
      ctx.beginPath();
      ctx.ellipse(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 1.5 + rand() * 3, 4 + rand() * 6, a, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    ctx.fillStyle = pith;
    ctx.beginPath();
    ctx.arc(cx, cy, CAP * 0.05, 0, Math.PI * 2);
    ctx.fill();
  });
}

function pitCap(profile: Profile, skinCol: string, flesh: string, fleshEdge: string, pit: string, pitScale: number) {
  return cap(profile, (ctx, outline, cx, cy) => {
    ctx.fillStyle = skinCol;
    ctx.fill(outline(1));
    ctx.fillStyle = radialFill(ctx, cx, cy, CAP * 0.5, fleshEdge, flesh);
    ctx.fill(outline(0.95));
    ctx.save();
    ctx.clip(outline(0.95));
    ctx.fillStyle = radialFill(ctx, cx, cy, CAP * 0.3, "rgba(220,60,40,0.55)", "rgba(220,60,40,0)");
    ctx.fillRect(0, 0, CAP, CAP);
    ctx.restore();
    ctx.fillStyle = pit;
    ctx.beginPath();
    ctx.ellipse(cx, cy, CAP * 0.16 * pitScale, CAP * 0.23 * pitScale, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.lineWidth = 2;
    for (let i = 0; i < 6; i++) {
      ctx.beginPath();
      const ox = (rand() - 0.5) * CAP * 0.15 * pitScale;
      ctx.moveTo(cx + ox, cy - CAP * 0.18 * pitScale);
      ctx.quadraticCurveTo(cx + ox * 2, cy, cx + ox, cy + CAP * 0.18 * pitScale);
      ctx.stroke();
    }
  });
}

// ---------------------------------------------------------------------------
// Extras (stems, leaves, crowns)
// ---------------------------------------------------------------------------

const stemMat = new THREE.MeshStandardMaterial({ color: "#5a3a1e", roughness: 0.8 });
const leafMat = new THREE.MeshStandardMaterial({ color: "#3f9a2c", roughness: 0.55, side: THREE.DoubleSide });

function leafGeometry() {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.quadraticCurveTo(0.22, 0.25, 0, 0.6);
  s.quadraticCurveTo(-0.22, 0.25, 0, 0);
  const g = new THREE.ShapeGeometry(s, 8);
  return g;
}
const LEAF_GEO = leafGeometry();
const STEM_GEO = new THREE.CylinderGeometry(0.035, 0.055, 0.42, 8);
const NUB_GEO = new THREE.CylinderGeometry(0.07, 0.1, 0.08, 10);
const CROWN_GEO = new THREE.ConeGeometry(0.16, 0.55, 4, 1, false);

function stemAndLeaf(top: number, leaf = true) {
  const g = new THREE.Group();
  const stem = new THREE.Mesh(STEM_GEO, stemMat);
  stem.position.set(0.02, top + 0.12, 0);
  stem.rotation.z = -0.25;
  g.add(stem);
  if (leaf) {
    const l = new THREE.Mesh(LEAF_GEO, leafMat);
    l.position.set(0.05, top + 0.05, 0.02);
    l.rotation.set(0.4, 0.3, -1.1);
    g.add(l);
  }
  return g;
}

function nub(top: number) {
  const m = new THREE.Mesh(NUB_GEO, new THREE.MeshStandardMaterial({ color: "#5d7d1f", roughness: 0.7 }));
  m.position.y = top;
  return m;
}

function strawberryCrown(top: number) {
  const g = new THREE.Group();
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const leaf = new THREE.Mesh(CROWN_GEO, leafMat);
    leaf.scale.set(1, 1, 0.25);
    leaf.position.set(Math.cos(a) * 0.22, top - 0.02, Math.sin(a) * 0.22);
    leaf.rotation.set(0, -a, 0);
    leaf.rotateZ(-1.25);
    g.add(leaf);
  }
  const stem = new THREE.Mesh(STEM_GEO, new THREE.MeshStandardMaterial({ color: "#3d7d22", roughness: 0.6 }));
  stem.scale.set(1.2, 0.5, 1.2);
  stem.position.y = top + 0.1;
  g.add(stem);
  return g;
}

// ---------------------------------------------------------------------------
// Lathe fruit factory
// ---------------------------------------------------------------------------

interface LatheSpec {
  id: string;
  size: number;
  profile: Profile;
  skin: THREE.Texture;
  flesh: THREE.Texture;
  material?: Partial<THREE.MeshPhysicalMaterialParameters>;
  juice: string;
  splat: string;
  extras?: (top: number) => THREE.Object3D;
}

function latheFruit(spec: LatheSpec): FruitAsset {
  const { profile } = spec;
  const { rmax, ymax } = profileBounds(profile);
  const body = new THREE.LatheGeometry(profile, 48);
  const halfA = new THREE.LatheGeometry(profile, 26, 0, Math.PI);
  const halfB = new THREE.LatheGeometry(profile, 26, Math.PI, Math.PI);
  const capA = capGeometry(profile, 1);
  const capB = capGeometry(profile, -1);

  const skinMat = new THREE.MeshPhysicalMaterial({
    map: spec.skin,
    roughness: 0.5,
    clearcoat: 0.35,
    clearcoatRoughness: 0.35,
    ...spec.material,
  });
  const fleshMat = new THREE.MeshStandardMaterial({
    map: spec.flesh,
    emissiveMap: spec.flesh,
    emissive: new THREE.Color(0xffffff),
    emissiveIntensity: 0.14,
    roughness: 0.3,
    metalness: 0,
  });

  const size = spec.size * FRUIT_SCALE;
  // Centroid of a half-solid of revolution sits ~4r/3π ≈ 0.42r from the cut.
  const offset = 0.4 * rmax;

  // Each half is wrapped so its origin is its own centroid; that way it
  // tumbles naturally instead of pivoting around the cut face.
  const wrap = (children: THREE.Object3D[], shiftX = 0) => {
    const outer = new THREE.Group();
    const inner = new THREE.Group();
    inner.position.x = shiftX;
    children.forEach((c) => inner.add(c));
    outer.add(inner);
    outer.scale.setScalar(size);
    return outer;
  };

  return {
    id: spec.id,
    size,
    hitRadius: size * 1.1,
    juice: new THREE.Color(spec.juice),
    splat: new THREE.Color(spec.splat),
    halfOffset: offset,
    whole() {
      const parts: THREE.Object3D[] = [new THREE.Mesh(body, skinMat)];
      if (spec.extras) parts.push(spec.extras(ymax));
      return wrap(parts);
    },
    halves() {
      const a: THREE.Object3D[] = [new THREE.Mesh(halfA, skinMat), new THREE.Mesh(capA, fleshMat)];
      if (spec.extras) a.push(spec.extras(ymax));
      const b: THREE.Object3D[] = [new THREE.Mesh(halfB, skinMat), new THREE.Mesh(capB, fleshMat)];
      return [wrap(a, -offset), wrap(b, offset)];
    },
  };
}

// ---------------------------------------------------------------------------
// Banana (power-up carrier)
// ---------------------------------------------------------------------------

const BANANA_CURVE = new THREE.QuadraticBezierCurve3(
  new THREE.Vector3(-1.2, 0.4, 0),
  new THREE.Vector3(0, -0.5, 0),
  new THREE.Vector3(1.2, 0.4, 0),
);

function bananaRadius(t: number) {
  return 0.07 + 0.3 * Math.pow(Math.sin(Math.PI * t), 0.6);
}

function bananaGeometry(t0: number, t1: number, capAt: number | null) {
  const N = 28;
  const M = 20;
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const tan = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const bin = new THREE.Vector3(0, 0, 1);
  const c = new THREE.Vector3();
  for (let i = 0; i <= N; i++) {
    const t = t0 + ((t1 - t0) * i) / N;
    BANANA_CURVE.getPoint(t, c);
    BANANA_CURVE.getTangent(t, tan);
    nrm.crossVectors(bin, tan).normalize();
    const r = bananaRadius(t);
    for (let j = 0; j <= M; j++) {
      const phi = (j / M) * Math.PI * 2;
      const rr = r * (1 + 0.07 * Math.cos(phi * 5));
      const dx = Math.cos(phi) * nrm.x + Math.sin(phi) * bin.x;
      const dy = Math.cos(phi) * nrm.y + Math.sin(phi) * bin.y;
      const dz = Math.cos(phi) * nrm.z + Math.sin(phi) * bin.z;
      pos.push(c.x + dx * rr, c.y + dy * rr, c.z + dz * rr);
      nor.push(dx, dy, dz);
      uv.push(t, j / M);
    }
  }
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < M; j++) {
      const a = i * (M + 1) + j;
      const b = a + M + 1;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);

  if (capAt === null) return { body: g, cap: null };

  // Flat cap at t = capAt, a disc perpendicular to the tangent (which is +X at t = 0.5).
  const capPos: number[] = [];
  const capUv: number[] = [];
  const capIdx: number[] = [];
  BANANA_CURVE.getPoint(capAt, c);
  BANANA_CURVE.getTangent(capAt, tan);
  nrm.crossVectors(bin, tan).normalize();
  const r = bananaRadius(capAt);
  capPos.push(c.x, c.y, c.z);
  capUv.push(0.5, 0.5);
  for (let j = 0; j <= M; j++) {
    const phi = (j / M) * Math.PI * 2;
    const rr = r * (1 + 0.07 * Math.cos(phi * 5));
    capPos.push(
      c.x + (Math.cos(phi) * nrm.x + Math.sin(phi) * bin.x) * rr,
      c.y + (Math.cos(phi) * nrm.y + Math.sin(phi) * bin.y) * rr,
      c.z + (Math.cos(phi) * nrm.z + Math.sin(phi) * bin.z) * rr,
    );
    capUv.push(0.5 + Math.cos(phi) * 0.5, 0.5 + Math.sin(phi) * 0.5);
  }
  const facesPlusX = capAt === t1; // the cap closes the end of this piece
  for (let j = 1; j <= M; j++) {
    if (facesPlusX) capIdx.push(0, j, j + 1);
    else capIdx.push(0, j + 1, j);
  }
  const cg = new THREE.BufferGeometry();
  cg.setAttribute("position", new THREE.Float32BufferAttribute(capPos, 3));
  cg.setAttribute("uv", new THREE.Float32BufferAttribute(capUv, 2));
  cg.setIndex(capIdx);
  cg.computeVertexNormals();
  return { body: g, cap: cg };
}

let bananaCache: { skin: THREE.Texture; flesh: THREE.Texture } | null = null;

function bananaTextures() {
  if (bananaCache) return bananaCache;
  const { c, ctx } = makeCanvas(CAP, CAP);
  const m = CAP / 2;
  ctx.fillStyle = "#f2c81e";
  ctx.beginPath();
  ctx.arc(m, m, m, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = radialFill(ctx, m, m, m * 0.88, "#fff8d8", "#f5e3a1");
  ctx.beginPath();
  ctx.arc(m, m, m * 0.88, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(140,100,40,0.5)";
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    ctx.beginPath();
    ctx.ellipse(m + Math.cos(a) * m * 0.12, m + Math.sin(a) * m * 0.12, 6, 3, a, 0, Math.PI * 2);
    ctx.fill();
  }
  bananaCache = { skin: SKINS.banana(), flesh: canvasTexture(c) };
  return bananaCache;
}

export const POWER_COLORS: Record<PowerUp, string> = {
  freeze: "#7fe3ff",
  frenzy: "#ff7a2f",
  double: "#ffd84d",
};

const POWER_TINT: Record<PowerUp, string> = {
  freeze: "#c9f3ff",
  frenzy: "#ffc2a3",
  double: "#fff3b0",
};

function bananaAsset(power: PowerUp): FruitAsset {
  const tex = bananaTextures();
  const whole = bananaGeometry(0, 1, null).body;
  const a = bananaGeometry(0.5, 1, 0.5); // +X side, cap faces −X
  const b = bananaGeometry(0, 0.5, 0.5); // −X side, cap faces +X
  const glow = new THREE.Color(POWER_COLORS[power]);
  const skinMat = new THREE.MeshPhysicalMaterial({
    map: tex.skin,
    color: POWER_TINT[power],
    roughness: 0.45,
    clearcoat: 0.4,
    emissive: glow,
    emissiveIntensity: 0.22,
    side: THREE.DoubleSide,
  });
  const fleshMat = new THREE.MeshStandardMaterial({
    map: tex.flesh,
    emissiveMap: tex.flesh,
    emissive: new THREE.Color(0xffffff),
    emissiveIntensity: 0.3,
    roughness: 0.35,
    side: THREE.DoubleSide,
  });
  const size = 0.95 * FRUIT_SCALE;
  const halo = () => {
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTexture(), color: glow, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.85 }),
    );
    s.scale.setScalar(3.6);
    s.position.z = -0.3;
    s.name = "halo";
    return s;
  };
  const group = (children: THREE.Object3D[], shiftX: number) => {
    const outer = new THREE.Group();
    const inner = new THREE.Group();
    inner.position.x = shiftX;
    children.forEach((c) => inner.add(c));
    outer.add(inner);
    outer.scale.setScalar(size);
    return outer;
  };
  return {
    id: `banana-${power}`,
    size,
    hitRadius: size * 1.15,
    juice: new THREE.Color("#fff4c2"),
    splat: new THREE.Color(POWER_COLORS[power]),
    halfOffset: 0.55,
    power,
    whole() {
      const g = group([new THREE.Mesh(whole, skinMat)], 0);
      g.add(halo());
      return g;
    },
    halves() {
      return [
        group([new THREE.Mesh(a.body, skinMat), new THREE.Mesh(a.cap!, fleshMat)], -0.55),
        group([new THREE.Mesh(b.body, skinMat), new THREE.Mesh(b.cap!, fleshMat)], 0.55),
      ];
    },
  };
}

// ---------------------------------------------------------------------------
// Bomb
// ---------------------------------------------------------------------------

export interface BombParts {
  spark: THREE.Sprite;
  halo: THREE.Sprite;
  fuseTip: THREE.Object3D;
}

let bombCache: { body: THREE.BufferGeometry; neck: THREE.BufferGeometry; fuse: THREE.BufferGeometry; mats: THREE.Material[] } | null = null;

export const BOMB_SIZE = 0.78 * FRUIT_SCALE;

export function buildBomb(): THREE.Object3D {
  if (!bombCache) {
    const fuseCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 1.05, 0),
      new THREE.Vector3(0.12, 1.35, 0.05),
      new THREE.Vector3(0.38, 1.5, 0),
      new THREE.Vector3(0.58, 1.42, -0.04),
    ]);
    bombCache = {
      body: new THREE.SphereGeometry(1, 48, 32),
      neck: new THREE.CylinderGeometry(0.3, 0.36, 0.28, 24),
      fuse: new THREE.TubeGeometry(fuseCurve, 24, 0.055, 8, false),
      mats: [
        new THREE.MeshPhysicalMaterial({ color: "#17171d", metalness: 0.55, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.15, emissive: "#ff1a1a", emissiveIntensity: 0.04 }),
        new THREE.MeshStandardMaterial({ color: "#8d8f97", metalness: 0.9, roughness: 0.3 }),
        new THREE.MeshStandardMaterial({ color: "#c9a46a", roughness: 0.9 }),
      ],
    };
  }
  const { body, neck, fuse, mats } = bombCache;
  const g = new THREE.Group();
  g.add(new THREE.Mesh(body, mats[0]));
  const n = new THREE.Mesh(neck, mats[1]);
  n.position.y = 0.98;
  g.add(n);
  g.add(new THREE.Mesh(fuse, mats[2]));

  const halo = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glowTexture(), color: "#ff2a2a", blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.55 }),
  );
  halo.scale.setScalar(3.4);
  halo.position.z = -0.6;
  g.add(halo);

  const tip = new THREE.Object3D();
  tip.position.set(0.6, 1.42, -0.04);
  g.add(tip);
  const spark = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glowTexture(), color: "#ffd27a", blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
  );
  spark.scale.setScalar(0.9);
  tip.add(spark);

  g.scale.setScalar(BOMB_SIZE);
  g.userData.parts = { spark, halo, fuseTip: tip } satisfies BombParts;
  return g;
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export interface FruitCatalogue {
  fruits: FruitAsset[];
  bananas: Record<PowerUp, FruitAsset>;
  byId: Record<string, FruitAsset>;
}

let catalogue: FruitCatalogue | null = null;

/** Builds all fruit assets (textures are painted procedurally, ~0.5–1 s). */
export function getCatalogue(): FruitCatalogue {
  if (catalogue) return catalogue;

  const watermelonP = PROFILES.watermelon();
  const orangeP = PROFILES.sphere(0.95);
  const appleP = PROFILES.apple();
  const lemonP = PROFILES.lemon(1.18);
  const limeP = PROFILES.lemon(1.02);
  const kiwiP = PROFILES.kiwi();
  const peachP = PROFILES.sphere(0.98);
  const plumP = PROFILES.sphere(1.04);
  const strawberryP = PROFILES.strawberry();


  const fruits: FruitAsset[] = [
    latheFruit({
      id: "watermelon",
      size: 1.05,
      profile: watermelonP,
      skin: SKINS.watermelon(),
      material: { clearcoat: 0.6, roughness: 0.4 },
      flesh: cap(watermelonP, (ctx, outline, cx, cy) => {
        ctx.fillStyle = "#1f4d1a";
        ctx.fill(outline(1));
        ctx.fillStyle = "#c8ec9a";
        ctx.fill(outline(0.95));
        ctx.fillStyle = radialFill(ctx, cx, cy, CAP * 0.5, "#ff5a6a", "#e2233a");
        ctx.fill(outline(0.9));
        ctx.save();
        ctx.clip(outline(0.9));
        for (let i = 0; i < 300; i++) {
          ctx.fillStyle = `rgba(255,${180 + rand() * 60},${190 + rand() * 50},${0.05 + rand() * 0.1})`;
          ctx.fillRect(rand() * CAP, rand() * CAP, 2 + rand() * 3, 2 + rand() * 3);
        }
        ctx.restore();
        ctx.fillStyle = "#1b120e";
        const n = 16;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + rand() * 0.2;
          const rx = CAP * 0.23 * (0.85 + rand() * 0.3);
          const ry = CAP * 0.3 * (0.85 + rand() * 0.3);
          ctx.beginPath();
          ctx.ellipse(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, 4, 7, a + Math.PI / 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }),
      juice: "#ff2f4f",
      splat: "#e0142e",
    }),
    latheFruit({
      id: "orange",
      size: 0.74,
      profile: orangeP,
      skin: SKINS.orange(),
      material: { roughness: 0.55, clearcoat: 0.25 },
      flesh: citrusCap(orangeP, "#f07a00", "#fff1d6", "#ffb347", "#ff8c1a"),
      juice: "#ff9a1f",
      splat: "#ff8000",
      extras: (top) => nub(top),
    }),
    latheFruit({
      id: "apple",
      size: 0.72,
      profile: appleP,
      skin: SKINS.apple(),
      material: { roughness: 0.32, clearcoat: 0.9, clearcoatRoughness: 0.12 },
      flesh: cap(appleP, (ctx, outline, cx, cy) => {
        ctx.fillStyle = "#a3101a";
        ctx.fill(outline(1));
        ctx.fillStyle = radialFill(ctx, cx, cy, CAP * 0.5, "#f7ecd0", "#ecd6a0");
        ctx.fill(outline(0.96));
        ctx.fillStyle = "rgba(225,200,140,0.6)";
        ctx.beginPath();
        ctx.ellipse(cx, cy, CAP * 0.12, CAP * 0.2, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#4b2a12";
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.ellipse(cx + s * CAP * 0.04, cy + 4, 5, 10, s * 0.3, 0, Math.PI * 2);
          ctx.fill();
        }
      }),
      juice: "#fff2c6",
      splat: "#f2d98a",
      extras: (top) => stemAndLeaf(top - 0.28),
    }),
    latheFruit({
      id: "lemon",
      size: 0.66,
      profile: lemonP,
      skin: SKINS.lemon(),
      material: { roughness: 0.45, clearcoat: 0.45 },
      flesh: citrusCap(lemonP, "#f2c200", "#fffbe6", "#fff38a", "#ffe14a"),
      juice: "#ffe74d",
      splat: "#ffd400",
    }),
    latheFruit({
      id: "lime",
      size: 0.6,
      profile: limeP,
      skin: SKINS.lime(),
      material: { roughness: 0.45, clearcoat: 0.45 },
      flesh: citrusCap(limeP, "#4a9a1f", "#f2ffe0", "#c8f27a", "#93d63f"),
      juice: "#a6e85a",
      splat: "#7ccf2a",
    }),
    latheFruit({
      id: "kiwi",
      size: 0.62,
      profile: kiwiP,
      skin: SKINS.kiwi(),
      material: { roughness: 0.85, clearcoat: 0, sheen: 1, sheenColor: new THREE.Color("#c9a06a"), sheenRoughness: 0.6 },
      flesh: cap(kiwiP, (ctx, outline, cx, cy) => {
        ctx.fillStyle = "#6b4526";
        ctx.fill(outline(1));
        ctx.fillStyle = radialFill(ctx, cx, cy, CAP * 0.5, "#c3ec6a", "#5fb22a");
        ctx.fill(outline(0.95));
        ctx.save();
        ctx.clip(outline(0.95));
        ctx.strokeStyle = "rgba(230,255,190,0.35)";
        ctx.lineWidth = 2;
        for (let i = 0; i < 48; i++) {
          const a = (i / 48) * Math.PI * 2;
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(a) * CAP * 0.1, cy + Math.sin(a) * CAP * 0.13);
          ctx.lineTo(cx + Math.cos(a) * CAP * 0.5, cy + Math.sin(a) * CAP * 0.6);
          ctx.stroke();
        }
        ctx.restore();
        ctx.fillStyle = "#fbfbe8";
        ctx.beginPath();
        ctx.ellipse(cx, cy, CAP * 0.09, CAP * 0.14, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#120c06";
        for (let i = 0; i < 40; i++) {
          const a = rand() * Math.PI * 2;
          const d = 0.15 + rand() * 0.06;
          ctx.beginPath();
          ctx.ellipse(cx + Math.cos(a) * CAP * d * 0.8, cy + Math.sin(a) * CAP * d, 2.2, 4, a + Math.PI / 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }),
      juice: "#9ad94f",
      splat: "#6fbf2a",
    }),
    latheFruit({
      id: "peach",
      size: 0.72,
      profile: peachP,
      skin: SKINS.peach(),
      material: { roughness: 0.7, clearcoat: 0, sheen: 0.5, sheenColor: new THREE.Color("#ffb08a"), sheenRoughness: 0.6 },
      flesh: pitCap(peachP, "#f05a46", "#ffc35e", "#ffa543", "#7a3a1c", 1.15),
      juice: "#ffb366",
      splat: "#ff9a3c",
      extras: (top) => stemAndLeaf(top - 0.08),
    }),
    latheFruit({
      id: "plum",
      size: 0.58,
      profile: plumP,
      skin: SKINS.plum(),
      material: { roughness: 0.4, clearcoat: 0.7, clearcoatRoughness: 0.3 },
      flesh: pitCap(plumP, "#3d0f45", "#ffe08a", "#f2b84a", "#9a5f28", 0.9),
      juice: "#d04a8a",
      splat: "#a3195f",
      extras: (top) => stemAndLeaf(top - 0.05, false),
    }),
    latheFruit({
      id: "strawberry",
      size: 0.62,
      profile: strawberryP,
      skin: SKINS.strawberry(),
      material: { roughness: 0.38, clearcoat: 0.8, clearcoatRoughness: 0.2 },
      flesh: cap(strawberryP, (ctx, outline, cx, cy) => {
        ctx.fillStyle = "#c80f2a";
        ctx.fill(outline(1));
        ctx.fillStyle = radialFill(ctx, cx, cy, CAP * 0.5, "#ffb3c0", "#ff3550");
        ctx.fill(outline(0.92));
        ctx.save();
        ctx.clip(outline(0.92));
        ctx.strokeStyle = "rgba(255,230,235,0.45)";
        ctx.lineWidth = 3;
        for (let i = 0; i < 14; i++) {
          const a = (i / 14) * Math.PI * 2;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + Math.cos(a) * CAP * 0.5, cy + Math.sin(a) * CAP * 0.5);
          ctx.stroke();
        }
        ctx.restore();
        ctx.fillStyle = "rgba(255,240,240,0.85)";
        ctx.beginPath();
        ctx.ellipse(cx, cy - CAP * 0.04, CAP * 0.07, CAP * 0.22, 0, 0, Math.PI * 2);
        ctx.fill();
      }),
      juice: "#ff3355",
      splat: "#e0102e",
      extras: (top) => strawberryCrown(top),
    }),
  ];

  const bananas = {
    freeze: bananaAsset("freeze"),
    frenzy: bananaAsset("frenzy"),
    double: bananaAsset("double"),
  };

  const byId: Record<string, FruitAsset> = {};
  for (const f of [...fruits, ...Object.values(bananas)]) byId[f.id] = f;
  catalogue = { fruits, bananas, byId };
  return catalogue;
}
