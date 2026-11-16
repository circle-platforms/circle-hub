// Unit tests for post-write cmd-verify-plumb (single_cmd_judge/steplist_judge, @1800 budget, reject/review gates, fail-closed HTTP).
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
/** When set, decides per question what the stub answers (a question is answered 'reject', 'review' or 'pass'); stubMode is the default. */
let decide: ((question: { command?: string; commands?: string[] }) => 'pass' | 'review' | 'reject') | null = null;
const seenBatches: Array<Record<string, unknown>> = [];

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

// ---------------------------------------------------------------------------------------------------------------------
// Round 34: a block plan had no description, so the tool took the intent of a block from the mind-map step at its position and
// Plumb refused commands the Hub accepted. InfoTest gives every block its own one line (desc) and judges commands by program only.
// ---------------------------------------------------------------------------------------------------------------------
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
    // What Plumb is asked, first: the intent line of each question.
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

/** A run as the download leaves it, frozen as the Hub freezes it: a plan can be checked against its command tree here. */
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
/** Resolved by the tree, but the contract does not allow this value: the program refuses it whatever the catalog's completeness. */
const REFUSED = seat('widget health interval 62', '把健康检查间隔设成 62');
/** Not a command of the tree. A download carries no word on whether the catalog is complete, so the tree cannot call it a refusal. */
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

    // Plumb passing a command the program refuses does not let it through either: the tree decides.
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
