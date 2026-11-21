import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { GetNodesOutput, ListTaskPacksOutput } from '../../contracts/src/tools.ts';
import { healthReader } from '../health/api.ts';
import { canonicalBytes, sha256Hex } from '../records/api.ts';
import { Database, createPool } from '../records/db.ts';
import { TraceReader, addEvent, startTelemetry, startTrace, updateTrace, type Telemetry } from '../telemetry/api.ts';
import { createTestServer, type TestMcpClient, type TestServer } from './testing.ts';

const SHARED_TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const LARGE_TRACE = 'a99970d70c924089bb7bfcf6a5bb1547';
const SESSION = 'synthetic-shared-session';
const PRIVATE = 'synthetic-private-text';

let server: TestServer;
let db: Database;
let telemetry: Telemetry;

before(async () => {
  server = await createTestServer({ observation: records => {
    db = new Database(createPool(records.database, 2));
    return { health: healthReader(db), traces: new TraceReader(db), writer: () => telemetry?.stats() ?? null };
  } });
  telemetry = startTelemetry({ database: server.records.database });
});

after(async () => {
  await telemetry?.close();
  await db?.end();
  await server?.close();
});

async function observation(client: TestMcpClient, query: Record<string, unknown>) {
  const reply = await client.call('get_nodes', { observability: query });
  assert.equal(reply.isError, false, JSON.stringify(reply.content));
  assert.doesNotMatch(JSON.stringify(reply), /synthetic-private-text|args_preview|admin_note|admin_reasons|status_message/);
  const value = GetNodesOutput.parse(reply.structuredContent).observability;
  assert.ok(value);
  return value;
}

