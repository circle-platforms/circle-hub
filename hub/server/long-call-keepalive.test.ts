// A tool call that needs minutes must not look dead to a client that gives up on silence (Node's fetch waits 300 s for response
// headers and 300 s between body chunks): the head goes out once the call has worked for a while and spaces follow, then the
// JSON body. Fast calls keep their ordinary one-piece answer with a content-length.
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { createTestServer, type TestServer } from './testing.ts';

let postgres: TemporaryPostgres;
let server: TestServer;

before(async () => {
  postgres = await startPostgres();
  server = await createTestServer({ postgres, keepalive: { headersAfterMs: 150, keepaliveMs: 100 } });
});
after(async () => {
  await server?.close();
  await postgres?.stop();
});

interface Timed {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  headMs: number;
  endMs: number;
  chunks: string[];
  body: string;
}

function callListTaskPacks(): Promise<Timed> {
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_task_packs', arguments: {} } });
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: server.port,
        path: '/mcp',
        method: 'POST',
        headers: {
          host: `127.0.0.1:${server.port}`,
          authorization: `Bearer ${server.admin.token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': String(Buffer.byteLength(payload)),
        },
      },
      (res) => {
        const headMs = performance.now() - started;
        const chunks: string[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, headMs, endMs: performance.now() - started, chunks, body: chunks.join('') }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

describe('long tool calls keep the connection alive', () => {
  test('a call that works longer than the threshold gets its head early, spaces while it works, then the JSON answer', async () => {
    const workflows = server.deps.workflows as { summaries: (...args: unknown[]) => Promise<unknown> };
    const original = workflows.summaries.bind(workflows);
    workflows.summaries = async (...args: unknown[]) => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return original(...args);
    };
    try {
      const reply = await callListTaskPacks();
      assert.equal(reply.status, 200);
      assert.ok(reply.headMs < 700, `the head came before the work was done (${reply.headMs.toFixed(0)} ms)`);
      assert.ok(reply.endMs >= 1100, `the body waited for the work (${reply.endMs.toFixed(0)} ms)`);
      assert.match(String(reply.headers['content-type']), /application\/json/);
      assert.equal(reply.headers['content-length'], undefined, 'the length is unknown when the head goes out first');
      const spaces = reply.chunks.filter((chunk) => /^ +$/.test(chunk));
      assert.ok(spaces.length >= 2, `keepalive spaces arrived while the call worked (${spaces.length})`);
      const answer = JSON.parse(reply.body) as { id: number; result?: { isError?: boolean; structuredContent?: { call_result?: string } } };
      assert.equal(answer.id, 1);
      assert.equal(answer.result?.structuredContent?.call_result, 'ok');
    } finally {
      workflows.summaries = original;
    }
  });

  test('a fast call is answered in one piece with its length, as before', async () => {
    const reply = await callListTaskPacks();
    assert.equal(reply.status, 200);
    assert.equal(reply.chunks.length, 1);
    assert.ok(reply.headers['content-length'] !== undefined, 'an ordinary answer carries its length');
    assert.equal((JSON.parse(reply.body) as { id: number }).id, 1);
  });

  test('the SDK client reads an answer that arrived after the keepalive spaces', async () => {
    const workflows = server.deps.workflows as { summaries: (...args: unknown[]) => Promise<unknown> };
    const original = workflows.summaries.bind(workflows);
    workflows.summaries = async (...args: unknown[]) => {
      await new Promise((resolve) => setTimeout(resolve, 900));
      return original(...args);
    };
    const client = await server.client(server.admin.token);
    try {
      const result = await client.call('list_task_packs', {});
      assert.equal(result.isError, false);
      assert.equal((result.structuredContent as { call_result?: string }).call_result, 'ok');
    } finally {
      workflows.summaries = original;
      await client.close();
    }
  });
});
