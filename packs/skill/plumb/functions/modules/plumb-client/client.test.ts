import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  PlumbClient,
  PlumbHttpError,
  estimateTokens,
  normalizeJudgeAnswer,
  redactSecret,
  stableStringify,
  type PlumbBatchQuestion,
  type PlumbTiming,
} from './index.ts';

interface TempTlsPair {
  dir: string;
  caCertPath: string;
  caSha256: string;
  serverCert: string;
  serverKey: string;
}

async function createTempCaAndServerCert(): Promise<TempTlsPair> {
  const dir = await mkdtemp(join(tmpdir(), 'plumb-tls-'));
  const caKeyPath = join(dir, 'ca.key.pem');
  const caCertPath = join(dir, 'ca.crt.pem');
  const srvKeyPath = join(dir, 'server.key.pem');
  const srvCsrPath = join(dir, 'server.csr.pem');
  const srvCertPath = join(dir, 'server.crt.pem');
  const extPath = join(dir, 'ext.cnf');

  execFileSync(
    'openssl',
    [
      'req', '-x509', '-sha256', '-newkey', 'rsa:2048',
      '-nodes', '-days', '1', '-subj', '/CN=Plumb Test CA',
      '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
      '-keyout', caKeyPath, '-out', caCertPath,
    ],
    { stdio: 'ignore' },
  );
  execFileSync(
    'openssl',
    ['req', '-new', '-sha256', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', srvKeyPath, '-out', srvCsrPath],
    { stdio: 'ignore' },
  );
  await writeFile(extPath, 'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
  execFileSync(
    'openssl',
    ['x509', '-req', '-sha256', '-in', srvCsrPath, '-CA', caCertPath, '-CAkey', caKeyPath, '-CAcreateserial', '-out', srvCertPath, '-days', '1', '-extfile', extPath],
    { stdio: 'ignore' },
  );

  const caPem = await readFile(caCertPath, 'utf8');
  const caSha256 = new X509Certificate(caPem).fingerprint256.replace(/:/gu, '').toLowerCase();
  const [serverCert, serverKey] = await Promise.all([readFile(srvCertPath, 'utf8'), readFile(srvKeyPath, 'utf8')]);
  return { dir, caCertPath, caSha256, serverCert, serverKey };
}

describe('plumb-client pure utilities', () => {
  it('redacts secrets and computes deterministic canonical JSON and token estimates', () => {
    const raw = 'Authorization: Bearer plumb_sk_secret_123456 x-claim-code: claim_999';
    const clean = redactSecret(raw, ['claim_999']);
    assert.ok(!clean.includes('secret_123456'));
    assert.ok(!clean.includes('claim_999'));
    assert.equal(stableStringify({ b: 1, a: { y: 2, x: undefined } }), '{"a":{"y":2},"b":1}');
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens('中文ab'), Math.ceil(2 + 2 / 3.5));
  });

  it('rejects non-loopback plain HTTP URLs unless explicitly allowed', () => {
    assert.throws(() => new PlumbClient({ baseUrl: 'http://192.0.2.10:8443', apiKey: 'plumb_sk_test_0001' }), /无权限/);
    const localClient = new PlumbClient({ baseUrl: 'http://127.0.0.1:8089/', apiKey: 'plumb_sk_test_0001' });
    assert.equal(localClient.baseUrl, 'http://127.0.0.1:8089');
    const explicitInsecure = new PlumbClient({ baseUrl: 'http://192.0.2.10:8089', allowInsecureHttp: true });
    assert.equal(explicitInsecure.baseUrl, 'http://192.0.2.10:8089');
  });
});

describe('plumb-client HTTPS TLS pinning and request safety', async () => {
  const tls = await createTempCaAndServerCert();
  const workDir = await mkdtemp(join(tmpdir(), 'plumb-client-work-'));
  let mode: 'ok' | 'bad_disclosure' | 'backend_down' | 'get_flaky' = 'ok';
  let getAttempts = 0;
  let judgeCalls = 0;

  const server = https.createServer({ cert: tls.serverCert, key: tls.serverKey }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'https://127.0.0.1');
      if (url.pathname === '/v1/status') {
        getAttempts += 1;
        if (mode === 'get_flaky' && getAttempts === 1) {
          res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '0' });
          res.end(JSON.stringify({ error: { code: 'backend_busy', message: 'busy' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ready', serving_version: 'plumb-27b-0.5.0', released: false }));
        return;
      }
      if (url.pathname === '/v1/judge') {
        judgeCalls += 1;
        if (mode === 'backend_down') {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'backend_down', message: 'backend sleeping' } }));
          return;
        }
        if (mode === 'bad_disclosure') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: '已确认', decided_by: '人工', model_version: 'plumb-27b-0.5.0', answer: { type: 'binary', choice: '正确', confidence: 0.99 } }));
          return;
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        if (body.questions && typeof body.questions === 'object') {
          const answers: Record<string, unknown> = {};
          for (const qid of Object.keys(body.questions)) {
            answers[qid] = {
              type: 'binary',
              choice: '正确',
              confidence: 0.99,
              probabilities: { 正确: 0.99, 错误: 0.01 },
              gate: { action: 'pass', calibrated: true, threshold: 0.98, reject_threshold: 0.2 },
            };
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            request_id: `req_${judgeCalls}`,
            status: '未确认',
            decided_by: '模型',
            model_version: 'plumb-27b-0.5.0',
            task: String(body.task ?? 'match'),
            answers,
          }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          request_id: `req_${judgeCalls}`,
          status: '未确认',
          decided_by: '模型',
          model_version: 'plumb-27b-0.5.0',
          task: String(body.task ?? 'single_cmd_judge'),
          answer: { type: 'binary', choice: '正确', confidence: 0.992, probabilities: { 正确: 0.992, 错误: 0.008 } },
          gate: { action: 'pass', calibrated: true, threshold: 0.98, reject_threshold: 0.2 },
        }));
        return;
      }
      res.writeHead(404);
      res.end('{}');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `https://127.0.0.1:${port}`;

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tls.dir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  it('rejects untrusted CA, accepts matching CA and SHA-256 pin, and rejects wrong pin', async () => {
    const noCaClient = new PlumbClient({ baseUrl, apiKey: 'plumb_sk_secret_tls' });
    await assert.rejects(() => noCaClient.status(), (err: PlumbHttpError) => err.category === '无权限');

    const badPinClient = new PlumbClient({
      baseUrl,
      apiKey: 'plumb_sk_secret_tls',
      caFile: tls.caCertPath,
      caSha256: '0'.repeat(64),
    });
    await assert.rejects(() => badPinClient.status(), (err: PlumbHttpError) => err.code === 'ca_fingerprint_mismatch');

    const pinnedClient = new PlumbClient({
      baseUrl,
      apiKey: 'plumb_sk_secret_tls',
      caFile: tls.caCertPath,
      caSha256: tls.caSha256,
    });
    const st = await pinnedClient.status();
    assert.equal(st.status, 'ready');
    assert.equal(st.serving_version, 'plumb-27b-0.5.0');
  });

  it('caches judge responses, logs redacted JSONL audit, and refuses forged disclosure', async () => {
    mode = 'ok';
    judgeCalls = 0;
    const cacheDir = join(workDir, 'cache');
    const auditOut = join(workDir, 'audit.jsonl');
    const client = new PlumbClient({
      baseUrl,
      apiKey: 'plumb_sk_secret_audit_9876',
      model: 'plumb-27b-0.5.0',
      caFile: tls.caCertPath,
      cacheDir,
      auditOut,
    });

    const first = await client.judge({ task: 'single_cmd_judge', state: 'cmd 1' });
    assert.equal(first.status, '未确认');
    assert.equal(first.decided_by, '模型');
    assert.equal(first.cache_hit, false);

    const second = await client.judge({ task: 'single_cmd_judge', state: 'cmd 1' });
    assert.equal(second.cache_hit, true);
    assert.equal(judgeCalls, 1);

    const auditLines = (await readFile(auditOut, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(auditLines.length, 2);
    assert.equal(auditLines[0].cache_hit, false);
    assert.equal(auditLines[1].cache_hit, true);
    assert.ok(!(await readFile(auditOut, 'utf8')).includes('secret_audit_9876'));

    mode = 'bad_disclosure';
    await assert.rejects(
      () => client.judge({ task: 'single_cmd_judge', state: 'cmd 2' }),
      /缺少合法的未确认模型披露字段/,
    );
  });

  it('retries GET 503 with mock timing but never retries POST 503 backend_down or rejects symlink cache/CA', async () => {
    mode = 'get_flaky';
    getAttempts = 0;
    const pauses: number[] = [];
    const client = new PlumbClient({
      baseUrl,
      apiKey: 'plumb_sk_secret_retry',
      caFile: tls.caCertPath,
      timing: { now: () => 1_700_000_000_000, pause: async (ms) => { pauses.push(ms); } },
    });
    const st = await client.status();
    assert.equal(st.status, 'ready');
    assert.equal(getAttempts, 2);
    assert.equal(pauses.length, 1);

    mode = 'backend_down';
    judgeCalls = 0;
    await assert.rejects(() => client.judge({ task: 'single_cmd_judge', state: 'cmd 3' }), (err: PlumbHttpError) => err.code === 'backend_down' && err.status === 503);
    assert.equal(judgeCalls, 1);

    const symCa = join(workDir, 'ca-link.pem');
    await symlink(tls.caCertPath, symCa);
    const symClient = new PlumbClient({ baseUrl, apiKey: 'plumb_sk_secret_retry', caFile: symCa });
    await assert.rejects(() => symClient.status(), /无法读取PLUMB CA 证书文件/);
  });

  it('splits >32 batch questions into <=32 chunks and propagates answer disclosure', async () => {
    mode = 'ok';
    judgeCalls = 0;
    const questions: Record<string, PlumbBatchQuestion> = {};
    for (let i = 0; i < 35; i += 1) {
      questions[`q_${i}`] = { type: 'binary', criteria: { 正确: '符合', 错误: '不符' } };
    }
    const client = new PlumbClient({ baseUrl, apiKey: 'plumb_sk_batch', caFile: tls.caCertPath, model: 'plumb-27b-0.5.0' });
    await assert.rejects(() => client.judge({ task: 'match', questions }), /超过上限 32/);

    const batchRes = await client.judgeBatched({ task: 'match', questions });
    assert.equal(judgeCalls, 2);
    assert.equal(Object.keys(batchRes.answers).length, 35);
    assert.equal(batchRes.answers.q_34.status, '未确认');
    assert.equal(batchRes.answers.q_34.decided_by, '模型');
    assert.equal(batchRes.answers.q_34.model_version, 'plumb-27b-0.5.0');
  });

  it('normalizes real Plumb noul, sequence (value-only), and wrapped batch answers', async () => {
    let variant: 'noul' | 'sequence' | 'wrapped_batch' = 'noul';
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (variant === 'noul') {
        res.end(JSON.stringify({
          status: '未确认',
          decided_by: '模型',
          model_version: 'plumb-27b-0.5.0',
          answer: { type: 'noul', value: 0.91, match: 0.91, probabilities: { yes: 0.91, no: 0.09 } },
          gate: { action: 'pass', calibrated: true },
        }));
      } else if (variant === 'sequence') {
        res.end(JSON.stringify({
          status: '未确认',
          decided_by: '模型',
          model_version: 'plumb-27b-0.5.0',
          answer: { type: 'choice', value: '保持', confidence: 0.94, probabilities: { 保持: 0.94, 改变: 0.04, 未实现: 0.02 } },
          gate: { action: 'pass', calibrated: true },
        }));
      } else {
        res.end(JSON.stringify({
          status: '未确认',
          decided_by: '模型',
          model_version: 'plumb-27b-0.5.0',
          answers: {
            s1: {
              status: '未确认',
              decided_by: '模型',
              model_version: 'plumb-27b-0.5.0',
              answer: { type: 'choice', value: '保持', confidence: 0.88, probabilities: { 保持: 0.88, 改变: 0.08, 未实现: 0.04 } },
              gate: { action: 'review', calibrated: true },
            },
          },
        }));
      }
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const { port } = srv.address() as AddressInfo;
      const client = new PlumbClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'plumb_sk_wire_test' });
      const r1 = await client.judge({ task: 'single_cmd_judge', command: 'ip address 192.0.2.1/24', node: { line: 'network', title: 'cfg' } });
      const n1 = normalizeJudgeAnswer(r1);
      assert.deepEqual([n1.kind, n1.choice, n1.match, n1.gate?.action], ['noul', 'yes', 0.91, 'pass']);

      variant = 'sequence';
      const r2 = await client.judge({ task: 'sequence', state: '[当前作者步骤 1]\n启用接口\n[候选命令块]\nno shutdown' });
      const n2 = normalizeJudgeAnswer(r2);
      assert.deepEqual([n2.kind, n2.choice, n2.confidence, n2.gate?.action], ['choice', '保持', 0.94, 'pass']);

      variant = 'wrapped_batch';
      const r3 = await client.judgeBatched({ task: 'sequence', questions: { s1: { task: 'sequence', state: 'x' } } });
      const n3 = normalizeJudgeAnswer(r3.answers.s1);
      assert.deepEqual([n3.kind, n3.choice, n3.confidence, n3.gate?.action], ['choice', '保持', 0.88, 'review']);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

describe('plumb-client concurrency, timeout, and body limits', async () => {
  let inFlight = 0;
  let peakInFlight = 0;
  let postHits = 0;
  let gateResolver: (() => void) | null = null;
  let slowMode = false;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      if (slowMode) {
        postHits += 1;
        await new Promise<void>((resolve) => {
          gateResolver = resolve;
        });
        inFlight -= 1;
        return;
      }
      if (req.url === '/v1/judge') {
        await new Promise((r) => setTimeout(r, 15));
        inFlight -= 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: '未确认', decided_by: '模型', model_version: 'plumb-27b-0.5.0', answer: { type: 'binary', choice: '正确', confidence: 0.99 } }));
        return;
      }
      inFlight -= 1;
      res.writeHead(404);
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  after(async () => {
    gateResolver?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('caps in-flight concurrency at maxConcurrent=2 and refuses state+node or >1 MiB locally', async () => {
    const client = new PlumbClient({ baseUrl, apiKey: 'plumb_sk_conc', maxConcurrent: 2, timeoutMs: 5000 });
    await assert.rejects(() => client.judge({ task: 'choice', state: 'x', node: { title: 'y' } }), /不能同时传入 state 与 node/);
    await assert.rejects(() => client.judge({ task: 'sequence', state: 'a'.repeat(1024 * 1024 + 64) }), (e: PlumbHttpError) => e.status === 413 && e.code === 'request_too_large');

    await Promise.all([
      client.judge({ task: 'single_cmd_judge', state: '1' }),
      client.judge({ task: 'single_cmd_judge', state: '2' }),
      client.judge({ task: 'single_cmd_judge', state: '3' }),
      client.judge({ task: 'single_cmd_judge', state: '4' }),
    ]);
    assert.ok(peakInFlight <= 2, `expected peak concurrency <= 2, got ${peakInFlight}`);
  });

  it('never auto-retries POST after socket timeout (no duplicate charge)', async () => {
    slowMode = true;
    postHits = 0;
    const client = new PlumbClient({ baseUrl, apiKey: 'plumb_sk_timeout', timeoutMs: 80 });
    await assert.rejects(
      () => client.judge({ task: 'single_cmd_judge', state: 'slow' }),
      (e: PlumbHttpError) => e.status === 504 && e.code === 'timeout' && e.retryable === false,
    );
    gateResolver?.();
    assert.equal(postHits, 1);
  });
});

describe('plumb-client wakeAndWait with a backend that fails to start', async () => {
  const REASON = 'allocation_failed (rc=1): synthetic scheduler said: Backend rejected accelerator request';
  const KEY = 'plumb_sk_wake_synthetic_0001';
  const POLL_MS = 5_000;
  interface Step {
    http?: number;
    body: Record<string, unknown>;
  }
  const idle: Step = { body: { status: 'down', backend_state: 'idle' } };
  const starting: Step = { body: { status: 'waking', backend_state: 'starting', phase: 'loading', progress_message: 'loading weights' } };
  const ready: Step = { body: { status: 'ready', serving_version: 'plumb-27b-0.5.0' } };
  // null leaves the field out of the answer.
  const failed = (message: string | null = REASON, phase: string | null = 'allocation'): Step => ({
    body: { status: 'down', backend_state: 'failed', ...(phase === null ? {} : { phase }), ...(message === null ? {} : { progress_message: message }) },
  });
  const backendDown = (): Step => ({ http: 503, body: { error: { type: 'backend_down', message: 'backend sleeping' } } });

  // The status answers in order (the last one repeats), the answer to a wake, and how often each route was asked.
  let statuses: Step[] = [];
  let wakeAnswer: Step = { body: { status: 'waking' } };
  let statusCalls = 0;
  let wakeCalls = 0;
  const arrange = (script: Step[], wake: Step = { body: { status: 'waking' } }): void => {
    statuses = script;
    wakeAnswer = wake;
    statusCalls = 0;
    wakeCalls = 0;
  };

  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const send = (step: Step): void => {
        res.writeHead(step.http ?? 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(step.body));
      };
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (req.method === 'GET' && path === '/v1/status') {
        const step = statuses[Math.min(statusCalls, statuses.length - 1)];
        statusCalls += 1;
        return send(step);
      }
      if (req.method === 'POST' && path === '/v1/wake') {
        wakeCalls += 1;
        return send(wakeAnswer);
      }
      if (req.method === 'POST' && path === '/v1/judge') return send(backendDown());
      return send({ http: 404, body: {} });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // A clock that moves only when the client pauses, so a poll is counted instead of waited for.
  function virtualClient(): { client: PlumbClient; pauses: number[] } {
    let now = 1_700_000_000_000;
    const pauses: number[] = [];
    const timing: PlumbTiming = {
      now: () => now,
      pause: async (ms: number) => {
        pauses.push(ms);
        now += ms;
      },
    };
    return { client: new PlumbClient({ baseUrl, apiKey: KEY, model: 'plumb-27b-0.5.0', noCache: true, timing }), pauses };
  }
  const wakeOptions = { timeoutMs: 720_000, pollIntervalMs: POLL_MS };

  it('ends the wait at the second failed poll after the wake and quotes the gateway\'s own reason', { timeout: 30_000 }, async () => {
    arrange([idle, failed(), failed(), ready]);
    const { client, pauses } = virtualClient();
    await assert.rejects(
      () => client.wakeAndWait(wakeOptions),
      (error: unknown) => {
        assert.ok(error instanceof PlumbHttpError);
        assert.equal(error.status, 503);
        assert.equal(error.code, 'backend_failed');
        assert.equal(error.retryable, false);
        assert.equal(error.category, '暂时不可用');
        assert.match(error.message, /^暂时不可用：Plumb 后端启动失败，网关报告：/);
        assert.ok(error.message.includes(REASON), error.message);
        assert.match(error.message, /请联系 Plumb 管理员检查后端，不要再次唤醒。$/);
        return true;
      },
    );
    assert.equal(wakeCalls, 1);
    assert.equal(statusCalls, 3, 'the status before the wake and two polls after it, not the third answer');
    assert.deepEqual(pauses, [POLL_MS, POLL_MS]);
  });

  it('wakes once and then needs two failed polls when the very first status already shows the failure', { timeout: 30_000 }, async () => {
    arrange([failed(), failed(), failed(), ready]);
    const { client } = virtualClient();
    await assert.rejects(() => client.wakeAndWait(wakeOptions), (error: unknown) => error instanceof PlumbHttpError && error.code === 'backend_failed');
    assert.equal(wakeCalls, 1);
    assert.equal(statusCalls, 3, 'the first status is not one of the two polls after the wake');

    arrange([failed(), failed(), starting, ready]);
    const answer = await virtualClient().client.wakeAndWait(wakeOptions);
    assert.equal(answer.status, 'ready');
    assert.equal(wakeCalls, 1);
    assert.equal(statusCalls, 4, 'one failed poll after the wake does not end the wait');
  });

  it('counts the polls after a status that is already waking and sends no wake', { timeout: 30_000 }, async () => {
    arrange([starting, failed(), failed(), ready]);
    await assert.rejects(() => virtualClient().client.wakeAndWait(wakeOptions), (error: unknown) => error instanceof PlumbHttpError && error.code === 'backend_failed');
    assert.equal(wakeCalls, 0);
    assert.equal(statusCalls, 3);
  });

  it('goes on after one failed poll that is followed by starting and then ready', { timeout: 30_000 }, async () => {
    arrange([idle, failed(), starting, ready]);
    const answer = await virtualClient().client.wakeAndWait(wakeOptions);
    assert.equal(answer.status, 'ready');
    assert.equal(answer.serving_version, 'plumb-27b-0.5.0');
    assert.equal(wakeCalls, 1);
    assert.equal(statusCalls, 4);
  });

  it('resets the count when a poll in between shows another state', { timeout: 30_000 }, async () => {
    arrange([idle, failed(), starting, failed(), ready]);
    const answer = await virtualClient().client.wakeAndWait(wakeOptions);
    assert.equal(answer.status, 'ready');
    assert.equal(statusCalls, 5, 'failed, starting, failed are never two failed polls in a row');
  });

  it('still ends with wake_timeout when the backend keeps starting', { timeout: 30_000 }, async () => {
    arrange([idle, starting]);
    const { client, pauses } = virtualClient();
    await assert.rejects(
      () => client.wakeAndWait({ timeoutMs: 6 * POLL_MS, pollIntervalMs: POLL_MS }),
      (error: unknown) => {
        assert.ok(error instanceof PlumbHttpError);
        assert.equal(error.status, 504);
        assert.equal(error.code, 'wake_timeout');
        assert.match(error.message, /等待 Plumb 后端唤醒超时/);
        return true;
      },
    );
    assert.equal(wakeCalls, 1);
    assert.equal(statusCalls, 7, 'the status before the wake and one poll for each of the six polling intervals');
    assert.deepEqual(pauses, Array.from({ length: 6 }, () => POLL_MS));
  });

  it('keeps ending the wait at once on version_mismatch and error', { timeout: 30_000 }, async () => {
    for (const state of ['version_mismatch', 'error']) {
      arrange([idle, { body: { status: state } }, ready]);
      await assert.rejects(
        () => virtualClient().client.wakeAndWait(wakeOptions),
        (error: unknown) => error instanceof PlumbHttpError && error.code === state && error.status === 503,
      );
      assert.equal(statusCalls, 2);
    }
  });

  it('falls back to the phase, then to saying the gateway gave no reason', { timeout: 30_000 }, async () => {
    arrange([idle, failed(null, 'allocation'), failed(null, 'allocation')]);
    await assert.rejects(
      () => virtualClient().client.wakeAndWait(wakeOptions),
      (error: unknown) => error instanceof Error && error.message.includes('网关报告的阶段：allocation') && !error.message.includes('没有说明原因'),
    );
    arrange([idle, failed(null, null), failed(null, null)]);
    await assert.rejects(
      () => virtualClient().client.wakeAndWait(wakeOptions),
      (error: unknown) => error instanceof Error && error.message.includes('网关没有说明原因'),
    );
  });

  it('redacts the API key from the quoted reason and keeps it to a few hundred characters', { timeout: 30_000 }, async () => {
    const long = `${KEY} refused the request\n${'accelerator unavailable '.repeat(60)}`;
    arrange([idle, failed(long), failed(long)]);
    await assert.rejects(
      () => virtualClient().client.wakeAndWait(wakeOptions),
      (error: unknown) => {
        assert.ok(error instanceof PlumbHttpError);
        assert.ok(!error.message.includes('wake_synthetic_0001'), error.message);
        assert.match(error.message, /plumb_sk_\[REDACTED\] refused the request accelerator unavailable/);
        const quoted = error.message.slice(error.message.indexOf('网关报告：') + 5, error.message.indexOf('。'));
        assert.equal(Array.from(quoted).length, 301, 'three hundred characters and the ellipsis');
        assert.ok(quoted.endsWith('…'));
        assert.ok(!/\s{2}|\n/u.test(quoted), 'whitespace is collapsed to single spaces');
        return true;
      },
    );
  });

  it('sends the person to the administrator, not to another wake, when the wake itself is answered with backend_down', { timeout: 30_000 }, async () => {
    arrange([idle], backendDown());
    const { client } = virtualClient();
    const adviceOfWake = (error: unknown): boolean => {
      assert.ok(error instanceof PlumbHttpError);
      assert.equal(error.status, 503);
      assert.equal(error.code, 'backend_down');
      assert.match(error.message, /请联系 Plumb 管理员检查后端。$/);
      assert.doesNotMatch(error.message, /plumb wake/);
      return true;
    };
    await assert.rejects(() => client.wake(), adviceOfWake);
    await assert.rejects(() => client.wakeAndWait(wakeOptions), adviceOfWake);

    arrange([backendDown()]);
    await assert.rejects(() => client.wakeAndWait(wakeOptions), adviceOfWake);
    assert.equal(wakeCalls, 0, 'the status answer ended the wait before any wake was sent');
  });

  it('keeps the wake advice for a status or judge call that meets backend_down', { timeout: 30_000 }, async () => {
    arrange([backendDown()]);
    const { client } = virtualClient();
    const advisesWake = (error: unknown): boolean => {
      assert.ok(error instanceof PlumbHttpError);
      assert.equal(error.code, 'backend_down');
      assert.match(error.message, /请先执行 plumb wake --wait 等待后端就绪后再试/);
      assert.doesNotMatch(error.message, /Plumb 管理员/);
      return true;
    };
    await assert.rejects(() => client.status(), advisesWake);
    await assert.rejects(() => client.judge({ task: 'single_cmd_judge', state: 'ctx', command: 'synthetic' }), advisesWake);
  });
});
