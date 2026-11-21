import { join } from 'node:path';
import { sha256, type RunKnowledge } from './generated/skills/run-tools/hub-client/index.ts';
import { isRecord } from './text.ts';

export const ENTRY_HEADING = '· 引用 ';
export interface EntryText { reference: string; statement: string; applicability?: unknown; fragments?: unknown }

export function sourceLines(entry: EntryText): { source: string; from: number; to: number } | null {
  const first = Array.isArray(entry.fragments) ? entry.fragments[0] : undefined;
  const found = typeof first === 'string' ? /^src:([0-9a-f]{64})\/text@1\/l\/([1-9][0-9]*)(?:-([1-9][0-9]*))?(?::[0-9]+-[0-9]+)?$/.exec(first) : null;
  return found ? { source: found[1], from: Number(found[2]), to: Number(found[3] ?? found[2]) } : null;
}

export function inSourceOrder<T extends EntryText>(entries: readonly T[]): T[] {
  const placed = entries.map((entry) => ({ entry, at: sourceLines(entry) }));
  if (placed.length < 2 || placed.some((row) => row.at === null)) return [...entries];
  const files = new Map<string, number>();
  for (const row of placed) if (!files.has(row.at!.source)) files.set(row.at!.source, files.size);
  return placed
    .map((row, index) => ({ ...row, index }))
    .sort((a, b) => files.get(a.at!.source)! - files.get(b.at!.source)! || a.at!.from - b.at!.from || a.at!.to - b.at!.to || a.index - b.index)
    .map((row) => row.entry);
}

export function entryLines(entry: EntryText): string[] {
  const at = sourceLines(entry);
  const source = at === null ? '' : `  源 ${at.source.slice(0, 12)} 行 ${at.from === at.to ? at.from : `${at.from}-${at.to}`}`;
  const conditions = typeof entry.applicability === 'string' && entry.applicability ? `  适用 ${entry.applicability.replace(/\s*[\r\n]+\s*/g, ' ')}` : '';
  return [`${ENTRY_HEADING}${entry.reference}${source}${conditions}`, entry.statement];
}

export function nodeLines(path: string, children: readonly string[], entries: readonly EntryText[]): string[] {
  const out = [`# ${path}`];
  if (children.length) out.push(`  子节点 ${children.length} 个：${children.join('、')}`);
  for (const entry of inSourceOrder(entries)) out.push(...entryLines(entry));
  return out;
}

const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');

export function knowledgeFiles(bytes: Uint8Array, run: string): { outputs: Array<{ name: string; bytes: Uint8Array }>; knowledge: RunKnowledge } {
  let lines: unknown[];
  try { lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line)); }
  catch { throw new Error('Hub 给的知识根不是逐行的 UTF-8 JSON，什么都没有写入'); }
  const [head, ...nodes] = lines;
  if (!isRecord(head) || head.schema !== 'run-knowledge@1' || head.run !== run || typeof head.root !== 'string' || head.nodes !== nodes.length) throw new Error(`Hub 给的知识根不是 --run 指定的 ${run} 的，或行数与首行不符，什么都没有写入`);
  const texts = new Map<string, string[]>(); let entries = 0;
  for (const node of nodes) {
    if (!isRecord(node) || typeof node.path !== 'string' || !node.path.startsWith('/') || !Array.isArray(node.children) || !Array.isArray(node.entries)) throw new Error('Hub 给的知识根里有不合式的节点，什么都没有写入');
    const top = node.path.split('/')[1] ?? '';
    const file = top === '' ? 'root.txt' : `${SAFE_FILE.test(top) ? top : `subtree-${sha256(top).slice(0, 12)}`}.txt`;
    const block = texts.get(file) ?? []; texts.set(file, block);
    const kept: EntryText[] = [];
    for (const entry of node.entries) {
      if (!isRecord(entry) || typeof entry.statement !== 'string' || typeof entry.reference !== 'string') throw new Error('Hub 给的知识根里有不合式的条目，什么都没有写入');
      entries++;
      kept.push({ reference: entry.reference, statement: entry.statement, applicability: entry.applicability, fragments: entry.fragments });
    }
    block.push(...nodeLines(node.path, node.children.filter(isRecord).map((child) => String(child.name)), kept), '');
  }
  const outputs: Array<{ name: string; bytes: Uint8Array }> = [{ name: join('knowledge', 'nodes.jsonl'), bytes }];
  const files: Array<{ file: string; bytes: number }> = [];
  for (const [file, block] of texts) { const text = Buffer.from(block.join('\n') + '\n'); outputs.push({ name: join('knowledge', file), bytes: text }); files.push({ file, bytes: text.length }); }
  const knowledge: RunKnowledge = { root: head.root, composition: typeof head.composition === 'string' ? head.composition : null, nodes: nodes.length, entries, sha256: sha256(bytes), files: files.map((f) => f.file) };
  outputs.push({ name: join('knowledge', 'index.json'), bytes: json({ run, root: knowledge.root, composition: knowledge.composition, nodes: knowledge.nodes, entries, sha256: knowledge.sha256, files }) });
  return { outputs, knowledge };
}
