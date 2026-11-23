import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readPackDirectory, validatePack } from '../../../../hub/runs/api.ts';
import { stagePack } from '../../../workflow/case-review/packaging.ts';
import { scanSkillPack } from '../../../../scripts/real/skill-script-safety.ts';
import type { PlumbTiming } from '../functions/modules/plumb-client/index.ts';
import { runPlumbCli } from './plumb.ts';

const PACK_DIR = fileURLToPath(new URL('../', import.meta.url));

describe('plumb CLI wrapper and security hygiene', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'plumb-cli-test-'));
  let statusCalls = 0;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ default_model: 'plumb-27b-0.5.0', models: [{ id: 'plumb-27b-0.5.0', released: false }] }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/status') {
        statusCalls += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: statusCalls >= 2 ? 'ready' : 'waking', serving_version: 'plumb-27b-0.5.0' }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/judge') {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          request_id: 'cli_req_1',
          status: '未确认',
          decided_by: '模型',
          model_version: 'plumb-27b-0.5.0',
          task: String(body.task ?? 'choice'),
          answer: { type: 'choice', choice: 'ip address', confidence: 0.91, probabilities: { 'ip address': 0.91, none: 0.09 } },
          gate: { action: 'review', calibrated: false },
        }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/keys/requests') {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ request_id: 'kr_001', claim_code: 'claim_secret_001', status: 'pending' }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/keys/requests/kr_001') {
        const code = req.headers['x-claim-code'];
        if (code !== 'claim_secret_001') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'invalid_claim_code', message: 'bad code' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ key_id: 'k_1', api_key: 'plumb_sk_claimed_1234', status: 'active' }));
        return;
      }
      res.writeHead(404);
      res.end('{}');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(workDir, { recursive: true, force: true });
  });

  it('refuses CLI --api-key, --claim-code, equals-joined options, and empty stdin', async () => {
    const errors: string[] = [];
    const code1 = await runPlumbCli(['models', '--base-url', baseUrl, '--api-key', 'plumb_sk_bad'], { stderr: (l) => errors.push(l) });
    assert.equal(code1, 1);
    assert.match(errors[0], /禁止通过命令行参数 --api-key 传入密钥/);

    errors.length = 0;
    const code2 = await runPlumbCli(['claim-key', '--request-id', 'kr_1', '--claim-code', 'c1'], { stderr: (l) => errors.push(l) });
    assert.equal(code2, 1);
    assert.match(errors[0], /禁止通过命令行参数 --claim-code 传入/);

    errors.length = 0;
    const code3 = await runPlumbCli(['models', `--base-url=${baseUrl}`], { stderr: (l) => errors.push(l) });
    assert.equal(code3, 1);
    assert.match(errors[0], /不允许使用 = 连接/);

    errors.length = 0;
    const code4 = await runPlumbCli(['models', '--base-url', baseUrl, '--key-stdin'], { stdinText: '\n', stderr: (l) => errors.push(l) });
    assert.equal(code4, 1);
    assert.match(errors[0], /标准输入首行为空/);
  });

  it('runs models, judge with --node-file/--candidates-file, and claim-key cleanly while writing --out audit', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const codeM = await runPlumbCli(['models', '--base-url', baseUrl, '--key-stdin'], {
      stdinText: 'plumb_sk_cli_secret_8888\n',
      stdout: (l) => stdout.push(l),
      stderr: (l) => stderr.push(l),
    });
    assert.equal(codeM, 0, stderr.join('\n'));
    assert.equal(JSON.parse(stdout[0]).default_model, 'plumb-27b-0.5.0');

    const nodeFile = join(workDir, 'node.json');
    const candsFile = join(workDir, 'cands.json');
    const auditFile = join(workDir, 'audit.jsonl');
    const resultOut = join(workDir, 'result.json');
    await writeFile(nodeFile, JSON.stringify({ line: 10, module: 'net', path: 'net/ip', title: 'set ip' }));
    await writeFile(candsFile, JSON.stringify([{ name: 'ip address', text: 'ip address <ip> <mask>' }, 'none']));

    stdout.length = 0;
    const codeJ = await runPlumbCli([
      'judge',
      '--base-url', baseUrl,
      '--task', 'choice',
      '--node-file', nodeFile,
      '--candidates-file', candsFile,
      '--out', auditFile,
      '--result-out', resultOut,
      '--key-stdin',
    ], {
      stdinText: 'plumb_sk_cli_secret_8888\n',
      stdout: (l) => stdout.push(l),
      stderr: (l) => stderr.push(l),
    });
    assert.equal(codeJ, 0, stderr.join('\n'));
    const parsedOut = JSON.parse(await readFile(resultOut, 'utf8')) as Record<string, unknown>;
    assert.equal(parsedOut.status, '未确认');
    assert.equal(parsedOut.decided_by, '模型');
    assert.ok(!(await readFile(auditFile, 'utf8')).includes('cli_secret_8888'));

    stdout.length = 0;
    const codeClaim = await runPlumbCli([
      'claim-key',
      '--base-url', baseUrl,
      '--request-id', 'kr_001',
      '--claim-code-stdin',
    ], {
      stdinText: 'claim_secret_001\n',
      stdout: (l) => stdout.push(l),
      stderr: (l) => stderr.push(l),
    });
    assert.equal(codeClaim, 0, stderr.join('\n'));
    assert.equal(JSON.parse(stdout[0]).key_id, 'k_1');
  });

  it('splits a judge --file batch that exceeds the gateway pair budget instead of sending it whole', async () => {
    const questions: Record<string, unknown> = {};
    for (let i = 0; i < 14; i += 1) {
      const count = i % 2 === 0 ? 24 : 16;
      questions[`q${i}`] = {
        task: 'choice',
        node: { line: 'synthetic', title: 'synthetic step' },
        candidates: [...Array.from({ length: count }, (_, k) => ({ name: `cmd ${k}`, text: 'syntax' })), { name: '都不是', text: '以上候选均不符合' }],
      };
    }
    const requestFile = join(workDir, 'big-batch.json');
    await writeFile(requestFile, JSON.stringify({ task: 'choice', questions }));
    const sizes: number[] = [];
    const batchServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { questions: Record<string, { candidates: Array<{ name: string }> }> };
        const priced = Object.values(body.questions).reduce((n, q) => n + q.candidates.length - 1, 0);
        sizes.push(priced);
        if (priced > 256) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'request_too_large', message: 'Compiled judge pairs (24) exceed limit (16)' } }));
          return;
        }
        const answers = Object.fromEntries(Object.entries(body.questions).map(([qid, q]) => [qid, { type: 'choice', choice: q.candidates[0]!.name, confidence: 0.9, probabilities: { [q.candidates[0]!.name]: 0.9, 都不是: 0.1 } }]));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: '未确认', decided_by: '模型', model_version: 'plumb-27b-0.5.0', task: 'choice', request_id: 'r', answers }));
      });
    });
    await new Promise<void>((resolve) => batchServer.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(batchServer.address() as AddressInfo).port}`;
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await runPlumbCli(['judge', '--base-url', url, '--file', requestFile, '--no-cache', '--key-stdin'], {
        stdinText: 'plumb_sk_cli_batch_1111\n',
        stdout: (l) => stdout.push(l),
        stderr: (l) => stderr.push(l),
      });
      assert.equal(code, 0, stderr.join('\n'));
      assert.equal(Object.keys(JSON.parse(stdout.join('\n')).answers).length, 14);
      assert.ok(sizes.length >= 2 && sizes.every((n) => n <= 256), `requests priced at ${sizes.join(', ')} pairs`);
    } finally {
      await new Promise<void>((resolve) => batchServer.close(() => resolve()));
    }
  });

  it('passes static skill-script safety scan and hub/runs/packs validatePack on staged copy', async () => {
    const safety = scanSkillPack(PACK_DIR);
    assert.deepEqual(safety.issues, [], JSON.stringify(safety.issues));
    assert.ok(safety.files >= 6);
    const stagedDir = join(workDir, 'staged-plumb');
    await stagePack(PACK_DIR, stagedDir);
    const readRes = await readPackDirectory(stagedDir);
    assert.equal(readRes.ok, true, JSON.stringify(readRes));
    if (!readRes.ok) throw new Error('unreachable');
    const validation = await validatePack(readRes.pack);
    assert.equal(validation.ok, true, JSON.stringify(validation));
  });
});

describe('plumb CLI wake --wait when the backend cannot be started', async () => {
  interface Answer {
    http: number;
    body: Record<string, unknown>;
  }
  let status: Answer = { http: 200, body: { status: 'down', backend_state: 'idle' } };
  let wake: Answer = { http: 200, body: { status: 'waking' } };
  let statusCalls = 0;
  let wakeCalls = 0;

  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      let answer: Answer = { http: 404, body: {} };
      if (req.method === 'GET' && path === '/v1/status') {
        statusCalls += 1;
        answer = status;
      } else if (req.method === 'POST' && path === '/v1/wake') {
        wakeCalls += 1;
        answer = wake;
      }
      res.writeHead(answer.http, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // A clock that moves only when the client pauses, so that sixty seconds of polls are counted instead of waited for.
  function virtualTiming(): PlumbTiming {
    let now = 1_700_000_000_000;
    return { now: () => now, pause: async (ms: number) => { now += ms; } };
  }

  async function wakeWait(): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    statusCalls = 0;
    wakeCalls = 0;
    const code = await runPlumbCli(['wake', '--wait', '--poll-sec', '5', '--timeout-sec', '720', '--base-url', baseUrl, '--key-stdin'], {
      stdinText: 'plumb_sk_cli_wake_0001\n',
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      timing: virtualTiming(),
    });
    return { code, stdout, stderr };
  }

  it('stops when every poll for sixty seconds after the wake shows the failure, and says why instead of waiting out the timeout', { timeout: 30_000 }, async () => {
    status = {
      http: 200,
      body: { status: 'down', backend_state: 'failed', phase: 'allocation', progress_message: 'allocation_failed (rc=1): synthetic scheduler said: Backend rejected accelerator request' },
    };
    wake = { http: 200, body: { status: 'waking' } };
    const { code, stdout, stderr } = await wakeWait();
    assert.equal(code, 1);
    assert.deepEqual(stdout, []);
    assert.equal(stderr.length, 1);
    assert.match(stderr[0], /^\[HTTP 503\/backend_failed\] 暂时不可用：Plumb 后端启动失败，网关报告：allocation_failed \(rc=1\): synthetic scheduler said: Backend rejected accelerator request。/);
    assert.match(stderr[0], /请联系 Plumb 管理员检查后端，不要再次唤醒。$/);
    assert.equal(wakeCalls, 1);
    assert.equal(statusCalls, 14, 'the status before the wake and thirteen polls, five seconds apart, from the first failed one to sixty seconds later');
  });

  it('does not tell the person to run wake --wait when the wake itself is refused with backend_down', { timeout: 30_000 }, async () => {
    status = { http: 200, body: { status: 'down', backend_state: 'idle' } };
    wake = { http: 503, body: { error: { type: 'backend_down', message: 'backend sleeping' } } };
    const { code, stderr } = await wakeWait();
    assert.equal(code, 1);
    assert.equal(stderr.length, 1);
    assert.match(stderr[0], /^\[HTTP 503\/backend_down\] /);
    assert.match(stderr[0], /请联系 Plumb 管理员检查后端。$/);
    assert.doesNotMatch(stderr[0], /plumb wake/);
  });
});
