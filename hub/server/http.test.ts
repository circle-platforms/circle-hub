// The HTTP surface: request targets that URL parsing refuses (never an unhandled rejection), /healthz with the release id,
// the Host and Origin checks against DNS rebinding, the same 401 for every kind of bad token, method and media type
// refusals and their call-log lines, strict UTF-8, bounded bodies (declared and streamed), the process-wide body budget,
// and a graceful close that waits for the handlers it cut off.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { createApp } from './app.ts';
import { readReleaseId } from './release.ts';
import { createTestServer, type TestServer } from './testing.ts';

let postgres: TemporaryPostgres;
let server: TestServer;

before(async () => {
  postgres = await startPostgres();
  server = await createTestServer({ postgres, limits: { maxRequestBytes: 64 * 1024 } });
});
after(async () => {
  await server?.close();
  await postgres?.stop();
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A raw request with exactly the given headers (fetch would set Host and Origin itself). */
function send(path: string, options: { method?: string; headers?: Record<string, string>; body?: string | Buffer; port?: number } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: options.port ?? server.port, path, method: options.method ?? 'GET', headers: { host: `127.0.0.1:${options.port ?? server.port}`, ...options.headers }, setHost: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } });
const mcpHeaders = (token?: string): Record<string, string> => ({
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
});

/** A raw request as text; resolves with what came back once the server closes, or after `waitMs` (a server that never answers). */
function raw(text: string, waitMs = 1500, port = server.port): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = '';
    const socket = connect(port, '127.0.0.1', () => socket.write(text));
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(received);
    }, waitMs);
    socket.on('data', (chunk) => (received += chunk.toString('utf8')));
    socket.on('end', () => {
      clearTimeout(timer);
      resolve(received);
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      if ((error as NodeJS.ErrnoException).code === 'ECONNRESET') resolve(received);
      else reject(error);
    });
  });
}

