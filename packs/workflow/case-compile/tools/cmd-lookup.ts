// Read-only lookups over the download of a run: the command tree and the manual of the locked root, and the executor rules and the
// block format the run froze.
//   node '<技能目录>/tools/cmd-lookup.ts' --run '<下载目录>/run.json' --param '<命令词，可带参数>'
//   node '<技能目录>/tools/cmd-lookup.ts' --run '<下载目录>/run.json' --heads '<命令词前缀>'
//   node '<技能目录>/tools/cmd-lookup.ts' --run '<下载目录>/run.json' --method '<对象>.<方法>'
//   node '<技能目录>/tools/cmd-lookup.ts' --run '<下载目录>/run.json' --methods '<对象>'
//   node '<技能目录>/tools/cmd-lookup.ts' --run '<下载目录>/run.json' --block '<块种类>'
// `--param` answers one command with its definition in the tree, the manual's window from its signature line to the next command's,
// the inverse the product declares and the manual's example lines; `--heads` lists the command heads below a prefix with their syntax
// lines. A miss names the next words of the node the words reached and the heads with the same words in another order. They read
// run.json and knowledge/nodes.jsonl (and where the text files are, the lines their blocks start at) of the download beside it.
// `--method` answers one object.method of the frozen executor rules: whether the contract enables it and the profile opens it (and
// why not), its signature and G, H and I texts, the typed authority the Hub checks a plan against (roles, types, effect budgets, the
// literal commands and programs a host line may use), what the block model says of it, the seat it maps to, with the references to
// cite; `--methods` lists the methods of one object by those states; `--block` answers the fields a block kind takes from the frozen
// slot schema of run.json, the pack's block table and the pack's sample. They read run.json, sources.json and sources/ (contract,
// profile, inventory) of the download. None calls a Hub, decides anything or writes anything; the logic is functions/cmd-lookup.ts
// and functions/contract-lookup.ts.
import { readFileSync, realpathSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockedTree } from '../functions/catalog-selection.ts';
import { formatClientCallError } from '../functions/client-cli.ts';
import { blockPositions, lookupHeads, lookupParam, type BlockPosition, type LookupSource } from '../functions/cmd-lookup.ts';
import { lookupBlock, lookupMethod, lookupMethods, methodSourceOf, type BlockExample, type BlockSource, type MethodSource, type SourceFile } from '../functions/contract-lookup.ts';
import { readSourceBytes, readSourceManifest, type SourceMaterial } from '../functions/source-materials.ts';
import { CallFailure, isRecord, parseCliOptions } from '../functions/text.ts';
import BLOCKS from '../tables/blocks-format.json' with { type: 'json' };
import { resolveCwdRoots, resolveExistingFileInsideCwd } from './workspace-path.ts';

const OPTIONS: Record<string, boolean> = { run: true, param: false, heads: false, method: false, methods: false, block: false };
/** The forms of the tool: exactly one of them is written. */
const FORMS = ['param', 'heads', 'method', 'methods', 'block'] as const;
const USAGE = "node '<技能目录>/tools/cmd-lookup.ts' --run '<下载目录>/run.json' 加 --param '<命令词>'、--heads '<命令词前缀>'、--method '<对象>.<方法>'、--methods '<对象>' 或 --block '<块种类>' 之一";
const RETRY = '用 tools/download-run.ts 重新下载本次运行，run.json 与 knowledge/ 留在同一个目录里';
const RETRY_SOURCES = '用 tools/download-run.ts 重新下载本次运行，run.json、sources.json 与 sources/ 留在同一个目录里';

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

/** The run.json of a download: the run's own export, not another file. */
async function readRun(runFile: string): Promise<{ [key: string]: unknown }> {
  let run: unknown;
  try { run = JSON.parse(utf8(await readFile(runFile), 'run.json')); }
  catch (error) { throw error instanceof CallFailure ? error : new CallFailure('invalid_parameters', 'run.json 不是完整的 JSON', RETRY_SOURCES); }
  if (!isRecord(run) || typeof run.run !== 'string') throw new CallFailure('invalid_parameters', 'run.json 缺少 run，不是运行导出的原件', RETRY_SOURCES);
  return run;
}
const missing = (error: unknown): error is NodeJS.ErrnoException => error instanceof Error && ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR');

/**
 * The executor rules of the download as the Hub's own readers take them: the contract, the profile and the bed manifest, found
 * through the source manifest (sources.json: the file of each slot and its digest, checked here) or, in an old download without
 * one, at the root. The files are cited by the reference the run gives them.
 */
