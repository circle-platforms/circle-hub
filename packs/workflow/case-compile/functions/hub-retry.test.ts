// Synthetic retry tests for read-only and submit Hub helpers (scripted fetch + injectable clock, plus loopback HTTP stub).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { HubReplyError } from './generated/skills/run-tools/hub-client/index.ts';
import { formatCallError } from './text.ts';
import {
  BACKOFF_STEPS_MS,
  fetchBytesRetrying,
  getRetrying,
  isConnectionRefused,
  KNOWLEDGE_MAX_BYTES,
  parseRetryAfterMs,
  READ_RETRY_BUDGET_MS,
  RETRY_BODY_MARKER,
  submitResultRetrying,
  type RetryTiming,
} from './hub-retry.ts';

function fakeClock(startAt = 0): RetryTiming & { pauses: number[]; elapsed: () => number } {
  let at = startAt;
  const pauses: number[] = [];
  return {
    pauses,
    now: () => at,
    pause: async (ms: number) => {
      pauses.push(ms);
      at += ms;
    },
    elapsed: () => at - startAt,
  };
}

function connRefusedError(nested: 'direct' | 'cause' | 'aggregate' = 'cause'): Error {
  const leaf = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:49152'), { code: 'ECONNREFUSED' });
  if (nested === 'direct') return leaf;
  if (nested === 'aggregate') {
    const v6 = Object.assign(new Error('connect ECONNREFUSED ::1:49152'), { code: 'ECONNREFUSED' });
    return new TypeError('fetch failed', { cause: new AggregateError([v6, leaf], 'ECONNREFUSED') });
  }
  return new TypeError('fetch failed', { cause: leaf });
}

test('parseRetryAfterMs handles seconds, fractions, HTTP-date relative to clock, and invalid inputs', () => {
  assert.equal(parseRetryAfterMs(null, 1000), null);
  assert.equal(parseRetryAfterMs('', 1000), null);
  assert.equal(parseRetryAfterMs('  ', 1000), null);
  assert.equal(parseRetryAfterMs('5', 1000), 5_000);
  assert.equal(parseRetryAfterMs('0', 1000), 0);
  assert.equal(parseRetryAfterMs('1.5', 1000), 1_500);
  assert.equal(parseRetryAfterMs('-3', 1000), null);
  assert.equal(parseRetryAfterMs('garbage', 1000), null);
  const base = Date.UTC(2026, 10, 14, 6, 0, 0);
  assert.equal(parseRetryAfterMs('Sat, 14 Nov 2026 06:00:07 GMT', base), 7_000);
  assert.equal(parseRetryAfterMs('Sat, 14 Nov 2026 05:59:50 GMT', base), 0);
});

test('isConnectionRefused recognizes direct, nested cause, and Happy Eyeballs AggregateError only', () => {
  assert.equal(isConnectionRefused(connRefusedError('direct')), true);
  assert.equal(isConnectionRefused(connRefusedError('cause')), true);
  assert.equal(isConnectionRefused(connRefusedError('aggregate')), true);
  const reset = new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
  assert.equal(isConnectionRefused(reset), false);
  const mixed = new AggregateError([
    Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
    Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
  ]);
  assert.equal(isConnectionRefused(mixed), false);
});

test('read retries recover across Hub restart sequence: 503 + Retry-After then ECONNREFUSED backoff then 200', async () => {
  const timing = fakeClock();
  const responses: Array<() => Response> = [
    () => new Response(`Hub 正在重启，${RETRY_BODY_MARKER}，稍后原样重试`, { status: 503, headers: { 'retry-after': '5' } }),
    () => { throw connRefusedError('cause'); },
    () => { throw connRefusedError('aggregate'); },
    () => new Response(Buffer.from('{"ok":true}'), { status: 200 }),
  ];
  let calls = 0;
  const bytes = await getRetrying('http://127.0.0.1:49152/run-export/run_01/run', 'token', {
    timing,
    fetch: async () => {
      calls++;
      return responses.shift()!();
    },
  });
  assert.equal(calls, 4);
  assert.deepEqual(timing.pauses, [5_000, BACKOFF_STEPS_MS[0], BACKOFF_STEPS_MS[1]]);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes)), { ok: true });
});