test('ordinary MCP initialization leads to a bundled, version-pinned skill', async () => {
  const account = await server.createUser('技能用户');
  const client = await server.client(account.token);
  assert.match(client.client.getInstructions() ?? '', /hub-observability/);
  assert.equal((await client.listTools()).tools.length, 6);
  const folder = new URL('../../packs/skill/hub-observability/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('pack.json', folder), 'utf8'));
  const list = await client.call('list_task_packs', { kind: 'skill', pack_id: 'hub-observability' });
  // Nothing is assigned to this account: the bundled skill is listed all the same, and the head still names the next step.
  assert.match(list.content[0].text ?? '', /^当前账户可用的工作流和技能共 1 个。[^\n]*请联系管理员把该账户加入团队或分配工作流。\nHub 调用观测\n/);
  // The answer carries the caller's capabilities beside the contract's fields (the published output schema is open).
  const { member_capabilities: _capabilities, ...listed } = list.structuredContent;
  const { packs: [pack] } = ListTaskPacksOutput.parse(listed);
  assert.equal(pack.pack, 'hub-observability@1.0.0');
  assert.equal(pack.digest, sha256Hex(canonicalBytes(manifest)));
  const read = await client.call('get_nodes', { pack: pack.pack, file: 'SKILL.md' });
  const file = GetNodesOutput.parse(read.structuredContent).skill_file;
  assert.ok(file);
  assert.equal(file.text, readFileSync(new URL('SKILL.md', folder), 'utf8'));
  assert.equal(file.sha256, sha256Hex(file.text));
  assert.equal(file.sha256, manifest.files[0].sha256);
  assert.equal(read.content[0].text, file.text, 'the reader-facing text is the skill file itself');
  assert.match(JSON.stringify(read.content), /observability/);
  assert.equal((await client.call('get_nodes', { pack: pack.pack, file: '../SKILL.md' })).isError, true);
  assert.equal((await client.call('start_run', { pack: pack.pack })).isError, true);
});

test('session lists page within the live account scope and trace trees hide other rows', async () => {
  const alice = await server.createUser('观测成员一');
  const bob = await server.createUser('观测成员二');
  const admin = await server.createUser('观测管理员', 'admin');
  const headers = { sessionId: SESSION, traceparent: `00-${SHARED_TRACE}-00f067aa0ba902b7-01` };
  const a = await server.client(alice.token, headers);
  const b = await server.client(bob.token, headers);
  const operator = await server.client(admin.token);
  const calls = { session: SESSION, tool: 'list_task_packs', limit: 1 };
  await a.call('list_task_packs');
  await a.call('list_task_packs');
  await b.call('list_task_packs');
  await server.records.callLog.append({ traceId: SHARED_TRACE, userId: bob.user.id, sessionId: SESSION,
    tool: 'list_task_packs', runId: null, arguments: { private: PRIVATE }, argsPreview: PRIVATE, callResult: 'ok', durationMs: 15,
    adminNote: PRIVATE });
  startTrace({ traceId: SHARED_TRACE, name: 'get_nodes', origin: 'mcp' }, () => {
    updateTrace({ userId: bob.user.id });
    addEvent('slow-query', 'warning', PRIVATE);
  });
  await telemetry.flush();
  const listed = await a.call('get_nodes', { observability: { calls } });
  assert.match(listed.content[0].text ?? '', /^调用记录 1 条。\n[^\n]*，list_task_packs，正常，耗时 \d+ 毫秒\n还有调用记录未列出，请继续读取。$/);
  const first = await observation(a, { calls });
  assert.ok('calls' in first && first.next);
  assert.equal(first.calls.length, 1);
  assert.equal(first.calls[0].user, alice.user.id);
  const second = await observation(a, { calls: { ...calls, cursor: first.next } });
  assert.ok('calls' in second);
  assert.equal(second.calls.length, 1);
  assert.equal(second.next, null);
  assert.notEqual(second.calls[0].span_id, first.calls[0].span_id);
  assert.deepEqual(await observation(a, { calls: { ...calls, user: bob.user.id } }), { calls: [], next: null });
  const team = await observation(operator, { calls: { ...calls, limit: 10 } });
  assert.ok('calls' in team);
  assert.deepEqual(new Set(team.calls.map(call => call.user)), new Set([alice.user.id, bob.user.id]));
  const tree = await observation(a, { trace: SHARED_TRACE });
  assert.ok('trace' in tree && tree.trace);
  assert.ok(tree.trace.roots.some(root => root.span_id === first.calls[0].span_id && root.children.length));
  assert.ok(tree.trace.roots.every(root => root.user_id === alice.user.id));
  const allTrees = await observation(operator, { trace: SHARED_TRACE });
  assert.ok('trace' in allTrees && allTrees.trace);
  assert.ok(allTrees.trace.roots.some(root => root.user_id === bob.user.id));
  assert.ok(allTrees.trace.roots.some(root => root.user_id === alice.user.id));
  assert.deepEqual(await observation(a, { trace: LARGE_TRACE }), { trace: null });
  await server.records.principals.setRole(server.admin.principal, admin.user.id, 'user');
  assert.deepEqual(await observation(operator, { calls }), { calls: [], next: null });
  assert.deepEqual(await observation(operator, { trace: SHARED_TRACE }), { trace: null });
  await server.records.principals.setDisabled(server.admin.principal, admin.user.id, true);
  await assert.rejects(operator.call('get_nodes', { observability: { calls } }), /401|认证|Bearer/);
});

test('large trace detail is capped and never replayed by long-call recovery', async () => {
  const user = await server.createUser('观测上限用户');
  const client = await server.client(user.token);
  startTrace({ traceId: LARGE_TRACE, name: 'get_nodes', origin: 'mcp' }, () => {
    updateTrace({ userId: user.user.id });
    for (let index = 0; index < 220; index++) addEvent('slow-query', 'warning', PRIVATE);
  });
  await telemetry.flush();
  const args = { observability: { trace: LARGE_TRACE } };
  const reply = await client.call('get_nodes', args);
  const detail = GetNodesOutput.parse(reply.structuredContent).observability;
  assert.ok(detail && 'trace' in detail && detail.trace?.truncated);
  const pending = [...detail.trace.roots];
  let count = 0;
  while (pending.length) {
    count++;
    pending.push(...pending.pop()!.children);
  }
  assert.equal(count, 200);
  assert.match(reply.content[0].text ?? '', /^这次调用的步骤 200 个，超过读取上限，只列出一部分。\nget_nodes，耗时 \d+ 毫秒[^\n]*\n  slow-query，耗时 0 毫秒，警告\n/);
  assert.match(JSON.stringify(reply.content), /slow-query/);
  assert.doesNotMatch(JSON.stringify(reply.content), /synthetic-private-text/);
  const recovered = await client.call('get_nodes', { call_query: { get_nodes: args, trace: reply.structuredContent.trace } });
  assert.ok(recovered.structuredContent.call_status);
  assert.equal(recovered.structuredContent.observability, undefined);
  assert.equal((await client.call('get_nodes', { ...args, pack: 'hub-observability' })).isError, true);
  assert.equal((await client.call('get_nodes', { observability: { calls: { cursor: 'invalid' } } })).isError, true);
});
