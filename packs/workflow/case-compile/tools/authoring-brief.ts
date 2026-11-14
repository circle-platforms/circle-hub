// The authoring briefs of a downloaded plan run (functions/authoring-brief.ts): one text file per case, `briefs/<index>.md`,
// beside `items/` and `knowledge/`, so a writer starts from the tree entries its case already names and from the envelope of
// its plan file instead of searching for them reply by reply. tools/download-run.ts writes them with the run; run alone, this tool writes them for a directory that
// was downloaded before. It reads local files only, decides nothing and never overwrites a brief.
//   node <skill directory>/tools/authoring-brief.ts --run <downloaded run directory>
import { realpathSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authoringBrief, canonicalPath, parameterRows, policyOf, type BriefKnowledge, type BriefNode } from '../functions/authoring-brief.ts';
import { formatCallError, isRecord } from '../functions/text.ts';
import { argumentsOf, writeNew } from '../functions/generated/skills/run-tools/hub-client/index.ts';

const parsed = (name: string, text: string): unknown => { try { return JSON.parse(text); } catch { throw new Error(`${name} 不是完整的 JSON`); } };

/** The command forms and the parameter a manual row states, when the entry's data carries them whole. */
const parameterOf = (data: unknown): { parameter?: { commands: string[]; name: string } } => {
  const stated = isRecord(data) && isRecord(data.parameter) ? data.parameter : null;
  if (!stated || typeof stated.name !== 'string' || !stated.name || !Array.isArray(stated.commands) || !stated.commands.length || !stated.commands.every((command) => typeof command === 'string' && command)) return {};
  return { parameter: { commands: stated.commands as string[], name: stated.name } };
};

/** The knowledge root a run download wrote: every node by canonical path, and the line each node's block starts at in the text files. Null when the run brought no root. */
export async function readKnowledge(directory: string): Promise<BriefKnowledge | null> {
  let raw: string;
  try { raw = await readFile(join(directory, 'knowledge', 'nodes.jsonl'), 'utf8'); } catch { return null; }
  const [head, ...rows] = raw.split('\n').filter((line) => line.length > 0).map((line) => parsed('knowledge/nodes.jsonl', line));
  if (!isRecord(head) || head.schema !== 'run-knowledge@1' || typeof head.root !== 'string') throw new Error('knowledge/nodes.jsonl 不是运行下载写的手册和命令树');
  const nodes = new Map<string, BriefNode>();
  for (const row of rows) {
    if (!isRecord(row) || typeof row.path !== 'string' || !Array.isArray(row.children) || !Array.isArray(row.entries)) throw new Error('knowledge/nodes.jsonl 里有不合式的节点');
    nodes.set(canonicalPath(row.path), {
      path: row.path,
      children: row.children.filter(isRecord).map((child) => ({ name: String(child.name), path: String(child.path) })),
      entries: row.entries.filter(isRecord).filter((entry) => typeof entry.statement === 'string' && typeof entry.reference === 'string').map((entry) => ({
        ...(typeof entry.kind === 'string' ? { kind: entry.kind } : {}), statement: entry.statement as string, reference: entry.reference as string,
        ...(typeof entry.applicability === 'string' && entry.applicability ? { applicability: entry.applicability } : {}),
        ...parameterOf(entry.data),
      })),
    });
  }
  const lines: BriefKnowledge['lines'] = new Map();
  for (const file of (await readdir(join(directory, 'knowledge'))).filter((name) => name.endsWith('.txt')).sort()) {
    const text = (await readFile(join(directory, 'knowledge', file), 'utf8')).split('\n');
    // A block starts at `# <path of a node>` and runs to the blank line before the next one; the first such line is the block.
    const starts: Array<{ path: string; at: number }> = [];
    text.forEach((value, at) => { if (value.startsWith('# /')) { const path = canonicalPath(value.slice(2)); if (nodes.has(path)) starts.push({ path, at }); } });
    starts.forEach((start, order) => {
      if (lines.has(start.path)) return;
      let end = order + 1 < starts.length ? starts[order + 1].at : text.length;
      while (end > start.at + 1 && text[end - 1] === '') end--;
      lines.set(start.path, { file, line: start.at + 1, count: end - start.at });
    });
  }
  return { root: head.root, nodes, lines, parameters: parameterRows(nodes.values()) };
}

export interface BriefReport { briefs: number; kept: number; without_record: number }
/** Writes `briefs/<index>.md` for every item of the directory that carries a recomposition record; a brief already there is left as it is. */
export async function writeBriefs(directory: string): Promise<BriefReport> {
  const report: BriefReport = { briefs: 0, kept: 0, without_record: 0 };
  const knowledge = await readKnowledge(directory);
  if (!knowledge) return report;
  const run = parsed('run.json', await readFile(join(directory, 'run.json'), 'utf8'));
  const policy = policyOf(isRecord(run) ? run.command_policy : null);
  // The bed a plan's bucket must name is the one the run's bound profile selects.
  const groups = isRecord(run) && Array.isArray(run.groups) ? run.groups.filter(isRecord) : [];
  const bed = groups.map((group) => (isRecord(group.profile) && typeof group.profile.bed === 'string' ? group.profile.bed : null)).find((value) => value !== null) ?? null;
  const present = new Set(await readdir(join(directory, 'briefs')).catch(() => [] as string[]));
  for (const name of (await readdir(join(directory, 'items'))).filter((value) => /^\d+\.json$/.test(value)).sort()) {
    const index = name.slice(0, -'.json'.length);
    const brief = authoringBrief(parsed(`items/${name}`, await readFile(join(directory, 'items', name), 'utf8')), index, knowledge, policy, bed);
    if (!brief) { report.without_record++; continue; }
    if (present.has(`${index}.md`)) { report.kept++; continue; }
    await mkdir(join(directory, 'briefs'), { recursive: true, mode: 0o700 });
    await writeNew(join(directory, 'briefs', `${index}.md`), Buffer.from(brief.text));
    report.briefs++;
  }
  return report;
}

export async function main(argv: string[]): Promise<number> {
  try {
    const args = argumentsOf(argv, ['run']);
    const report = await writeBriefs(args.run);
    process.stdout.write(JSON.stringify({ directory: resolve(args.run, 'briefs'), ...report }) + '\n');
    return 0;
  } catch (error) { process.stderr.write(formatCallError(error) + '\n'); return 1; }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
