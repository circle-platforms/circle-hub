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

    const callsHtml = await consoleClient.get('/console/records');
    assert.equal(callsHtml.status, 200);
    assert.ok(callsHtml.body.includes('list_task_packs'), 'console calls page contains tool name');
    // The list names the call; its trace and session are read in the pane a row opens (decision 151: technical values
    // stand in the technical details, not in columns of every row).
    assert.ok(!callsHtml.body.includes(TRACE_ID), 'the list of calls carries no trace id');
    assert.ok(callsHtml.body.includes('call=' + userCalls[0].digest), 'each row links to its call');
    const oneCall = await consoleClient.get('/console/records?call=' + userCalls[0].digest);
    assert.equal(oneCall.status, 200);
    assert.ok(oneCall.body.includes(TRACE_ID), 'the selected call shows its trace id');
    assert.ok(oneCall.body.includes(SESSION_ID), 'and its session id');
  });

  test('a rejected pack function has a private argument preview and the errors the caller received', async () => {
    const { logsCommand } = await import('../../hub/server/cli.ts');
    const { hub } = bed;
    await hub.assignPack(bed.reviewer.principal, 'test-bed');
    const inventory = { schema: 'test-bed-manifest@1', beds: [{ name: 'synthetic', services: [], reserved: [], devices: [
      { name: 'a', type: 'client', ipv4: ['192.0.2.10/26'], ipv6: [] },
      { name: 'b', type: 'client', ipv4: ['192.0.2.10/26'], ipv6: [] },
    ] }] };
    await hub.hub.docs.put(hub.admin.principal, 'synthetic-log', Buffer.from(JSON.stringify(inventory)), { fileName: 'synthetic.json' });
    const member = await bed.connect(bed.reviewer);
    const answer = await member.call('start_run', { pack: 'test-bed', inputs: { inventory: { external: 'doc:doc:synthetic-log' } }, parameters: { action: 'search' } });
    assert.equal(answer.out.errors[0].code, 'test-bed.manifest_invalid');
    const lines: string[] = [];
    const io = { cwd: hub.records.dataDir, env: { CIRCLE_HUB_TOKEN: hub.admin.token }, stdout: (s: string) => lines.push(s), stderr: (s: string) => assert.fail(s) };
    assert.equal(await logsCommand(['export', '--tool', 'start_run'], {
      io, records: async () => hub.records, config: () => assert.fail('the supplied token authenticates directly'), deps: async () => hub.deps, actingAdmin: async () => hub.admin.principal,
    }, { io }), 0);
    const row = lines.join('\n').split('\n').map(s => JSON.parse(s)).find(row => row.trace_id === answer.out.trace);
    const reasons: string[] = row.admin_reasons ?? [];
    const preview = reasons.find(reason => reason.startsWith('参数预览 '));
    assert.ok(preview, 'administrator export has a redacted preview');
    const args = JSON.parse(preview.slice('参数预览 '.length));
    assert.equal(args.pack, 'test-bed');
    assert.equal(args.inputs.inventory.external, 'doc:doc:synthetic-log');
    assert.deepEqual(Object.keys(args.parameters), ['action']);
    assert.equal(args.parameters.action.type, 'string');
    assert.ok(!preview.includes('search'));
    const errors = reasons.filter(reason => reason.startsWith('调用错误 ')).map(reason => JSON.parse(reason.slice('调用错误 '.length)));
    assert.deepEqual(errors, answer.out.errors.map(({ code, path, message, fix }) => ({ code, path, message, fix })));
    const inspector = await consoleClient.get('/console/records?call=' + row.digest);
    assert.ok(inspector.body.includes('参数预览') && inspector.body.includes(answer.out.errors[0].message));
    assert.equal(row.args_preview, null);
    const publicReceipt = await hub.records.store.get(row.digest);
    const memberRow = (await hub.records.callLog.query(bed.reviewer.principal, { traceId: answer.out.trace })).items[0];
    const observation = await member.call('get_nodes', { observability: { calls: { trace: answer.out.trace } } });
    for (const view of [publicReceipt, memberRow, observation.out]) {
      assert.doesNotMatch(JSON.stringify(view), /synthetic-log|参数预览|manifest_invalid.*自动化测试环境清单/);
    }
    const success = await member.call('list_task_packs', {});
    const okRow = (await hub.records.callLog.query(hub.admin.principal, { traceId: success.out.trace })).items[0];
    assert.equal(okRow.call_result, 'ok');
    assert.equal(okRow.args_preview, null);
    assert.ok(!okRow.admin_reasons?.some(reason => reason.startsWith('参数预览 ')));
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
