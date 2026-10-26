// A bounded number of tasks at once, with a bounded first-come waiting line. A full line fails fast instead of growing.

export interface SlotPool {
  /** Runs `task` once a slot is free; rejects at once with the pool's `full()` error when the waiting line is full. */
  run<T>(task: () => Promise<T>): Promise<T>;
  /** Rejects every call still waiting for a slot with `error()`; returns how many. */
  rejectWaiting(error: () => unknown): number;
  readonly active: number;
  readonly queued: number;
}

export function createSlotPool(limits: { running: number; waiting: number; full: () => unknown }): SlotPool {
  let active = 0;
  const line: { start: () => void; fail: (error: unknown) => void }[] = [];
  const release = (): void => {
    active -= 1;
    line.shift()?.start();
  };
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const go = async (): Promise<T> => {
        try {
          return await task();
        } finally {
          release();
        }
      };
      if (active < limits.running) {
        active += 1;
        return go();
      }
      if (line.length >= limits.waiting) return Promise.reject(limits.full());
      return new Promise<T>((resolve, reject) => {
        line.push({
          // The slot passes straight to this call, so a newcomer cannot overtake the line.
          start: () => {
            active += 1;
            go().then(resolve, reject);
          },
          fail: reject,
        });
      });
    },
    rejectWaiting(error: () => unknown): number {
      const waiting = line.splice(0, line.length);
      for (const entry of waiting) entry.fail(error());
      return waiting.length;
    },
    get active() {
      return active;
    },
    get queued() {
      return line.length;
    },
  };
}
