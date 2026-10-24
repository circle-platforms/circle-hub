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
/** Most pages of one view an export follows: a page holds thousands of entries, so a real build needs a handful. */
const MAX_PAGES = 1000;
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
      typeof value.truncated !== 'boolean' || !Array.isArray(value.cut_keys) || !Array.isArray(value.notes) ||
      !(value.next === undefined || value.next === null || typeof value.next === 'string'))
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
      !(value.next === undefined || value.next === null || typeof value.next === 'string') ||
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
/** The continuation id a view names for its next page, or null on the last page (a malformed one is a Hub/script mismatch). */
function nextOf(view: any): string | null {
  if (view.next === undefined || view.next === null) return null;
  if (typeof view.next === 'string' && view.next !== '') return view.next;
  return fail('合式的续页标识', '视图的 next 不是空的续读标识；核对 Hub 与脚本版本后重新导出');
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
    sameCounts(view, '索引分页或分片');
    return view;
  };
  /**
   * The deduplicated entry counts of the locked scope (`totals.entry_counts`: total, placed on the tree, not placed).
   * Every page, every only= shard and the facets view count the same entries, so a difference means another snapshot.
   */
  function sameCounts(view: any, what: string): void {
    const whole = initial.totals?.entry_counts, mine = view.totals?.entry_counts;
    if (!object(whole) || !object(mine)) return; // An older Hub does not carry the counts: nothing to compare.
    // Field by field: a parsed answer may order its members differently than the canonical bytes of another view.
    if (whole.total !== mine.total || whole.placed !== mine.placed || whole.unplaced !== mine.unplaced)
      fail(`同一快照的条目计数（${what}）`, '视图的 totals.entry_counts 与首页不同（总数、已挂到树上位置、未挂到树上位置）；构建在导出中被重新生产或同步过，换空目录重新导出');
  }
  // ---- the key list: page the index by its own continuation id, then cross-check it against the facets view
  const pages: any[] = [initial];
  const keys = new Set<string>(Object.keys(initial.keys));
  const pagedListed = new Set<string>(Object.keys(initial.entries));
  const followed = new Set<string>();
  /** Continuation reads the Hub refused: a page whose entries have unaccepted credential hits is not served by `after`. */
  let refused = 0;
  let next = nextOf(initial);
  while (next !== null) {
    if (followed.has(next)) fail('可推进的索引续页', '索引重复给出同一个续页标识；核对 Hub 与脚本版本后重新导出');
    followed.add(next);
    if (pages.length >= MAX_PAGES) fail(`可读完的索引分页（不超过 ${MAX_PAGES} 页）`, '索引分页过多；核对视图字节预算和构建规模后重新导出');
    let read: ViewRead;
    try { read = await deps.index(next); } catch (error) {
      if (!(error instanceof ExportError)) throw error;
      refused++; // The facets view below still enumerates every key; a stopped page is reported, never guessed away.
      break;
    }
    const page = locked(read);
    if (page.total_keys !== initial.total_keys || page.total_entries !== initial.total_entries)
      fail('每页一致的索引总数', '续页的 total_keys 或 total_entries 与首页不同；换空目录重新导出同一构建');
    pages.push(page);
    for (const key of Object.keys(page.keys)) keys.add(key);
    for (const digest of Object.keys(page.entries)) pagedListed.add(digest);
    next = nextOf(page);
  }

  // The facets view of the same scan counts the same entries — placed, unplaced at the root and product-wide alike — and
  // lists every distinct value, so its rows and totals cross-check the paged key list. It pages by its own continuation.
  const facetId = `knowledge:facets:${encodeURIComponent(options.product)}:${encodeURIComponent(options.build)}?kind=case&by=${KEY_FIELD}`;
  const facetKeys = new Set<string>();
  const followedFacets = new Set<string>();
  let facetRows = 0, facetRefused = 0, facetPages = 1, facetTotal = 0, facetEmpty = 0, facetTruncated = false;
  const addRows = (view: any) => {
    for (const row of view.rows) {
      if (!object(row) || !object(row.values) || !Object.hasOwn(row.values, KEY_FIELD) || !Number.isSafeInteger(row.count) || row.count < 1)
        fail('合式的分面行', '核对 Hub 的分面视图版本后重新导出');
      const key = keyText(row.values[KEY_FIELD]);
      if (key === null) continue; // The null group: the entries that carry no value of the key. The index has no key for them.
      facetRows++;
      if (key === '') fail('可导出的文档键', '有一个文档键是空字符串，only= 表达不了空取值；请管理员核对来源里 document 为空的用例条目，改正后重新生产并导出');
      if (key === PROTO_KEY) fail('可列出的文档键', `有一个文档键是 ${PROTO_KEY}，索引视图不为它列出任何键；请管理员核对来源里该 document 取值的条目，改正后重新生产并导出`);
      facetKeys.add(key);
    }
  };
  const facetRead = await deps.facets(facetId);
  const facet = facetViewOf(facetRead.view);
  sameSnapshot(facetRead, facet, '文档分面');
  sameCounts(facet, '文档分面');
  addRows(facet);
  facetTotal = facet.total; facetEmpty = facet.totals.empty[KEY_FIELD]; facetTruncated = facet.truncated;
  let facetNext = nextOf(facet);
  while (facetNext !== null) {
    if (followedFacets.has(facetNext)) fail('可推进的分面续页', '分面视图重复给出同一个续页标识；核对 Hub 与脚本版本后重新导出');
    followedFacets.add(facetNext);
    if (facetPages >= MAX_PAGES) fail(`可读完的分面分页（不超过 ${MAX_PAGES} 页）`, '分面分页过多；核对视图字节预算和构建规模后重新导出');
    let read: ViewRead;
    try { read = await deps.facets(facetNext); } catch (error) {
      if (!(error instanceof ExportError)) throw error;
      facetRefused++;
      break;
    }
    const page = facetViewOf(read.view);
    sameSnapshot(read, page, '文档分面');
    sameCounts(page, '文档分面分页');
    if (page.total !== facetTotal || page.totals.empty[KEY_FIELD] !== facetEmpty)
      fail('每页一致的分面总数', '分面续页的 total 或空组计数与首页不同；换空目录重新导出同一构建');
    facetPages++;
    addRows(page);
    facetTruncated = facetTruncated || page.truncated;
    facetNext = nextOf(page);
  }

  const documents = [...new Set([...keys, ...facetKeys])].sort();
  const carriers = facetTotal - facetEmpty;
  if (documents.length !== initial.total_keys)
    fail(`与索引 total_keys 一致的完整文档键（索引 ${initial.total_keys} 个，分页列出 ${keys.size} 个，分面非空取值 ${facetRows} 行，合计 ${documents.length} 个，读不出的续页 ${refused + facetRefused} 次）`,
      '按两个视图自己的说明补齐：分面行被行数或字节预算截断、取值文字有凭据扫描命中、续页读不出都会少列；处理后重新导出。未归位条目和产品级根的条目两个视图照常计入，重新生产不会补上这个差');
  if (carriers !== initial.total_entries)
    fail(`两个视图一致的用例条目总数（索引 total_entries ${initial.total_entries}，分面 total ${facetTotal} 减无文档键 ${facetEmpty} 为 ${carriers}）`,
      '核对两个视图读的是不是同一快照，以及来源里有没有 document 是混着空的列表的条目（索引按元素计键，分面把该条目同时计入空组）；改正来源后重新生产并导出');
  if (documents.length === 0 && (refused > 0 || facetRefused > 0 || pages.length > 1 || facetPages > 1 || initial.truncated || facetTruncated))
    // A locked product-wide root may legitimately be empty, but only an answer that declares itself complete and empty
    // proves it: a refused continuation, a second page, a truncated view or a note is never that declaration.
    fail('确认完整且为空的文档键',
      `索引读了 ${pages.length} 页、分面读了 ${facetPages} 页，读不出的续页 ${refused + facetRefused} 次，截断 ${initial.truncated || facetTruncated ? '是' : '否'}；空答复不等于空根。下一步：管理员受理这些页上的凭据命中或修复来源后重新导出，不能把读不全当作没有条目`);

  // ---- the saved views: the one complete page when the first already is one, else one only= shard per document
  const shards: any[] = [];
  if (pages.length === 1 && !initial.truncated) shards.push(initial);
  else for (const document of documents) {
    const page = locked(await deps.index(`${base}&only=${encodeURIComponent(document)}`));
    const listed = Object.keys(page.entries).length;
    if (!Object.hasOwn(page.keys, document) || Object.keys(page.keys).length !== 1)
      fail('该文档键下列出的条目', '这个文档的条目一条也没有列出（多半是它们的文字有凭据扫描命中而被排除）；请管理员受理这些命中或修复来源文字，重新生产后导出');
    // A single listed key can only be truncated by entries the scan withheld: they stay in the totals and leave every
    // listing, so the shard's own totals name exactly how many are missing.
    if (page.truncated && page.total_entries === listed)
      fail('可解释的分片截断', '这个单文档分片标了截断，却没有条目差额可以解释；核对 Hub 与脚本版本后重新导出');
    shards.push(page);
  }
  const entries = new Set(shards.flatMap(page => Object.keys(page.entries)));
  /** Entries the Hub counted and withheld from every listing (their own text has credential scan hits). */
  const withheld = shards.reduce((sum, page) => sum + Math.max(0, page.total_entries - Object.keys(page.entries).length), 0);
  const lost = [...pagedListed].filter(digest => !entries.has(digest)).length;
  if (documents.length !== initial.total_keys || entries.size + withheld !== initial.total_entries || lost > 0)
    fail(`与总数一致的全部索引条目（文档 ${documents.length}/${initial.total_keys}，条目 ${entries.size}${withheld === 0 ? '' : ` 加扫描排除 ${withheld}`}/${initial.total_entries}，分页列出而分片没给的 ${lost} 条）`,
      '核对文档字段和索引完整性；差额若来自凭据扫描排除，请管理员受理这些命中或修复来源文字，重新生产后导出');
  shards.forEach((page, i) => save(`index-${i + 1}.json`, Buffer.from(JSON.stringify(page, null, 2) + '\n')));
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
  const lines = [`索引 ${shards.length} 份；文档 ${documents.length} 份${documents.length === 0 && facetEmpty > 0 ? `（有 ${facetEmpty} 条用例没有文档键）` : ''}；用例 ${entries.size} 条${withheld === 0 ? '' : `（另有 ${withheld} 条被凭据扫描排除，没有进输入）`}；命令树 1 份`];
  if (refused + facetRefused > 0) lines.push(`读不出的续页 ${refused + facetRefused} 次，文档键由分面视图补齐；下一页读不出通常是该页条目有未受理的凭据命中，管理员受理后可整页续读`);
  return [...lines, ...summaries];
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
    if (result.status !== 0) {
      if (args[0] === 'knowledge') fail('成功的管理员视图读取', '核对产品、构建、管理员令牌和权限；若构建在导出中重新生产或同步过，快照已移动，换空目录重新导出');
      fail('成功的管理员原件命令', '在部署主机核对 CLI 的数据库配置和管理员令牌，再重新导出');
    }
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
