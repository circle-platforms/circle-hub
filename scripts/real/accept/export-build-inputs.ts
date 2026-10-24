// Export acceptance inputs through public MCP reads and the administrator original CLI. No real data is used by tests.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { callTools } from '../hub-call.ts';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const hex = /^[a-f0-9]{64}$/;
const object = (v: any): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
const hash = (v: Uint8Array) => createHash('sha256').update(v).digest('hex');
export class ExportError extends Error {
  readonly missing: string;
  readonly action: string;
  constructor(missing: string, action: string) { super(missing); this.missing = missing; this.action = action; }
}
const fail = (missing: string, action: string): never => { throw new ExportError(missing, action); };
export interface Options { token: string; url: string; product: string; build: string; out: string }
export interface IndexRead { view: any; root: string; unversioned?: string }
export interface Deps {
  index(external: string): Promise<IndexRead>;
  nodes(args: Record<string, unknown>): Promise<any>;
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
  // Authenticate the local administrator CLI before the MCP side writes any run records.
  await deps.cli(['original', 'list', '--external', 'accept-export-preflight:', '--limit', '1']);
  const base = `knowledge:index:${encodeURIComponent(options.product)}:${encodeURIComponent(options.build)}?kind=case&key=document&fields=commands,document,node`;
  const first = await deps.index(base);
  const initial = viewOf(first.view);
  if (initial.build.root !== first.root) fail('与运行锁定根一致的索引', '重新导出同一构建；若仍不一致，交管理员核对读取器');
  const locked = (read: IndexRead) => {
    const view = viewOf(read.view);
    if (read.root !== first.root || read.unversioned !== first.unversioned || view.build.root !== initial.build.root ||
        view.product !== initial.product || view.build.build !== initial.build.build || JSON.stringify(view.unversioned) !== JSON.stringify(initial.unversioned))
      fail('同一快照的全部索引分片', '构建根或无版本根发生变化；换空目录重新导出');
    return view;
  };
  let documents = Object.keys(initial.keys).sort();
  const pages: any[] = [];
  if (!initial.truncated) pages.push(initial);
  else {
    // The index has no key cursor. Traverse the locked roots through get_nodes to discover keys hidden by its byte cap.
    const docs = new Set<string>(documents);
    for (const root of [...new Set([first.root, first.unversioned].filter((v): v is string => !!v))]) {
      const pending = ['/']; const visited = new Set<string>();
      while (pending.length) {
        const path = pending.shift()!;
        if (visited.has(path)) continue;
        visited.add(path);
        let cursor: string | undefined; const cursors = new Set<string>();
        do {
          const answer = await deps.nodes({ root, paths: [path], depth: 0, ...(cursor ? { cursor } : {}) });
          if (!object(answer) || answer.call_result !== 'ok' || answer.root !== root || !Array.isArray(answer.nodes) || !answer.nodes.length)
            fail('锁定根的完整文档键', '恢复 get_nodes 读取权限或来源后重新导出');
          for (const node of answer.nodes) {
            if (!Array.isArray(node.entries) || !Array.isArray(node.children)) fail('完整树节点', '核对 Hub 的 get_nodes 回答后重新导出');
            for (const e of node.entries) if (e.kind === 'case' && typeof e.data?.document === 'string') docs.add(e.data.document);
            for (const child of node.children) { if (typeof child.path !== 'string') fail('子节点路径', '修复树节点后重新导出'); pending.push(child.path); }
          }
          const next = answer.next ?? undefined;
          if (next && (typeof next !== 'string' || cursors.has(next))) fail('可推进的树分页', '修复 get_nodes 分页游标后重新导出');
          if (next) cursors.add(next);
          cursor = next;
        } while (cursor);
      }
    }
    documents = [...docs].sort();
    if (documents.length !== initial.total_keys) fail('完整的索引文档键', '核对被扫描排除的条目或无文档键条目，修复来源后重新生产并导出');
    for (const document of documents) {
      const page = locked(await deps.index(`${base}&only=${encodeURIComponent(document)}`));
      if (page.truncated || Object.keys(page.keys).length !== 1 || !Object.hasOwn(page.keys, document))
        fail('完整的单文档索引分片', '核对扫描排除或单键预算，提高对应上限后重新导出');
      pages.push(page);
    }
    if (!documents.length) fail('可补取的索引键', '核对索引截断原因并修复来源后重新导出');
  }
  const entries = new Set(pages.flatMap(page => Object.keys(page.entries)));
  if (documents.length !== initial.total_keys || entries.size !== initial.total_entries)
    fail('与总数一致的全部索引条目', '核对文档字段和索引完整性，修复来源后重新导出');
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
  return [`索引 ${pages.length} 份；文档 ${documents.length} 份；用例 ${entries.size} 条；命令树 1 份`, ...summaries];
}

export type CliRunner = (args: string[], env: NodeJS.ProcessEnv) => Promise<{ status: number | null; stdout: string }>;
export function createDeps(options: Options, runner?: CliRunner): Deps {
  const session = randomUUID(); let reads = 0;
  const tool = async (name: string, args: unknown): Promise<any> => {
    const [answer] = await callTools({ token: options.token, url: options.url, session }, [{ tool: name, args }]);
    if (answer.isError || !object(answer.structured) || answer.structured.call_result !== 'ok') fail('成功的公开工具回答', '核对令牌权限、包分配、构建和来源后重新导出');
    return answer.structured;
  };
  const nodes = (args: Record<string, unknown>) => tool('get_nodes', args);
  return {
    nodes,
    async index(external) {
      const path = join(options.out, `view-read-${++reads}.json`);
      const at = external.indexOf('&only=');
      await cli(['knowledge', 'view', at < 0 ? external : external.slice(0, at), ...(at < 0 ? [] : ['--only', external.slice(at + 6)]), '--out', path]);
      const bytes = readFileSync(path);
      let view: any;
      try { view = JSON.parse(bytes.toString('utf8')); } catch { fail('完整 JSON 索引', '修复知识视图导出后重新导出'); }
      unlinkSync(path);
      return { view, root: view?.build?.root, unversioned: view?.unversioned?.root };

    },
    cli,
  };
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
      if (!['--token-file', '--url', '--product', '--build', '--out'].includes(name) || values[name] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--'))
        fail('完整命令参数', '使用 --token-file <文件> [--url <MCP地址>] --product <产品> --build <构建> --out <仓库外空目录>');
      values[name] = argv[i + 1];
    }
    if (['--token-file', '--product', '--build', '--out'].some(k => !values[k])) fail('必填参数', '补齐 --token-file、--product、--build 和 --out');
    const token = readFileSync(values['--token-file'], 'utf8').trim();
    if (!token) fail('非空令牌', '让管理员提供有效的令牌文件');
    const options = { token, url: values['--url'] ?? 'http://127.0.0.1:7420/mcp', product: values['--product'], build: values['--build'], out: resolve(values['--out']) };
    for (const line of await exportBuild(options, createDeps(options))) io.out(line);
    return 0;
  } catch (error) {
    const e = error instanceof ExportError ? error : new ExportError('导出所需的可读文件或连接', '核对令牌文件、目录权限、CLI 配置和 Hub 连接后重新导出');
    io.error(`缺少：${e.missing}；下一步：${e.action}`);
    return 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().then(code => { process.exitCode = code; });
