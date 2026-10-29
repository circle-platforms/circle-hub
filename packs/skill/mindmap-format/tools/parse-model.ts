// A local client helper: parse the supplied bytes with the same parser the skill pack publishes.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { kityminderParser } from '../functions/kityminder.ts';

export function parseModel(bytes: Uint8Array) {
  const model = kityminderParser.parse(bytes).model;
  return { parser: 'kityminder@1', source_sha256: createHash('sha256').update(bytes).digest('hex'), model };
}

async function main() {
  const { values } = parseArgs({ options: { source: { type: 'string' }, out: { type: 'string' } }, strict: true });
  if (!values.source || !values.out) throw new Error('用法：parse-model.ts --source <原件文件> --out <模型文件>');
  const parsed = parseModel(await readFile(values.source));
  await writeFile(values.out, JSON.stringify(parsed), { flag: 'wx', mode: 0o600 });
  console.log(`已解析 ${parsed.model.nodes.length} 个节点；原件摘要 ${parsed.source_sha256}`);
}

if (import.meta.main) main().catch(() => { console.error('脑图解析未完成；核对原件和本地文件后重试'); process.exitCode = 1; });
