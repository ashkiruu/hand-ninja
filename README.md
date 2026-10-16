# Hand Ninja

A Fruit Ninja-style browser game where **your hand is the blade**. Your webcam tracks your index fingertip with MediaPipe, and every fruit, effect, sound and piece of music is generated procedurally. The game ships no image or audio files.

![Gameplay](docs/gameplay.jpg)

| Title | Results |
| --- | --- |
| ![Title](docs/title.jpg) | ![Results](docs/results.jpg) |

## Run it

```bash
npm install      # also copies the MediaPipe WASM runtime into public/
npm run dev      # http://localhost:5173
```

Open the page in Chrome or Edge (Safari and Firefox work too), click **Enter the Dojo** and allow camera access. Hold up your hand and slice a fruit to pick a mode.

- The camera only works on `localhost` or over `https`. To play from a phone on your network, serve it over https (for example with `npx vite --https` and a plugin, or a tunnel).
- No camera? Click-and-drag (or touch-drag) with the mouse works everywhere.
- `npm run build` produces a static site in `dist/` that you can host anywhere.

## Deploy

Every push to `main` builds the game and publishes it to GitHub Pages (`.github/workflows/deploy.yml`). One-time setup: in the repo go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**, then re-run the workflow from the **Actions** tab. The game is then live at `https://<user>.github.io/hand-ninja/` over HTTPS, so the camera works on phones too.

**Controls:** swipe with your index finger · `Esc`/`P` pause · `S` settings · `D` performance overlay.

## Game modes

- **Classic:** endless and gets harder over time. Miss 3 fruit or hit 1 bomb and the game is over.
- **Arcade:** 60 seconds. Bombs cost 10 points. Glowing bananas give power-ups: **Freeze** (slow motion, timer paused), **Frenzy** (fruit thrown in from both sides) and **Double Score**.

Both modes have combos (3+ fruit in one swipe), random **Critical** hits on fast swipes, and a best score saved per mode.

## How the hand tracking works

```
Webcam (30–60 Hz) ─► MediaPipe HandLandmarker (GPU) ─► fingertip (landmark 8)
   ─► mirror + cover-fit + "reach" zoom (same transform as the background video)
   ─► One Euro filter ─► velocity estimate ─► extrapolate to render time (+lead)
   ─► Blade (60–120 Hz) ─► swept segment-vs-circle slicing
```

- **Smoothing without lag:** a 2D [One Euro filter](https://gery.casiez.net/1euro/) adapts its cutoff to speed, so a resting hand is steady and a fast swipe passes through almost unfiltered.
- **Camera rate ≠ screen rate:** detection runs once per camera frame. The blade is extrapolated from the filtered velocity to each render frame, with a small configurable lead to hide camera latency, so it moves at 60–120 fps.
- **No tunnelling:** fruit is tested against the segment the blade travelled this frame, not a single point, so fast swipes never pass through a fruit. Pointer input keeps every sample between frames for the same reason.
- **Deliberate cuts only:** the blade becomes "live" only above a minimum speed (with hysteresis), so a hand hovering near a fruit doesn't slice it.
- **Exact alignment:** the camera background and the landmark mapping share one mirror + cover-fit + zoom transform, so the glowing blade tip sits on your real fingertip.
- **Robustness:** brief tracking dropouts (motion blur) are bridged. Large jumps are treated as glitches and don't cut. Losing your hand for more than 1.2 s pauses the game.

Everything above can be tuned live in **Settings**: blade sensitivity, reach, steadiness/responsiveness (One Euro parameters), prediction, and which landmark drives the blade (index tip, middle tip or palm center).

## How the fruit is made

Each fruit is a lathe (surface of revolution) built from a 2D profile, with skins painted procedurally on canvases (stripes, pores, blush, seeds). Slicing a lathe through its axis is exact and cheap. Each half is a half-lathe plus a flat cap shaped like the profile, textured with the fruit's flesh (seeds, segments, pits). At the moment of the cut, the fruit is rotated by the smallest rotation that lines the cut plane up with your swipe, so it always splits the way you cut it. Each half then spins about the swipe axis so its flesh turns towards you.

## Effects and audio

- HDR rendering with bloom, ACES tone mapping, vignette, chromatic aberration and a shock-wave distortion on bomb hits ([postprocessing](https://github.com/pmndrs/postprocessing))
- Glowing, tapered, Catmull-Rom-smoothed blade trail, juice droplets with specular highlights, mist, sparks, juice stains on the dojo wall, drifting embers
- Hit-stop on every slice, slow motion on big combos and bombs, trauma-based screen shake
- Web Audio synthesis: speed-dependent swipe whooshes, wet splats, metallic "shing", bomb fuse crackle and explosion, combo arpeggios, and a generative koto + taiko soundtrack in the Japanese *In* scale

## Project layout

```
src/
  App.ts                 state machine, frame loop, input wiring
  tracking/              HandTracker (MediaPipe), OneEuroFilter, video↔screen mapping
  input/Blade.ts         blade model: filtering, prediction, live state, swept hit tests
  game/                  Game rules/spawner, World (slice physics + FX), Menu (slice-to-select rings), procedural fruitModels
  render/                Renderer + post FX, Background shader, BladeTrail, Particles, Splatters, textures
  audio/AudioEngine.ts   procedural SFX + music
  ui/                    DOM HUD/screens/settings, floating popups
public/models/           MediaPipe hand_landmarker.task (Apache-2.0)
```

## Tech

Vite · TypeScript · Three.js · postprocessing · MediaPipe Tasks Vision · GSAP · Fontsource (Shojumaru, Outfit)
