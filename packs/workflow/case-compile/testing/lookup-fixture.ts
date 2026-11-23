import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathOf } from '../../../../hub/refs/api.ts';
import { knowledgeFiles } from '../functions/knowledge-text.ts';

type Row = { [key: string]: any };
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
export const LOOKUP_RUN = 'run_01aaaaaaaaaaaaaaaaaaaaaaaa';
export const LOOKUP_ROOT = sha('lookup fixture root');
export const SOURCE_CLI = sha('lookup fixture reference manual chapter');
export const SOURCE_APP = sha('lookup fixture guide manual chapter');
const SOURCE_XML = sha('lookup fixture command tree');
export const BULK = 65;
export const REPORT_ENTRIES = 50;

export const LOOKUP_POLICY = {
  schema: 'command-policy@1',
  read_only: ['/commands/show'],
  inverse_rules: [{ source_prefix: '/commands/no', inverse_prefix: '/commands' }, { source_prefix: '/commands', inverse_prefix: '/commands/no' }],
  inverse_alternatives: [['on', 'off']],
  confirmations: [{ command_prefix: '/commands/orbit/probe/run', prompt: 'proceed:', answer: 'YES' }],
};

export interface LookupFixture {
  run: string;
  root: string;
  rows: Row[];
  files: Map<string, Buffer>;
  statements: Map<string, string>;
  reference(path: string, start: string): string;
  runJson(policy?: unknown): Row;
}

interface Node { path: string; name: string; entries: Row[]; children: Map<string, string> }

