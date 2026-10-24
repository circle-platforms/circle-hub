// Export acceptance inputs through the administrator's public reads: the knowledge views and the original CLI, both over
// `bin/circle-hub`. No real data is used by tests.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const hex = /^[a-f0-9]{64}$/;
/** The data field the index keys on and the facets view counts: one field, so one facet row is one index key. */
const KEY_FIELD = 'document';
/** The value the index counts in total_keys but never lists as a key (a JSON reader would take it for the prototype). */
const PROTO_KEY = '__proto__';
const object = (v: any): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
const hash = (v: Uint8Array) => createHash('sha256').update(v).digest('hex');
export class ExportError extends Error {
  readonly missing: string;
  readonly action: string;
  constructor(missing: string, action: string) { super(missing); this.missing = missing; this.action = action; }
}
const fail = (missing: string, action: string): never => { throw new ExportError(missing, action); };
export interface Options { token: string; product: string; build: string; out: string }
/** One view read: the view as JSON, and the two roots the reader locked (the build root and the product-wide one). */
export interface ViewRead { view: any; root: string; unversioned?: string }
export interface Deps {
  index(external: string): Promise<ViewRead>;
  facets(external: string): Promise<ViewRead>;
  cli(args: string[]): Promise<string>;
}

/** Resolve every ancestor before checking Git, including a symlink ancestor of a nonexistent destination. */
export function prepareOutput(path: string): string {
  let ancestor = resolve(path);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const actual = realpathSync(ancestor);
  if (!lstatSync(actual).isDirectory()) fail('输出目录', '指定仓库外的空目录');
  const check = spawnSync('git', ['-C', actual, 'rev-parse', '--is-inside-work-tree', '--is-inside-git-dir'], { encoding: 'utf8' });
  if (check.stdout.split(/\s+/).includes('true')) fail('仓库外输出目录', '改用仓库外的空目录');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const out = realpathSync(path);
  if (readdirSync(out).length) fail('空输出目录', '换一个新的仓库外目录，保留已有证据');
  chmodSync(out, 0o700);
  if (/[\r\n]/.test(out)) fail('可写入清单的目录', '目录名不要含换行');
  return out;
}
function viewOf(value: any): any {
  if (!object(value) || value.schema !== 'index-view@1' || value.kind !== 'case' || value.key !== 'document' ||
      !object(value.build) || !hex.test(value.build.root) || !object(value.keys) || !object(value.entries) ||
      !['total_keys', 'total_entries', 'skipped'].every(k => Number.isSafeInteger(value[k]) && value[k] >= 0) ||
      typeof value.truncated !== 'boolean' || !Array.isArray(value.cut_keys) || !Array.isArray(value.notes))
    fail('合式的文档用例索引', '核对 Hub 与脚本版本后重新导出');
  for (const [key, entries] of Object.entries(value.keys)) {
    if (!key || /[\r\n:]/.test(key) || !Array.isArray(entries) || entries.some(id => !hex.test(id) || !object(value.entries[id])))
      fail('完整的文档用例索引条目', '修复索引键或缺失条目后重新生产并导出');
  }
  if (value.skipped) fail('已读取的全部来源', '修复未读来源并重新生产知识根，再重新导出');
  if (value.cut_keys.length) fail('单个文档键下的完整条目', '协调提高单键条目上限后重新导出；only= 不能拆开同一键');
  return value;
}
/**
 * The facets view of the same scan (`kind=case&by=document`): one row per distinct value with its entry count, the null
 * group for the entries that carry no value, `total` for every entry of the kind (placed and unplaced) and
 * `totals.empty.document` for the null group. It is the only public read that enumerates the index keys completely.
 */
function facetViewOf(value: any): any {
  if (!object(value) || value.schema !== 'facet-view@1' || value.kind !== 'case' ||
      !Array.isArray(value.by) || value.by.length !== 1 || value.by[0] !== KEY_FIELD ||
      !object(value.build) || !hex.test(value.build.root) || !Array.isArray(value.rows) ||
      !Number.isSafeInteger(value.total) || value.total < 0 || typeof value.truncated !== 'boolean' ||
      !Number.isSafeInteger(value.skipped) || value.skipped < 0 || !Array.isArray(value.notes) ||
      !object(value.totals) || !object(value.totals.empty) ||
      !Number.isSafeInteger(value.totals.empty[KEY_FIELD]) || value.totals.empty[KEY_FIELD] < 0)
    fail('合式的文档用例分面', '核对 Hub 与脚本版本后重新导出');
  if (value.skipped) fail('已读取的全部来源', '修复未读来源并重新生产知识根，再重新导出');
  return value;
}
/**
 * The index key text of a facet value: a string as it is, another scalar as its canonical JSON text — what the Hub keys
 * a value that is not a string by. A value that is not a scalar already arrives as that text, so it is a string here.
 */