export async function readMethodSource(runFile: string): Promise<MethodSource> {
  const directory = dirname(runFile);
  await readRun(runFile);
  const info = await lstat(join(directory, 'sources.json')).catch((error: NodeJS.ErrnoException) => { if (missing(error)) return null; throw error; });
  let manifest: SourceMaterial[] | null = null;
  const documents: { [slot: string]: unknown } = {};
  const files: { [slot: string]: SourceFile } = {};
  try {
    if (info !== null) manifest = await readSourceManifest(directory);
    for (const slot of ['contract', 'profile', 'inventory']) {
      const bytes = await readSourceBytes(directory, slot);
      const row = manifest?.find((candidate) => candidate.slot === slot);
      try { documents[slot] = JSON.parse(utf8(bytes, `来源 ${slot}`)); }
      catch (error) { throw error instanceof CallFailure ? error : new CallFailure('invalid_parameters', `来源 ${slot} 不是完整的 JSON`, RETRY_SOURCES); }
      files[slot] = { file: row?.file ?? `${slot}.json`, reference: row?.reference ?? null };
    }
  } catch (error) {
    if (missing(error)) throw new CallFailure('not_found', `下载目录里缺来源文件${error.path === undefined ? '' : `：${error.path}`}，来源清单指向的文件读不到`, RETRY_SOURCES);
    throw error;
  }
  return methodSourceOf({ contract: documents.contract, profile: documents.profile, inventory: documents.inventory }, { contract: files.contract!, profile: files.profile!, inventory: files.inventory! });
}

const SAMPLES = new URL('../samples/positive/', import.meta.url);
/** The sample the pack has of a block kind: the first block of that kind in samples/positive/typed-block-<KIND>.json, when there is one. */
function sampleOf(kind: string): BlockExample | null {
  if (!/^[A-Z][A-Z0-9_]*$/.test(kind)) return null;
  try {
    const sample = JSON.parse(readFileSync(new URL(`typed-block-${kind}.json`, SAMPLES), 'utf8')) as unknown;
    const blocks = isRecord(sample) && isRecord(sample.subject) && isRecord(sample.subject.data) && Array.isArray(sample.subject.data.blocks) ? sample.subject.data.blocks : [];
    const index = blocks.findIndex((block) => isRecord(block) && block.kind === kind);
    return index < 0 ? null : { file: `samples/positive/typed-block-${kind}.json`, index: index + 1, count: blocks.length, block: blocks[index] };
  } catch { return null; }
}

/** The block format of the download: the slot schema its run froze, the pack's block table and the pack's samples. */
export async function readBlockSource(runFile: string): Promise<BlockSource> {
  const run = await readRun(runFile);
  const slots = run.slots;
  if (!isRecord(slots) || !isRecord(slots.schema)) throw new CallFailure('invalid_parameters', 'run.json 里没有冻结的 slots.schema，查不了块种类', RETRY_SOURCES);
  return { schema: slots.schema, schemaSha256: typeof slots.sha256 === 'string' ? slots.sha256 : null, table: BLOCKS as unknown as Record<string, unknown>, example: sampleOf };
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
    const given = FORMS.filter((name) => args[name] !== undefined);
    if (given.length === 0) throw new CallFailure('invalid_parameters', '缺少 --param、--heads、--method、--methods 或 --block，必须写一个', `请按 ${USAGE} 重试`);
    if (given.length > 1) throw new CallFailure('invalid_parameters', '--param、--heads、--method、--methods 与 --block 只能写一个', `请按 ${USAGE} 重试`);
    const cwd = resolveCwdRoots(io.cwd);
    const runFile = resolveExistingFileInsideCwd(cwd, args.run!, '--run', '写本次运行下载目录里的 run.json');
    const form = given[0]!;
    if (form === 'param' || form === 'heads') {
      const source = await readLookupSource(runFile.canonical);
      out(form === 'param' ? lookupParam(source, args.param!) : lookupHeads(source, args.heads!));
    } else if (form === 'block') out(lookupBlock(await readBlockSource(runFile.canonical), args.block!));
    else {
      const source = await readMethodSource(runFile.canonical);
      out(form === 'method' ? lookupMethod(source, args.method!) : lookupMethods(source, args.methods!));
    }
    return 0;
  } catch (error) {
    err(formatClientCallError(once(error)) + '\n');
    return 1;
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
