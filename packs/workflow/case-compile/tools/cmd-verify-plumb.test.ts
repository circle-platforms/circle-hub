import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { knowledgeFiles } from '../functions/knowledge-text.ts';
import { COMMAND_CATALOG, CONTRACT_DOC, MANIFEST_DOC, PROFILE_DOC, QUOTE } from '../functions/test-support.ts';
import { frozenRun, writeDownload } from '../testing/frozen-run.ts';
import type { FlatCatalog } from '../testing/locked-tree.ts';
import { runCmdVerifyPlumb } from './cmd-verify-plumb.ts';

const RUN = 'run_01aaaaaaaaaaaaaaaaaaaaaaaa';
const ROOT = 'a'.repeat(64);

let stubMode: 'pass' | 'review' | 'reject' | 'mismatch_no' | 'service_down' | 'too_large' = 'pass';
let decide: ((question: { command?: string; commands?: string[] }) => 'pass' | 'review' | 'reject') | null = null;
const seenBatches: Array<Record<string, unknown>> = [];
let refuseLong: ((question: { state?: string }) => boolean) | null = null;
const refusedForLength: number[] = [];

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    if (req.method !== 'POST' || req.url !== '/v1/judge') {
      res.writeHead(404);
      res.end('{}');
      return;
    }
    if (stubMode === 'service_down') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'backend_down', message: '后端尚未就绪' }, retryable: false }));
      return;
    }
    if (stubMode === 'too_large') {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'payload_too_large', message: '请求体过大' } }));
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      task?: string;
      questions?: Record<string, { task?: string; command?: string; commands?: string[]; definition?: string; state?: string; node?: Record<string, unknown> }>;
    };
    if (refuseLong && Object.values(body.questions ?? {}).some((q) => refuseLong!(q))) {
      refusedForLength.push(Object.keys(body.questions ?? {}).length);
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'request_too_large', message: '输入超过逐个打分接口的长度上限，已被判断服务截断，未作答。' } }));
      return;
    }
    seenBatches.push(body as unknown as Record<string, unknown>);
    const answers: Record<string, unknown> = {};
    for (const [qid, q] of Object.entries(body.questions ?? {})) {
      assert.ok(q.task === 'single_cmd_judge' || q.task === 'steplist_judge');
      assert.ok(!(q.state && q.node), 'must NEVER send both state and node');
      assert.ok(q.state || (q.node && typeof q.node.line === 'string' && q.node.line.length > 0));
      const mode = decide ? decide(q) : stubMode;
      const isNo = mode === 'reject' || mode === 'mismatch_no';
      answers[qid] = {
        status: '未确认',
        decided_by: '模型',
        model_version: 'plumb-27b-0.5.0',
        answer: {
          type: 'noul',
          value: isNo ? 'no' : 'yes',
          match: isNo ? 0 : 1,
          probabilities: { yes: isNo ? 0.1 : 0.92, no: isNo ? 0.9 : 0.08 },
        },
        gate: {
          action: mode === 'reject' ? 'reject' : mode === 'review' ? 'review' : 'pass',
          calibrated: true,
          calibration_source: 'benchmark-synth',
        },
      };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: '未确认',
      decided_by: '模型',
      model_version: 'plumb-27b-0.5.0',
      task: body.task,
      request_id: `req-${seenBatches.length}`,
      answers,
    }));
  });
});