function keyText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  return fail('可映射成索引键的分面取值', '分面取值不是字符串、有限数字或布尔；核对 Hub 的分面视图版本后重新导出');
}
interface Original { external: string; sha: string; size: number; at: string }
function originals(text: string): Original[] {
  const rows: Original[] = [];
  for (const line of text.split('\n')) {
    const [external, sha, size, at, extra] = line.trimEnd().split('\t');
    if (!hex.test(sha ?? '')) continue; // The CLI's fixed empty-list sentence has no digest.
    if (extra !== undefined || !/^\d+ 字节$/.test(size ?? '') || !Number.isFinite(Date.parse(at))) fail('可核对的原件清单', '核对管理员 CLI 版本后重新导出');
    rows.push({ external, sha, size: Number(size.split(' ')[0]), at });
  }
  return rows;
}
export async function exportBuild(options: Options, deps: Deps): Promise<string[]> {
  const out = prepareOutput(options.out);
  const summaries: string[] = [];
  const save = (name: string, bytes: Uint8Array) => {
    writeFileSync(join(out, name), bytes, { flag: 'wx', mode: 0o600 });
    summaries.push(`文件 ${summaries.length + 1}；字节 ${bytes.length}；sha256 ${hash(bytes)}`);
  };
  // Authenticate the local administrator CLI before any view read writes its records.
  await deps.cli(['original', 'list', '--external', 'accept-export-preflight:', '--limit', '1']);
  const base = `knowledge:index:${encodeURIComponent(options.product)}:${encodeURIComponent(options.build)}?kind=case&key=${KEY_FIELD}&fields=commands,document,node`;
  const first = await deps.index(base);
  const initial = viewOf(first.view);
  if (initial.build.root !== first.root) fail('与运行锁定根一致的索引', '重新导出同一构建；若仍不一致，交管理员核对读取器');
  /**
   * One snapshot: the same two roots and compositions, the same product and build name. The unversioned *totals* are not
   * compared: an index view filters them by its own `only`, so a shard's summary legitimately counts less than the
   * discovery read's while both read the same product-wide composition.
   */
  const sameSnapshot = (read: ViewRead, view: any, what: string) => {
    if (read.root !== first.root || read.unversioned !== first.unversioned || view.build.root !== initial.build.root ||
        view.product !== initial.product || view.build.build !== initial.build.build ||
        (view.unversioned?.composition ?? null) !== (initial.unversioned?.composition ?? null))
      fail(`同一快照的${what}`, '构建根或无版本根发生变化；换空目录重新导出');
  };
  const locked = (read: ViewRead) => {
    const view = viewOf(read.view);
    sameSnapshot(read, view, '全部索引分片');
    return view;
  };
  let documents = Object.keys(initial.keys).sort();
  const pages: any[] = [];
  if (!initial.truncated) pages.push(initial);
  else {
    // The index has no key cursor, and a tree walk cannot enumerate what the production left unplaced at the root:
    // get_nodes lists the entries hung on nodes, while an unplaced entry is readable only by its own reference — yet the
    // index counts it in total_keys and total_entries. The facets view of the same scan counts the same entries and lists
    // every distinct value, placed and unplaced alike, so it is the complete key list; each key is then fetched by only=.
    const facetRead = await deps.facets(`knowledge:facets:${encodeURIComponent(options.product)}:${encodeURIComponent(options.build)}?kind=case&by=${KEY_FIELD}`);
    const facet = facetViewOf(facetRead.view);
    sameSnapshot(facetRead, facet, '文档分面');
    const found = new Set<string>(documents);
    let values = 0;
    for (const row of facet.rows) {
      if (!object(row) || !object(row.values) || !Object.hasOwn(row.values, KEY_FIELD) || !Number.isSafeInteger(row.count) || row.count < 1)
        fail('合式的分面行', '核对 Hub 的分面视图版本后重新导出');
      const key = keyText(row.values[KEY_FIELD]);
      if (key === null) continue; // The null group: the entries that carry no value of the key. The index has no key for them.
      values++;
      if (key === '') fail('可导出的文档键', '有一个文档键是空字符串，only= 表达不了空取值；请管理员核对来源里 document 为空的用例条目，改正后重新生产并导出');
      if (key === PROTO_KEY) fail('可列出的文档键', `有一个文档键是 ${PROTO_KEY}，索引视图把它计入 total_keys 却不作为键列出；请管理员核对来源里该 document 取值的条目，改正后重新生产并导出`);
      found.add(key);
    }
    documents = [...found].sort();
    const carriers = facet.total - facet.totals.empty[KEY_FIELD];
    if (documents.length !== initial.total_keys)
      fail(`与索引 total_keys 一致的完整文档键（索引 ${initial.total_keys} 个，分面非空取值 ${values} 行，两边合计 ${documents.length} 个，分面截断 ${facet.truncated ? '是' : '否'}）`,
        '按分面视图自己的说明补齐少的取值：行被行数或字节预算截断、取值文字有凭据扫描命中、条目组合数超过上限都会少列；处理后重新导出。未归位条目的键分面照常列出，重新生产不会补上这个差');
    if (carriers !== initial.total_entries)
      fail(`两个视图一致的用例条目总数（索引 total_entries ${initial.total_entries}，分面 total ${facet.total} 减无文档键 ${facet.totals.empty[KEY_FIELD]} 为 ${carriers}）`,
        '核对两个视图读的是不是同一快照，以及来源里有没有 document 是混着空的列表的条目（索引按元素计键，分面把该条目同时计入空组）；改正来源后重新生产并导出');
    if (!documents.length) fail('可补取的索引键', '核对索引截断原因并修复来源后重新导出');
    for (const document of documents) {
      const page = locked(await deps.index(`${base}&only=${encodeURIComponent(document)}`));
      const listed = Object.keys(page.entries).length;
      if (!Object.hasOwn(page.keys, document) || Object.keys(page.keys).length !== 1)
        fail('该文档键下列出的条目', '这个文档的条目一条也没有列出（多半是它们的文字有凭据扫描命中而被排除）；请管理员受理这些命中或修复来源文字，重新生产后导出');
      // A single listed key with no per-key cut can only be truncated by entries the scan withheld: they stay in the
      // totals and leave every listing, so the shard's own totals name exactly how many are missing.
      if (page.truncated && page.total_entries === listed)
        fail('可解释的分片截断', '这个单文档分片标了截断，却没有条目差额可以解释；核对 Hub 与脚本版本后重新导出');
      pages.push(page);
    }
  }
  const entries = new Set(pages.flatMap(page => Object.keys(page.entries)));
  /** Entries the Hub counted and withheld from every listing (their own text has credential scan hits). */
  const withheld = pages.reduce((sum, page) => sum + Math.max(0, page.total_entries - Object.keys(page.entries).length), 0);
  if (documents.length !== initial.total_keys || entries.size + withheld !== initial.total_entries)
    fail(`与总数一致的全部索引条目（文档 ${documents.length}/${initial.total_keys}，条目 ${entries.size}${withheld === 0 ? '' : ` 加扫描排除 ${withheld}`}/${initial.total_entries}）`,
      '核对文档字段和索引完整性；差额若来自凭据扫描排除，请管理员受理这些命中或修复来源文字，重新生产后导出');
  pages.forEach((page, i) => save(`index-${i + 1}.json`, Buffer.from(JSON.stringify(page, null, 2) + '\n')));
  let missing = 0;
  const maps: string[] = [];
  const obtain = async (row: Original, name: string) => {
    const path = join(out, name);
    await deps.cli(['original', 'export', row.sha, '--out', path]);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('普通原件文件', '检查导出目录和 CLI 后重新导出');
    const bytes = readFileSync(path);
    if (bytes.length !== row.size || hash(bytes) !== row.sha) fail('摘要一致的原件字节', '停止使用这批输入，核对原件存储和管理员 CLI 后重新导出');
    summaries.push(`原件 ${summaries.length + 1}；字节 ${bytes.length}；sha256 ${row.sha}`);
    return bytes;
  };
  for (const [i, document] of documents.entries()) {
    const exact = `agile:case:${document}`;
    const rows = originals(await deps.cli(['original', 'list', '--external', exact, '--limit', '500']));
    const row = rows.filter(r => r.external === exact).sort((a, b) => b.at.localeCompare(a.at))[0];
    if (!row) { missing++; continue; }
    const original = await obtain(row, `original-map-${i + 1}.json`);
    let map: unknown; let mapBytes = original;
    try {
      map = JSON.parse(original.toString('utf8'));
      if (object(map) && !object(map.root) && typeof map.data === 'string') {
        mapBytes = Buffer.from(map.data, 'utf8');
        map = JSON.parse(map.data);
      }
    } catch { fail('可解析的脑图原件', '核对平台原始回答和 data 字符串格式后重新导出'); }
    if (!object(map) || !object(map.root)) fail('含 root 的脑图数据', '核对平台回答中的 data 脑图字段，补读该原件后重新导出');
    save(`map-${i + 1}.json`, mapBytes);
    maps.push(`${join(out, `map-${i + 1}.json`)}:${document}`);
  }
  save('maps.txt', Buffer.from(maps.join('\n') + (maps.length ? '\n' : '')));
  const suffix = `/command_tree-${options.build}.xml`;
  const trees = originals(await deps.cli(['original', 'list', '--external', 'buildsite:file:', '--suffix', suffix, '--limit', '500']));
  const matches = trees.filter(r => r.external.startsWith('buildsite:file:') && r.external.slice('buildsite:file:'.length).endsWith(suffix));
  if (trees.length >= 500 || matches.length !== 1) missing++;
  else await obtain(matches[0], 'command-tree.xml');
  if (missing) fail(`原件缺失或不唯一 ${missing} 份`, '管理员按构建列出的文档清单补读原件，核对命令树路径及原件列表上限；换空目录重新导出');
  return [`索引 ${pages.length} 份；文档 ${documents.length} 份；用例 ${entries.size} 条${withheld === 0 ? '' : `（另有 ${withheld} 条被凭据扫描排除，没有进输入）`}；命令树 1 份`, ...summaries];
}

