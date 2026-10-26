import { readFileSync } from 'node:fs';
import { parseRuntimeContract } from '../../../packs/workflow/case-compile/functions/runtime-contract.ts';
import { argumentsOf, main, output, parserRefusal, record, requireFact, summary } from './io.ts';
export function checkContract(bytes: Uint8Array, expected: string) {
  const raw: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
  const parsed = parseRuntimeContract(raw);
  if (!parsed.ok) throw parserRefusal('runtime-contract', parsed.problems, '集成者重新只读导出完整原合约，按问题修正后重跑');
  requireFact(/^[a-f0-9]{64}$/.test(expected) && parsed.contract.pinned.identity === expected, '合约不是网关钉住的副本（期望的是原合约的规范身份）；重新读取钉住的摘要和合约');
  requireFact(record(raw), '合约不是对象');
  return { raw, contract: parsed.contract };
}
export function run(args: string[]): void {
  const { files, options } = argumentsOf(args, 1, ['--expect', '--out']);
  const bytes = readFileSync(files[0]!); const checked = checkContract(bytes, options['--expect'] ?? '');
  output(options['--out'] ?? '', 'runtime-contract.json', bytes);
  summary(checked.contract.enabled.length, bytes, { name: 'runner-contract', file: 'runtime-contract.json' });
}
main(import.meta.url, run);
