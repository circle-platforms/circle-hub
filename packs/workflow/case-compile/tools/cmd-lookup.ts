// Read-only command lookup over the download of a run: the command tree and the manual of the locked root, one command at a time.
//   node '<技能目录>/tools/cmd-lookup.ts' --run '<下载目录>/run.json' --param '<命令词，可带参数>'
//   node '<技能目录>/tools/cmd-lookup.ts' --run '<下载目录>/run.json' --heads '<命令词前缀>'
// `--param` answers one command with its definition in the tree, the manual's window from its signature line to the next command's,
// the inverse the product declares and the manual's example lines; `--heads` lists the command heads below a prefix with their syntax
// lines. A miss names the next words of the node the words reached and the heads with the same words in another order. It reads
// run.json and knowledge/nodes.jsonl (and where the text files are, the lines their blocks start at) of the download beside it,
// calls no Hub, decides nothing and writes nothing; the logic is functions/cmd-lookup.ts.
import { realpathSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockedTree } from '../functions/catalog-selection.ts';
import { formatClientCallError } from '../functions/client-cli.ts';
import { blockPositions, lookupHeads, lookupParam, type BlockPosition, type LookupSource } from '../functions/cmd-lookup.ts';
import { CallFailure, isRecord, parseCliOptions } from '../functions/text.ts';
import { resolveCwdRoots, resolveExistingFileInsideCwd } from './workspace-path.ts';

const OPTIONS: Record<string, boolean> = { run: true, param: false, heads: false };
const USAGE = "node '<技能目录>/tools/cmd-lookup.ts' --run '<下载目录>/run.json' --param '<命令词>' 或 --heads '<命令词前缀>'";
const RETRY = '用 tools/download-run.ts 重新下载本次运行，run.json 与 knowledge/ 留在同一个目录里';

export interface LookupIo { out?: (text: string) => void; err?: (text: string) => void; cwd?: string }

/** A file of the download's knowledge folder as bytes, or null when the download has none; never through a link. */
async function knowledgeFile(directory: string, name: string): Promise<Buffer | null> {
  const path = join(directory, 'knowledge', name);
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  if (info === null) return null;
  if (info.isSymbolicLink() || !info.isFile()) throw new CallFailure('invalid_parameters', `knowledge/${name} 不是普通文件`, RETRY);
  return readFile(path);
}
const utf8 = (bytes: Uint8Array, what: string): string => {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new CallFailure('invalid_parameters', `${what} 不是完整的 UTF-8`, RETRY); }
};

/** The download beside a run.json as the lookup reads it: the run, its locked tree, and where each node's block starts in the text files. */
export async function readLookupSource(runFile: string): Promise<LookupSource> {
  const directory = dirname(runFile);
  let run: unknown;
  try { run = JSON.parse(utf8(await readFile(runFile), 'run.json')); }
  catch (error) { throw error instanceof CallFailure ? error : new CallFailure('invalid_parameters', 'run.json 不是完整的 JSON', RETRY); }
  if (!isRecord(run) || typeof run.run !== 'string' || typeof run.root !== 'string') throw new CallFailure('invalid_parameters', 'run.json 缺少 run 或 root，不是运行导出的原件', RETRY);
  const nodes = await knowledgeFile(directory, 'nodes.jsonl');
  if (nodes === null) throw new CallFailure('not_found', '下载目录里没有 knowledge/nodes.jsonl，查不了命令树', RETRY);
  let rows: unknown[];
  try { rows = utf8(nodes, 'knowledge/nodes.jsonl').split('\n').filter(Boolean).map((line) => JSON.parse(line) as unknown); }
  catch (error) { throw error instanceof CallFailure ? error : new CallFailure('invalid_parameters', 'knowledge/nodes.jsonl 不是逐行的 JSON', RETRY); }
  const tree = lockedTree(rows, { run: run.run, root: run.root });
  if (typeof tree === 'string') throw new CallFailure('invalid_parameters', tree, RETRY);
  const blocks = new Map<string, BlockPosition>();
  for (const name of ['commands.txt', 'manual.txt']) {
    const text = await knowledgeFile(directory, name);
    if (text !== null) for (const [path, at] of blockPositions(name, utf8(text, `knowledge/${name}`))) blocks.set(path, at);
  }
  return { tree, run: run as unknown as LookupSource['run'], blocks };
}

/** The helpers of the workspace check word their facts with the category word in front; the one-line form takes it only once. */
function once(error: unknown): unknown {
  if (!(error instanceof CallFailure)) return error;
  const fact = error.fact.replace(/^(参数无效|无权限|不存在|已被占用|暂时不可用)：/u, '');
  return fact === error.fact ? error : new CallFailure(error.category, fact, error.next_action, { ...(error.path === undefined ? {} : { path: error.path }), ...(error.legal_form === undefined ? {} : { legal_form: error.legal_form }) });
}

export async function main(argv: string[], io: LookupIo = {}): Promise<number> {
  const out = io.out ?? ((text: string) => { process.stdout.write(text); });
  const err = io.err ?? ((text: string) => { process.stderr.write(text); });
  try {
    const args = parseCliOptions(argv, OPTIONS, USAGE);
    if (args.param === undefined && args.heads === undefined) throw new CallFailure('invalid_parameters', '缺少 --param 或 --heads，必须写一个', `请按 ${USAGE} 重试`);
    if (args.param !== undefined && args.heads !== undefined) throw new CallFailure('invalid_parameters', '--param 与 --heads 只能写一个', `请按 ${USAGE} 重试`);
    const cwd = resolveCwdRoots(io.cwd);
    const runFile = resolveExistingFileInsideCwd(cwd, args.run!, '--run', '写本次运行下载目录里的 run.json');
    const source = await readLookupSource(runFile.canonical);
    out(args.param !== undefined ? lookupParam(source, args.param) : lookupHeads(source, args.heads!));
    return 0;
  } catch (error) {
    err(formatClientCallError(once(error)) + '\n');
    return 1;
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
