// Synthetic pack check function that holds about 600 MB while it works (more than the rules default of 256 MB plus headroom,
// less than the check limit), then supports: a check over a whole run's workbook holds that much for a run of 17 cases.

export default function heavy(_input: unknown): unknown {
  const blocks: Uint8Array[] = [];
  for (let i = 0; i < 600; i++) blocks.push(new Uint8Array(1024 * 1024).fill(1));
  // Hold it for a while, as a real check does while it compares, so the sandbox's resident-size poller sees it.
  const until = Date.now() + 1500;
  let sum = 0;
  while (Date.now() < until) { sum = 0; for (const block of blocks) sum += block[block.length - 1]; }
  return [{ verdict: 'support', statement: '占用大量内存的检查照常完成', grounds: [], tier: 'advisory', data: { megabytes: sum } }];
}