await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address() as AddressInfo;
const baseUrl = `http://127.0.0.1:${port}`;

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function buildBatch(): Buffer {
  const rows = [
    { path: '/', children: ['commands'], statements: [] },
    { path: '/commands', children: ['ip', 'no'], statements: [] },
    { path: '/commands/ip', children: ['address'], statements: [] },
    { path: '/commands/ip/address', children: [], statements: [['definition', 'ip address <ip:ipv4> <mask:ipv4>\n  配置接口主 IPv4 地址']] },
    { path: '/commands/no', children: ['shutdown'], statements: [] },
    { path: '/commands/no/shutdown', children: [], statements: [['definition', 'no shutdown\n  启用接口']] },
  ];
  const nodes = rows.map((r, idx) => ({
    path: r.path,
    reference: `tree:${ROOT}${r.path}`,
    name: r.path.split('/').at(-1),
    level: r.children.length ? 'branch' : 'leaf',
    digest: String(idx + 1).padStart(64, '0'),
    children: r.children.map((c, j) => ({ name: c, path: `${r.path === '/' ? '' : r.path}/${c}`, digest: String(idx * 100 + j).padStart(64, '0') })),
    entries: r.statements.map(([kind, statement], k) => ({
      entry: String(k + 200).padStart(64, 'b'),
      kind,
      statement,
      reference: `tree:${ROOT}${r.path}@${String(k + 200).padStart(64, 'b')}`,
    })),
  }));
  const head = { schema: 'run-knowledge@1', run: RUN, root: ROOT, composition: null, nodes: nodes.length, entries: 2 };
  return Buffer.from([head, ...nodes].map((n) => JSON.stringify(n)).join('\n') + '\n');
}

async function setupWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), 'cc-cmd-verify-'));
  for (const { name, bytes } of knowledgeFiles(buildBatch(), RUN).outputs) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), bytes);
  }
  await writeFile(join(dir, 'run.json'), JSON.stringify({ run: RUN, product: 'synth-switch', version: '1.0', build: 'b1' }));
  await mkdir(join(dir, 'items'));
  await writeFile(join(dir, 'items', '00.json'), JSON.stringify({
    id: 'doc:0',
    fields: {
      autoid: 'C0',
      title: '接口配置与启用',
      path: ['网络配置', '接口', '接口配置与启用'],
      steps: [{ text: '配置接口 eth0 地址为 192.0.2.10/24 并启用接口' }],
    },
  }));
  const plans = join(dir, 'plans');
  await mkdir(plans);
  const singleAndMultiPlan = {
    item: 'doc:0',
    handling: 'handled',
    slots: {
      plan: [{
        text: 'plan 0',
        quotes: [],
        data: {
          bucket: 'bed-0',
          blocks: [],
          replacements: [],
          steps: [
            { object: 'dut0', method: 'cmd_config', args: ['ip address 192.0.2.10/24'], keywords: {}, author_step_refs: ['1'] },
            { object: 'dut0', method: 'cmd_config', args: ['ip address 192.0.2.10/24\nno shutdown'], keywords: {}, author_step_refs: ['1'] },
          ],
          expects: [],
        },
      }],
    },
  };
  await writeFile(join(plans, '00.json'), JSON.stringify(singleAndMultiPlan));
  await writeFile(join(plans, '01.json'), JSON.stringify({ item: 'doc:skip', handling: 'skipped', reason: '不适用' }));
  return { dir, plans, singlePlanPath: join(plans, '00.json') };
}