test('read retries follow 2s, 4s, 8s backoff without Retry-After and cap total wait at 60s with formatted error', async () => {
  const timing = fakeClock();
  let calls = 0;
  await assert.rejects(
    () => getRetrying('http://127.0.0.1:49152/run-export/run_01/run', 'token', {
      timing,
      fetch: async () => {
        calls++;
        throw connRefusedError('cause');
      },
    }),
    (error: unknown) => {
      const formatted = formatCallError(error);
      assert.match(formatted, /^暂时不可用：.*ECONNREFUSED.*已等待 60 秒并尝试 10 次.*。请.*。$/);
      return true;
    },
  );
  assert.equal(calls, 10);
  assert.deepEqual(timing.pauses, [2_000, 4_000, 8_000, 8_000, 8_000, 8_000, 8_000, 8_000, 6_000]);
  assert.equal(timing.elapsed(), READ_RETRY_BUDGET_MS);

  const timing503 = fakeClock();
  let calls503 = 0;
  await assert.rejects(
    () => fetchBytesRetrying('http://127.0.0.1:49152/run-export/run_01/knowledge', 'token', KNOWLEDGE_MAX_BYTES, {
      timing: timing503,
      fetch: async () => {
        calls503++;
        return new Response('正在排水', { status: 503 });
      },
    }),
    (error: unknown) => {
      const formatted = formatCallError(error);
      assert.match(formatted, /^暂时不可用：Hub 答复 503.*已等待 60 秒并尝试 10 次.*。请.*。$/);
      return true;
    },
  );
  assert.equal(calls503, 10);
  assert.equal(timing503.elapsed(), READ_RETRY_BUDGET_MS);
});

test('read fails immediately when Retry-After exceeds remaining 60s budget and caps repeated Retry-After: 0 loops', async () => {
  const timing = fakeClock();
  let calls = 0;
  await assert.rejects(
    () => getRetrying('http://127.0.0.1:49152/x', 'token', {
      timing,
      fetch: async () => {
        calls++;
        return new Response('过载', { status: 503, headers: { 'retry-after': '120' } });
      },
    }),
    (error: unknown) => {
      const formatted = formatCallError(error);
      assert.match(formatted, /^暂时不可用：Hub 答复 503.*已等待 0 秒并尝试 1 次.*120 秒.*。请.*。$/);
      return true;
    },
  );
  assert.equal(calls, 1);
  assert.deepEqual(timing.pauses, []);

  // Repeated Retry-After: 0 cannot spin forever: falls back to bounded backoff after 3 zero pauses.
  const zeroClock = fakeClock();
  let zeroCalls = 0;
  await assert.rejects(
    () => getRetrying('http://127.0.0.1:49152/x', 'token', {
      timing: zeroClock,
      fetch: async () => {
        zeroCalls++;
        return new Response('重启', { status: 503, headers: { 'retry-after': '0' } });
      },
    }),
    (error: unknown) => {
      assert.match(formatCallError(error), /^暂时不可用：Hub 答复 503.*60 秒.*尝试 \d+ 次/);
      return true;
    },
  );
  assert.equal(zeroClock.elapsed(), 60_000);
  assert.deepEqual(zeroClock.pauses.slice(0, 6), [0, 0, 0, 2_000, 4_000, 8_000]);
  assert.equal(zeroCalls, 13);
});

test('read does not retry 4xx, 500, TimeoutError, or mid-stream ECONNRESET', async () => {
  for (const status of [400, 401, 403, 404, 409, 500, 502, 504]) {
    const timing = fakeClock();
    let calls = 0;
    await assert.rejects(
      () => getRetrying('http://127.0.0.1:49152/x', 'token', {
        timing,
        fetch: async () => {
          calls++;
          return new Response('nope', { status });
        },
      }),
      (error: unknown) => error instanceof HubReplyError && error.status === status,
    );
    assert.equal(calls, 1, `status ${status} must not retry`);
    assert.deepEqual(timing.pauses, []);
  }

  for (const err of [
    Object.assign(new Error('timeout'), { name: 'TimeoutError' }),
    new TypeError('terminated', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) }),
  ]) {
    const timing = fakeClock();
    let calls = 0;
    await assert.rejects(
      () => getRetrying('http://127.0.0.1:49152/x', 'token', {
        timing,
        fetch: async () => {
          calls++;
          throw err;
        },
      }),
      (thrown: unknown) => {
        assert.match(formatCallError(thrown), /^暂时不可用：.*。请.*。$/);
        return true;
      },
    );
    assert.equal(calls, 1);
    assert.deepEqual(timing.pauses, []);
  }
});

