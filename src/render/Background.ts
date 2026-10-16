import * as THREE from "three";

// Full-screen background drawn as part of the main scene: a procedural dark
// wooden dojo wall blended with the (mirrored, cover-fit) webcam feed.

const vert = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.9999, 1.0);
}`;

const frag = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uVideo;
uniform float uHasVideo;
uniform float uCamOpacity;
uniform vec2 uCover;
uniform float uAspect;
uniform float uTime;
uniform float uFlash;
uniform float uFreeze;
uniform float uDanger;

float hash(float n) { return fract(sin(n) * 43758.5453123); }
float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2(1, 0)), u.x), mix(hash2(i + vec2(0, 1)), hash2(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0; float a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; }
  return s;
}

vec3 srgbToLinear(vec3 c) { return pow(c, vec3(2.2)); }

vec3 wood(vec2 uv) {
  vec2 p = vec2((uv.x - 0.5) * uAspect, uv.y);
  float plankW = 0.26;
  float px = p.x / plankW + 0.5;
  float id = floor(px);
  float fx = fract(px);
  float off = hash(id * 7.13) * 50.0;
  // long vertical grain with wavy growth rings
  float warp = fbm(vec2(p.x * 6.0, p.y * 1.2 + off)) * 2.0;
  float rings = sin((p.x * 38.0 + warp * 6.0 + off) ) * 0.5 + 0.5;
  float grain = fbm(vec2(p.x * 60.0 + off, p.y * 4.0));
  float tone = hash(id * 3.71);
  vec3 dark = vec3(0.155, 0.085, 0.045);
  vec3 light = vec3(0.30, 0.17, 0.085);
  vec3 col = mix(dark, light, 0.35 + 0.35 * grain + 0.2 * rings * grain);
  col *= 0.8 + tone * 0.35;
  // knots
  vec2 kp = vec2(fx - 0.5, fract(p.y * 0.9 + off) - 0.5);
  float knot = smoothstep(0.12, 0.0, length(kp * vec2(2.5, 1.0))) * step(0.72, hash(id * 1.9 + floor(p.y * 0.9 + off)));
  col = mix(col, dark * 0.6, knot * 0.8);
  // plank seams + bevel highlight
  float seam = smoothstep(0.0, 0.025, fx) * smoothstep(1.0, 0.975, fx);
  col *= mix(0.25, 1.0, seam);
  col += vec3(0.05, 0.03, 0.015) * smoothstep(0.03, 0.06, fx) * smoothstep(0.1, 0.06, fx);
  return col;
}

void main() {
  vec2 uv = vUv;
  vec3 col = srgbToLinear(wood(uv) * 1.6);

  // warm lantern light from the top
  float lamp = exp(-pow(length((uv - vec2(0.5, 1.05)) * vec2(uAspect * 0.55, 1.0)), 2.0) * 2.2);
  col *= 0.55 + lamp * 1.3;

  if (uHasVideo > 0.5) {
    vec2 vuv = 0.5 + (uv - 0.5) / uCover;
    vuv.x = 1.0 - vuv.x;
    vec3 cam = srgbToLinear(texture2D(uVideo, vuv).rgb);
    float l = dot(cam, vec3(0.2126, 0.7152, 0.0722));
    cam = mix(vec3(l), cam, 0.7) * vec3(1.0, 0.93, 0.85);
    col = mix(col, cam * 0.85, uCamOpacity);
  }

  // freeze frost from the edges
  float edge = smoothstep(0.25, 0.75, length((uv - 0.5) * vec2(uAspect, 1.0)) / max(uAspect, 1.0) * 1.6);
  col = mix(col, vec3(0.55, 0.85, 1.0) * 0.6, uFreeze * (0.06 + 0.45 * edge));

  // danger pulse (bomb on screen) and flash
  col += vec3(0.16, 0.005, 0.0) * uDanger * edge * edge;
  col = mix(col, vec3(4.0), uFlash);

  gl_FragColor = vec4(col, 1.0);
}`;

export class Background {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private videoTex: THREE.VideoTexture | null = null;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uVideo: { value: null },
        uHasVideo: { value: 0 },
        uCamOpacity: { value: 0.45 },
        uCover: { value: new THREE.Vector2(1, 1) },
        uAspect: { value: 1 },
        uTime: { value: 0 },
        uFlash: { value: 0 },
        uFreeze: { value: 0 },
        uDanger: { value: 0 },
      },
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
  }

  setVideo(video: HTMLVideoElement) {
    this.videoTex = new THREE.VideoTexture(video);
    this.videoTex.minFilter = THREE.LinearFilter;
    this.videoTex.magFilter = THREE.LinearFilter;
    this.videoTex.generateMipmaps = false;
    this.material.uniforms.uVideo.value = this.videoTex;
    this.material.uniforms.uHasVideo.value = 1;
  }

  update(time: number, aspect: number, cover: { x: number; y: number }, camOpacity: number) {
    const u = this.material.uniforms;
    u.uTime.value = time;
    u.uAspect.value = aspect;
    u.uCover.value.set(cover.x, cover.y);
    u.uCamOpacity.value = camOpacity;
  }

  set flash(v: number) {
    this.material.uniforms.uFlash.value = v;
  }
  set freeze(v: number) {
    this.material.uniforms.uFreeze.value = v;
  }
  set danger(v: number) {
    this.material.uniforms.uDanger.value = v;
  }
}
