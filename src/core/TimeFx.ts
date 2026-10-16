/**
 * Game-feel time control: hit-stop (a few frames of near-freeze on impact)
 * and slow motion that eases back to normal speed. Input and UI always run
 * in real time; only the simulation uses `scale`.
 */
export class TimeFx {
  scale = 1;
  private hitstop = 0;
  private slowTarget = 1;
  private slowLeft = 0;
  private slow = 1;

  hitStop(seconds: number) {
    this.hitstop = Math.max(this.hitstop, seconds);
  }

  slowMo(scale: number, seconds: number) {
    this.slowTarget = Math.min(this.slowLeft > 0 ? this.slowTarget : 1, scale);
    this.slowLeft = Math.max(this.slowLeft, seconds);
    this.slow = Math.min(this.slow, scale);
  }

  reset() {
    this.hitstop = 0;
    this.slowLeft = 0;
    this.slow = 1;
    this.slowTarget = 1;
    this.scale = 1;
  }

  update(realDt: number) {
    if (this.hitstop > 0) this.hitstop -= realDt;
    if (this.slowLeft > 0) {
      this.slowLeft -= realDt;
      this.slow = this.slowTarget;
    } else {
      this.slowTarget = 1;
      this.slow += (1 - this.slow) * (1 - Math.exp(-realDt * 5));
    }
    this.scale = this.hitstop > 0 ? 0.04 : this.slow;
  }
}
