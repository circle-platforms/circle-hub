// Locate exact node-text quotations in original bytes. Hub checks case ownership on submission.
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { originalQuoteLocator, type QuoteNode } from './raw-spans.ts';

type Candidate = { item: string; selector: string; text: string };
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function locateCandidates(raw: string, parsed: unknown, candidates: readonly Candidate[]) {
  if (!isRecord(parsed) || parsed.parser !== 'kityminder@1' || typeof parsed.source_sha256 !== 'string' || !isRecord(parsed.model) || !Array.isArray(parsed.model.nodes)) throw new Error('需要 mindmap-format 的解析模型');
  if (parsed.model.nulRemoved !== 0 || (typeof parsed.model.surrogatesReplaced === 'number' && parsed.model.surrogatesReplaced !== 0)) throw new Error('原件经过字符替换，不能取得原始引文；修复原件后重读');
  const nodes = parsed.model.nodes as QuoteNode[];
  const locate = originalQuoteLocator(raw, parsed.source_sha256, nodes);
  return candidates.map(({ item, selector, text }, index) => ({ ordinal: index + 1, item, selector, quotes: locate(selector, text) }));
}

async function main() {
  const { values } = parseArgs({ options: { source: { type: 'string' }, model: { type: 'string' }, candidates: { type: 'string' }, out: { type: 'string' } }, strict: true });
  if (!values.source || !values.model || !values.candidates || !values.out) throw new Error('用法：locate-quotes.ts --source <原件> --model <脑图模型> --candidates <候选.json> --out <结果.json>');
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(values.source));
  const parsed: unknown = JSON.parse(await readFile(values.model, 'utf8'));
  const candidates: unknown = JSON.parse(await readFile(values.candidates, 'utf8'));
  if (!Array.isArray(candidates) || candidates.some(row => !isRecord(row) || typeof row.item !== 'string' || typeof row.selector !== 'string' || typeof row.text !== 'string')) throw new Error('候选必须是 item、selector、text 对象数组');
  const results = locateCandidates(raw, parsed, candidates as Candidate[]);
  await writeFile(values.out, JSON.stringify(results, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(`候选 ${results.length} 条；唯一 ${results.filter(row => row.quotes.length === 1).length} 条；未找到 ${results.filter(row => row.quotes.length === 0).length} 条；多处 ${results.filter(row => row.quotes.length > 1).length} 条`);
}

if (import.meta.main) main().catch(() => { console.error('引文定位未完成；核对输入、来源摘要和本地文件后重试'); process.exitCode = 1; });