export type CliRunner = (args: string[], env: NodeJS.ProcessEnv) => Promise<{ status: number | null; stdout: string }>;
export function createDeps(options: Options, runner?: CliRunner): Deps {
  let reads = 0;
  /** One administrator view read: the CLI writes the view bytes to a new file, which is parsed and removed again. */
  const readView = async (external: string): Promise<ViewRead> => {
    const at = external.indexOf('&only=');
    const path = join(options.out, `view-read-${++reads}.json`);
    await cli(['knowledge', 'view', at < 0 ? external : external.slice(0, at), ...(at < 0 ? [] : ['--only', external.slice(at + 6)]), '--out', path]);
    const bytes = readFileSync(path);
    let view: any;
    try { view = JSON.parse(bytes.toString('utf8')); } catch { fail('完整 JSON 视图', '修复知识视图导出后重新导出'); }
    unlinkSync(path);
    return { view, root: view?.build?.root, unversioned: view?.unversioned?.root };
  };
  return { index: readView, facets: readView, cli };
  async function cli(args: string[]): Promise<string> {
    const env = { ...process.env, CIRCLE_HUB_TOKEN: options.token };
    const result = runner ? await runner(['bin/circle-hub', ...args], env) : spawnSync(process.execPath, ['bin/circle-hub', ...args], { cwd: REPO, env, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.status !== 0) fail('成功的管理员原件命令', '在部署主机核对 CLI 的数据库配置和管理员令牌，再重新导出');
    return result.stdout;
  }
}
export async function main(argv = process.argv.slice(2), io = { out: (s: string) => console.log(s), error: (s: string) => console.error(s) }): Promise<number> {
  try {
    const values: Record<string, string> = {};
    for (let i = 0; i < argv.length; i += 2) {
      const name = argv[i];
      if (!['--token-file', '--product', '--build', '--out'].includes(name) || values[name] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--'))
        fail('完整命令参数', '使用 --token-file <文件> --product <产品> --build <构建> --out <仓库外空目录>');
      values[name] = argv[i + 1];
    }
    if (['--token-file', '--product', '--build', '--out'].some(k => !values[k])) fail('必填参数', '补齐 --token-file、--product、--build 和 --out');
    const token = readFileSync(values['--token-file'], 'utf8').trim();
    if (!token) fail('非空令牌', '让管理员提供有效的令牌文件');
    const options = { token, product: values['--product'], build: values['--build'], out: resolve(values['--out']) };
    for (const line of await exportBuild(options, createDeps(options))) io.out(line);
    return 0;
  } catch (error) {
    const e = error instanceof ExportError ? error : new ExportError('导出所需的可读文件或命令', '核对令牌文件、目录权限和 CLI 的数据库配置后重新导出');
    io.error(`缺少：${e.missing}；下一步：${e.action}`);
    return 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().then(code => { process.exitCode = code; });
