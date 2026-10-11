/** Deterministic per-instance prefixed id generator (task_000001, ...). */
export class IdGen {
  #counters = new Map<string, number>();

  next(prefix: string): string {
    const n = (this.#counters.get(prefix) ?? 0) + 1;
    this.#counters.set(prefix, n);
    return `${prefix}_${String(n).padStart(6, "0")}`;
  }
}
