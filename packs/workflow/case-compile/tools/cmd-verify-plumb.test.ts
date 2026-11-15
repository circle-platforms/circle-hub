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
