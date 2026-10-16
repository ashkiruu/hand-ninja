import * as THREE from "three";

// Full-screen background drawn as part of the main scene: a dark wooden dojo
// wall blended with the (mirrored, cover-fit) webcam feed.
//
// The wood is procedural noise, which is far too expensive to evaluate per
// pixel per frame, so it is baked into a texture whenever the screen size
// changes; each frame only samples that texture and the camera.

const fullscreenVert = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.9999, 1.0);
}`;

const woodFrag = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uAspect;

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
  float warp = fbm(vec2(p.x * 6.0, p.y * 1.2 + off)) * 2.0;
  float rings = sin((p.x * 38.0 + warp * 6.0 + off)) * 0.5 + 0.5;
  float grain = fbm(vec2(p.x * 60.0 + off, p.y * 4.0));
  float tone = hash(id * 3.71);
  vec3 dark = vec3(0.155, 0.085, 0.045);
  vec3 light = vec3(0.30, 0.17, 0.085);
  vec3 col = mix(dark, light, 0.35 + 0.35 * grain + 0.2 * rings * grain);
  col *= 0.8 + tone * 0.35;
  vec2 kp = vec2(fx - 0.5, fract(p.y * 0.9 + off) - 0.5);
  float knot = smoothstep(0.12, 0.0, length(kp * vec2(2.5, 1.0))) * step(0.72, hash(id * 1.9 + floor(p.y * 0.9 + off)));
  col = mix(col, dark * 0.6, knot * 0.8);
  float seam = smoothstep(0.0, 0.025, fx) * smoothstep(1.0, 0.975, fx);
  col *= mix(0.25, 1.0, seam);
  col += vec3(0.05, 0.03, 0.015) * smoothstep(0.03, 0.06, fx) * smoothstep(0.1, 0.06, fx);
  return col;
}

void main() {
  vec3 col = srgbToLinear(wood(vUv) * 1.6);
  // warm lantern light from the top
  float lamp = exp(-pow(length((vUv - vec2(0.5, 1.05)) * vec2(uAspect * 0.55, 1.0)), 2.0) * 2.2);
  col *= 0.55 + lamp * 1.3;
  gl_FragColor = vec4(col, 1.0);
}`;

const displayFrag = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uWood;
uniform sampler2D uVideo;
uniform float uHasVideo;
uniform float uCamOpacity;
uniform vec2 uCover;
uniform float uAspect;
uniform float uFreeze;
uniform float uDanger;

void main() {
  vec3 col = texture2D(uWood, vUv).rgb;

  if (uHasVideo > 0.5 && uCamOpacity > 0.001) {
    vec2 vuv = 0.5 + (vUv - 0.5) / uCover;
    vuv.x = 1.0 - vuv.x;
    vec3 cam = texture2D(uVideo, vuv).rgb;
    cam *= cam; // cheap sRGB → linear
    float l = dot(cam, vec3(0.2126, 0.7152, 0.0722));
    cam = mix(vec3(l), cam, 0.7) * vec3(1.0, 0.93, 0.85);
    col = mix(col, cam * 0.85, uCamOpacity);
  }

  float edge = smoothstep(0.25, 0.75, length((vUv - 0.5) * vec2(uAspect, 1.0)) / max(uAspect, 1.0) * 1.6);
  col = mix(col, vec3(0.55, 0.85, 1.0) * 0.6, uFreeze * (0.06 + 0.45 * edge));
  col += vec3(0.16, 0.005, 0.0) * uDanger * edge * edge;
  gl_FragColor = vec4(col, 1.0);
}`;

export class Background {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private videoTex: THREE.VideoTexture | null = null;
  private frameTex: THREE.VideoFrameTexture | null = null;
  private frame: VideoFrame | null = null;
  private woodTarget: THREE.WebGLRenderTarget;
  private bakeScene = new THREE.Scene();
  private bakeCamera = new THREE.Camera();
  private bakeMaterial: THREE.ShaderMaterial;
  private bakedSize = "";

  constructor() {
    this.woodTarget = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false });
    this.bakeMaterial = new THREE.ShaderMaterial({
      vertexShader: fullscreenVert,
      fragmentShader: woodFrag,
      depthWrite: false,
      depthTest: false,
      uniforms: { uAspect: { value: 1 } },
    });
    const bakeQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.bakeMaterial);
    bakeQuad.frustumCulled = false;
    this.bakeScene.add(bakeQuad);

    this.material = new THREE.ShaderMaterial({
      vertexShader: fullscreenVert,
      fragmentShader: displayFrag,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uWood: { value: this.woodTarget.texture },
        uVideo: { value: null },
        uHasVideo: { value: 0 },
        uCamOpacity: { value: 0.35 },
        uCover: { value: new THREE.Vector2(1, 1) },
        uAspect: { value: 1 },
        uFreeze: { value: 0 },
        uDanger: { value: 0 },
      },
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
  }

  /** Re-bake the wood texture for the current screen size (cheap no-op if unchanged). */
  bake(gl: THREE.WebGLRenderer, cssWidth: number, cssHeight: number) {
    // The wall is soft, low-contrast detail: ~1 texel per CSS pixel is plenty.
    const scale = Math.min(1, 1600 / Math.max(cssWidth, cssHeight));
    const w = Math.max(4, Math.round(cssWidth * scale));
    const h = Math.max(4, Math.round(cssHeight * scale));
    const key = `${w}x${h}`;
    if (key === this.bakedSize) return;
    this.bakedSize = key;
    this.woodTarget.setSize(w, h);
    this.bakeMaterial.uniforms.uAspect.value = cssWidth / cssHeight;
    const prev = gl.getRenderTarget();
    gl.setRenderTarget(this.woodTarget);
    gl.render(this.bakeScene, this.bakeCamera);
    gl.setRenderTarget(prev);
  }

  /**
   * Show a specific camera frame (the one the hand tracker just analysed)
   * instead of the live feed, so the blade and the hand in the video line up.
   * Takes ownership of the frame.
   */
  setFrame(frame: VideoFrame) {
    if (!this.frameTex) {
      this.frameTex = new THREE.VideoFrameTexture();
      this.frameTex.minFilter = THREE.LinearFilter;
      this.frameTex.magFilter = THREE.LinearFilter;
      this.frameTex.generateMipmaps = false;
    }
    const prev = this.frame;
    this.frameTex.setFrame(frame);
    this.frame = frame;
    prev?.close();
    this.material.uniforms.uVideo.value = this.frameTex;
    this.material.uniforms.uHasVideo.value = 1;
  }

  /** Go back to the live camera feed. */
  useLive() {
    if (!this.videoTex || this.material.uniforms.uVideo.value === this.videoTex) return;
    this.material.uniforms.uVideo.value = this.videoTex;
    this.frame?.close();
    this.frame = null;
  }

  setVideo(video: HTMLVideoElement) {
    this.videoTex = new THREE.VideoTexture(video);
    this.videoTex.minFilter = THREE.LinearFilter;
    this.videoTex.magFilter = THREE.LinearFilter;
    this.videoTex.generateMipmaps = false;
    this.material.uniforms.uVideo.value = this.videoTex;
    this.material.uniforms.uHasVideo.value = 1;
  }

  update(aspect: number, cover: { x: number; y: number }, camOpacity: number) {
    const u = this.material.uniforms;
    u.uAspect.value = aspect;
    u.uCover.value.set(cover.x, cover.y);
    u.uCamOpacity.value = camOpacity;
  }

  set freeze(v: number) {
    this.material.uniforms.uFreeze.value = v;
  }
  set danger(v: number) {
    this.material.uniforms.uDanger.value = v;
  }
}
