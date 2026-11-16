// The knowledge text files of a run download (knowledge/<top node>.txt): what a model reads, searches and copies quotes out of.
// The Hub checks a quote against the text its reference resolves to, byte for byte (quote@1: an exact contiguous substring; for
// tree:<root>/<path>@<entry> that text is the entry's statement, hub/knowledge/read.ts), so every line a model may copy has to
// be the statement's own line. Whatever the download adds for the reader (the reference, the conditions) therefore goes on a
// heading line of its own, and the statement is written under it as it is: nothing in front of a line, nothing cut, nothing
// shortened. Run 34's writer copied «· Demo(config)#sdns dnssec keygen …» out of manual.txt with its bullet and the Hub refused
// the quote. The reference implementation (InfoTest) does the same with a manual: the metadata (a locator, `total_lines=…`) is a
// line of its own and the lines under it are the document's, and a cut is announced on a line of its own.
//
// Order: nodes keep the order of the Hub's batch. So do the entries of a node, unless the batch says where each of them stands in
// its source. The Hub lists a node's entries by kind, statement and digest (hub/knowledge/read.ts #entriesAt) and its children by
// name (contracts/src/knowledge.ts TreeNodeBody), because the tree records no document order; what it does keep, in the
// composition, is the source fragments of every entry, and since the batch carries them (`fragments`, read.ts subtreeNodes) the
// entries of a node whose fragments are all line ranges of a text source (`src:<digest>/text@1/l/<from>-<to>`, which is what a
// manual's adoc chapters are cited by) are put back in the order of those lines, as the reference implementation gives a manual
// in the order of its lines. A heading line says the lines it came from (`源 <digest> 行 <from>-<to>`). A batch without
// fragments, or with fragments of another kind, is rendered in the Hub's order, which says nothing about the manual's.
//
// This module renders what run-tools/hub-client `knowledgeFiles` rendered before (same arguments, same answer, same files, same
// `index.json`); hub-retry.ts and the authoring brief use it. The embedded run-tools 1.0.2 module is published and stays as it
// was; when run-tools is next given a version this belongs in its hub-client module.
import { join } from 'node:path';
import { sha256, type RunKnowledge } from './generated/skills/run-tools/hub-client/index.ts';
import { isRecord } from './text.ts';

/** What opens the heading line of an entry in the text files. A heading is for the reader and is never part of the entry's text. */
export const ENTRY_HEADING = '· 引用 ';
export interface EntryText { reference: string; statement: string; applicability?: unknown; fragments?: unknown }

/** Where an entry stands in its source: the source file's digest and the lines of its first fragment, when that is a line range of a text source (the core text parser's `l/<n>` and `l/<a>-<b>` selectors). */
export function sourceLines(entry: EntryText): { source: string; from: number; to: number } | null {
  const first = Array.isArray(entry.fragments) ? entry.fragments[0] : undefined;
  const found = typeof first === 'string' ? /^src:([0-9a-f]{64})\/text@1\/l\/([1-9][0-9]*)(?:-([1-9][0-9]*))?(?::[0-9]+-[0-9]+)?$/.exec(first) : null;
  return found ? { source: found[1], from: Number(found[2]), to: Number(found[3] ?? found[2]) } : null;
}

/** The entries of a node in the order of their source lines, file by file in the order the files first appear; unchanged when any entry has no line range to go by. */
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

/**
 * One entry as the text files show it: a heading line that carries its reference (the one to cite) and the conditions it
 * declares and, when the batch says so, the source lines it stands on, then the statement itself, from its first line to its last.
 * The statement runs to the next heading line or the next `# <path>` line.
 */
export function entryLines(entry: EntryText): string[] {
  const at = sourceLines(entry);
  const source = at === null ? '' : `  源 ${at.source.slice(0, 12)} 行 ${at.from === at.to ? at.from : `${at.from}-${at.to}`}`;
  const conditions = typeof entry.applicability === 'string' && entry.applicability ? `  适用 ${entry.applicability.replace(/\s*[\r\n]+\s*/g, ' ')}` : '';
  return [`${ENTRY_HEADING}${entry.reference}${source}${conditions}`, entry.statement];
}

/** A node's block of a text file: `# <path>`, the names of its children, then its entries, in the order of their source lines when the batch gives them (inSourceOrder) and in the Hub's order when not. */
export function nodeLines(path: string, children: readonly string[], entries: readonly EntryText[]): string[] {
  const out = [`# ${path}`];
  if (children.length) out.push(`  子节点 ${children.length} 个：${children.join('、')}`);
  for (const entry of inSourceOrder(entries)) out.push(...entryLines(entry));
  return out;
}

const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');

/**
 * The files of a run's knowledge root, from the Hub's one batch (GET /run-export/<run>/knowledge: a head line, then one node a
 * line as a subtree read gives it): `knowledge/nodes.jsonl` is the answer byte for byte; one text file per top-level node of
 * the root (`knowledge/<name>.txt`) holds every node below it as a block for reading and searching (nodeLines): `# <path>`, the
 * names of its children, then each entry as a heading line with its reference and conditions and, under it, its statement as the
 * Hub holds it, word for word (entryLines); `knowledge/index.json` lists the root, the counts and the files. The root is
 * immutable, so nothing here goes stale during the run.
 */
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
