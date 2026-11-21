export default function heavy(_input: unknown): unknown {
  const blocks: Uint8Array[] = [];
  for (let i = 0; i < 600; i++) blocks.push(new Uint8Array(1024 * 1024).fill(1));
  const until = Date.now() + 1500;
  let sum = 0;
  while (Date.now() < until) { sum = 0; for (const block of blocks) sum += block[block.length - 1]; }
  return [{ verdict: 'support', statement: '占用大量内存的检查照常完成', grounds: [], tier: 'advisory', data: { megabytes: sum } }];
}