export function lookupFixture(): LookupFixture {
  const nodes = new Map<string, Node>();
  const statements = new Map<string, string>();
  const at = (segments: string[]): Node => {
    const path = pathOf(segments);
    let node = nodes.get(path);
    if (node === undefined) {
      node = { path, name: segments.at(-1) ?? '', entries: [], children: new Map() };
      nodes.set(path, node);
      if (segments.length > 0) at(segments.slice(0, -1)).children.set(node.name, path);
    }
    return node;
  };
  const entry = (node: Node, kind: string, statement: string, data: Row, fragments: string[]): void => {
    const id = sha(`entry ${node.path} ${kind} ${statement} ${JSON.stringify(data)}`);
    const reference = `tree:${LOOKUP_ROOT}${node.path}@${id}`;
    node.entries.push({ entry: id, kind, statement, reference, data, fragments });
    statements.set(reference, statement);
  };
  const lines = (from: number, to?: number): string => (to === undefined || to === from ? `${from}` : `${from}-${to}`);

  const command = (words: string[], syntax: string, details: string[], params: Row[], manual?: { statement: string; line: number }, otherForm?: Row[]): void => {
    const node = at(['commands', ...words]);
    const statement = [syntax, ...details].join('\n');
    entry(node, 'definition', statement, { words, signatures: [{ id: '1', params, reference: `src:${SOURCE_XML}/xml@1/x/${words.join('/')}/arguments` }, ...(otherForm ? [{ id: '2', params: otherForm, reference: `src:${SOURCE_XML}/xml@1/x/${words.join('/')}/arguments` }] : [])], summary: details[0]?.trim() ?? '' }, [`src:${SOURCE_XML}/xml@1/x/${words.join('/')}`]);
    if (manual) entry(node, 'definition', manual.statement, { form: 'signature', manual_name: 'cli-orbit', words, section_path: ['信标管理'], signature: words.join(' '), params: [], parameters_verified: false }, [`src:${SOURCE_CLI}/text@1/l/${manual.line}`]);
  };
  const text = (chapter: string[], source: string, statement: string, from: number, to?: number, extra: Row = {}): void => {
    entry(at(['manual', ...chapter]), 'behaviour', statement, { form: 'text', manual_name: source === SOURCE_CLI ? 'cli-orbit' : 'app-orbit', section_path: chapter.slice(1), ...extra }, [`src:${source}/text@1/l/${lines(from, to)}`]);
  };
  const row = (chapter: string[], statement: string, from: number, to: number | undefined, parameter: { commands: string[]; name: string }): void => {
    entry(at(['manual', ...chapter]), 'behaviour', statement, { form: 'table_row', manual_name: 'cli-orbit', section_path: chapter.slice(1), parameter }, [`src:${SOURCE_CLI}/text@1/l/${lines(from, to)}`]);
  };

  at(['commands']);
  at(['manual']);

  command(['orbit', 'beacon', 'add'], 'orbit beacon add <arg1:string 1..40> <arg2:{fast|slow}> [<arg3:int 1..64="8">]', [
    '  Add a beacon', '  级别：CLI_LEVEL_CONFIG', '  arg1: Beacon name', '  arg2: Beacon mode', '  arg3: Retry count',
  ], [
    { name: 'arg1', type: 'string', minLength: 1, maxLength: 40, description: 'Beacon name' },
    { name: 'arg2', type: 'enum', values: ['fast', 'slow'], description: 'Beacon mode' },
    { name: 'arg3', type: 'int', minimum: 1, maximum: 64, optional: true, default: '8', description: 'Retry count' },
  ], { statement: 'orbit beacon add <name> <mode> [retries]', line: 120 });
  command(['orbit', 'beacon', 'remove'], 'orbit beacon remove <arg1:string 1..40>', ['  Remove a beacon', '  级别：CLI_LEVEL_CONFIG', '  arg1: Beacon name'], [{ name: 'arg1', type: 'string', minLength: 1, maxLength: 40, description: 'Beacon name' }], { statement: 'orbit beacon remove <name>', line: 140 });
  command(['no', 'orbit', 'beacon', 'add'], 'no orbit beacon add <arg1:string 1..40>', ['  Delete a beacon', '  级别：CLI_LEVEL_CONFIG', '  arg1: Beacon name'], [{ name: 'arg1', type: 'string', minLength: 1, maxLength: 40, description: 'Beacon name' }]);
  command(['show', 'orbit', 'beacon'], 'show orbit beacon [<arg1:string>]', ['  Show beacons', '  级别：CLI_LEVEL_USER'], [{ name: 'arg1', type: 'string', optional: true, default: '' }]);
  command(['orbit', 'link'], 'orbit link <arg1:string/ipv4>', ['  Select a link', '  级别：CLI_LEVEL_CONFIG', '  arg1: Link name'], [{ name: 'arg1', type: 'string' }], undefined, [{ name: 'arg1', type: 'ipv4' }]);
  command(['orbit', 'link', 'on'], 'orbit link on', ['  Enable links', '  级别：CLI_LEVEL_CONFIG'], [], { statement: 'orbit link on', line: 200 });
  command(['orbit', 'link', 'off'], 'orbit link off', ['  Disable links', '  级别：CLI_LEVEL_CONFIG'], [], { statement: 'orbit link off', line: 210 });
  command(['orbit', 'probe', 'run'], 'orbit probe run <arg1:string>', ['  Run a probe', '  级别：CLI_LEVEL_CONFIG', '  arg1: Probe name'], [{ name: 'arg1', type: 'string' }]);
  command(['orbit', 'sync', 'peer'], 'orbit sync peer <arg1:string>', ['  Sync to a peer', '  级别：CLI_LEVEL_CONFIG', '  arg1: Peer name'], [{ name: 'arg1', type: 'string' }]);
  command(['orbit', 'sync', 'local'], 'orbit sync local', ['  Sync locally', '  级别：CLI_LEVEL_CONFIG'], []);
  command(['orbit', 'report', 'add'], 'orbit report add <arg1:string>', ['  Add a report', '  级别：CLI_LEVEL_CONFIG', '  arg1: Report name'], [{ name: 'arg1', type: 'string' }], { statement: 'orbit report add <name>', line: 300 });
  command(['orbit', 'report', 'remove'], 'orbit report remove <arg1:string>', ['  Remove a report', '  级别：CLI_LEVEL_CONFIG', '  arg1: Report name'], [{ name: 'arg1', type: 'string' }], { statement: 'orbit report remove <name>', line: 400 });
  for (let i = 0; i < BULK; i++) {
    const word = `w${String(i).padStart(2, '0')}`;
    command(['orbit', 'bulk', word], `orbit bulk ${word} <arg1:string>`, [`  Bulk command ${word}`, '  级别：CLI_LEVEL_CONFIG'], [{ name: 'arg1', type: 'string' }]);
  }
  const unchecked = at(['commands', 'orbit', 'probe', 'wait']);
  entry(unchecked, 'definition', 'orbit probe wait <arg1:string>\n  Wait for a probe\n  级别：CLI_LEVEL_CONFIG\n  arg1: Seconds', { words: ['orbit', 'probe', 'wait'], signatures: [{ id: '1', params: [{ name: 'arg1', type: 'string', unchecked_constraints: [{ path: './arguments/arg[1]/@limit', source_value: '[1-x]' }] }], reference: `src:${SOURCE_XML}/xml@1/x/orbit/probe/wait/arguments` }], summary: 'Wait for a probe' }, [`src:${SOURCE_XML}/xml@1/x/orbit/probe/wait`]);

  const beacons = ['cli-orbit', '信标管理'];
  text(beacons, SOURCE_CLI, '前一条命令的尾部说明。', 119);
  text(beacons, SOURCE_CLI, '该命令用于创建一个信标。', 121);
  row(beacons, '| name | 信标名称，长度 1 到 40。 |', 123, 124, { commands: ['orbit beacon add'], name: 'name' });
  row([...beacons, '参数'], '| mode | 取值必须为：fast 或 slow。 |', 126, undefined, { commands: ['orbit beacon add'], name: 'mode' });
  text([...beacons, '参数'], SOURCE_CLI, '示例：', 128);
  text([...beacons, '参数'], SOURCE_CLI, 'Demo(config)#orbit beacon add "b1" fast 3', 129);
  text(beacons, SOURCE_CLI, '该命令用于删除一个信标。', 141);
  entry(at(['manual', ...beacons]), 'behaviour', '**orbit beacon purge** *<name>*', { form: 'signature_drift', manual_name: 'cli-orbit', section_path: ['信标管理'], command_mentions: ['orbit beacon purge'], drift: { missing: ['orbit beacon purge'], next_action: '手册与命令树维护者核对这条完整定义后重产' }, signature_literals: [{ primary: 'orbit beacon purge', alternatives: ['orbit beacon purge'] }] }, [`src:${SOURCE_CLI}/text@1/l/160`]);
  text(beacons, SOURCE_CLI, '该命令用于启用链路。', 201);
  text(beacons, SOURCE_CLI, '示例：', 203);
  text(beacons, SOURCE_CLI, 'Demo(config)#orbit link on', 204);
  text(beacons, SOURCE_CLI, '该命令用于关闭链路。', 211);
  row(beacons, '| retries | 重试次数，1 到 64。 |', 50, undefined, { commands: ['orbit beacon add'], name: 'retries' });
  const probes = ['cli-orbit', '探针管理'];
  text(probes, SOURCE_CLI, '**orbit probe run** *<name>*', 600, undefined, { command_literals: ['orbit probe run'], command_mentions: ['orbit probe run'] });
  text(probes, SOURCE_CLI, '该命令用于运行一个探针。', 601);
  row(probes, '| name | 探针名称。 |', 603, undefined, { commands: ['orbit probe run'], name: 'name' });
  text(probes, SOURCE_CLI, '**orbit probe wait** *<seconds>*', 610, undefined, { command_literals: ['orbit probe wait'], command_mentions: ['orbit probe wait'] });
  text(probes, SOURCE_CLI, '该命令用于等待一个探针。', 611);
  const reports = ['cli-orbit', '报告管理'];
  for (let i = 1; i <= REPORT_ENTRIES; i++) text(reports, SOURCE_CLI, i % 7 === 0 ? `第 ${i} 条说明。\n（续）` : `第 ${i} 条说明。`, 300 + i);
  text(reports, SOURCE_CLI, '该命令用于删除一份报告。', 401);

  const guide = ['app-orbit', '配置', '信标示例'];
  text(guide, SOURCE_APP, '下面配置一个信标：', 10);
  text(guide, SOURCE_APP, 'Demo(config)#orbit beacon add "app1" slow', 12);
  text(guide, SOURCE_APP, 'Demo(config)#orbit beacon add "app2" fast 5\nDemo(config)#show orbit beacon', 14, 15);
  text(guide, SOURCE_APP, 'Demo(config)#orbit link on', 16);
  text(guide, SOURCE_APP, ['配置清单：', 'orbit beacon add "x1" fast 1', ...Array.from({ length: 8 }, (_, i) => `! 第 ${i + 1} 行不是命令`), 'orbit beacon add "x2" slow 2', 'show orbit beacon'].join('\n'), 20, 31);
  text(guide, SOURCE_APP, '| 配置信标 | *orbit beacon add* _<name> <mode>_ |', 18);
  text(guide, SOURCE_APP, '另一个章节里恰好落在 orbit report add 手册行号范围内的行', 305);

  const rows: Row[] = [...nodes.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((node) => ({
    path: node.path,
    reference: `tree:${LOOKUP_ROOT}${node.path}`,
    name: node.name,
    level: node.children.size === 0 ? 'leaf' : node.path === '/' ? 'trunk' : 'branch',
    digest: sha(`node ${node.path}`),
    children: [...node.children].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, path]) => ({ name, path, digest: sha(`node ${path}`) })),
    entries: [...node.entries].sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.statement < b.statement ? -1 : a.statement > b.statement ? 1 : a.entry < b.entry ? -1 : 1)),
  }));
  const head = { schema: 'run-knowledge@1', run: LOOKUP_RUN, root: LOOKUP_ROOT, composition: null, nodes: rows.length, entries: rows.reduce((sum, node) => sum + node.entries.length, 0) };
  const all = [head, ...rows];
  const bytes = Buffer.from(all.map((line) => JSON.stringify(line)).join('\n') + '\n');
  const files = new Map<string, Buffer>();
  for (const output of knowledgeFiles(bytes, LOOKUP_RUN).outputs) files.set(output.name.replace(/^knowledge[\\/]/, ''), Buffer.from(output.bytes));
  return {
    run: LOOKUP_RUN,
    root: LOOKUP_ROOT,
    rows: all,
    files,
    statements,
    reference(path, start) {
      const node = rows.find((candidate) => candidate.path === path);
      const found = node?.entries.find((candidate: Row) => String(candidate.statement).startsWith(start));
      if (!found) throw new Error(`no entry at ${path} starting with ${start}`);
      return found.reference;
    },
    runJson: (policy: unknown = LOOKUP_POLICY) => ({ run: LOOKUP_RUN, root: LOOKUP_ROOT, product: 'orbit', version: '1.0', build: 'Rel_ORBIT_1', ...(policy === null ? {} : { command_policy: policy }), groups: [], items: [] }),
  };
}

export async function writeLookupDownload(directory: string, fixture: LookupFixture, options: { policy?: unknown; withText?: boolean } = {}): Promise<string> {
  await mkdir(join(directory, 'knowledge'), { recursive: true });
  for (const [name, bytes] of fixture.files) {
    if (options.withText === false && name.endsWith('.txt')) continue;
    await writeFile(join(directory, 'knowledge', name), bytes);
  }
  const file = join(directory, 'run.json');
  await writeFile(file, JSON.stringify(fixture.runJson(options.policy)));
  return file;
}
