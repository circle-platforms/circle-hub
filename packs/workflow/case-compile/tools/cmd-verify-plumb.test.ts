// Unit tests for post-write cmd-verify-plumb (single_cmd_judge/steplist_judge, @1800 budget, reject/review gates, fail-closed HTTP).
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { knowledgeFiles } from '../functions/generated/skills/run-tools/hub-client/index.ts';
import { runCmdVerifyPlumb } from './cmd-verify-plumb.ts';

const RUN = 'run_01aaaaaaaaaaaaaaaaaaaaaaaa';
const ROOT = 'a'.repeat(64);

let stubMode: 'pass' | 'review' | 'reject' | 'mismatch_no' | 'service_down' | 'too_large' = 'pass';
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
      const isNo = stubMode === 'reject' || stubMode === 'mismatch_no';
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
          action: stubMode === 'reject' ? 'reject' : stubMode === 'review' ? 'review' : 'pass',
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

// The step intent Plumb is told: the author's own words for what a step realizes (author_step_refs are the ids of the action atoms
// of the frozen recomposition record), never the mind-map step at the same position, which says nothing about the command.
const INTENT_ITEM = 'doc:intent';
const MIND_MAP = ['MM步骤一：接口未配置', 'MM步骤二：配置地址', 'MM步骤三：查看接口'];
const A2 = '配置接口 eth0 地址为 192.0.2.10/24';
const A3_AUTHOR = '启用接口';
const A3_ADAPTED = '启用接口 eth0（本环境的接口名）';
const CASE_TITLE = '接口地址与启用';
const RECOMPOSITION = {
  record: {
    schema: 'recompose-record@1',
    contract: { intent: { text: CASE_TITLE } },
    atoms: [
      { id: 'a1', kind: 'intent', text: CASE_TITLE },
      { id: 'a2', kind: 'action', text: A2 },
      { id: 'a3', kind: 'action', text: A3_AUTHOR },
      { id: 'a4', kind: 'action', text: '查看接口状态' },
      { id: 'a5', kind: 'expectation', text: '接口状态为 up' },
    ],
    ledgers: {
      original: [{ atom: 'a2', text: A2 }, { atom: 'a3', text: A3_AUTHOR }, { atom: 'a4', text: '查看接口状态' }],
      adapted: [{ atom: 'a3', action: 'parameter_change', text: A3_ADAPTED, commands: ['no shutdown'], equivalence_reason: '合成依据：换成本环境的接口名' }],
      concretizations: [],
      rebindings: [],
    },
  },
};

async function setupIntentWorkspace() {
  const w = await setupWorkspace();
  await writeFile(join(w.dir, 'items', '10.json'), JSON.stringify({
    id: INTENT_ITEM,
    fields: {
      autoid: 'C1',
      title: CASE_TITLE,
      path: ['网络配置', '接口', CASE_TITLE],
      steps: MIND_MAP.map((text) => ({ text, expected: [] })),
      recomposition: RECOMPOSITION,
    },
  }));
  const write = async (name: string, data: Record<string, unknown>) => {
    const file = join(w.plans, name);
    await writeFile(file, JSON.stringify({ item: INTENT_ITEM, handling: 'handled', slots: { plan: [{ text: 'plan', quotes: [], data }] } }));
    return file;
  };
  return { ...w, write };
}

const config = (id: string, command: string, refs?: string[]) => ({
  id,
  kind: 'CONFIG',
  call: { object: 'dut0', method: 'cmd_config', args: [command], keywords: {} },
  ...(refs ? { author_step_refs: refs } : {}),
});
const flat = (command: string, extra: Record<string, unknown> = {}) => ({ object: 'dut0', method: 'cmd_config', args: [command], keywords: {}, ...extra });

/** Every question Plumb was asked, in step order, with the 步骤位置 and 步骤意图 lines of its state (or the node title). */
function askedSteps(): Array<{ qid: string; pointer: string | null; intent: string | null; question: Record<string, any> }> {
  const questions = seenBatches.flatMap((batch) => Object.entries((batch as { questions: Record<string, Record<string, any>> }).questions));
  return questions
    .sort(([a], [b]) => Number(a.split(':')[1]) - Number(b.split(':')[1]))
    .map(([qid, question]) => ({
      qid,
      pointer: /^步骤位置: (.+)$/mu.exec(question.state ?? '')?.[1] ?? null,
      intent: /^步骤意图: (.+)$/mu.exec(question.state ?? '')?.[1] ?? question.node?.title ?? null,
      question,
    }));
}

