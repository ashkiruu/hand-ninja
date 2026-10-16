import * as THREE from "three";

// Procedural canvas textures. Everything visual in the game is generated at
// startup, so there are no image assets to license or download.

export function makeCanvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  return { c, ctx };
}

export function canvasTexture(c: HTMLCanvasElement, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

// ---------- small deterministic noise helpers ----------

let seed = 1337;
export function rand() {
  // mulberry32
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function hash2(x: number, y: number) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Tileable-in-x value noise in [0,1]. `period` is the x period in noise cells. */
export function valueNoise(x: number, y: number, period = 1e9) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const x0 = ((xi % period) + period) % period;
  const x1 = (((xi + 1) % period) + period) % period;
  const a = hash2(x0, yi);
  const b = hash2(x1, yi);
  const c = hash2(x0, yi + 1);
  const d = hash2(x1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function fbm(x: number, y: number, octaves = 4, period = 1e9) {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x * f, y * f, period * f);
    amp *= 0.5;
    f *= 2;
  }
  return sum / (1 - Math.pow(0.5, octaves));
}

/** Per-pixel painter. `fn` returns [r,g,b] (0..255) for normalized (u,v). */
export function paint(w: number, h: number, fn: (u: number, v: number, x: number, y: number) => [number, number, number]) {
  const { c, ctx } = makeCanvas(w, h);
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn(x / w, y / h, x, y);
      const i = (y * w + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// ---------- shared effect textures ----------

let glowTex: THREE.Texture | null = null;
/** Soft radial glow, white → transparent. */
export function glowTexture() {
  if (glowTex) return glowTex;
  const { c, ctx } = makeCanvas(128, 128);
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.2, "rgba(255,255,255,0.65)");
  g.addColorStop(0.5, "rgba(255,255,255,0.18)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  glowTex = canvasTexture(c);
  return glowTex;
}

/** Juice splat masks (white on transparent), several variants. */
export function splatTextures(count = 5): THREE.Texture[] {
  const out: THREE.Texture[] = [];
  for (let k = 0; k < count; k++) {
    const S = 256;
    const { c, ctx } = makeCanvas(S, S);
    ctx.fillStyle = "#fff";
    const cx = S / 2;
    const cy = S / 2;
    // main blob with a noisy outline
    const base = S * 0.2;
    ctx.beginPath();
    const steps = 64;
    const off = rand() * 100;
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const n = fbm(Math.cos(a) * 1.6 + off, Math.sin(a) * 1.6 + off, 3);
      const r = base * (0.75 + n * 0.7);
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.fill();
    // streaks + droplets flung outward
    const arms = 7 + Math.floor(rand() * 6);
    for (let i = 0; i < arms; i++) {
      const a = rand() * Math.PI * 2;
      const len = base * (0.9 + rand() * 1.4);
      const w = 3 + rand() * 7;
      ctx.lineCap = "round";
      ctx.lineWidth = w;
      ctx.strokeStyle = "#fff";
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * base * 0.6, cy + Math.sin(a) * base * 0.6);
      ctx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
      ctx.stroke();
      const dr = w * (0.8 + rand() * 0.8);
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * (len + dr * 1.5), cy + Math.sin(a) * (len + dr * 1.5), dr, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let i = 0; i < 26; i++) {
      const a = rand() * Math.PI * 2;
      const d = base * (1.1 + rand() * 1.5);
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 1 + rand() * 4.5, 0, Math.PI * 2);
      ctx.fill();
    }
    out.push(canvasTexture(c));
  }
  return out;
}

/**
 * Circular ring with text running around it (the slice-to-select menu rings).
 */
export function ringTexture(label: string, color: string, glow: string) {
  const S = 512;
  const { c, ctx } = makeCanvas(S, S);
  const cx = S / 2;
  const R = S * 0.4;

  // glow ring
  ctx.save();
  ctx.shadowColor = glow;
  ctx.shadowBlur = 24;
  ctx.strokeStyle = color;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(cx, cx, R + 34, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.6;
  ctx.beginPath();
  ctx.arc(cx, cx, R - 30, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  // text around the circle, repeated to fill it
  const text = `${label} • `;
  ctx.font = `52px Shojumaru, "Outfit Variable", sans-serif`;
  ctx.fillStyle = color;
  ctx.shadowColor = glow;
  ctx.shadowBlur = 12;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const circumference = 2 * Math.PI * R;
  const unit = ctx.measureText(text).width;
  const reps = Math.max(1, Math.floor(circumference / unit));
  const full = text.repeat(reps);
  const totalW = ctx.measureText(full).width;
  const stretch = circumference / totalW;
  let a = -Math.PI / 2;
  for (const ch of full) {
    const w = ctx.measureText(ch).width * stretch;
    a += w / 2 / R;
    ctx.save();
    ctx.translate(cx + Math.cos(a) * R, cx + Math.sin(a) * R);
    ctx.rotate(a + Math.PI / 2);
    ctx.fillText(ch, 0, 0);
    ctx.restore();
    a += w / 2 / R;
  }
  return canvasTexture(c);
}
