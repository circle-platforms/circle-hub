// Unit tests for pre-write cmd-select-plumb (tournament choice <=25, no definition/state mixup, gate & HTTP handling).
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { knowledgeFiles } from '../functions/knowledge-text.ts';
import { CMD_CANDIDATES_SCHEMA, runCmdSelectPlumb } from './cmd-select-plumb.ts';

const RUN = 'run_01aaaaaaaaaaaaaaaaaaaaaaaa';
const ROOT = 'a'.repeat(64);

let stubMode: 'pass' | 'review' | 'reject' | 'none' | 'service_down' | 'too_large' | 'gateway_budget' = 'pass';
const seenRequests: Array<Record<string, unknown>> = [];
const GATEWAY_MAX_PAIRS = 256;

/** What the gateway charges a choice question on a model with a none threshold: its candidates, less the single none option. */
function chargedPairs(question: { candidates?: Array<{ name: string }> }): number {
  const names = (question.candidates ?? []).map((c) => c.name);
  return names.length >= 2 && names.filter((n) => n === '都不是').length === 1 ? names.length - 1 : names.length;
}

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
      res.end(JSON.stringify({ error: { type: 'payload_too_large', message: '请求超过限制' } }));
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      questions?: Record<string, { task?: string; node?: Record<string, unknown>; state?: string; definition?: string; candidates?: Array<{ name: string; text: string }> }>;
    };
    seenRequests.push(body as unknown as Record<string, unknown>);
    if (stubMode === 'gateway_budget') {
      // execute_judge: one pair budget for the whole request, spent by its questions in order.
      let remaining = GATEWAY_MAX_PAIRS;
      for (const q of Object.values(body.questions ?? {})) {
        const cost = chargedPairs(q);
        if (cost > remaining) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'request_too_large', message: `Compiled judge pairs (${cost}) exceed limit (${remaining})`, retryable: false } }));
          return;
        }
        remaining -= cost;
      }
    }
    const answers: Record<string, unknown> = {};
    for (const [qid, q] of Object.entries(body.questions ?? {})) {
      assert.equal(q.task, 'choice');
      assert.equal(q.definition, undefined, 'choice request must NEVER include definition');
      assert.equal(q.state, undefined, 'choice request must NEVER send state alongside node');
      assert.ok(q.node && typeof q.node.line === 'string' && q.node.line.length > 0, 'node.line must be non-empty');
      assert.ok(Array.isArray(q.candidates) && q.candidates.length >= 2 && q.candidates.length <= 25);

      const names = q.candidates.map((c) => c.name);
      let picked = names[0]!;
      if (stubMode === 'none') {
        picked = '都不是';
      } else if (names.includes('ip address')) {
        picked = 'ip address';
      } else if (names.includes('widget cmd-10')) {
        picked = 'widget cmd-10';
      }

      answers[qid] = {
        status: '未确认',
        decided_by: '模型',
        model_version: 'plumb-27b-0.5.0',
        answer: {
          type: 'choice',
          value: picked,
          confidence: stubMode === 'reject' ? 0.25 : stubMode === 'review' ? 0.62 : 0.93,
          probabilities: { [picked]: 0.93, 都不是: 0.07 },
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
      task: 'choice',
      request_id: `req-${seenRequests.length}`,
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

function buildBatch(cmdCount = 35): Buffer {
  const rows: Array<{ path: string; children: string[]; statements: Array<[string, string]> }> = [
    { path: '/', children: ['commands'], statements: [] },
    { path: '/commands', children: ['widget', 'ip'], statements: [] },
    {
      path: '/commands/ip',
      children: ['address'],
      statements: [],
    },
    {
      path: '/commands/ip/address',
      children: [],
      statements: [['definition', 'ip address <ip:ipv4> <mask:ipv4>\n  配置接口 IPv4 地址，属于 widget 合成组网步骤']],
    },
    {
      path: '/commands/widget',
      children: Array.from({ length: cmdCount }, (_, i) => `cmd-${String(i).padStart(2, '0')}`),
      statements: [],
    },
  ];
  for (let i = 0; i < cmdCount; i += 1) {
    const name = `cmd-${String(i).padStart(2, '0')}`;
    rows.push({
      path: `/commands/widget/${name}`,
      children: [],
      statements: [['definition', `widget ${name} <v:int>\n  合成 widget 测试命令 ${i}`]],
    });
  }
  const nodes = rows.map((r, idx) => ({
    path: r.path,
    reference: `tree:${ROOT}${r.path}`,
    name: r.path.split('/').at(-1),
    level: r.children.length ? 'branch' : 'leaf',
    digest: String(idx + 1).padStart(64, '0'),
    children: r.children.map((c, j) => ({ name: c, path: `${r.path === '/' ? '' : r.path}/${c}`, digest: String(idx * 100 + j).padStart(64, '0') })),
    entries: r.statements.map(([kind, statement], k) => ({
      entry: String(k + 100).padStart(64, 'a'),
      kind,
      statement,
      reference: `tree:${ROOT}${r.path}@${String(k + 100).padStart(64, 'a')}`,
    })),
  }));
  const head = { schema: 'run-knowledge@1', run: RUN, root: ROOT, composition: null, nodes: nodes.length, entries: nodes.length };
  return Buffer.from([head, ...nodes].map((n) => JSON.stringify(n)).join('\n') + '\n');
}

async function setupRunDir(cmdCount = 35, stepCount = 1): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cc-cmd-select-'));
  for (const { name, bytes } of knowledgeFiles(buildBatch(cmdCount), RUN).outputs) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), bytes);
  }
  await writeFile(join(dir, 'run.json'), JSON.stringify({
    run: RUN,
    product: 'synth-firewall',
    version: '1.0',
    build: 'b1',
  }));
  await mkdir(join(dir, 'items'));
  await writeFile(join(dir, 'items', '00.json'), JSON.stringify({
    id: 'doc:c-0',
    fields: {
      autoid: 'C0',
      title: '配置接口与组件',
      path: ['网络配置', '接口管理', '配置接口与组件'],
      steps: Array.from({ length: stepCount }, (_, i) => ({ text: i === 0 ? '为 widget 设置 ip address 192.0.2.10/24' : `为 widget 设置第 ${i + 1} 项 ip address 192.0.2.${10 + i}/24` })),
    },
  }));
  return dir;
}