describe('request targets', () => {
  test('a target URL parsing rejects is a 400, never an unhandled rejection; // stays a path and is not read as an authority', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const host = `127.0.0.1:${server.port}`;
      const expected: [string, number][] = [
        ['//', 404],
        ['///', 404],
        ['//?x', 404],
        ['//:80', 404],
        ['//a:b', 404],
        ['//x/healthz', 404],
        ['http://a:b/', 400],
        ['http://%zz/', 400],
        ['*', 400],
      ];
      for (const [target, status] of expected) {
        const reply = await raw(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
        assert.match(reply, new RegExp(`^HTTP/1\\.1 ${status} `), `${target}: ${reply.slice(0, 80) || 'no answer'}`);
      }
      // An origin-form path that starts with // never reaches /mcp through a fake authority.
      const posted = await raw(`POST //x/mcp HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nAuthorization: Bearer ${server.admin.token}\r\nContent-Length: ${initialize.length}\r\nConnection: close\r\n\r\n${initialize}`);
      assert.match(posted, /^HTTP\/1\.1 404 /);
      // The absolute form is served when its authority is this server, refused like a foreign Host otherwise.
      assert.match(await raw(`GET http://${host}/healthz HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`), /^HTTP\/1\.1 200 /);
      assert.match(await raw(`GET http://attacker.example/healthz HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`), /^HTTP\/1\.1 403 /);
      assert.match(await raw(`GET http://${['user', ':pw'].join('')}@${host}/healthz HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`), /^HTTP\/1\.1 400 /);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(rejections, [], 'no request leaves a rejection nobody handles');
      assert.equal((await send('/healthz')).status, 200, 'the server is still up');
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});

describe('/healthz', () => {
  test('answers 200 without a token, with the release id (null in a checkout without release.json) and no secrets', async () => {
    const reply = await send('/healthz');
    assert.equal(reply.status, 200);
    assert.deepEqual(JSON.parse(reply.body), { status: 'ok', release: null });
    assert.equal(reply.headers['x-content-type-options'], 'nosniff');
  });

  test('the release comes from release.json in the code root; a malformed file refuses to start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'circle-hub-release-'));
    try {
      assert.equal(readReleaseId(root), null);
      await writeFile(join(root, 'release.json'), JSON.stringify({ schema: 'circle-hub-release@1', id: '0123456789ab', created_at: '2026-10-22T00:00:00.000Z' }));
      assert.equal(readReleaseId(root), '0123456789ab');
      const app = createApp(server.deps, { codeRoot: root });
      const info = await app.listen();
      try {
        const reply = await send('/healthz', { port: info.port });
        assert.deepEqual(JSON.parse(reply.body), { status: 'ok', release: '0123456789ab' });
      } finally {
        await app.close();
      }
      await writeFile(join(root, 'release.json'), '{"id":"../../etc"}');
      assert.throws(() => createApp(server.deps, { codeRoot: root }), /不是 circle-hub-release@1/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('Host and Origin', () => {
  test('a foreign Host is refused on every route (DNS rebinding); 127.0.0.1 and localhost with the port pass', async () => {
    for (const host of ['attacker.example', `attacker.example:${server.port}`, `127.0.0.1:${server.port + 1}`, `localhost.:${server.port}`, `0.0.0.0:${server.port}`, '']) {
      for (const path of ['/healthz', '/mcp', '/console/login']) {
        const reply = await send(path, { headers: { host }, method: path === '/mcp' ? 'POST' : 'GET', ...(path === '/mcp' ? { body: initialize } : {}) });
        assert.equal(reply.status, 403, `${host} ${path}`);
      }
    }
    assert.equal((await send('/healthz', { headers: { host: `localhost:${server.port}` } })).status, 200);
    assert.equal((await send('/healthz', { headers: { host: `LOCALHOST:${server.port}` } })).status, 200);
  });

  test('a request without any Host header is refused', async () => {
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(server.port, '127.0.0.1', () => socket.write('GET /healthz HTTP/1.0\r\n\r\n'));
      let text = '';
      socket.on('data', (chunk) => (text += chunk.toString('utf8')));
      socket.on('end', () => resolve(text));
      socket.on('error', reject);
    });
    assert.match(reply, /^HTTP\/1\.[01] 403/);
  });

  test('an Origin must be a loopback origin; a rebinding page with its own origin and host is refused', async () => {
    for (const origin of ['http://attacker.example', 'null', `http://attacker.example:${server.port}`, 'http://127.0.0.1.attacker.example', 'file://', 'http://localhost:3000/path']) {
      const reply = await send('/mcp', { method: 'POST', headers: { ...mcpHeaders(server.admin.token), origin }, body: initialize });
      assert.equal(reply.status, 403, origin);
      assert.equal(JSON.parse(reply.body).error.code, -32000);
    }
    const rebinding = await send('/mcp', {
      method: 'POST',
      headers: { ...mcpHeaders(server.admin.token), host: `rebind.attacker.example:${server.port}`, origin: `http://rebind.attacker.example:${server.port}` },
      body: initialize,
    });
    assert.equal(rebinding.status, 403);
    for (const origin of ['http://localhost:6274', `http://127.0.0.1:${server.port}`, 'http://[::1]:8080']) {
      const reply = await send('/mcp', { method: 'POST', headers: { ...mcpHeaders(server.admin.token), origin }, body: initialize });
      assert.equal(reply.status, 200, origin);
    }
  });
});

describe('/mcp transport', () => {
  test('missing, unknown, revoked and disabled tokens get the same 401', async () => {
    const user = await server.createUser('令牌测试');
    const revoked = await server.createUser('撤销测试');
    const tokens = await server.records.principals.tokens(revoked.user.id);
    await server.records.principals.revokeToken(server.admin.principal, tokens[0].id);
    const disabled = await server.createUser('停用测试');
    await server.records.principals.setDisabled(server.admin.principal, disabled.user.id, true);
    const replies = [
      await send('/mcp', { method: 'POST', headers: mcpHeaders(), body: initialize }),
      await send('/mcp', { method: 'POST', headers: mcpHeaders('A'.repeat(43)), body: initialize }),
      await send('/mcp', { method: 'POST', headers: mcpHeaders(revoked.token), body: initialize }),
      await send('/mcp', { method: 'POST', headers: mcpHeaders(disabled.token), body: initialize }),
      await send('/mcp', { method: 'POST', headers: { ...mcpHeaders(), authorization: `Basic ${Buffer.from('a:b').toString('base64')}` }, body: initialize }),
    ];
    for (const reply of replies) {
      assert.equal(reply.status, 401);
      assert.equal(reply.body, replies[0].body);
      assert.equal(reply.headers['www-authenticate'], 'Bearer realm="circle-hub"');
    }
    assert.equal(JSON.parse(replies[0].body).error.code, -32001);
    const ok = await send('/mcp', { method: 'POST', headers: mcpHeaders(user.token), body: initialize });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.body).result.serverInfo.name, 'circle-hub');
  });

  test('GET and DELETE are 405, a wrong media type 415, a body that is not JSON 400', async () => {
    assert.equal((await send('/mcp', { headers: mcpHeaders(server.admin.token) })).status, 405);
    assert.equal((await send('/mcp', { method: 'DELETE', headers: mcpHeaders(server.admin.token) })).status, 405);
    assert.equal((await send('/mcp', { method: 'POST', headers: { ...mcpHeaders(server.admin.token), 'content-type': 'text/plain' }, body: initialize })).status, 415);
    const bad = await send('/mcp', { method: 'POST', headers: mcpHeaders(server.admin.token), body: '{"jsonrpc":' });
    assert.equal(bad.status, 400);
    assert.equal(JSON.parse(bad.body).error.code, -32700);
    // The transport refuses a client that does not accept both answer forms; the call is logged as a transport failure.
    const list = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} });
    const refused = await send('/mcp', { method: 'POST', headers: { ...mcpHeaders(server.admin.token), accept: 'application/json' }, body: list });
    assert.equal(refused.status, 406);
    const lines = await server.records.callLog.query(server.admin.principal, { tool: 'tools/list', limit: 5 });
    assert.equal(lines.items[0].call_result, 'transport_failure');
    assert.match((lines.items[0].admin_reasons ?? []).join('\n'), /HTTP 406/);
  });

  test('a body over the request limit is refused before it is read, declared or streamed, and logged as a transport failure', async () => {
    const big = Buffer.alloc(80 * 1024, 0x20);
    const declared = await send('/mcp', { method: 'POST', headers: { ...mcpHeaders(server.admin.token), 'content-length': String(big.length) }, body: big });
    assert.equal(declared.status, 413);
    assert.equal(declared.headers.connection, 'close');
    const streamed = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: server.port, path: '/mcp', method: 'POST', headers: { ...mcpHeaders(server.admin.token), host: `127.0.0.1:${server.port}`, 'transfer-encoding': 'chunked' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', (error) => ((error as NodeJS.ErrnoException).code === 'EPIPE' || (error as NodeJS.ErrnoException).code === 'ECONNRESET' ? undefined : reject(error)));
      for (let i = 0; i < 4; i++) req.write(Buffer.alloc(32 * 1024, 0x20));
      req.end();
    });
    assert.equal(streamed, 413);
    const lines = await server.records.callLog.query(server.admin.principal, { tool: 'mcp' });
    assert.ok(lines.items.some((line) => line.call_result === 'transport_failure' && /over 65536 bytes/.test((line.admin_reasons ?? []).join('\n'))));
  });

  test('every refusal of an authenticated caller at the transport is one transport_failure line with its reason', async () => {
    const user = await server.createUser('传输日志');
    const headers = mcpHeaders(user.token);
    const replies = [
      await send('/mcp', { method: 'PUT', headers, body: initialize }),
      await send('/mcp', { method: 'POST', headers: { ...headers, 'content-type': 'text/plain' }, body: initialize }),
      await send('/mcp', { method: 'POST', headers, body: '{}' }),
      await send('/mcp', { method: 'POST', headers, body: '{"hello":"world"}' }),
      await send('/mcp', { method: 'POST', headers, body: '{"jsonrpc":"2.0","id":null,"method":"tools/list"}' }),
      await send('/mcp', { method: 'POST', headers, body: '{"jsonrpc":"2.0","id":3,"method":5}' }),
    ];
    assert.deepEqual(
      replies.map((r) => r.status),
      [405, 415, 400, 400, 400, 400],
    );
    const lines = (await server.records.callLog.query(server.admin.principal, { userId: user.user.id, limit: 50, newestFirst: false })).items;
    assert.equal(lines.length, replies.length, 'one line per refused request');
    for (const line of lines) {
      assert.equal(line.call_result, 'transport_failure');
      assert.equal(line.tool, 'mcp');
      assert.ok(line.admin_reasons?.length, 'the reason is in private admin reasons');
      assert.equal(line.admin_note, `管理员理由 ${line.admin_reasons.length} 条；详见管理员调用日志详情`);
    }
    assert.match((lines[0].admin_reasons ?? []).join('\n'), /method PUT is not served/);
    assert.match((lines[1].admin_reasons ?? []).join('\n'), /text\/plain is not application\/json/);
    assert.match((lines[2].admin_reasons ?? []).join('\n'), /the transport answered HTTP 400/);
    // Neither is a call: a GET (the client's probe for the optional server stream, 405 by the specification) and a
    // notification (202).
    assert.equal((await send('/mcp', { headers })).status, 405);
    const notified = await send('/mcp', { method: 'POST', headers, body: '{"jsonrpc":"2.0","method":"notifications/initialized"}' });
    assert.equal(notified.status, 202);
    assert.equal((await server.records.callLog.query(server.admin.principal, { userId: user.user.id, limit: 50 })).items.length, lines.length);
  });

  test('a body that is not UTF-8 is refused, never decoded with replacement characters', async () => {
    const user = await server.createUser('编码测试');
    const call = (text: string) => Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'list_task_packs', arguments: { kind: text } } }), 'utf8');
    const good = call('workflow');
    const bad = Buffer.concat([good.subarray(0, good.indexOf('workflow')), Buffer.from([0x77, 0xe9, 0x6f]), good.subarray(good.indexOf('workflow') + 3)]);
    const reply = await send('/mcp', { method: 'POST', headers: mcpHeaders(user.token), body: bad });
    assert.equal(reply.status, 400);
    assert.equal(JSON.parse(reply.body).error.code, -32700);
    const [line] = (await server.records.callLog.query(server.admin.principal, { userId: user.user.id, limit: 5 })).items;
    assert.equal(line.call_result, 'transport_failure');
    assert.match((line.admin_reasons ?? []).join('\n'), /not UTF-8/);
    assert.equal((await send('/mcp', { method: 'POST', headers: mcpHeaders(user.token), body: good })).status, 200, 'the same call in UTF-8 is served');
  });

  test('request bodies held at once have a process-wide budget: over it a request gets 503 with Retry-After, then the budget is free again', async () => {
    const app = createApp(server.deps, { codeRoot: server.records.dataDir, maxInflightBodyBytes: 4096, log: () => {} });
    const info = await app.listen();
    try {
      const host = `127.0.0.1:${info.port}`;
      const head = (length: number) =>
        `POST /mcp HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nAuthorization: Bearer ${server.admin.token}\r\nContent-Length: ${length}\r\n\r\n`;
      // A slow client holds 3000 bytes of the budget while its body is still arriving.
      const slow = connect(info.port, '127.0.0.1');
      await new Promise<void>((resolve) => slow.once('connect', () => resolve()));
      slow.write(`${head(3000)}${' '.repeat(1000)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const padded = initialize.padEnd(2000, ' ');
      const busy = await raw(`${head(2000)}${padded}`, 1500, info.port);
      assert.match(busy, /^HTTP\/1\.1 503 /);
      assert.match(busy, /retry-after: 5/i);
      // The slow body ends (it is not JSON): its answer frees the budget for the next request. (No half-close: Node's
      // HTTP server aborts a request whose client ends its side.)
      const slowReply = new Promise<string>((resolve) => slow.once('data', (chunk) => resolve(chunk.toString('utf8'))));
      slow.write(' '.repeat(2000));
      assert.match(await slowReply, /^HTTP\/1\.1 400 /);
      slow.destroy();
      assert.match(await raw(`${head(2000)}${padded}`, 1500, info.port), /^HTTP\/1\.1 200 /);
      const lines = await server.records.callLog.query(server.admin.principal, { userId: server.admin.user.id, tool: 'mcp', limit: 20 });
      assert.ok(lines.items.some((line) => /budget of 4096 bytes/.test((line.admin_reasons ?? []).join('\n'))), 'the 503 is logged as a transport failure');
    } finally {
      await app.close();
    }
  });

  test('unknown paths are 404 and the console refuses methods it does not serve', async () => {
    assert.equal((await send('/nothing')).status, 404);
    assert.equal((await send('/console/runs', { method: 'POST', body: '' })).status, 405);
  });
});

describe('close', () => {
  test('close() waits for a request in flight, then the port is free; it can be called twice', async () => {
    const other = await createTestServer({ postgres });
    const client = await other.client(other.admin.token);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = other.fakes.workflows.summaries.bind(other.fakes.workflows);
    other.fakes.workflows.summaries = async (user) => {
      await gate;
      return original(user);
    };
    const pending = client.call('list_task_packs', {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    const closing = other.app.close();
    setTimeout(release, 100);
    const result = await pending;
    assert.equal(result.isError, false, 'the request in flight was answered');
    await closing;
    await other.app.close();
    await assert.rejects(send('/healthz', { port: other.port }), /ECONNREFUSED/);
    await other.close();
  });

  test('a handler slower than the close deadline still writes its call-log line before close() resolves', async () => {
    const app = createApp(server.deps, { codeRoot: server.records.dataDir, closeTimeoutMs: 100, closeGraceMs: 5000, log: () => {} });
    const info = await app.listen();
    const workflows = server.fakes.workflows;
    const original = workflows.summaries.bind(workflows);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let finished = false;
    workflows.summaries = async (user) => {
      await gate;
      finished = true;
      return original(user);
    };
    try {
      const trace = 'c0ffee00c0ffee00c0ffee00c0ffee01';
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_task_packs', arguments: {} } });
      const pending = send('/mcp', { method: 'POST', port: info.port, headers: { ...mcpHeaders(server.admin.token), host: `127.0.0.1:${info.port}`, traceparent: `00-${trace}-00f067aa0ba902b7-01` }, body }).catch(
        (error: NodeJS.ErrnoException) => error.code,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      setTimeout(release, 400);
      const started = Date.now();
      await app.close();
      assert.ok(finished, 'close() waited for the handler it cut off');
      assert.ok(Date.now() - started >= 300, 'past the close deadline');
      const lines = await server.records.callLog.query(server.admin.principal, { tool: 'list_task_packs', limit: 50 });
      assert.ok(lines.items.some((line) => line.trace_id === trace), 'the line of the cut-off call is written');
      assert.equal(await pending, 'ECONNRESET', 'the connection itself was closed at the deadline');
    } finally {
      release();
      workflows.summaries = original;
      await app.close();
    }
  });
});
