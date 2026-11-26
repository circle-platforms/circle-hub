import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { knowledgeFiles } from '../../../packs/workflow/case-compile/functions/generated/skills/run-tools/hub-client/index.ts';
import type { CliProbe } from '../verify-tool-cli.ts';

export const REMOTE_CASE_COMPILE_TOOLS = ['tools/assemble-delivery.ts', 'tools/download-returns.ts', 'tools/download-run.ts', 'tools/fetch-run.ts', 'tools/submit-plans.ts'] as const;
export const REMOTE_RECOMPOSE_TOOLS = ['tools/download-run.ts', 'tools/submit-records.ts'] as const;
const RUN = 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', PLAN = 'run_01bbbbbbbbbbbbbbbbbbbbbbbb', EMPTY = 'run_01cccccccccccccccccccccccc';
const LATE = 'run_01dddddddddddddddddddddddd', LATE_RECOMPOSE = 'run_01eeeeeeeeeeeeeeeeeeeeeeee';
export const EMPTY_TOKEN_STDERR = "参数无效：标准输入里没有令牌（标准输入为空，常见原因是 node 命令行与 <<'EOF' 之间多打了换行或漏了 <<'EOF'）。请把 node 命令行与 <<'EOF' 写在同一行（空格隔开，切勿在 <<'EOF' 前换行），下一行只写 %HUB_TOKEN%，再一行只写 EOF。\n";
export const OPEN_EMPTY_STDOUT = "无法编译：开运行工具出错：标准输入里没有令牌（标准输入为空，常见原因是 node 命令行与 <<'EOF' 之间多打了换行或漏了 <<'EOF'）\n";
export const NO_DISPATCH_STDERR = '暂时不可用：尚未上机验证，或设备输出缺少逐条结论；--runs 请只选择已结束的上机验证。请读取原作业的进展，取得完整且未冻结的逐条结果后重试。\n';
export interface RemoteCliReceipt { method: string; path: string; authorized: boolean }
export interface RemoteCliProbes {
  caseCompile: Record<string, CliProbe[]>;
  plumbCaseCompile: Record<string, CliProbe[]>;
  lateCaseCompile: Record<string, CliProbe[]>;
  readCaseCompile: Record<string, CliProbe[]>;
  recompose: Record<string, CliProbe[]>;
  receipts(): Promise<RemoteCliReceipt[]>;
  close(): Promise<void>;
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export async function buildRemoteCliProbes(stagedCaseDir: string, stagedRecomposeDir: string, workRoot: string): Promise<RemoteCliProbes> {
  if (!stagedCaseDir || !stagedRecomposeDir) throw new Error('Both staged pack directories are required');
  await mkdir(workRoot, { recursive: true, mode: 0o700 });
  const token = 'synthetic-cli-' + digest(Buffer.from(workRoot));
  const receipt = join(workRoot, 'http-receipts.jsonl'); await writeFile(receipt, '', { mode: 0o600 });
  const atom = (id: string, kind: string, text: string, after: string[] = []) => ({ id, kind, text, content: text, reference: `src:${'a'.repeat(64)}/kityminder@1/n/${id}`, selector: `n/${id}`, node_id: id, start: 0, end: text.length, labels: [], explicit_labels: [], number_label: null, after });
  const item = { id: 'n/case', fields: { case_id: 'SYNTHETIC-1', autoid: '990000000000000101', title: '合成用例', source_ref: `src:${'a'.repeat(64)}`, node: 'n/case', atoms: [atom('a1', 'action', '合成动作'), atom('a2', 'expectation', '合成期望', ['a1'])] } };
  const originals = { contract: Buffer.from('{"synthetic_contract":true}'), profile: Buffer.from('{"synthetic_profile":true}'), inventory: Buffer.from('{"synthetic_inventory":true}') };
  const record = { run: RUN, items: [item], sources: Object.entries(originals).map(([slot, bytes]) => ({ slot, role: 'expected', media_type: 'application/json', reference: `src:${digest(bytes)}` })) };
  const routes: Record<string, { status: number; body: string; contentType?: string }> = {};
  const jsonRoute = (path: string, value: unknown) => { routes[`GET ${path}`] = { status: 200, body: JSON.stringify(value) }; };
  jsonRoute(`/run-export/${RUN}/run`, { schema: 'run-export@1', run: record });
  jsonRoute(`/run-export/${RUN}`, { schema: 'run-export@1', run: record, result: { run: RUN }, submission: { run: RUN } });
  jsonRoute(`/run-export/${EMPTY}/jobs`, { schema: 'run-jobs@1', run: EMPTY, jobs: [] });
  jsonRoute(`/run-export/${RUN}/jobs`, { schema: 'run-jobs@1', run: RUN, jobs: [{ job: 'c'.repeat(64), verification_run: RUN, plan_run: PLAN, items: [], sha256: 'd'.repeat(64), ended: 'done', outcome: 'effective', frozen: false, result: `src:${'9'.repeat(64)}`, device_return: null, rows: [] }] });
  for (const bytes of Object.values(originals)) routes[`GET /run-export/${RUN}/sources/${digest(bytes)}`] = { status: 200, body: bytes.toString(), contentType: 'application/json' };
  const lateRoot = 'a'.repeat(64), lateEntry = 'e'.repeat(64);
  const lateRecord = { case: { id: '990000000000000300' }, atoms: [], ledgers: { adapted: [{ atom: 'a1', commands: [], equivalence_refs: [`tree:${lateRoot}/widgets@${lateEntry}`] }] } };
  const late = {
    schema: 'run-late@1', run: LATE, run_reference: `rec:${'c'.repeat(64)}`, resolved_at: '2026-11-17T00:00:00.000Z',
    late: { inputs: [{ slot: 'recomposition_result', run: LATE_RECOMPOSE, reference: `rec:${'d'.repeat(64)}` }], refresh: 'f'.repeat(64) },
    items: [
      { id: 'case-0', late: { recomposition: { record: lateRecord, receipt: `rec:${'1'.repeat(64)}`, late: true, record_sha256: '1'.repeat(64) } } },
      { id: 'case-1', late: { recomposition_problem: '合成：还没有已受理提交', recomposition_waiting: { run: LATE_RECOMPOSE, result: null, state: 'no_result', item: 'recompose-item-1' } } },
    ],
  };
  jsonRoute(`/run-export/${LATE}/late`, late);
  routes['POST /mcp'] = { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '合成回执：已受理' }] } }) };
  const plans = join(workRoot, 'plans'), records = join(workRoot, 'records');
  await mkdir(plans); await mkdir(records);
  await writeFile(join(plans, '01.json'), JSON.stringify({ item: item.id, handling: 'handled', slots: { plan: [{ text: '合成计划', quotes: [], data: {} }] } }));
  await writeFile(join(records, '01.json'), JSON.stringify({ item: item.id, method: { kind: 'declared', text: '合成方法', sources: ['synthetic-reference'], basis: '合成依据' } }));
  const notes = join(workRoot, 'notes.json'); await writeFile(notes, '{"cases":{}}');
  // The record that opened the compile (a plain one: no judge field, which means Plumb); the delivery tool reads it before it reads the Hub.
  const opened = join(workRoot, 'opened.json');
  await writeFile(opened, JSON.stringify({
    schema: 'open-compile@1', ready: true,
    contract: `doc:doc:synthetic-rules@${digest(originals.contract)}`,
    profile: `doc:doc:synthetic-profile@${digest(originals.profile)}`,
    inventory: `doc:doc:synthetic-inventory@${digest(originals.inventory)}`,
  }));
  const child = fork(fileURLToPath(new URL('./remote-cli-worker.ts', import.meta.url)), [], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { NODE_NO_WARNINGS: '1' } });
  const origin = await new Promise<string>((resolve, reject) => {
    child.once('error', reject); child.once('exit', code => reject(new Error(`Synthetic CLI responder exited before ready: ${code}`)));
    child.once('message', value => resolve((value as { origin: string }).origin));
    child.send({ token, run: RUN, receipt, routes });
  });
  const probe = (argv: string[], complete: CliProbe['complete'] = { status: 0 }): CliProbe[] => [{ argv, cwd: workRoot, subcommand: null, stdinValues: [token], complete, empty: { status: 1, stdout: '', stderr: EMPTY_TOKEN_STDERR } }];
  const plumbDir = join(workRoot, 'plumb-run');
  const plumbKnowledgeRoot = 'a'.repeat(64);
  const kNodes = [
    { path: '/', children: ['commands'], statements: [] as Array<[string, string]> },
    { path: '/commands', children: ['ip'], statements: [] as Array<[string, string]> },
    { path: '/commands/ip', children: ['address'], statements: [] as Array<[string, string]> },
    { path: '/commands/ip/address', children: [], statements: [['definition', 'ip address <ip:ipv4> <mask:ipv4>\n  配置接口 IPv4 地址']] as Array<[string, string]> },
  ].map((row, idx) => ({
    path: row.path, reference: `tree:${plumbKnowledgeRoot}${row.path}`, name: row.path.split('/').at(-1),
    level: row.children.length ? 'branch' : 'leaf', digest: String(idx + 1).padStart(64, '0'),
    children: row.children.map((c, j) => ({ name: c, path: `${row.path === '/' ? '' : row.path}/${c}`, digest: String(idx * 100 + j).padStart(64, '0') })),
    entries: row.statements.map(([kind, statement], k) => ({ entry: String(k + 100).padStart(64, 'a'), kind, statement, reference: `tree:${plumbKnowledgeRoot}${row.path}@${String(k + 100).padStart(64, 'a')}` })),
  }));
  const kBytes = Buffer.from([{ schema: 'run-knowledge@1', run: RUN, root: plumbKnowledgeRoot, composition: null, nodes: kNodes.length, entries: 1 }, ...kNodes].map((n) => JSON.stringify(n)).join('\n') + '\n');
  for (const { name, bytes } of knowledgeFiles(kBytes, RUN).outputs) {
    await mkdir(dirname(join(plumbDir, name)), { recursive: true });
    await writeFile(join(plumbDir, name), bytes);
  }
  const plumbItem = {
    id: 'doc:plumb-1',
    fields: {
      autoid: '990000000000000201',
      title: '配置接口 IP 地址',
      path: ['网络', '接口'],
      steps: [{ text: '配置接口 eth0 地址 ip address 192.0.2.10/24' }],
      recomposition: { record: { schema: 'recompose-record@1', contract: { intent: { text: '配置接口地址' } }, atoms: [{ id: '1', kind: 'action', text: '配置接口 eth0 地址 192.0.2.10/24' }], ledgers: { original: [], adapted: [], rebindings: [] } } },
    },
  };
  await mkdir(join(plumbDir, 'items'), { recursive: true });
  await writeFile(join(plumbDir, 'items', '00.json'), JSON.stringify(plumbItem));
  await writeFile(join(plumbDir, 'run.json'), JSON.stringify({ run: RUN, product: 'synth-switch', version: '1.0', build: 'b1', items: [plumbItem] }));
  const plumbPlans = join(workRoot, 'plumb-plans');
  await mkdir(plumbPlans, { recursive: true });
  await writeFile(join(plumbPlans, '00.json'), JSON.stringify({ item: plumbItem.id, handling: 'handled', slots: { plan: [{ text: 'plan 0', quotes: [], data: { bucket: 'bed-0', blocks: [], replacements: [], steps: [{ object: 'dut0', method: 'cmd_config', args: ['ip address 192.0.2.10/24'], keywords: {}, author_step_refs: ['1'] }], expects: [] } }] } }));
  const plumbBriefs = join(workRoot, 'plumb-briefs');
  const lateDir = join(workRoot, 'late-run');
  await mkdir(join(lateDir, 'items'), { recursive: true }); await mkdir(join(lateDir, 'knowledge'));
  const lateItems = [0, 1].map((index) => ({ id: `case-${index}`, label: `合成用例 ${index}`, fields: { title: `合成用例 ${index}`, recomposition_late: { slot: 'recomposition_result', run: LATE_RECOMPOSE, source: `src:${'a'.repeat(64)}`, node: `n/case-${index}` } } }));
  await writeFile(join(lateDir, 'run.json'), JSON.stringify({ run: LATE, items: lateItems, groups: [] }));
  for (const [index, lateItem] of lateItems.entries()) await writeFile(join(lateDir, 'items', `0${index}.json`), JSON.stringify(lateItem));
  const lateNodes = [
    { schema: 'run-knowledge@1', run: LATE, root: lateRoot, composition: null, nodes: 2, entries: 1 },
    { path: '/', reference: `tree:${lateRoot}/`, name: '', level: 'trunk', digest: lateRoot, children: [{ name: 'widgets', path: '/widgets', digest: 'b'.repeat(64) }], entries: [] },
    { path: '/widgets', reference: `tree:${lateRoot}/widgets`, name: 'widgets', level: 'leaf', digest: 'b'.repeat(64), children: [], entries: [{ entry: lateEntry, kind: 'definition', statement: 'widget health interval <seconds:int 1..60>', reference: `tree:${lateRoot}/widgets@${lateEntry}`, data: {} }] },
  ];
  await writeFile(join(lateDir, 'knowledge', 'nodes.jsonl'), lateNodes.map((line) => JSON.stringify(line)).join('\n') + '\n');
  const lateReport = { run: LATE, dir: 'late-run', resolved_at: late.resolved_at, inputs: late.late.inputs, accepted: 1, newly_accepted: ['case-0'], waiting: [{ item: 'case-1', state: 'no_result', problem: '合成：还没有已受理提交' }], briefs: 1 };
  const openArgv = ['--hub', origin + '/mcp', '--plumb', origin, '--subject', 'agile:mindmap:990001', '--product', 'synth-switch', '--build', 'b1', '--booking', PLAN, '--out', join(workRoot, 'open-compile.json')];
  const openProbe: CliProbe = {
    argv: openArgv, cwd: workRoot, subcommand: null, stdinValues: [token, 'synthetic-plumb-key', 'synthetic-jev-key'],
    complete: { status: 1, stdout: '无法编译：Hub 答复 400：\n', stderr: '' },
    empty: { status: 1, stdout: OPEN_EMPTY_STDOUT, stderr: '' },
  };
  const plumbProbe = (argv: string[]): CliProbe[] => [{ argv, cwd: workRoot, subcommand: null, stdinValues: [token], complete: { status: 0 }, empty: { status: 1, stdout: '' } }];
  return {
    caseCompile: {
      'tools/assemble-delivery.ts': probe(['--hub', origin + '/mcp', '--runs', EMPTY, '--notes', notes, '--out', join(workRoot, 'delivery'), '--open', opened], { status: 1, stdout: '', stderr: NO_DISPATCH_STDERR }),
      'tools/download-returns.ts': probe(['--hub', origin + '/mcp', '--run', RUN, '--out', join(workRoot, 'returns')]),
      'tools/download-run.ts': probe(['--hub', origin + '/mcp', '--run', RUN, '--out', join(workRoot, 'compile-download')]),
      'tools/fetch-run.ts': probe(['--hub', origin + '/mcp', '--run', RUN, '--out', join(workRoot, 'fetched')]),
      'tools/submit-plans.ts': probe(['--hub', origin + '/mcp', '--run', RUN, '--model', 'synthetic-model', '--plans', plans]),
    },
    plumbCaseCompile: {
      'tools/cmd-select-plumb.ts': plumbProbe(['--run', plumbDir, '--base-url', origin, '--no-cache', '--key-stdin']),
      'tools/cmd-verify-plumb.ts': plumbProbe(['--plans', plumbPlans, '--run', plumbDir, '--base-url', origin, '--no-cache', '--key-stdin']),
      'tools/fidelity-plumb.ts': plumbProbe(['--run', plumbDir, '--plans', plumbPlans, '--briefs', plumbBriefs, '--base-url', origin, '--no-cache', '--key-stdin']),
      'tools/open-compile.ts': [openProbe],
    },
    readCaseCompile: {
      'tools/device-read.ts': probe(['--hub', origin + '/mcp', '--booking', PLAN, '--device', 'dev0', '--line', 'show widget name', '--out', join(workRoot, 'device-read.txt')], { status: 0, stdout: JSON.stringify({ read: false, why: 'Hub 答复 400' }) + '\n', stderr: '' }),
    },
    lateCaseCompile: {
      'tools/refresh-late.ts': probe(['--hub', origin + '/mcp', '--run', LATE, '--dir', 'late-run'], { status: 0, stdout: JSON.stringify(lateReport) + '\n', stderr: '' }),
    },
    recompose: {
      'tools/download-run.ts': probe(['--hub', origin + '/mcp', '--run', RUN, '--out', join(workRoot, 'recompose-download')]),
      'tools/submit-records.ts': probe(['--hub', origin + '/mcp', '--run', RUN, '--model', 'synthetic-model', '--records', records]),
    },
    async receipts() { return (await readFile(receipt, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as RemoteCliReceipt); },
    async close() { if (child.exitCode !== null) return; const ended = new Promise<void>(resolve => child.once('exit', () => resolve())); child.disconnect(); await ended; },
  };
}