test('cmd-select-plumb performs <=25 two-stage choice elimination and writes disclosed candidate file', async () => {
  const dir = await setupRunDir(35); // 36 recalled candidates -> Stage 1 (24 + 12) + Stage 2
  try {
    stubMode = 'pass';
    seenRequests.length = 0;
    const res = await runCmdSelectPlumb(
      ['--run', dir, '--base-url', baseUrl, '--no-cache', '--key-stdin'],
      { stdinText: 'plumb_sk_test_key\n' },
    );
    assert.equal(res.code, 0, res.stderr);
    assert.equal(seenRequests.length, 2, 'Stage 1 + Stage 2 tournament elimination expected');
    const summary = JSON.parse(res.stdout);
    assert.equal(summary.status, '未确认');
    assert.equal(summary.decided_by, '模型');
    assert.equal(summary.model_version, 'plumb-27b-0.5.0');

    const candDoc = JSON.parse(await readFile(join(dir, 'plumb', 'cmd_candidates', '00.json'), 'utf8'));
    assert.equal(candDoc.schema, CMD_CANDIDATES_SCHEMA);
    assert.equal(candDoc.status, '未确认');
    assert.equal(candDoc.decided_by, '模型');
    assert.equal(candDoc.steps[0].recalled_count, 36);
    assert.equal(candDoc.steps[0].selected.command, 'ip address');
    assert.equal(candDoc.steps[0].stages.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cmd-select-plumb takes the run directory as --run and refuses its run.json file with the one-line correct form before any call', async () => {
  const dir = await setupRunDir(1);
  try {
    stubMode = 'pass';
    seenRequests.length = 0;
    const file = join(dir, 'run.json');
    const refused = await runCmdSelectPlumb(['--run', file, '--base-url', baseUrl, '--no-cache', '--key-stdin'], { stdinText: 'plumb_sk_test_key\n' });
    assert.equal(refused.code, 1);
    assert.equal(refused.stdout, '');
    assert.ok(refused.stderr.startsWith(`参数无效：--run ${file} 不是普通目录。`), refused.stderr);
    assert.ok(refused.stderr.trimEnd().endsWith("合法写法：--run '<运行目录>'（放 run.json 的目录，不是 run.json 文件）。"), refused.stderr);
    assert.equal(refused.stderr.trim().split('\n').length, 1);
    assert.equal(seenRequests.length, 0, 'no question was asked of Plumb');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cmd-select-plumb handles review, strict-review, none, reject, and fail-closed HTTP errors', async () => {
  const dir = await setupRunDir(5);
  try {
    stubMode = 'review';
    const revOut = join(dir, 'rev');
    const revRes = await runCmdSelectPlumb(
      ['--run', dir, '--out-dir', revOut, '--base-url', baseUrl, '--no-cache'],
      { env: { ...process.env, PLUMB_API_KEY: 'plumb_sk_test_env' } },
    );
    assert.equal(revRes.code, 0, revRes.stderr);
    const revDoc = JSON.parse(await readFile(join(revOut, '00.json'), 'utf8'));
    assert.equal(revDoc.steps[0].review_required, true);
    assert.match(revDoc.steps[0].note, /\[需人工复核：Plumb choice 落入 review 区\]/);

    const strictRes = await runCmdSelectPlumb(
      ['--run', dir, '--out-dir', join(dir, 'strict'), '--base-url', baseUrl, '--no-cache', '--strict-review'],
      { env: { ...process.env, PLUMB_API_KEY: 'plumb_sk_test_env' } },
    );
    assert.equal(strictRes.code, 1);
    assert.match(strictRes.stderr, /--strict-review/);

    stubMode = 'reject';
    const rejOut = join(dir, 'rej');
    const rejRes = await runCmdSelectPlumb(
      ['--run', dir, '--out-dir', rejOut, '--base-url', baseUrl, '--no-cache'],
      { env: { ...process.env, PLUMB_API_KEY: 'plumb_sk_test_env' } },
    );
    assert.equal(rejRes.code, 0);
    const rejDoc = JSON.parse(await readFile(join(rejOut, '00.json'), 'utf8'));
    assert.equal(rejDoc.steps[0].rejected, true);
    assert.equal(rejDoc.steps[0].selected, null);

    stubMode = 'service_down';
    const downRes = await runCmdSelectPlumb(
      ['--run', dir, '--out-dir', join(dir, 'down'), '--base-url', baseUrl, '--no-cache'],
      { env: { ...process.env, PLUMB_API_KEY: 'plumb_sk_test_env' } },
    );
    assert.equal(downRes.code, 1);
    assert.match(downRes.stderr, /^暂时不可用：/);

    stubMode = 'too_large';
    const largeRes = await runCmdSelectPlumb(
      ['--run', dir, '--out-dir', join(dir, 'large'), '--base-url', baseUrl, '--no-cache'],
      { env: { ...process.env, PLUMB_API_KEY: 'plumb_sk_test_env' } },
    );
    assert.equal(largeRes.code, 1);
    assert.match(largeRes.stderr, /^参数无效：/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cmd-select-plumb sends no request that the gateway prices above its 256-pair budget when seven steps recall 40 commands each', async () => {
  const dir = await setupRunDir(60, 7); // each step recalls 40 commands: chunks of 24 and 16, 14 questions and 280 pairs for stage 1
  try {
    stubMode = 'gateway_budget';
    seenRequests.length = 0;
    const res = await runCmdSelectPlumb(
      ['--run', dir, '--base-url', baseUrl, '--no-cache', '--key-stdin'],
      { stdinText: 'plumb_sk_test_key\n' },
    );
    assert.equal(res.code, 0, res.stderr);
    const priced = seenRequests.map((r) => Object.values((r as { questions: Record<string, { candidates?: Array<{ name: string }> }> }).questions).reduce((n, q) => n + chargedPairs(q), 0));
    assert.ok(priced.length >= 3, 'stage 1 needs two requests, stage 2 one more');
    assert.ok(priced.every((pairs) => pairs <= GATEWAY_MAX_PAIRS), `requests priced at ${priced.join(', ')} pairs`);
    const doc = JSON.parse(await readFile(join(dir, 'plumb', 'cmd_candidates', '00.json'), 'utf8'));
    assert.equal(doc.steps.length, 7);
    assert.ok(doc.steps.every((step: { recalled_count: number }) => step.recalled_count === 40));
  } finally {
    stubMode = 'pass';
    await rm(dir, { recursive: true, force: true });
  }
});