test('cmd-verify-plumb verifies single_cmd_judge and steplist_judge with definition and supports node context mode', async () => {
  const w = await setupWorkspace();
  try {
    stubMode = 'pass';
    seenBatches.length = 0;
    const res = await runCmdVerifyPlumb(
      ['--plans', w.plans, '--run', w.dir, '--base-url', baseUrl, '--no-cache', '--key-stdin'],
      { stdinText: 'plumb_sk_verify_123\n' },
    );
    assert.equal(res.code, 0, res.stderr);
    assert.equal(seenBatches.length, 2, 'single_cmd_judge + steplist_judge should batch separately');
    const report = JSON.parse(res.stdout);
    assert.equal(report.status, '未确认');
    assert.equal(report.decided_by, '模型');
    assert.equal(report.checked, 1);
    assert.equal(report.skipped.length, 1);
    assert.equal(report.results[0].steps[0].task, 'single_cmd_judge');
    assert.equal(report.results[0].steps[0].definition_attached, true);
    assert.equal(report.results[0].steps[1].task, 'steplist_judge');

    seenBatches.length = 0;
    const nodeRes = await runCmdVerifyPlumb(
      ['--file', w.singlePlanPath, '--run', w.dir, '--context-mode', 'node', '--base-url', baseUrl, '--no-cache'],
      { env: { ...process.env, PLUMB_API_KEY: 'plumb_sk_verify_env' } },
    );
    assert.equal(nodeRes.code, 0, nodeRes.stderr);
    assert.equal(JSON.parse(nodeRes.stdout).context_mode, 'node');
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('cmd-verify-plumb hard-blocks reject/mismatch, warns on review, strict-blocks review, and fails closed on 503/413', async () => {
  const w = await setupWorkspace();
  try {
    stubMode = 'reject';
    const rejRes = await runCmdVerifyPlumb(
      ['--file', w.singlePlanPath, '--run', w.dir, '--base-url', baseUrl, '--no-cache'],
      { env: { ...process.env, PLUMB_API_KEY: 'plumb_sk_verify_env' } },
    );
    assert.equal(rejRes.code, 1);
    assert.match(rejRes.stderr, /Plumb 命令核验未通过/);
    assert.equal(JSON.parse(rejRes.stdout).blocked_count, 2);

    stubMode = 'mismatch_no';
    const noRes = await runCmdVerifyPlumb(
      ['--file', w.singlePlanPath, '--run', w.dir, '--base-url', baseUrl, '--no-cache'],
      { env: { ...process.env, PLUMB_API_KEY: 'plumb_sk_verify_env' } },
    );
    assert.equal(noRes.code, 1);

    stubMode = 'review';
    const revRes = await runCmdVerifyPlumb(
      ['--file', w.singlePlanPath, '--run', w.dir, '--base-url', baseUrl, '--no-cache'],
      { env: { ...process.env, PLUMB_API_KEY: 'plumb_sk_verify_env' } },
    );
    assert.equal(revRes.code, 0, revRes.stderr);
    const revJson = JSON.parse(revRes.stdout);
    assert.equal(revJson.review_required_count, 2);
    assert.match(revJson.results[0].steps[0].note, /\[需人工复核：Plumb match 落入 review 区\]/);

    const strictRes = await runCmdVerifyPlumb(
      ['--file', w.singlePlanPath, '--run', w.dir, '--base-url', baseUrl, '--no-cache', '--strict-review'],
      { env: { ...process.env, PLUMB_API_KEY: 'plumb_sk_verify_env' } },
    );
    assert.equal(strictRes.code, 1);

    stubMode = 'service_down';
    const downRes = await runCmdVerifyPlumb(
      ['--file', w.singlePlanPath, '--run', w.dir, '--base-url', baseUrl, '--no-cache'],
      { env: { ...process.env, PLUMB_API_KEY: 'plumb_sk_verify_env' } },
    );
    assert.equal(downRes.code, 1);
    assert.match(downRes.stderr, /^暂时不可用：/);

    stubMode = 'too_large';
    const largeRes = await runCmdVerifyPlumb(
      ['--file', w.singlePlanPath, '--run', w.dir, '--base-url', baseUrl, '--no-cache'],
      { env: { ...process.env, PLUMB_API_KEY: 'plumb_sk_verify_env' } },
    );
    assert.equal(largeRes.code, 1);
    assert.match(largeRes.stderr, /^参数无效：/);
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

type Asked = { command?: string; commands?: string[]; state?: string; node?: { title?: string; line?: string } };
const asked = (): Asked[] => seenBatches.flatMap((batch) => Object.values((batch as { questions?: Record<string, Asked> }).questions ?? {}));
const intentOfQuestion = (q: Asked): string | undefined => /^步骤意图: (.*)$/mu.exec(q.state ?? '')?.[1] ?? q.node?.title;
const planFile = (item: string, data: Record<string, unknown>) => ({ item, handling: 'handled', slots: { plan: [{ text: '合成计划', quotes: [], data }] } });
const device = (line: string, extra: Record<string, unknown> = {}) => ({ object: 'dut0', method: 'cmd_config', args: [line], keywords: {}, ...extra });
const OVERRIDE = 'Plumb 判断（未确认）与命令树核对不一致；命令树核对通过，以命令树为准，需人工复核';
const KEY = { stdinText: 'plumb_sk_verify_123\n' };

async function runOn(args: string[], io: { stdinText?: string } = KEY) {
  seenBatches.length = 0;
  return runCmdVerifyPlumb([...args, '--base-url', baseUrl, '--no-cache', '--key-stdin'], io);
}

test('cmd-verify-plumb takes the run directory as --run and refuses its run.json file with the one-line correct form before any call', async () => {
  const w = await setupWorkspace();
  try {
    seenBatches.length = 0;
    const file = join(w.dir, 'run.json');
    const refused = await runOn(['--plans', w.plans, '--run', file]);
    assert.equal(refused.code, 1);
    assert.equal(refused.stdout, '');
    assert.ok(refused.stderr.startsWith(`参数无效：--run ${file} 不是普通目录。`), refused.stderr);
    assert.ok(refused.stderr.trimEnd().endsWith("合法写法：--run '<运行目录>'（放 run.json 的目录，不是 run.json 文件）。"), refused.stderr);
    assert.equal(refused.stderr.trim().split('\n').length, 1);
    assert.equal(seenBatches.length, 0, 'no question was asked of Plumb');
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('a block plan: the intent of a command is the description of its block, as for a flat step; without one it is the case title and the report says so', async () => {
  const w = await setupWorkspace();
  try {
    const blocks = [
      { id: 'c_addr', kind: 'CONFIG', call: device('ip address 192.0.2.10/24'), description: '配置接口地址为 192.0.2.10/24', author_step_refs: ['a2'] },
      { id: 'c_up', kind: 'CONFIG', call: device('no shutdown'), author_step_refs: ['a2'] },
      { id: 'o_show', kind: 'OBSERVE_ONLY', call: device('show interface', { method: 'cmd_enable' }), description: '查看接口状态' },
    ];
    const file = join(w.plans, '02.json');
    await writeFile(file, JSON.stringify(planFile('doc:0', { bucket: 'bed-0', blocks, replacements: [], steps: [], expects: [] })));
    stubMode = 'pass';
    decide = null;
    const res = await runOn(['--file', file, '--run', w.dir]);
    assert.equal(res.code, 0, res.stderr);
    const steps = JSON.parse(res.stdout).results[0].steps as Array<Record<string, unknown>>;
    assert.deepEqual(steps.map((s) => [s.pointer, s.intent, s.intent_source]), [
      ['/blocks/0/call', '配置接口地址为 192.0.2.10/24', 'description'],
      ['/blocks/1/call', '接口配置与启用', 'case_title'],
      ['/blocks/2/call', '查看接口状态', 'description'],
    ]);
    assert.equal(steps[0]!.disclosure, undefined, 'nothing to disclose when the writer wrote the line');
    assert.match(String(steps[1]!.disclosure), /没有写 description.*用例标题/, 'the fallback is said in the step');
    assert.deepEqual(asked().map(intentOfQuestion), ['配置接口地址为 192.0.2.10/24', '接口配置与启用', '查看接口状态']);
    const all = JSON.stringify(asked());
    assert.equal(all.includes('配置接口 eth0 地址为 192.0.2.10/24 并启用接口'), false, 'the mind-map step at the position of a block is not borrowed');
    assert.equal(all.includes('a2'), false, 'nor is an author step summary');

    const node = await runOn(['--file', file, '--run', w.dir, '--context-mode', 'node']);
    assert.equal(node.code, 0, node.stderr);
    assert.deepEqual(asked().map(intentOfQuestion), ['配置接口地址为 192.0.2.10/24', '接口配置与启用', '查看接口状态'], 'the node form carries the same line');
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('a flat step keeps its own description even when it names author steps; without one its intent is the case title, not the mind-map step at its position', async () => {
  const w = await setupWorkspace();
  try {
    const steps = [
      device('ip address 192.0.2.10/24', { description: '配置接口地址', author_step_refs: ['1'] }),
      device('no shutdown', { author_step_refs: ['1'] }),
      device('show interface', { method: 'cmd_enable' }),
    ];
    const file = join(w.plans, '03.json');
    await writeFile(file, JSON.stringify(planFile('doc:0', { bucket: 'bed-0', blocks: [], replacements: [], steps, expects: [] })));
    stubMode = 'pass';
    decide = null;
    const res = await runOn(['--file', file, '--run', w.dir]);
    assert.equal(res.code, 0, res.stderr);
    assert.deepEqual(asked().map(intentOfQuestion), ['配置接口地址', '接口配置与启用', '接口配置与启用']);
    assert.equal(JSON.stringify(asked()).includes('配置接口 eth0 地址为 192.0.2.10/24 并启用接口'), false);
    const report = JSON.parse(res.stdout).results[0].steps as Array<Record<string, unknown>>;
    assert.deepEqual(report.map((s) => [s.pointer, s.intent, s.intent_source]), [
      ['/steps/0', '配置接口地址', 'description'],
      ['/steps/1', '接口配置与启用', 'case_title'],
      ['/steps/2', '接口配置与启用', 'case_title'],
    ]);
    assert.match(String(report[1]!.disclosure), /没有写 description.*用例标题/);
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

async function frozenWorkspace(steps: unknown[]) {
  const dir = await mkdtemp(join(tmpdir(), 'cc-cmd-verify-frozen-'));
  const item = { id: 'doc:case-1', label: '合成用例', location: QUOTE.reference, fields: { autoid: '990000000000000031', title: '健康检查间隔配置', path: ['合成文档', '合成分组', '健康检查间隔配置'], steps: [{ text: '配置健康检查间隔 widget health interval 60' }] } };
  const run = frozenRun({
    groups: [{ kind: 'case-compile', contract: CONTRACT_DOC, profile: PROFILE_DOC, manifest: MANIFEST_DOC, leases: { now: '2026-10-23T02:00:00.000Z', entries: [] } }],
    items: [item],
    root: (COMMAND_CATALOG as { root: string }).root,
    command_policy: (COMMAND_CATALOG as { policy: unknown }).policy,
    extra: { product: 'widget', version: '1.0', build: 'b1' },
  });
  await writeDownload(dir, run, COMMAND_CATALOG as FlatCatalog);
  await mkdir(join(dir, 'sources'));
  const rows = [];
  for (const [slot, doc] of [['contract', CONTRACT_DOC], ['profile', PROFILE_DOC], ['inventory', MANIFEST_DOC]] as const) {
    await writeFile(join(dir, 'sources', `${slot}.json`), JSON.stringify(doc));
    rows.push({ slot, role: 'expected', reference: `src:${'b'.repeat(64)}`, label: slot, media_type: 'application/json', file: `sources/${slot}.json`, sha256: 'b'.repeat(64) });
  }
  await writeFile(join(dir, 'sources.json'), JSON.stringify(rows));
  await mkdir(join(dir, 'items'));
  await writeFile(join(dir, 'items', '00.json'), JSON.stringify(item));
  const plans = join(dir, 'plans');
  await mkdir(plans);
  const data = { bucket: 'bed-a', blocks: [], replacements: [], steps, expects: [{ text: QUOTE.text, quote: { ...QUOTE }, after: 1 }] };
  const file = join(plans, '00.json');
  await writeFile(file, JSON.stringify(planFile('doc:case-1', data)));
  return { dir, file };
}
const seat = (line: string, description: string) => ({ object: 'widget-seat', method: 'configure', args: [line], keywords: {}, description });
const VALID = [seat('widget health interval 60', '设置健康检查间隔为 60'), seat('widget health interval 61', '把健康检查间隔改成 61')];
const REFUSED = seat('widget health interval 62', '把健康检查间隔设成 62');
const UNPARSEABLE = seat('widget unknown command 5', '执行一条树里没有的命令');

test('Plumb is advisory where the command tree decides: a command it rejects but the tree accepts is review_required, not blocked, and the exit code stays 0', async () => {
  const w = await frozenWorkspace(VALID);
  try {
    stubMode = 'reject';
    decide = null;
    const res = await runOn(['--file', w.file, '--run', w.dir]);
    assert.equal(res.code, 0, res.stderr);
    const report = JSON.parse(res.stdout);
    assert.equal(report.blocked_count, 0);
    assert.equal(report.review_required_count, 2);
    for (const step of report.results[0].steps) {
      assert.equal(step.verdict, 'review');
      assert.equal(step.blocked, false);
      assert.equal(step.review_required, true);
      assert.equal(step.plumb_verdict, 'reject', 'what Plumb said is kept beside the verdict');
      assert.equal(step.tree_check.status, 'accepted');
      assert.equal(step.disclosure, OVERRIDE);
      assert.equal(step.note, '[需人工复核：Plumb 拒绝（p(是)=0.100），命令树核对通过]');
      assert.equal(step.gate.action, 'reject');
      assert.equal(typeof step.probabilities.yes, 'number', 'the Plumb probability stays in the report');
      assert.ok(step.probabilities.yes < 0.5);
    }
    assert.equal(res.stderr, '', 'a review is not a failure');

    const strict = await runOn(['--file', w.file, '--run', w.dir, '--strict-review']);
    assert.equal(strict.code, 1, '--strict-review blocks a review, an overridden one included');
    assert.equal(JSON.parse(strict.stdout).blocked_count, 2);
  } finally {
    decide = null;
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('a command the tree refuses stays blocked, whatever Plumb says; the commands beside it that the tree accepts are only reviewed', async () => {
  const w = await frozenWorkspace([VALID[0], REFUSED, VALID[1]]);
  try {
    stubMode = 'reject';
    decide = null;
    const rej = await runOn(['--file', w.file, '--run', w.dir]);
    assert.equal(rej.code, 1);
    const report = JSON.parse(rej.stdout);
    const by = (pointer: string) => report.results[0].steps.find((s: { pointer: string }) => s.pointer === pointer);
    assert.deepEqual([by('/steps/0').verdict, by('/steps/0').blocked, by('/steps/0').tree_check.status], ['review', false, 'accepted']);
    assert.deepEqual([by('/steps/1').verdict, by('/steps/1').blocked, by('/steps/1').tree_check.status], ['reject', true, 'refused']);
    assert.deepEqual([by('/steps/2').verdict, by('/steps/2').blocked, by('/steps/2').tree_check.status], ['review', false, 'accepted']);
    assert.equal(report.blocked_count, 1);
    assert.equal(report.review_required_count, 2);
    assert.match(by('/steps/1').tree_check.problems[0].message, /\S/, 'the refusal says what the tree found');
    assert.match(rej.stderr, /命令树核对未通过/, 'the stop text names the program check');
    assert.match(rej.stderr, /widget health interval 62/);

    stubMode = 'pass';
    const pass = await runOn(['--file', w.file, '--run', w.dir]);
    assert.equal(pass.code, 1, pass.stderr);
    const passed = JSON.parse(pass.stdout);
    assert.deepEqual(passed.results[0].steps.map((s: { blocked: boolean }) => s.blocked), [false, true, false]);
    assert.equal(passed.results[0].steps[1].plumb_verdict, 'pass');
    assert.equal(passed.results[0].steps[1].verdict, 'reject');
  } finally {
    decide = null;
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('a command the tree cannot parse is no refusal either: Plumb alone has spoken, so its reject stands and its pass stands, and the report says the tree gave no conclusion', async () => {
  const w = await frozenWorkspace([VALID[0], UNPARSEABLE]);
  try {
    stubMode = 'reject';
    decide = null;
    const rej = await runOn(['--file', w.file, '--run', w.dir]);
    assert.equal(rej.code, 1);
    const steps = JSON.parse(rej.stdout).results[0].steps as Array<Record<string, any>>;
    assert.deepEqual(steps.map((x) => [x.verdict, x.blocked, x.tree_check.status]), [['review', false, 'accepted'], ['reject', true, 'undetermined']]);
    assert.match(steps[1]!.tree_check.reason, /\S/);
    assert.match(steps[1]!.disclosure, /命令树核对没有给出结论/);
    assert.match(rej.stderr, /命令树核对没有结论/);

    stubMode = 'pass';
    const pass = await runOn(['--file', w.file, '--run', w.dir]);
    assert.equal(pass.code, 0, pass.stderr);
    assert.deepEqual(JSON.parse(pass.stdout).results[0].steps.map((x: { verdict: string }) => x.verdict), ['pass', 'pass']);
  } finally {
    decide = null;
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('without a frozen run the tree cannot speak: a Plumb reject blocks as before and the step says the tree check did not run', async () => {
  const w = await setupWorkspace();
  try {
    stubMode = 'reject';
    decide = null;
    const res = await runOn(['--file', w.singlePlanPath, '--run', w.dir]);
    assert.equal(res.code, 1);
    const steps = JSON.parse(res.stdout).results[0].steps as Array<Record<string, any>>;
    for (const step of steps) {
      assert.equal(step.blocked, true);
      assert.equal(step.tree_check.status, 'not_run');
      assert.match(step.tree_check.reason, /\S/);
      assert.match(step.disclosure, /命令树核对没有给出结论/);
    }
    const helped = await runCmdVerifyPlumb(['--help'], {});
    assert.equal(helped.code, 0);
    assert.match(helped.stdout, /命令树/);
    assert.match(helped.stdout, /需人工复核/);
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('questions the judging service refuses for their length are asked again by themselves with fewer of the earlier steps, and the report says which', async () => {
  const w = await setupWorkspace();
  try {
    const steps = Array.from({ length: 8 }, (_, k) => device(`ip address 192.0.2.${k + 1}/24`, { description: `配置第 ${k + 1} 个地址` }));
    const file = join(w.plans, '05.json');
    await writeFile(file, JSON.stringify(planFile('doc:0', { bucket: 'bed-0', blocks: [], replacements: [], steps, expects: [] })));
    stubMode = 'pass';
    decide = null;
    refuseLong = null;
    const whole = await runOn(['--file', file, '--run', w.dir]);
    assert.equal(whole.code, 0, whole.stderr);
    const full = asked().map((q) => q.state ?? '');
    assert.equal(full.length, 8);
    assert.ok(full.every((state, k) => k === 0 || state.length > full[k - 1]!.length), 'every question carries the steps before it');
    assert.equal(JSON.parse(whole.stdout).results[0].steps.some((s: Record<string, unknown>) => s.earlier_steps_shortened), false);

    const limit = full[4]!.length;
    refuseLong = (q) => (q.state ?? '').length > limit;
    refusedForLength.length = 0;
    const res = await runOn(['--file', file, '--run', w.dir]);
    assert.equal(res.code, 0, res.stderr);
    const report = JSON.parse(res.stdout) as { blocked_count: number; results: Array<{ steps: Array<Record<string, unknown>> }> };
    assert.equal(report.blocked_count, 0);
    assert.deepEqual(report.results[0]!.steps.map((s) => s.earlier_steps_shortened === true), [false, false, false, false, false, true, true, true]);
    assert.equal(refusedForLength[0], 8, 'the request of all eight was refused whole');
    assert.ok(refusedForLength.slice(1).every((size) => size === 1), 'after that each question is asked by itself');
    const answered = asked().map((q) => q.state ?? '');
    assert.equal(answered.length, 8, 'each question was answered once');
    assert.deepEqual(answered.slice(0, 5), full.slice(0, 5), 'a question the service takes keeps all of its earlier steps');
    for (const [k, state] of answered.slice(5).entries()) {
      assert.ok(state.length <= limit, 'what was answered fits');
      assert.match(state, /\[当前步骤\]\n步骤位置: \/steps\/\d\n步骤意图: 配置第 \d 个地址\n候选命令: ip address 192\.0\.2\.\d\/24$/, 'the step itself is whole');
      assert.match(state, /（前面 \d 步已省略）\n\d\. ip address/, `step ${k + 6} keeps the latest of its earlier steps and says how many are left out`);
    }
  } finally {
    refuseLong = null;
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('a step the judging service refuses with nothing but itself is named to the writer with what to change, and no report is written', async () => {
  const w = await setupWorkspace();
  try {
    const steps = [device('ip address 192.0.2.1/24', { description: '配置地址' }), device('no shutdown', { description: '这一步的描述本身就超过判断服务读得下的长度' }), device('ip address 192.0.2.2/24', { description: '再配置一个地址' })];
    const file = join(w.plans, '06.json');
    await writeFile(file, JSON.stringify(planFile('doc:0', { bucket: 'bed-0', blocks: [], replacements: [], steps, expects: [] })));
    stubMode = 'pass';
    decide = null;
    refuseLong = (q) => (q.state ?? '').includes('步骤意图: 这一步的描述本身就超过');
    refusedForLength.length = 0;
    const res = await runOn(['--file', file, '--run', w.dir]);
    assert.equal(res.code, 1);
    assert.equal(res.stdout, '');
    assert.equal(res.stderr.trim(), '参数无效：以下步骤不带前面的步骤、只它自己，判断服务仍因输入过长拒收：06.json:/steps/1（no shutdown）。请把这一步拆成几条更短的命令，或把这一步的描述写短，再重跑 cmd-verify-plumb.ts。');
    assert.ok(refusedForLength.length >= 3, 'asked whole, by itself, and with fewer earlier steps before giving up');
    assert.equal(asked().length, 2, 'the two other steps were answered');
  } finally {
    refuseLong = null;
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('--tree-only asks Plumb nothing and needs no address or key: the tree refuses, accepts, or leaves a step unknown and says so', async () => {
  const w = await frozenWorkspace([VALID[0], REFUSED, UNPARSEABLE]);
  try {
    stubMode = 'reject';
    decide = null;
    seenBatches.length = 0;
    const res = await runCmdVerifyPlumb(['--file', w.file, '--run', w.dir, '--tree-only'], {});
    assert.equal(seenBatches.length, 0, 'no question reaches the judging service');
    assert.equal(res.code, 1);
    const report = JSON.parse(res.stdout);
    assert.deepEqual([report.judge, report.decided_by, report.model_version, report.status], ['tree-only', '程序', null, '未知']);
    const steps = report.results[0].steps as Array<Record<string, any>>;
    assert.deepEqual(steps.map((x) => [x.verdict, x.blocked, x.review_required, x.tree_check.status, x.plumb_verdict]), [['pass', false, false, 'accepted', null], ['reject', true, false, 'refused', null], ['review', false, true, 'undetermined', null]]);
    assert.match(steps[2]!.disclosure, /命令树核对没有给出结论.*不问 Plumb.*状态未知/);
    assert.deepEqual([report.blocked_count, report.review_required_count], [1, 1]);
    assert.match(res.stderr, /^参数无效：命令核验未通过（阻断 1 处）/, 'the stop text does not name Plumb');
    assert.match(res.stderr, /widget health interval 62/);
  } finally {
    decide = null;
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('--tree-only on a plan the tree accepts throughout is settled by the program; a step it cannot settle blocks only under --strict-review', async () => {
  const good = await frozenWorkspace(VALID), open = await frozenWorkspace([VALID[0], UNPARSEABLE]);
  try {
    const settled = await runCmdVerifyPlumb(['--file', good.file, '--run', good.dir, '--tree-only'], {});
    assert.equal(settled.code, 0, settled.stderr);
    const report = JSON.parse(settled.stdout);
    assert.deepEqual([report.status, report.decided_by, report.review_required_count], ['已确认', '程序', 0]);
    const lenient = await runCmdVerifyPlumb(['--file', open.file, '--run', open.dir, '--tree-only'], {});
    assert.equal(lenient.code, 0, lenient.stderr);
    assert.equal(JSON.parse(lenient.stdout).status, '未知');
    const strict = await runCmdVerifyPlumb(['--file', open.file, '--run', open.dir, '--tree-only', '--strict-review'], {});
    assert.equal(strict.code, 1);
    assert.match(strict.stderr, /命令树核对没有结论，--strict-review/);
  } finally {
    await rm(good.dir, { recursive: true, force: true }); await rm(open.dir, { recursive: true, force: true });
  }
});
