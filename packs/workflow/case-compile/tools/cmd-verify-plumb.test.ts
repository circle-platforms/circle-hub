import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, test } from 'node:test';
import { knowledgeFiles } from '../functions/knowledge-text.ts';
import { COMMAND_CATALOG, CONTRACT_DOC, MANIFEST_DOC, PROFILE_DOC, QUOTE } from '../functions/test-support.ts';
import { frozenRun, writeDownload } from '../testing/frozen-run.ts';
import type { FlatCatalog } from '../testing/locked-tree.ts';
import { FakeCallError, JEV_WIRE_KEY, JEV_WIRE_VERSION, filesBelow, jevFake, jevWire, sha256Text, textForms, validAnswer } from '../testing/jev-fake.ts';
import { JEV_ENDPOINT } from '../functions/generated/skills/jev-judge/jev-client/index.ts';
import { COMMAND_CRITERIA, JEV_STATE_BUDGET_EST_TOKENS, SINGLE_INSTRUCTIONS } from '../functions/jev-judge.ts';
import { estimateTokens } from '../functions/generated/skills/plumb/plumb-client/index.ts';
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

test('--tree-only has said nothing about a command it did not look at: plans all skipped, or without a device command, are unknown with what is missing and the next step', async () => {
  const w = await frozenWorkspace(VALID);
  try {
    const plans = join(w.dir, 'plans');
    const skippedFile = join(plans, '01.json'), bareFile = join(plans, '02.json');
    await writeFile(skippedFile, JSON.stringify({ item: 'doc:case-1', handling: 'skipped', reason: '不适用' }));
    await writeFile(bareFile, JSON.stringify(planFile('doc:case-1', { bucket: 'bed-a', blocks: [], replacements: [], steps: [{ object: 'widget-seat', method: 'configure', args: [], keywords: {} }], expects: [] })));
    const NEXT = '确认这些计划本来就不下发设备命令（跳过的用例看它写的理由）；本该有命令的先写进计划，再重跑 cmd-verify-plumb.ts';

    const skipped = await runCmdVerifyPlumb(['--file', skippedFile, '--run', w.dir, '--tree-only'], {});
    assert.equal(skipped.code, 0, skipped.stderr);
    const none = JSON.parse(skipped.stdout);
    assert.deepEqual([none.judge, none.status, none.decided_by, none.checked, none.steps_checked, none.skipped.length, none.blocked_count, none.review_required_count], ['tree-only', '未知', '程序', 0, 0, 1, 0, 0]);
    assert.equal(none.missing_fact, '没有核对任何命令：这次给的计划都标为跳过（1 份），命令树核对一步也没有做');
    assert.equal(none.next_action, NEXT);

    const bare = await runCmdVerifyPlumb(['--file', bareFile, '--run', w.dir, '--tree-only'], {});
    assert.equal(bare.code, 0, bare.stderr);
    const noCommand = JSON.parse(bare.stdout);
    assert.deepEqual([noCommand.status, noCommand.decided_by, noCommand.checked, noCommand.steps_checked, noCommand.results[0].steps], ['未知', '程序', 1, 0, []]);
    assert.equal(noCommand.missing_fact, '没有核对任何命令：计划里没有一步下发设备命令，命令树核对一步也没有做');
    assert.equal(noCommand.next_action, NEXT);

    // A plan with commands the tree accepts is still confirmed, and says nothing is missing.
    const good = await runCmdVerifyPlumb(['--file', w.file, '--run', w.dir, '--tree-only'], {});
    assert.equal(good.code, 0, good.stderr);
    const checked = JSON.parse(good.stdout);
    assert.deepEqual([checked.status, checked.decided_by, checked.steps_checked, 'missing_fact' in checked, 'next_action' in checked], ['已确认', '程序', 2, false, false]);

    // Once the program has looked at some command the report is about those: a skipped plan or one without a command beside them adds no gap.
    const mixed = await runCmdVerifyPlumb(['--plans', plans, '--run', w.dir, '--tree-only'], {});
    assert.equal(mixed.code, 0, mixed.stderr);
    const some = JSON.parse(mixed.stdout);
    assert.deepEqual([some.status, some.checked, some.steps_checked, some.skipped.length, 'missing_fact' in some], ['已确认', 2, 2, 1, false]);
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('--tree-only is run by pipeline.ts: the help says so, since the declaration still asks for the address and the key that the option does not need', async () => {
  const helped = await runCmdVerifyPlumb(['--help'], {});
  assert.equal(helped.code, 0);
  assert.match(helped.stdout, /此时工具本身不需要 --base-url 和密钥；但命令行声明（cmd-verify-plumb\.cli\.json）仍要求它们，守卫会拒绝没带它们的直接调用，所以这个选项由 pipeline\.ts 运行，不由主代理手敲/);
  assert.match(helped.stdout, /一步命令也没有核对.*状态也是未知，写明缺什么和下一步/);
});

// ---- Jev as the judge: pipeline.ts runs the tool with --judge jev when the user chose Jev for this compile ----

const JEV_IN = { stdinText: 'jev_sk_synthetic_1\n' };
const jevArgs = (file: string, dir: string, extra: string[] = []) => ['--file', file, '--run', dir, '--judge', 'jev', '--key-stdin', ...extra];

test('--judge jev: Jev is asked about every command, each step is held for review with Jev\'s probability, nothing blocks and Plumb is never asked', async () => {
  const w = await frozenWorkspace(VALID);
  try {
    seenBatches.length = 0;
    const f = jevFake(() => ({ type: 'noul', noul: 0.8 }));
    const audit = join(w.dir, 'jev-commands.jsonl');
    const res = await runCmdVerifyPlumb(jevArgs(w.file, w.dir, ['--audit-out', audit]), { ...JEV_IN, jev: f.factory });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.stderr, '');
    assert.equal(seenBatches.length, 0, 'no question reaches the Plumb gateway');
    assert.deepEqual(f.configs, [{ apiKey: 'jev_sk_synthetic_1', auditPath: audit }], 'the key comes from the first stdin line and the request log is named');
    assert.deepEqual(f.requests.map((r) => r.model), ['jev-latest', 'jev-1.13.0'], 'one invocation has one model version');
    const report = JSON.parse(res.stdout);
    assert.deepEqual([report.judge, report.status, report.decided_by, report.model_version, report.prompt_version, report.jev_requests], ['jev', '未确认', '模型', 'jev-1.13.0', 'jev-noul@command-v1', 2]);
    assert.deepEqual([report.blocked_count, report.review_required_count], [0, 2]);
    for (const step of report.results[0].steps) {
      assert.deepEqual([step.verdict, step.blocked, step.review_required, step.plumb_verdict, step.tree_check.status], ['review', false, true, 'review', 'accepted']);
      assert.equal(step.note, '[需人工复核：Jev 的回答未经确认，只作参考（p(是)=0.800）]');
      assert.deepEqual([step.answer, step.match, step.probabilities.yes], ['yes', 0.8, 0.8]);
      assert.deepEqual(step.gate, { action: 'review', calibrated: false, calibration_source: 'uncalibrated' });
      assert.equal(step.disclosure, undefined, 'the tree accepted the step, so there is nothing more to disclose');
    }
    // The first command line of the plan went out as `command`, beside the context.
    assert.equal((f.requests[0]!.state as { command: string }).command, 'widget health interval 60');
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('--judge jev: the tree refuses what it refuses whatever Jev says, and a step the tree cannot settle says that Jev alone advised and nothing settled it', async () => {
  const w = await frozenWorkspace([VALID[0], REFUSED, UNPARSEABLE]);
  try {
    const f = jevFake(() => ({ type: 'noul', noul: 0.99 }));
    const res = await runCmdVerifyPlumb(jevArgs(w.file, w.dir), { ...JEV_IN, jev: f.factory });
    assert.equal(res.code, 1);
    const steps = JSON.parse(res.stdout).results[0].steps as Array<Record<string, any>>;
    assert.deepEqual(steps.map((x) => [x.verdict, x.blocked, x.review_required, x.tree_check.status]), [['review', false, true, 'accepted'], ['reject', true, false, 'refused'], ['review', false, true, 'undetermined']]);
    assert.equal(steps[1]!.plumb_verdict, 'review', 'what Jev said stays beside the tree\'s refusal');
    assert.match(steps[2]!.disclosure, /命令树核对没有给出结论.*这一步只有 Jev 的判断（未确认，只作参考），既没有放行也没有拒绝，状态未知/);
    assert.match(res.stderr, /^参数无效：Jev 命令核验未通过（阻断 1 处）/);
    assert.match(res.stderr, /widget health interval 62/);
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('--judge jev: an outage ends the tool under the word the pipeline waits on, a refused key says what to do, and a key that is no key or a call that is no Jev call is refused before any request', async () => {
  const w = await frozenWorkspace(VALID);
  try {
    const outage = jevFake(() => new FakeCallError('暂时不可用', 503, 'unavailable'));
    const down = await runCmdVerifyPlumb(jevArgs(w.file, w.dir), { ...JEV_IN, jev: outage.factory });
    assert.equal(down.code, 1);
    assert.equal(down.stdout, '');
    assert.match(down.stderr, /^暂时不可用：Jev 暂时不可用（HTTP 503，unavailable）/);
    const refused = jevFake(() => new FakeCallError('无权限', 401, 'unauthorized'));
    const denied = await runCmdVerifyPlumb(jevArgs(w.file, w.dir), { ...JEV_IN, jev: refused.factory });
    assert.match(denied.stderr, /^无权限：Jev 拒绝了密钥（HTTP 401，unauthorized）.*JEV_API_KEY/);
    assert.ok(!denied.stderr.includes('jev_sk_synthetic_1'));
    const idle = jevFake(() => ({ type: 'noul', noul: 0.5 }));
    const placeholder = await runCmdVerifyPlumb(jevArgs(w.file, w.dir), { stdinText: '%JEV_API_KEY%\n', jev: idle.factory });
    assert.match(placeholder.stderr, /^无权限：Jev 密钥没有展开，标准输入第一行还是占位符/);
    const noFlag = await runCmdVerifyPlumb(['--file', w.file, '--run', w.dir, '--judge', 'jev'], { ...JEV_IN, jev: idle.factory });
    assert.match(noFlag.stderr, /^无权限：Jev 密钥只从标准输入第一行读入，没有带 --key-stdin/);
    const other = await runCmdVerifyPlumb(['--file', w.file, '--run', w.dir, '--judge', 'gpt', '--key-stdin'], { ...JEV_IN, jev: idle.factory });
    assert.match(other.stderr, /^参数无效：--judge 只能写 plumb 或 jev/);
    const both = await runCmdVerifyPlumb(['--file', w.file, '--run', w.dir, '--judge', 'jev', '--tree-only'], { ...JEV_IN, jev: idle.factory });
    assert.match(both.stderr, /^参数无效：--tree-only 不问任何判断服务，不能同时写 --judge/);
    assert.equal(idle.requests.length, 0);
    assert.deepEqual(idle.configs, [], 'no client was built for any of them');
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('--judge jev: a question Jev refuses for its length (the body too large, or the model\'s context too short) is asked again with fewer of the earlier steps, and the report says which', async () => {
  for (const [status, code] of [[413, 'request_too_large'], [422, 'context_too_long']] as const) {
    const w = await frozenWorkspace(VALID);
    try {
      const f = jevFake((request) => ((request.state as { context: string }).context.includes('[已执行的步骤]') ? new FakeCallError('参数无效', status, code, '题面太长') : { type: 'noul', noul: 0.6 }));
      const res = await runCmdVerifyPlumb(jevArgs(w.file, w.dir), { ...JEV_IN, jev: f.factory });
      assert.equal(res.code, 0, `${code}: ${res.stderr}`);
      const steps = JSON.parse(res.stdout).results[0].steps as Array<Record<string, unknown>>;
      assert.deepEqual(steps.map((s) => s.earlier_steps_shortened ?? false), [false, true], code);
      assert.ok(f.requests.some((r) => !(r.state as { context: string }).context.includes('[已执行的步骤]') && (r.state as { command: string }).command === 'widget health interval 61'), `${code}: the second step was asked again without the steps before it`);
    } finally {
      await rm(w.dir, { recursive: true, force: true });
    }
  }
});


// ---- the real embedded client of the jev-judge skill runs; only the network under it is replaced ----

const WIRE_KEY = JEV_WIRE_KEY;

test('--judge jev with the real embedded client: the request that leaves carries the mapped question and state, the answers come back as unconfirmed review advice, and neither the key nor the state text is written anywhere', async () => {
  const w = await frozenWorkspace(VALID);
  try {
    const wire = jevWire();
    const out = join(w.dir, 'verify', 'report.json'), audit = join(w.dir, 'verify', 'jev-commands.jsonl');
    const before = new Set(await filesBelow(w.dir));
    const res = await runCmdVerifyPlumb(jevArgs(w.file, w.dir, ['--out', out, '--audit-out', audit]), { stdinText: `${WIRE_KEY}\n`, jevTransport: wire.transport });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.stderr, '');

    // What left: one request per command, to the module's fixed address, the key only in the header, the question as the adapter maps it.
    assert.equal(wire.calls.length, 2);
    for (const call of wire.calls) {
      assert.equal(call.url, JEV_ENDPOINT);
      assert.equal(call.authorization, `Bearer ${WIRE_KEY}`);
      assert.equal(call.contentType, 'application/json');
      assert.equal(call.timeoutMs, 60_000, 'on the pipeline path a request may take a minute, not the client\'s default half minute');
      assert.deepEqual(Object.keys(call.sent), ['state', 'model', 'questions']);
      assert.deepEqual(Object.keys(call.sent.questions), ['q1']);
      assert.deepEqual(call.sent.questions.q1, { type: 'noul', instructions: SINGLE_INSTRUCTIONS, criteria: COMMAND_CRITERIA });
      assert.ok(!call.text.includes(WIRE_KEY), 'the key is not in the body');
    }
    assert.deepEqual(wire.calls.map((call) => call.sent.model), ['jev-latest', JEV_WIRE_VERSION], 'the first request asks for the latest, the next one for the exact version that answered');
    const [first, second] = wire.calls.map((call) => call.sent.state as { context: string; command: string; definition?: string });
    assert.deepEqual(Object.keys(first!), ['context', 'command', 'definition']);
    assert.equal(first!.command, 'widget health interval 60');
    assert.equal(first!.context, '[用例]\n健康检查间隔配置\n\n[当前步骤]\n步骤位置: /steps/0\n步骤意图: 设置健康检查间隔为 60\n候选命令: widget health interval 60');
    assert.equal(second!.command, 'widget health interval 61');
    assert.match(second!.context, /\n\n\[已执行的步骤\]\n1\. widget health interval 60\n\n\[当前步骤\]\n步骤位置: \/steps\/1\n步骤意图: 把健康检查间隔改成 61\n候选命令: widget health interval 61$/);

    // What came back: advice only, with the disclosure, held for review whatever Jev's probability.
    const report = JSON.parse(res.stdout);
    assert.deepEqual([report.judge, report.status, report.decided_by, report.model_version, report.prompt_version, report.jev_requests, report.blocked_count, report.review_required_count], ['jev', '未确认', '模型', JEV_WIRE_VERSION, 'jev-noul@command-v1', 2, 0, 2]);
    for (const step of report.results[0].steps) {
      assert.deepEqual([step.verdict, step.blocked, step.review_required, step.answer, step.match, step.probabilities.yes], ['review', false, true, 'yes', 0.8, 0.8]);
      assert.deepEqual(step.gate, { action: 'review', calibrated: false, calibration_source: 'uncalibrated' });
      assert.equal(step.probabilities.no, 0.2);
      assert.equal(step.note, '[需人工复核：Jev 的回答未经确认，只作参考（p(是)=0.800）]');
    }
    assert.equal(await readFile(out, 'utf8'), res.stdout, 'the report file is what the tool printed');

    // The request log has one line per request: sizes, digest, status and usage, no content, owner-only.
    const lines = (await readFile(audit, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(lines.length, 2);
    lines.forEach((line, index) => {
      assert.deepEqual(Object.keys(line), ['ts', 'endpoint_host', 'questions', 'question_types', 'body_bytes', 'body_sha256', 'attempt', 'http_status', 'model', 'usage', 'duration_ms', 'error_code']);
      assert.deepEqual([line.endpoint_host, line.questions, line.question_types, line.attempt, line.http_status, line.model, line.usage, line.error_code], ['api.typesafe.ai', 1, ['noul'], 1, 200, JEV_WIRE_VERSION, { input_tokens: 120, output_tokens: 30 }, null]);
      assert.equal(line.body_sha256, sha256Text(wire.calls[index]!.text));
      assert.equal(line.body_bytes, Buffer.byteLength(wire.calls[index]!.text));
    });
    assert.equal((await stat(audit)).mode & 0o777, 0o600);

    // Neither the key nor the text of any state is in a file the run wrote, in what it printed, or in the request log.
    const written = (await filesBelow(w.dir)).filter((file) => !before.has(file));
    assert.deepEqual(written.map((file) => relative(w.dir, file)), ['verify/jev-commands.answers.jsonl', 'verify/jev-commands.jsonl', 'verify/report.json'], 'the answers are kept beside the request log, for the next pass');
    const kept = (await readFile(join(w.dir, 'verify', 'jev-commands.answers.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(kept.map((line) => [Object.keys(line), line.model_version, line.answer]), [[['key', 'model_version', 'answer'], JEV_WIRE_VERSION, { type: 'noul', noul: 0.8 }], [['key', 'model_version', 'answer'], JEV_WIRE_VERSION, { type: 'noul', noul: 0.8 }]]);
    assert.equal((await stat(join(w.dir, 'verify', 'jev-commands.answers.jsonl'))).mode & 0o777, 0o600);
    const seen = [...(await Promise.all(written.map((file) => readFile(file, 'utf8')))), res.stdout, res.stderr];
    for (const text of seen) {
      assert.ok(!text.includes(WIRE_KEY));
      for (const call of wire.calls) for (const form of [...textForms((call.sent.state as { context: string }).context), ...textForms(JSON.stringify(call.sent.state)), call.text]) assert.ok(!text.includes(form), 'the state text stays out of what the run leaves behind');
    }
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('--judge jev with the real embedded client: a request the service refuses for its length, in either of its two ways, is asked again without the earlier steps and the report says which', async () => {
  for (const [name, refusal] of [['body too large', { status: 413, body: 'too large' }], ['context too long', { status: 422, body: JSON.stringify({ error: { type: 'max_tokens_exceeded' } }) }]] as const) {
    const w = await frozenWorkspace(VALID);
    try {
      const wire = jevWire((question, call) => ((call.sent.state as { context: string }).context.includes('[已执行的步骤]') ? refusal : validAnswer(question)));
      const res = await runCmdVerifyPlumb(jevArgs(w.file, w.dir, ['--audit-out', join(w.dir, 'audit.jsonl')]), { stdinText: `${WIRE_KEY}\n`, jevTransport: wire.transport });
      assert.equal(res.code, 0, `${name}: ${res.stderr}`);
      assert.equal(wire.calls.length, 3, `${name}: the first step, the second with the first before it (refused), the second alone`);
      const states = wire.calls.map((call) => (call.sent.state as { context: string; command: string }));
      assert.deepEqual(states.map((state) => [state.command, state.context.includes('[已执行的步骤]')]), [['widget health interval 60', false], ['widget health interval 61', true], ['widget health interval 61', false]], name);
      const steps = JSON.parse(res.stdout).results[0].steps as Array<Record<string, unknown>>;
      assert.deepEqual(steps.map((step) => step.earlier_steps_shortened ?? false), [false, true], name);
      assert.deepEqual(steps.map((step) => step.review_required), [true, true], name);
      const audit = (await readFile(join(w.dir, 'audit.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { http_status: number; error_code: string | null });
      assert.deepEqual(audit.map((line) => [line.http_status, line.error_code]), [[200, null], [refusal.status, name === 'body too large' ? 'request_too_large' : 'context_too_long'], [200, null]], name);
    } finally {
      await rm(w.dir, { recursive: true, force: true });
    }
  }
});

test('--judge jev with the real embedded client: jev_requests counts the requests that left the client, the one it sent again after a 429 included, and the request log has a line for each', async () => {
  const w = await frozenWorkspace(VALID);
  try {
    const wire = jevWire((question, _call, n) => (n === 1 ? { status: 429, body: '', headers: { 'retry-after': '0.5' } } : validAnswer(question)));
    const audit = join(w.dir, 'jev-commands.jsonl');
    const res = await runCmdVerifyPlumb(jevArgs(w.file, w.dir, ['--audit-out', audit]), { stdinText: `${WIRE_KEY}\n`, jevTransport: wire.transport });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(wire.calls.length, 3, 'two questions and one request sent again');
    const report = JSON.parse(res.stdout);
    assert.equal(report.jev_requests, 3, 'the requests that left, not the questions asked');
    const lines = (await readFile(audit, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { attempt: number; http_status: number; error_code: string | null });
    assert.deepEqual(lines.map((line) => [line.attempt, line.http_status, line.error_code]), [[1, 429, 'rate_limited'], [2, 200, null], [1, 200, null]]);
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('--judge jev with the real embedded client: a request the service rejects leaves its step without a Jev opinion: the tree speaks alone, the other steps are answered, and nothing of the request is shown or sent back to the writer', async () => {
  const w = await frozenWorkspace(VALID);
  try {
    // The service rejects the question of the second step, and its answer echoes the request body (which the client never shows).
    const wire = jevWire((question, call) => ((call.sent.state as { command: string }).command.endsWith('61') ? { status: 422, body: JSON.stringify({ detail: call.text }) } : validAnswer(question)));
    const out = join(w.dir, 'report.json'), audit = join(w.dir, 'jev-commands.jsonl');
    const res = await runCmdVerifyPlumb(jevArgs(w.file, w.dir, ['--out', out, '--audit-out', audit]), { stdinText: `${WIRE_KEY}\n`, jevTransport: wire.transport });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.stderr, '');
    const report = JSON.parse(res.stdout);
    const [judged, gone] = report.results[0].steps as Array<Record<string, any>>;
    assert.deepEqual([judged.verdict, judged.review_required, judged.jev_no_opinion, judged.gate.action], ['review', true, undefined, 'review'], 'the step Jev answered is advice, as always');
    assert.deepEqual([gone.verdict, gone.blocked, gone.review_required, gone.plumb_verdict, gone.answer, gone.gate, gone.tree_check.status], ['pass', false, false, null, null, null, 'accepted'], 'the step without a Jev opinion stands on the tree alone');
    assert.deepEqual(gone.jev_no_opinion, { code: 'request_rejected', reason: 'Jev 服务拒绝了这个请求（HTTP 422，request_rejected）' });
    assert.equal(gone.disclosure, 'Jev 对这一步没有给出答复（Jev 服务拒绝了这个请求（HTTP 422，request_rejected））；这一步只有命令树核对的结论（通过），没有 Jev 的判断');
    assert.deepEqual([report.jev_no_opinion_count, report.review_required_count, report.blocked_count, report.jev_requests], [1, 1, 0, 2]);
    // Nothing of the rejected request, and not the key, is in what the run wrote or printed.
    const state = JSON.stringify((wire.calls[1]!.sent.state as { context: string }).context).slice(1, -1);
    for (const text of [res.stdout, await readFile(out, 'utf8'), await readFile(audit, 'utf8'), await readFile(join(w.dir, 'jev-commands.answers.jsonl'), 'utf8')]) {
      assert.ok(!text.includes(WIRE_KEY) && !text.includes(wire.calls[1]!.text) && !text.includes(state));
    }
    // The next pass asks the rejected question again and nothing else: the answered one is kept.
    const next = jevWire((question) => validAnswer(question));
    const again = await runCmdVerifyPlumb(jevArgs(w.file, w.dir, ['--audit-out', join(w.dir, 'second.jsonl')]), { stdinText: `${WIRE_KEY}\n`, jevTransport: next.transport });
    assert.equal(again.code, 0, again.stderr);
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('--judge jev with the real embedded client: a step the service refuses for its size even alone has no Jev opinion, and what the tree refuses is still blocked', async () => {
  const w = await frozenWorkspace([VALID[0], REFUSED, UNPARSEABLE]);
  try {
    const wire = jevWire((question, call) => ((call.sent.state as { command: string }).command.endsWith('62') || (call.sent.state as { command: string }).command.endsWith('5') ? { status: 413, body: 'too large' } : validAnswer(question)));
    const res = await runCmdVerifyPlumb(jevArgs(w.file, w.dir, ['--audit-out', join(w.dir, 'audit.jsonl')]), { stdinText: `${WIRE_KEY}\n`, jevTransport: wire.transport });
    assert.equal(res.code, 1, 'the tree refuses the second step whatever Jev says');
    const steps = JSON.parse(res.stdout).results[0].steps as Array<Record<string, any>>;
    assert.deepEqual(steps.map((step) => [step.verdict, step.blocked, step.review_required, step.jev_no_opinion?.code, step.earlier_steps_shortened ?? false]), [['review', false, true, undefined, false], ['reject', true, false, 'request_too_large', true], ['review', false, true, 'request_too_large', true]]);
    assert.match(steps[2]!.disclosure, /命令树核对没有给出结论.*Jev 对这一步没有给出答复（题面超过 Jev 服务的大小上限（HTTP 413，request_too_large））；这一步没有判断，状态未知/);
    assert.match(res.stderr, /^参数无效：Jev 命令核验未通过（阻断 1 处）：00\.json:\/steps\/1 命令树核对未通过/);
    assert.doesNotMatch(res.stderr, /Jev 拒收|拒绝了这个请求|没有给出答复/, 'the blocked step is the tree\'s, and is said as such');
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('--judge jev with the real embedded client: what the service refuses, echoes or drops ends the tool under the right word, and no error text carries the key or the state', async () => {
  const w = await frozenWorkspace(VALID);
  try {
    const cases: Array<{ name: string; script: Parameters<typeof jevWire>[0]; head: RegExp; code: string }> = [
      { name: 'key refused', script: () => ({ status: 401, body: JSON.stringify({ detail: 'Invalid API key' }) }), head: /^无权限：Jev 拒绝了密钥（HTTP 401，unauthorized）.*JEV_API_KEY/s, code: 'unauthorized' },
      { name: 'service error echoing the key', script: () => ({ status: 500, body: `upstream said Bearer ${WIRE_KEY}` }), head: /^暂时不可用：Jev 暂时不可用（HTTP 500，invalid_response）：Jev 的应答里出现了 API 密钥/, code: 'invalid_response' },
      { name: 'connection lost with the key in its message', script: () => Object.assign(new Error(`socket hang up ${WIRE_KEY}`), { code: 'ECONNRESET' }), head: /^暂时不可用：Jev 暂时不可用（connection_lost）/, code: 'connection_lost' },
      { name: 'answer of another shape', script: () => ({ status: 200, body: JSON.stringify({ model: JEV_WIRE_VERSION, answers: { q1: { type: 'choice', choice: 'x', probabilities: { x: 1 }, confidence: 1 } }, usage: { input_tokens: 1, output_tokens: 1 } }) }), head: /^暂时不可用：Jev 暂时不可用（HTTP 200，invalid_response）/, code: 'invalid_response' },
    ];
    for (const [index, failing] of cases.entries()) {
      const wire = jevWire(failing.script);
      const audit = join(w.dir, `audit-${index}.jsonl`);
      const res = await runCmdVerifyPlumb(jevArgs(w.file, w.dir, ['--audit-out', audit]), { stdinText: `${WIRE_KEY}\n`, jevTransport: wire.transport });
      assert.equal(res.code, 1, failing.name);
      assert.equal(res.stdout, '', `${failing.name}: no report is written when Jev did not answer`);
      assert.match(res.stderr, failing.head, failing.name);
      assert.equal(wire.calls.length, 1, `${failing.name}: the first failure stops the others and nothing is sent again`);
      const logged = (await readFile(audit, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { error_code: string | null; question_types: string[] });
      assert.deepEqual(logged.map((line) => [line.error_code, line.question_types]), [[failing.code, ['noul']]], failing.name);
      const call = wire.calls[0]!;
      const state = call.sent.state as { context: string; command: string };
      for (const text of [res.stderr, await readFile(audit, 'utf8')]) {
        assert.ok(!text.includes(WIRE_KEY), `${failing.name}: the key is not shown`);
        for (const form of [...textForms(state.context), state.command, call.text]) assert.ok(!text.includes(form), `${failing.name}: the state text is not shown`);
      }
    }
    // A key that cannot go into a header is refused by the client before anything is sent, and no text shows it.
    const idle = jevWire();
    const bad = await runCmdVerifyPlumb(jevArgs(w.file, w.dir), { stdinText: 'bad key!\n', jevTransport: idle.transport });
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /^无权限：Jev 密钥照现在的写法用不了（密钥为空、太长或含不允许的字符），没有发出任何请求（invalid_key）/);
    assert.doesNotMatch(bad.stderr, /拒绝了密钥/);
    assert.ok(!bad.stderr.includes('bad key!'));
    assert.equal(idle.calls.length, 0);
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

// ---- the size of a Jev state: its own budget, not the 1800 that the Plumb gateway reads ----

const WIDE_STEP = '健康检查间隔的说明';

test('--judge jev: a context over the 1800 of Plumb and under the Jev budget is asked whole, and the same plan is refused for Plumb at 1800', async () => {
  const description = WIDE_STEP.repeat(400);
  const w = await frozenWorkspace([seat('widget health interval 60', description)]);
  try {
    const wire = jevWire();
    const res = await runCmdVerifyPlumb(jevArgs(w.file, w.dir), { stdinText: `${WIRE_KEY}\n`, jevTransport: wire.transport });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(wire.calls.length, 1);
    const state = wire.calls[0]!.sent.state as { context: string; command: string };
    assert.ok(state.context.includes(description), 'the whole description of the step is in the context');
    const size = estimateTokens(state.context) + estimateTokens(state.command);
    assert.ok(size > 1800 && size < JEV_STATE_BUDGET_EST_TOKENS, `the state is ${size} estimated tokens`);
    assert.equal(JSON.parse(res.stdout).results[0].steps[0].earlier_steps_shortened, undefined);

    const plumb = await runCmdVerifyPlumb(['--file', w.file, '--run', w.dir, '--base-url', baseUrl, '--key-stdin'], KEY);
    assert.equal(plumb.code, 1);
    assert.match(plumb.stderr, /^参数无效：以下命令上下文超过 Plumb @1800 token 上限，拒绝截断并停用：.*00\.json:\/steps\/0\(\d+ tokens\)/su);
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('--judge jev: a context of about thirty thousand estimated tokens is still asked whole', async () => {
  const description = WIDE_STEP.repeat(3300);
  const w = await frozenWorkspace([seat('widget health interval 60', description)]);
  try {
    const wire = jevWire();
    const res = await runCmdVerifyPlumb(jevArgs(w.file, w.dir), { stdinText: `${WIRE_KEY}\n`, jevTransport: wire.transport });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(wire.calls.length, 1);
    const state = wire.calls[0]!.sent.state as { context: string; command: string };
    assert.ok(state.context.includes(description));
    const size = estimateTokens(state.context) + estimateTokens(state.command);
    assert.ok(size > 29000 && size < JEV_STATE_BUDGET_EST_TOKENS, `the state is ${size} estimated tokens`);
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('--judge jev: a context over the Jev budget is refused as it always was, under the Jev wording, and nothing is sent', async () => {
  const w = await frozenWorkspace([VALID[0]!, seat('widget health interval 61', WIDE_STEP.repeat(4000))]);
  try {
    const wire = jevWire();
    const res = await runCmdVerifyPlumb(jevArgs(w.file, w.dir), { stdinText: `${WIRE_KEY}\n`, jevTransport: wire.transport });
    assert.equal(res.code, 1);
    assert.equal(res.stdout, '');
    assert.match(res.stderr, /^参数无效：以下命令上下文超过给 Jev 的题面预算（32768 个估算 token，取自 InfoTest 给 Jev 题面定的预算，不是实测的服务上限），拒绝截断并停用：.*00\.json:\/steps\/1\(\d+ tokens\)。请拆短单步命令列表或精简当前步骤描述/su);
    assert.doesNotMatch(res.stderr, /@1800|与给 Plumb 的相同/u);
    assert.equal(wire.calls.length, 0, 'nothing is asked of a service when a context is refused');
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('--judge jev: a question the service refuses for its size is asked again with a fifth less of its characters, measured against the Jev budget and not cut down to the 1800 of Plumb', async () => {
  // Four hundred valid steps: the last ones have thousands of tokens of earlier steps in their context, far over what Plumb reads.
  const w = await frozenWorkspace(Array.from({ length: 400 }, (_, k) => seat(k % 2 === 0 ? 'widget health interval 60' : 'widget health interval 61', `配置第 ${k + 1} 组间隔`)));
  try {
    const contextOf = (call: { sent: { state: unknown } }): string => (call.sent.state as { context: string }).context;
    const stepOf = (context: string): number => Number(/步骤意图: 配置第 (\d+) 组间隔/u.exec(context)![1]);
    let limit = Number.MAX_SAFE_INTEGER;
    const script: Parameters<typeof jevWire>[0] = (question, call) => (contextOf(call).length > limit ? { status: 413, body: 'too large' } : validAnswer(question));
    const first = jevWire(script);
    // The tree of this fixture lets a plan call the command ten times, so it blocks the later steps and the tool ends with code 1; what is asked of Jev
    // and what the report says about the steps is the same, and that is what is looked at here.
    const whole = await runCmdVerifyPlumb(jevArgs(w.file, w.dir), { stdinText: `${WIRE_KEY}\n`, jevTransport: first.transport });
    assert.equal(whole.code, 1);
    assert.match(JSON.parse(whole.stdout).results[0].steps[399].tree_check.problems[0].message, /超过声明预算 10 次/u);
    const lengths = new Map(first.calls.map((call) => [stepOf(contextOf(call)), contextOf(call).length]));
    assert.equal(lengths.size, 400);
    const wholeTokens = estimateTokens(first.calls.map(contextOf).find((context) => stepOf(context) === 400)!);
    assert.ok(wholeTokens > 1800 * 1.5, `the last step is ${wholeTokens} estimated tokens: far over what Plumb reads`);

    limit = lengths.get(399)!;   // the last step is refused whole, the one before it is not
    const second = jevWire(script);
    const res = await runCmdVerifyPlumb(jevArgs(w.file, w.dir), { stdinText: `${WIRE_KEY}\n`, jevTransport: second.transport });
    assert.equal(res.code, 1);
    const steps = JSON.parse(res.stdout).results[0].steps as Array<Record<string, unknown>>;
    assert.deepEqual(steps.map((step) => step.earlier_steps_shortened === true), [...Array.from({ length: 399 }, () => false), true]);
    const ofLast = second.calls.map(contextOf).filter((context) => stepOf(context) === 400);
    assert.equal(ofLast.length, 2, 'the whole one, refused, and the shortened one');
    const [refused, again] = ofLast as [string, string];
    assert.equal(refused.length, lengths.get(400));
    assert.ok(again.length <= Math.floor(lengths.get(400)! * 0.8), 'a fifth less of the characters at most');
    assert.ok(estimateTokens(again) > 1800 * 1.3, `the shortened context is still ${estimateTokens(again)} estimated tokens: it was cut by a fifth, not down to what Plumb reads`);
    assert.match(again, /\[已执行的步骤\]\n（前面 \d+ 步已省略）\n\d+\. widget health interval 6[01]\n/u);
    assert.ok((again.match(/^\d+\. widget health interval/gmu) ?? []).length > 300, 'most of the earlier steps stay');
    assert.match(again, /\[当前步骤\]\n步骤位置: \/steps\/399\n步骤意图: 配置第 400 组间隔\n候选命令: widget health interval 61$/u, 'the step itself is whole');
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});
