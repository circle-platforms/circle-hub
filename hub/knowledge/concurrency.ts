// Bounded concurrency for reads, producer calls and chunked writes.

/** Runs `fn` over the items with at most `limit` running at a time; the results keep the input order. */
export async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(Math.floor(limit), items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** A counting semaphore: at most `size` holders at a time, the others wait in order. */
export class Semaphore {
  #free: number;
  readonly #waiting: Array<() => void> = [];

  constructor(size: number) {
    this.#free = Math.max(1, Math.floor(size));
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#free > 0) this.#free--;
    else await new Promise<void>((resolve) => this.#waiting.push(resolve));
    try {
      return await fn();
    } finally {
      const next = this.#waiting.shift();
      if (next !== undefined) next();
      else this.#free++;
    }
  }
}

/** Splits items into consecutive chunks of at most `size`. */
export function chunks<T>(items: readonly T[], size: number): T[][] {
  const step = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));
  return out;
}
