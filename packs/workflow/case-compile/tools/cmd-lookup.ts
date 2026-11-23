import { readFileSync, realpathSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockedTree } from '../functions/catalog-selection.ts';
import { formatClientCallError } from '../functions/client-cli.ts';
import { blockPositions, lookupHeads, lookupParam, type BlockPosition, type LookupSource } from '../functions/cmd-lookup.ts';
import { lookupBlock, lookupMethod, lookupMethods, methodSourceOf, type BlockExample, type BlockSource, type MethodSource, type SourceFile } from '../functions/contract-lookup.ts';
import { readSourceBytes, readSourceManifest, type SourceMaterial } from '../functions/source-materials.ts';
import { CallFailure, isRecord, parseCliOptions } from '../functions/text.ts';
import BLOCKS from '../tables/blocks-format.json' with { type: 'json' };
import { resolveCwdRoots, resolveRun } from './workspace-path.ts';

const OPTIONS: Record<string, boolean> = { run: true, param: false, heads: false, method: false, methods: false, block: false };
const FORMS = ['param', 'heads', 'method', 'methods', 'block'] as const;
const USAGE = "node '<技能目录>/tools/cmd-lookup.ts' --run '<运行目录>' 加 --param '<命令词>'、--heads '<命令词前缀>'、--method '<对象>.<方法>'、--methods '<对象>' 或 --block '<块种类>' 之一";
const RETRY = '用 tools/download-run.ts 重新下载本次运行，run.json 与 knowledge/ 留在同一个目录里';
const RETRY_SOURCES = '用 tools/download-run.ts 重新下载本次运行，run.json、sources.json 与 sources/ 留在同一个目录里';

export interface LookupIo { out?: (text: string) => void; err?: (text: string) => void; cwd?: string }

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

export async function readLookupSource(directory: string): Promise<LookupSource> {
  let run: unknown;
  try { run = JSON.parse(utf8(await readFile(join(directory, 'run.json')), 'run.json')); }
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

async function readRun(directory: string): Promise<{ [key: string]: unknown }> {
  let run: unknown;
  try { run = JSON.parse(utf8(await readFile(join(directory, 'run.json')), 'run.json')); }
  catch (error) { throw error instanceof CallFailure ? error : new CallFailure('invalid_parameters', 'run.json 不是完整的 JSON', RETRY_SOURCES); }
  if (!isRecord(run) || typeof run.run !== 'string') throw new CallFailure('invalid_parameters', 'run.json 缺少 run，不是运行导出的原件', RETRY_SOURCES);
  return run;
}
const missing = (error: unknown): error is NodeJS.ErrnoException => error instanceof Error && ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR');

export async function readMethodSource(directory: string): Promise<MethodSource> {
  await readRun(directory);
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
function sampleOf(kind: string): BlockExample | null {
  if (!/^[A-Z][A-Z0-9_]*$/.test(kind)) return null;
  try {
    const sample = JSON.parse(readFileSync(new URL(`typed-block-${kind}.json`, SAMPLES), 'utf8')) as unknown;
    const blocks = isRecord(sample) && isRecord(sample.subject) && isRecord(sample.subject.data) && Array.isArray(sample.subject.data.blocks) ? sample.subject.data.blocks : [];
    const index = blocks.findIndex((block) => isRecord(block) && block.kind === kind);
    return index < 0 ? null : { file: `samples/positive/typed-block-${kind}.json`, index: index + 1, count: blocks.length, block: blocks[index] };
  } catch { return null; }
}

export async function readBlockSource(directory: string): Promise<BlockSource> {
  const run = await readRun(directory);
  const slots = run.slots;
  if (!isRecord(slots) || !isRecord(slots.schema)) throw new CallFailure('invalid_parameters', 'run.json 里没有冻结的 slots.schema，查不了块种类', RETRY_SOURCES);
  return { schema: slots.schema, schemaSha256: typeof slots.sha256 === 'string' ? slots.sha256 : null, table: BLOCKS as unknown as Record<string, unknown>, example: sampleOf };
}

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
    const run = resolveRun(args.run!, cwd, RETRY);
    const form = given[0]!;
    if (form === 'param' || form === 'heads') {
      const source = await readLookupSource(run.directory.canonical);
      out(form === 'param' ? lookupParam(source, args.param!) : lookupHeads(source, args.heads!));
    } else if (form === 'block') out(lookupBlock(await readBlockSource(run.directory.canonical), args.block!));
    else {
      const source = await readMethodSource(run.directory.canonical);
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
