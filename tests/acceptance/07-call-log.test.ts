// Scenario 7 (brief section 9): Call log: one line per call with trace id and session id;
// argument digest and size only.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { DOCUMENTS } from '../fixtures/agile/index.ts';
import { openConsole, requestHttp, type ConsoleClient } from './support/console.ts';
import { openBed, type Bed } from './support/hub.ts';
import type { McpClient } from './support/mcp.ts';

let postgres: TemporaryPostgres;
let bed: Bed;
let client: McpClient;
let consoleClient: ConsoleClient;

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const TRACEPARENT = `00-${TRACE_ID}-00f067aa0ba902b7-01`;
const SESSION_ID = 'sess-s07-trace';

before(async () => {
  postgres = await startPostgres();
  bed = await openBed({ postgres });
  client = await bed.connect(bed.reviewer, { sessionId: SESSION_ID, traceparent: TRACEPARENT });
  consoleClient = await openConsole(bed.hub, bed.hub.admin.token);
});
after(async () => {
  await bed?.close();
  await postgres?.stop();
});

describe('scenario 7: call log', () => {
  test('one line per call with trace id and session id; argument digest and size only', async () => {
    // Make 3 distinct MCP calls with the client configured with traceparent & session
    const listAnswer = await client.call('list_task_packs', {});
    assert.equal(listAnswer.isError, false);
    assert.equal(listAnswer.out.trace, TRACE_ID, 'list_task_packs answer trace matches traceparent');

    const uploadAnswer = await client.call('upload_file', {
      file_path: Buffer.from(JSON.stringify({ test: 'content' })).toString('base64'),
      name: 'test.json',
      media_type: 'application/json',
    });
    assert.equal(uploadAnswer.isError, false);
    assert.equal(uploadAnswer.out.trace, TRACE_ID);

    const startAnswer = await client.call('start_run', {
      pack: 'case-review',
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } },
    });
    assert.equal(startAnswer.isError, false);
    assert.equal(startAnswer.out.trace, TRACE_ID);

    // Query call log for this user
    const logPage = await bed.hub.records.callLog.query(bed.hub.admin.principal, {
      userId: bed.reviewer.user.id,
      newestFirst: false,
    });

    const userCalls = logPage.items.filter(
      (entry) => entry.tool === 'list_task_packs' || entry.tool === 'upload_file' || entry.tool === 'start_run',
    );

    assert.equal(userCalls.length, 3, 'exactly one line per tool call');

    for (const call of userCalls) {
      assert.equal(call.trace_id, TRACE_ID, 'trace_id matches W3C traceparent trace id');
      assert.equal(call.session, SESSION_ID, 'session id matches Circle-Session-Id header');
      assert.match(call.args_digest, /^[0-9a-f]{64}$/, 'args_digest is sha256 hex');
      assert.ok(typeof call.args_size === 'number' && call.args_size > 0, 'args_size is positive byte count');
      assert.equal(call.call_result, 'ok', 'call_result is ok');
      assert.equal(call.user, bed.reviewer.user.id, 'user id is recorded');
      assert.ok(typeof call.duration_ms === 'number' && call.duration_ms >= 0, 'duration_ms is recorded');

      // The full raw arguments must NOT be stored in the call log entry
      assert.equal((call as unknown as Record<string, unknown>).arguments, undefined);
    }

    // Console HTML check: /console/admin/calls displays the calls
    const callsHtml = await consoleClient.get('/console/admin/calls');
    assert.equal(callsHtml.status, 200);
    assert.ok(callsHtml.body.includes(TRACE_ID), 'console calls page contains trace id');
    assert.ok(callsHtml.body.includes('list_task_packs'), 'console calls page contains tool name');
  });

  test('refused batch JSON-RPC request logs one call log line per request in batch', async () => {
    // Send a batch request (array of 3 JSON-RPC requests) to /mcp
    const batchBody = JSON.stringify([
      { jsonrpc: '2.0', id: 'b1', method: 'tools/call', params: { name: 'list_task_packs', arguments: {} } },
      { jsonrpc: '2.0', id: 'b2', method: 'tools/call', params: { name: 'list_task_packs', arguments: {} } },
      { jsonrpc: '2.0', id: 'b3', method: 'tools/call', params: { name: 'list_task_packs', arguments: {} } },
    ]);
    const res = await requestHttp(bed.hub.port, '/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${bed.reviewer.token}`,
      },
      body: batchBody,
    });
    assert.equal(res.status, 400);

    // Query call log for reviewer
    const logPage = await bed.hub.records.callLog.query(bed.hub.admin.principal, {
      userId: bed.reviewer.user.id,
      newestFirst: false,
    });
    const batchCalls = logPage.items.filter((entry) =>
      entry.admin_reasons?.some(reason=>reason.includes('JSON-RPC batch refused')),
    );
    assert.equal(batchCalls.length, 3, 'exactly 3 call log lines logged, one for each request in the batch');
    for (let i = 0; i < 3; i++) {
      assert.equal(batchCalls[i].call_result, 'transport_failure');
      assert.ok(batchCalls[i].admin_reasons?.some(reason=>reason.includes(`request ${i + 1} of 3`)));
    }
  });
});
