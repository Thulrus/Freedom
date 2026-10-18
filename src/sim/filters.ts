/** Allocation-free discrete filters (Betaflight-style PT1/PT2). */

export class Pt1 {
  state = 0;
  private k = 1;

  /** Configure for cutoff (Hz) at sample period dt (s). cutoff <= 0 = passthrough. */
  configure(cutoffHz: number, dt: number): void {
    if (cutoffHz <= 0) {
      this.k = 1;
      return;
    }
    const rc = 1 / (2 * Math.PI * cutoffHz);
    this.k = dt / (rc + dt);
  }

  apply(input: number): number {
    this.state += this.k * (input - this.state);
    return this.state;
  }

  reset(value = 0): void {
    this.state = value;
  }
}

/** Two cascaded PT1 stages, BF's PT2 (cutoff corrected so -3dB stays at cutoff). */
export class Pt2 {
  state = 0;
  private s1 = 0;
  private k = 1;

  configure(cutoffHz: number, dt: number): void {
    if (cutoffHz <= 0) {
      this.k = 1;
      return;
    }
    const order = 2;
    const orderCutoffCorrection = 1 / Math.sqrt(Math.pow(2, 1 / order) - 1);
    const rc = 1 / (2 * orderCutoffCorrection * Math.PI * cutoffHz);
    this.k = dt / (rc + dt);
  }

  apply(input: number): number {
    this.s1 += this.k * (input - this.s1);
    this.state += this.k * (this.s1 - this.state);
    return this.state;
  }

  reset(value = 0): void {
    this.s1 = value;
    this.state = value;
  }
}