test('submit retries ONLY on 503 containing 这次调用没有执行, honoring Retry-After and 2/4/8s backoff', async () => {
  const timing = fakeClock();
  const replies = [
    new Response(`Hub 正在重启，${RETRY_BODY_MARKER}，稍后原样重试`, { status: 503, headers: { 'retry-after': '5' } }),
    new Response(RETRY_BODY_MARKER, { status: 503 }),
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '受理' }] } }), { status: 200 }),
  ];
  let calls = 0;
  const out = await submitResultRetrying('http://127.0.0.1:49152', 'token', { run: 'run_01' }, {
    timing,
    fetch: async () => {
      calls++;
      return replies.shift()!;
    },
  });
  assert.deepEqual(out, { text: '受理', failed: false });
  assert.equal(calls, 3);
  assert.deepEqual(timing.pauses, [5_000, 2_000]);

  const exhaustClock = fakeClock();
  let exhaustCalls = 0;
  await assert.rejects(
    () => submitResultRetrying('http://127.0.0.1:49152', 'token', { run: 'run_01' }, {
      timing: exhaustClock,
      fetch: async () => {
        exhaustCalls++;
        return new Response(`Hub 正在重启，${RETRY_BODY_MARKER}`, { status: 503, headers: { 'retry-after': '5' } });
      },
    }),
    (error: unknown) => {
      const formatted = formatCallError(error);
      assert.match(formatted, /^暂时不可用：Hub 答复 503.*已等待 60 秒并尝试 13 次.*。请.*。$/);
      return true;
    },
  );
  assert.equal(exhaustCalls, 13);
  assert.equal(exhaustClock.elapsed(), 60_000);
});

test('submit NEVER retries ambiguous 503, ECONNREFUSED, TimeoutError, ECONNRESET, or torn responses and tells caller 先查回原调用', async () => {
  const cases: Array<{ name: string; respond: () => Promise<Response>; expectCheckOriginal: boolean; expectedCategory: string }> = [
    {
      name: '503 without marker',
      respond: async () => new Response('upstream overload', { status: 503 }),
      expectCheckOriginal: true,
      expectedCategory: '暂时不可用',
    },
    {
      name: '502 bad gateway',
      respond: async () => new Response('bad gateway', { status: 502 }),
      expectCheckOriginal: true,
      expectedCategory: '暂时不可用',
    },
    {
      name: 'ECONNREFUSED',
      respond: async () => { throw connRefusedError('cause'); },
      expectCheckOriginal: true,
      expectedCategory: '暂时不可用',
    },
    {
      name: 'TimeoutError',
      respond: async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); },
      expectCheckOriginal: true,
      expectedCategory: '暂时不可用',
    },
    {
      name: 'mid-flight ECONNRESET',
      respond: async () => { throw new TypeError('terminated', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) }); },
      expectCheckOriginal: true,
      expectedCategory: '暂时不可用',
    },
    {
      name: '503 stream reset before body completes',
      respond: async () => ({
        status: 503,
        ok: false,
        headers: new Headers({ 'retry-after': '5' }),
        text: async () => { throw Object.assign(new Error('aborted'), { code: 'ECONNRESET' }); },
      } as unknown as Response),
      expectCheckOriginal: true,
      expectedCategory: '暂时不可用',
    },
  ];

  for (const scenario of cases) {
    const timing = fakeClock();
    let calls = 0;
    await assert.rejects(
      () => submitResultRetrying('http://127.0.0.1:49152', 'token', { run: 'run_01' }, {
        timing,
        fetch: async () => {
          calls++;
          return scenario.respond();
        },
      }),
      (error: unknown) => {
        const formatted = formatCallError(error);
        assert.match(formatted, new RegExp(`^${scenario.expectedCategory}：.*。请.*。$`), scenario.name);
        if (scenario.expectCheckOriginal) assert.match(formatted, /先查回原调用/, scenario.name);
        return true;
      },
    );
    assert.equal(calls, 1, `${scenario.name}: must attempt only once`);
    assert.deepEqual(timing.pauses, [], `${scenario.name}: must not sleep or retry`);
  }
});

test('real loopback HTTP server recovers on 503 with Retry-After for both read and submit', async (t) => {
  let getHits = 0;
  let postHits = 0;
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/run-export/run_01/run') {
      getHits++;
      if (getHits === 1) {
        res.writeHead(503, { 'retry-after': '0' });
        res.end(`Hub 正在重启，${RETRY_BODY_MARKER}，稍后原样重试`);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ schema: 'run-export@1', run: { run: 'run_01' } }));
      return;
    }
    if (req.method === 'POST' && req.url === '/mcp') {
      postHits++;
      if (postHits === 1) {
        res.writeHead(503, { 'retry-after': '0' });
        res.end(`Hub 正在重启，${RETRY_BODY_MARKER}，稍后原样重试`);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '受理' }] } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as { port: number };
  const origin = `http://127.0.0.1:${port}`;

  const raw = await getRetrying(`${origin}/run-export/run_01/run`, 'token');
  assert.equal(JSON.parse(new TextDecoder().decode(raw)).schema, 'run-export@1');
  assert.equal(getHits, 2);

  const submitted = await submitResultRetrying(origin, 'token', { run: 'run_01' });
  assert.deepEqual(submitted, { text: '受理', failed: false });
  assert.equal(postHits, 2);
});