const BLOCK_PLAN = {
  bucket: 'bed-0',
  replacements: [],
  steps: [],
  expects: [],
  blocks: [
    config('c_first', 'ip address 192.0.2.10/24'),
    config('c_addr', 'ip address 192.0.2.10/24', ['a2']),
    config('c_up', 'no shutdown', ['a3']),
    config('c_both', 'ip address 192.0.2.11/24', ['a3', 'a2']),
    config('c_unknown', 'no shutdown', ['a9']),
    config('c_expectation', 'no shutdown', ['a5']),
    config('c_numeric', 'no shutdown', ['1']),
    config('c_partial', 'ip address 192.0.2.12/24', ['a2', 'a9']),
    config('c_repeat', 'ip address 192.0.2.13/24', ['a2', 'a2']),
    config('c_list', 'ip address 192.0.2.14/24\nno shutdown', ['a3']),
  ],
};

test('a block takes the text of the author steps it references, in the order written, the adapted text where the recomposition adapted it', async () => {
  const w = await setupIntentWorkspace();
  try {
    stubMode = 'pass';
    seenBatches.length = 0;
    const file = await w.write('20-blocks.json', BLOCK_PLAN);
    const res = await runCmdVerifyPlumb(['--file', file, '--run', w.dir, '--base-url', baseUrl, '--no-cache', '--key-stdin'], { stdinText: 'plumb_sk_intent\n' });
    assert.equal(res.code, 0, res.stderr);
    const asked = askedSteps();
    assert.deepEqual(asked.map((a) => a.pointer), BLOCK_PLAN.blocks.map((_, i) => `/blocks/${i}/call`));
    assert.deepEqual(asked.map((a) => a.intent), [
      CASE_TITLE, // no references: the case title, not the mind-map step at position 0
      A2,
      A3_ADAPTED,
      `${A3_ADAPTED}；${A2}`, // the order of the references, not of the record
      CASE_TITLE, // a9 is no author step of this case
      CASE_TITLE, // a5 is an expectation, not an author step
      CASE_TITLE, // "1" is a position, not an author step id
      A2, // a9 contributes nothing, a2 stays
      A2, // the same step referenced twice is named once
      A3_ADAPTED, // a list of commands is asked about with the same intent
    ]);
    assert.equal(asked[9]!.question.task, 'steplist_judge');
    for (const a of asked) assert.ok(!MIND_MAP.some((text) => a.question.state.includes(text)), `${a.pointer} borrowed a mind-map step by position`);
    // Only the intent line differs from what was always sent: the case, the steps executed before, the candidate and the definition.
    assert.equal(asked[1]!.question.state, [
      `[用例]\n${CASE_TITLE}`,
      '[已执行的步骤]\n1. ip address 192.0.2.10/24',
      `[当前步骤]\n步骤位置: /blocks/1/call\n步骤意图: ${A2}\n候选命令: ip address 192.0.2.10/24`,
    ].join('\n\n'));
    assert.equal(asked[1]!.question.command, 'ip address 192.0.2.10/24');
    assert.match(asked[1]!.question.definition, /^ip address <ip:ipv4> <mask:ipv4>/u);
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('the report names the intent each step was given and where it came from, and says so when a block has only the case title', async () => {
  const w = await setupIntentWorkspace();
  try {
    stubMode = 'pass';
    seenBatches.length = 0;
    const file = await w.write('21-blocks.json', BLOCK_PLAN);
    const res = await runCmdVerifyPlumb(['--file', file, '--run', w.dir, '--base-url', baseUrl, '--no-cache', '--key-stdin'], { stdinText: 'plumb_sk_intent\n' });
    assert.equal(res.code, 0, res.stderr);
    const steps = JSON.parse(res.stdout).results[0].steps as Array<{ pointer: string; intent: string; intent_source: string; disclosure: string }>;
    const asked = askedSteps();
    assert.deepEqual(steps.map((s) => s.intent), asked.map((a) => a.intent), 'the report states the intent line that was sent');
    assert.deepEqual(steps.map((s) => s.intent_source), ['case_title', 'author_steps', 'author_steps', 'author_steps', 'case_title', 'case_title', 'case_title', 'author_steps', 'author_steps', 'author_steps']);
    assert.match(steps[0]!.disclosure, /用例标题/u);
    assert.match(steps[0]!.disclosure, /没有写 author_step_refs/u);
    assert.match(steps[0]!.disclosure, /块计划不按位置借用脑图步骤/u);
    assert.equal(steps[1]!.disclosure, '步骤意图取自作者步骤 a2');
    assert.equal(steps[2]!.disclosure, '步骤意图取自作者步骤 a3（取适配后的写法）', 'the adapted text is named as such');
    assert.equal(steps[3]!.disclosure, '步骤意图取自作者步骤 a3（取适配后的写法）、a2', 'in the order of the references');
    assert.match(steps[4]!.disclosure, /a9 不是本用例的作者步骤编号/u);
    assert.match(steps[4]!.disclosure, /用例标题/u);
    assert.match(steps[5]!.disclosure, /a5 不是本用例的作者步骤编号/u);
    assert.match(steps[6]!.disclosure, /1 不是本用例的作者步骤编号/u);
    assert.equal(steps[7]!.disclosure, '步骤意图取自作者步骤 a2；author_step_refs 里的 a9 不是本用例的作者步骤编号（本用例的作者步骤编号：a2、a3、a4），没有采用');
    assert.ok(!/用例标题/u.test(steps[7]!.disclosure), 'a step with an author step does not claim the case title');
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('a sequential plan keeps its description, the mind-map step at the same position and the case title when it references no author step', async () => {
  const w = await setupIntentWorkspace();
  try {
    stubMode = 'pass';
    seenBatches.length = 0;
    const file = await w.write('22-flat.json', {
      bucket: 'bed-0',
      blocks: [],
      replacements: [],
      expects: [],
      steps: [
        flat('ip address 192.0.2.10/24', { description: '步骤上写的说明' }),
        flat('ip address 192.0.2.11/24'),
        flat('no shutdown'),
        flat('ip address 192.0.2.12/24'),
        flat('ip address 192.0.2.13/24', { description: '引用了不存在的作者步骤', author_step_refs: ['a9'] }),
      ],
    });
    const res = await runCmdVerifyPlumb(['--file', file, '--run', w.dir, '--base-url', baseUrl, '--no-cache', '--key-stdin'], { stdinText: 'plumb_sk_intent\n' });
    assert.equal(res.code, 0, res.stderr);
    assert.deepEqual(askedSteps().map((a) => a.intent), ['步骤上写的说明', MIND_MAP[1], MIND_MAP[2], CASE_TITLE, '引用了不存在的作者步骤']);
    const steps = JSON.parse(res.stdout).results[0].steps as Array<{ intent_source: string; disclosure: string }>;
    assert.deepEqual(steps.map((s) => s.intent_source), ['description', 'mindmap_position', 'mindmap_position', 'case_title', 'description']);
    assert.match(steps[1]!.disclosure, /脑图里同一序号的步骤/u);
    assert.match(steps[3]!.disclosure, /用例标题/u);
    assert.match(steps[4]!.disclosure, /a9 不是本用例的作者步骤编号/u);
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('a sequential step that references author steps takes their text instead of its own description', async () => {
  const w = await setupIntentWorkspace();
  try {
    stubMode = 'pass';
    seenBatches.length = 0;
    const file = await w.write('23-flat-refs.json', {
      bucket: 'bed-0',
      blocks: [],
      replacements: [],
      expects: [],
      steps: [
        flat('no shutdown', { description: '步骤上写的说明', author_step_refs: ['a3'] }),
        flat('ip address 192.0.2.11/24', { author_step_refs: ['a2', 'a3'] }),
      ],
    });
    const res = await runCmdVerifyPlumb(['--file', file, '--run', w.dir, '--base-url', baseUrl, '--no-cache', '--key-stdin'], { stdinText: 'plumb_sk_intent\n' });
    assert.equal(res.code, 0, res.stderr);
    assert.deepEqual(askedSteps().map((a) => a.intent), [A3_ADAPTED, `${A2}；${A3_ADAPTED}`]);
    assert.deepEqual((JSON.parse(res.stdout).results[0].steps as Array<{ intent_source: string }>).map((s) => s.intent_source), ['author_steps', 'author_steps']);
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('the node context carries the same intent as its title', async () => {
  const w = await setupIntentWorkspace();
  try {
    stubMode = 'pass';
    seenBatches.length = 0;
    const file = await w.write('24-node.json', BLOCK_PLAN);
    const res = await runCmdVerifyPlumb(['--file', file, '--run', w.dir, '--context-mode', 'node', '--base-url', baseUrl, '--no-cache', '--key-stdin'], { stdinText: 'plumb_sk_intent\n' });
    assert.equal(res.code, 0, res.stderr);
    const asked = askedSteps();
    assert.deepEqual(asked.map((a) => a.intent), [CASE_TITLE, A2, A3_ADAPTED, `${A3_ADAPTED}；${A2}`, CASE_TITLE, CASE_TITLE, CASE_TITLE, A2, A2, A3_ADAPTED]);
    assert.ok(asked.every((a) => a.question.state === undefined && a.question.node.line === 'synth-switch'), 'one context form per question, the product line unchanged');
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('a step whose references are no author steps of the case has the same intent whether the case has a recomposition record or none', async () => {
  const w = await setupIntentWorkspace();
  try {
    stubMode = 'pass';
    seenBatches.length = 0;
    await writeFile(join(w.dir, 'items', '11.json'), JSON.stringify({ id: 'doc:plain', fields: { title: '没有重组记录的用例', steps: [{ text: '脑图第一步' }] } }));
    const file = join(w.plans, '25-no-record.json');
    await writeFile(file, JSON.stringify({
      item: 'doc:plain',
      handling: 'handled',
      slots: { plan: [{ text: 'plan', quotes: [], data: { bucket: 'bed-0', replacements: [], steps: [], expects: [], blocks: [config('c_one', 'no shutdown', ['a2']), config('c_two', 'no shutdown')] } }] },
    }));
    const res = await runCmdVerifyPlumb(['--file', file, '--run', w.dir, '--base-url', baseUrl, '--no-cache', '--key-stdin'], { stdinText: 'plumb_sk_intent\n' });
    assert.equal(res.code, 0, res.stderr);
    assert.deepEqual(askedSteps().map((a) => a.intent), ['没有重组记录的用例', '没有重组记录的用例']);
    const steps = JSON.parse(res.stdout).results[0].steps as Array<{ disclosure: string }>;
    assert.match(steps[0]!.disclosure, /a2 不是本用例的作者步骤编号（本用例没有可对照的作者步骤）/u);
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('an author step too long for the 1800-token budget is refused with the way out, never cut, and nothing is sent to Plumb', async () => {
  const w = await setupIntentWorkspace();
  try {
    stubMode = 'pass';
    seenBatches.length = 0;
    await writeFile(join(w.dir, 'items', '12.json'), JSON.stringify({
      id: 'doc:long',
      fields: {
        title: CASE_TITLE,
        steps: [],
        recomposition: { record: { atoms: [{ id: 'a2', kind: 'action', text: '长'.repeat(1900) }], ledgers: { original: [], adapted: [] } } },
      },
    }));
    const file = join(w.plans, '26-long.json');
    await writeFile(file, JSON.stringify({
      item: 'doc:long',
      handling: 'handled',
      slots: { plan: [{ text: 'plan', quotes: [], data: { bucket: 'bed-0', replacements: [], steps: [], expects: [], blocks: [config('c_long', 'ip address 192.0.2.10/24', ['a2'])] } }] },
    }));
    const res = await runCmdVerifyPlumb(['--file', file, '--run', w.dir, '--base-url', baseUrl, '--no-cache', '--key-stdin'], { stdinText: 'plumb_sk_intent\n' });
    assert.equal(res.code, 1);
    assert.match(res.stderr, /^参数无效：.*超过 Plumb @1800 token 上限，拒绝截断并停用：.*26-long\.json:\/blocks\/0\/call/u);
    assert.match(res.stderr, /少引用几条作者步骤（author_step_refs）/u);
    assert.equal(seenBatches.length, 0);
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});
