// CI shards of a test file list, shared by run-unit-tests.ts and run-acceptance-tests.ts. Node's own --test-shard deals
// files out by index modulo the total over the sorted list, which put the slowest files together; these slices are
// balanced by measured durations instead, and every file still lands in exactly one slice.

export interface Shard {
  index: number;
  total: number;
}

/** Parses `<index>/<total>` with 1 <= index <= total; undefined when unset or empty. */
export function parseShard(text: string | undefined): Shard | undefined {
  if (text === undefined || text === '') return undefined;
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(text);
  if (match === null || Number(match[1]) > Number(match[2])) throw new Error(`分片必须写成 <序号>/<总数>，且序号不大于总数：${text}`);
  return { index: Number(match[1]), total: Number(match[2]) };
}

/** Longest file first into the least-loaded slice (ties go to the lower slice); deterministic for a given file list. */
export function slices(files: readonly string[], total: number, secondsOf: (file: string) => number): string[][] {
  const out: string[][] = Array.from({ length: total }, () => []);
  const load = new Array<number>(total).fill(0);
  const ordered = [...files].sort((a, b) => secondsOf(b) - secondsOf(a) || (a < b ? -1 : a > b ? 1 : 0));
  for (const file of ordered) {
    let target = 0;
    for (let i = 1; i < total; i++) if (load[i] < load[target]) target = i;
    out[target].push(file);
    load[target] += secondsOf(file);
  }
  return out.map((slice) => slice.sort());
}

/** The files of one shard, or all of them when there is no shard. */
export function shardFiles(files: readonly string[], shard: Shard | undefined, secondsOf: (file: string) => number): string[] {
  if (shard === undefined) return [...files];
  return slices(files, shard.total, secondsOf)[shard.index - 1];
}
