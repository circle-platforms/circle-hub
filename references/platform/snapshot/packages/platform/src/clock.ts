/** Injectable clock: lease and window logic must be test-deterministic. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export class FakeClock implements Clock {
  #t: number;
  constructor(startMs = 0) {
    this.#t = startMs;
  }
  now(): number {
    return this.#t;
  }
  advance(ms: number): void {
    this.#t += ms;
  }
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}
