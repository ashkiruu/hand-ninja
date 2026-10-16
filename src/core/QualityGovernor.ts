/**
 * Adaptive resolution. Watches the real frame rate and lowers the render
 * pixel ratio until the game holds ~60 fps, so it stays smooth on anything
 * from a gaming PC to a thin laptop's integrated GPU.
 *
 * - Downgrades after 2 consecutive slow seconds (< 50 fps).
 * - Upgrades back one step after 8 consecutive fast seconds (> 58 fps), but
 *   never to a level that has already proven too slow twice, so it settles
 *   instead of oscillating (each change costs a resize).
 * - Ignores single frames longer than 1 s (tab switches, loading), but not
 *   merely slow frames: a machine running at 5 fps must still adapt.
 */
export interface QualityLevel {
  pixelRatio: number;
  /** MSAA samples (0 = off). */
  msaa: number;
}

export class QualityGovernor {
  onChange: ((level: QualityLevel) => void) | null = null;
  private levels: QualityLevel[] = [{ pixelRatio: 1, msaa: 0 }];
  private level = 0;
  private failures: number[] = [0];
  private frames = 0;
  private time = 0;
  private slow = 0;
  private fast = 0;
  private cooldown = 0;
  private enabled = false;

  /**
   * Builds the ladder of quality levels, best first. `sharp` allows high
   * pixel ratios and, on low-DPI screens (where jaggies show), MSAA on the top
   * level only: under load, anti-aliasing is the first thing to go, then
   * resolution.
   */
  configure(sharp: boolean) {
    const dpr = window.devicePixelRatio || 1;
    const cap = Math.min(dpr, sharp ? 2 : 1);
    const steps = [2, 1.75, 1.5, 1.25, 1, 0.85, 0.7, 0.6];
    const ratios = [cap, ...steps.filter((s) => s < cap - 0.01)];
    this.levels = ratios.map((pixelRatio) => ({ pixelRatio, msaa: 0 }));
    if (sharp && cap <= 1.25) this.levels.unshift({ pixelRatio: cap, msaa: 4 });
    this.failures = this.levels.map(() => 0);
    // Start at ≤ 1.5× without MSAA, and upgrade only if there is headroom.
    const start = this.levels.findIndex((l) => l.pixelRatio <= 1.5 + 1e-3 && l.msaa === 0);
    this.level = Math.max(0, start);
    this.reset();
    this.onChange?.(this.current);
  }

  get current() {
    return this.levels[this.level];
  }

  /** Only measure during real gameplay/menus (not while loading). */
  setEnabled(on: boolean) {
    this.enabled = on;
    this.reset();
  }

  sample(rawDt: number) {
    if (!this.enabled || rawDt <= 0 || rawDt > 1 || document.hidden) return;
    this.frames++;
    this.time += rawDt;
    if (this.time < 1) return;
    const fps = this.frames / this.time;
    this.frames = 0;
    this.time = 0;
    if (this.cooldown > 0) {
      this.cooldown--;
      return;
    }
    if (fps < 50) {
      this.slow++;
      this.fast = 0;
    } else if (fps > 58) {
      this.fast++;
      this.slow = 0;
    } else {
      this.slow = this.fast = 0;
    }
    if (this.slow >= 2 && this.level < this.levels.length - 1) {
      this.failures[this.level]++;
      this.set(this.level + 1);
    } else if (this.fast >= 8 && this.level > 0 && this.failures[this.level - 1] < 2) {
      this.set(this.level - 1);
    }
  }

  private set(level: number) {
    this.level = level;
    this.reset();
    this.cooldown = 2; // let the new resolution settle before judging it
    this.onChange?.(this.current);
  }

  private reset() {
    this.frames = 0;
    this.time = 0;
    this.slow = 0;
    this.fast = 0;
  }
}
