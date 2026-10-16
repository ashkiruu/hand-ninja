// One Euro filter (Casiez et al., CHI 2012) for 2D points.
//
// An adaptive low-pass: the cutoff frequency rises with speed, so a resting
// hand is rock steady while a fast swipe is passed through with little lag.
// Both axes share one cutoff (driven by the speed magnitude) so the filtered
// path keeps its shape instead of lagging more on one axis than the other.

function alpha(cutoffHz: number, dt: number) {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dt);
}

export class OneEuroFilter2D {
  minCutoff: number;
  beta: number;
  dCutoff: number;

  private x = 0;
  private y = 0;
  private dx = 0;
  private dy = 0;
  private t = -1;

  // dCutoff is higher than the paper's 1 Hz so the cutoff opens up quickly at
  // the very start of a swipe, which is where lag is most noticeable.
  constructor(minCutoff = 1.4, beta = 6, dCutoff = 4) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  reset() {
    this.t = -1;
  }

  /** Filter a sample taken at time `t` (seconds). Returns the filtered point in `out`. */
  filter(x: number, y: number, t: number, out: { x: number; y: number }) {
    if (this.t < 0) {
      this.x = x;
      this.y = y;
      this.dx = 0;
      this.dy = 0;
      this.t = t;
      out.x = x;
      out.y = y;
      return out;
    }
    const dt = Math.max(1e-4, t - this.t);
    this.t = t;

    // Smoothed derivative drives the adaptive cutoff.
    const ad = alpha(this.dCutoff, dt);
    this.dx += ad * ((x - this.x) / dt - this.dx);
    this.dy += ad * ((y - this.y) / dt - this.dy);
    const speed = Math.hypot(this.dx, this.dy);

    const a = alpha(this.minCutoff + this.beta * speed, dt);
    this.x += a * (x - this.x);
    this.y += a * (y - this.y);
    out.x = this.x;
    out.y = this.y;
    return out;
  }
}
