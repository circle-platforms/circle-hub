// The MCP surface through the official SDK client over streamable HTTP (raw POSTs where the SDK would not send the body):
// every tool's happy and error paths, the published schemas and per-caller annotations, the isError matrix, output schemas,
// the plain-text content, absent equals forbidden, records by reference, the call log (no argument content, refused
// batches, notes records would refuse), trace and session ids, token revocation, concurrent calls, and service answers that
// violate their output schema.
import assert from 'node:assert/strict';
import { readdir, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { PROTOCOL_CODES } from '../../contracts/generated/protocol.ts';
import type { PermissionRole } from '../../contracts/generated/vocabulary.ts';
import { SubmitResultOutput } from '../../contracts/src/tools.ts';
import { SERVER_INSTRUCTIONS, TOOLS } from '../../contracts/src/tools.ts';
import { canonicalize, sha256Hex, type CallLogInput } from '../records/api.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { ROOT_1, defaultPacks, fakeWorkflowPack } from './fakes.ts';
import { createTestServer, type TestMcpClient, type TestServer, type TestUser, type ToolCallResult } from './testing.ts';

type Published = { name: string; title: string; description: string; inputSchema: unknown; outputSchema: unknown; annotations: Record<string, boolean> };
const PUBLISHED = JSON.parse(readFileSync(new URL('../../contracts/generated/tools.json', import.meta.url), 'utf8')) as Published[];

const b64 = (data: string | Buffer): string => Buffer.from(data).toString('base64');
const MINDMAP = JSON.stringify({
  root: { data: { id: 'n1', text: '合成用例集' }, children: [{ data: { id: 'n2', text: '用例 甲', priority: 1, resource: ['tag'] }, children: [] }] },
  template: 'default',
  theme: 'fresh-blue',
  version: '1.4.43',
});
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const TRACEPARENT = `00-${TRACE}-00f067aa0ba902b7-01`;

let postgres: TemporaryPostgres;
let server: TestServer;
let counter = 0;

before(async () => {
  postgres = await startPostgres();
  server = await createTestServer({ postgres });
});
after(async () => {
  await server?.close();
  await postgres?.stop();
});

async function person(packs: string[] = ['review'], role: PermissionRole = 'user'): Promise<TestUser> {
  counter += 1;
  const user = await server.createUser(`用户${counter}`, role);
  for (const pack of packs) await server.assign(user.principal, pack);
  return user;
}

async function connect(user: TestUser, options: Parameters<TestServer['client']>[1] = {}): Promise<TestMcpClient> {
  return server.client(user.token, options);
}

function output(name: string) {
  const tool = TOOLS.find((t) => t.name === name);
  assert.ok(tool);
  return tool.output;
}

/** A tool result with its trace taken out, to compare two answers. */
function comparable(result: ToolCallResult): unknown {
  const trace = String(result.structuredContent.trace);
  return {
    isError: result.isError,
    structured: { ...result.structuredContent, trace: 'TRACE' },
    text: result.content.map((block) => block.text?.replaceAll(trace, 'TRACE')),
  };
}

function firstError(result: ToolCallResult): { code: string; path?: string; message: string; fix?: string } {
  const errors = result.structuredContent.errors as { code: string; path?: string; message: string; fix?: string }[];
  assert.ok(errors.length > 0, 'an error answer names a code');
  return errors[0];
}

async function upload(client: TestMcpClient, content: string, extra: Record<string, unknown> = {}): Promise<ToolCallResult> {
  return client.call('upload_file', { file_path: b64(content), ...extra });
}

async function startRun(client: TestMcpClient, reference: string, pack = 'review'): Promise<ToolCallResult> {
  return client.call('start_run', { pack, inputs: { subject: { reference } } });
}

/** A raw POST /mcp with exactly this body (the SDK client never sends batches or odd member names). */
async function post(token: string, body: string): Promise<{ status: number; json: unknown }> {
  const reply = await fetch(server.mcpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body,
  });
  const text = await reply.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: reply.status, json };
}

describe('initialize and tools/list', () => {
  test('initialize returns serverInfo circle-hub, the instructions and the tools capability', async () => {
    const user = await person();
    const client = await connect(user);
    assert.equal(client.client.getServerVersion()?.name, 'circle-hub');
    assert.equal(client.client.getInstructions(), SERVER_INSTRUCTIONS);
    assert.ok(client.client.getServerCapabilities()?.tools, 'the tools capability is declared');
    await client.close();
  });

  test('tools/list gives the six published tools; with an external input the annotations equal tools.json', async () => {
    const user = await person(['review']);
    const client = await connect(user);
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      PUBLISHED.map((t) => t.name),
    );
    for (const tool of tools) {
      const expected = PUBLISHED.find((t) => t.name === tool.name)!;
      assert.equal(tool.title, expected.title);
      assert.equal(tool.description, expected.description);
      assert.deepEqual(tool.inputSchema, expected.inputSchema, `${tool.name} input schema is the published one`);
      assert.deepEqual(tool.outputSchema, expected.outputSchema, `${tool.name} output schema is the published one`);
      assert.deepEqual(tool.annotations, expected.annotations, `${tool.name} annotations`);
    }
    await client.close();
  });

  test('without a pack that reads an external system start_run is closed-world; the other annotations stay the same', async () => {
    for (const packs of [['local-review'], []]) {
      const user = await person(packs);
      const client = await connect(user);
      const { tools } = await client.listTools();
      for (const tool of tools) {
        const expected = PUBLISHED.find((t) => t.name === tool.name)!.annotations;
        if (tool.name === 'start_run') assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: false, openWorldHint: false });
        else assert.deepEqual(tool.annotations, expected, tool.name);
      }
      await client.close();
    }
  });

  test('start_run is open-world for a caller whose pack binds expected sources at start_run, whatever its inputs accept', async () => {
    const packs = [...defaultPacks(), fakeWorkflowPack('expected-review', '合成期望来源评审', ['application/json'], { expectedSources: true })];
    const other = await createTestServer({ postgres, packs });
    try {
      const user = await other.createUser('期望来源');
      await other.assign(user.principal, 'expected-review');
      const client = await other.client(user.token);
      const start = (await client.listTools()).tools.find((t) => t.name === 'start_run')!;
      assert.equal(start.annotations?.openWorldHint, true, 'the expected sources are read from external systems');
      assert.deepEqual(start.annotations, PUBLISHED.find((t) => t.name === 'start_run')!.annotations);
      await client.close();
    } finally {
      await other.close();
    }
  });

  test('start_run stays closed-world for a pack whose inputs take only the Hub\'s own knowledge views: reading them is Hub-internal', async () => {
    const packs = [
      ...defaultPacks(),
      fakeWorkflowPack('scope', '合成回归范围', ['knowledge:impact', 'knowledge:facets', 'knowledge:index', 'application/json'], { factsOnly: true }),
      fakeWorkflowPack('scope-outside', '合成外部范围', ['knowledge:impact', 'tracker:document'], { factsOnly: true }),
    ];
    const other = await createTestServer({ postgres, packs });
    try {
      for (const [pack, open] of [['scope', false], ['scope-outside', true]] as const) {
        const user = await other.createUser(`范围 ${pack}`);
        await other.assign(user.principal, pack);
        const client = await other.client(user.token);
        const start = (await client.listTools()).tools.find((t) => t.name === 'start_run')!;
        assert.equal(start.annotations?.openWorldHint, open, `${pack}: a knowledge view is not an external system, an external type is`);
        if (!open) assert.deepEqual(start.annotations, { readOnlyHint: false, destructiveHint: false, openWorldHint: false });
        await client.close();
      }
    } finally {
      await other.close();
    }
  });

  test('an unknown tool is a JSON-RPC error, not a tool result', async () => {
    const client = await connect(await person());
    await assert.rejects(client.client.callTool({ name: 'delete_everything', arguments: {} }), (error: unknown) => error instanceof McpError && /没有这个工具/.test(error.message));
    await client.close();
  });
});

describe('list_task_packs', () => {
  test('lists the assigned workflow packs, filters by kind and refuses bad arguments with the empty shape', async () => {
    const user = await person(['review', 'local-review']);
    const client = await connect(user);
    const all = await client.call('list_task_packs', {});
    assert.equal(all.isError, false);
    assert.deepEqual((all.structuredContent.packs as { id: string }[]).map((p) => p.id).sort(), ['local-review', 'review']);
    assert.match(all.content[0].text ?? '', /^可用的任务包 2 个/);
    const products = await client.call('list_task_packs', { kind: 'product' });
    assert.deepEqual(products.structuredContent.packs, []);
    const bad = await client.call('list_task_packs', { kind: 'plugin' });
    assert.equal(bad.isError, true);
    assert.equal(firstError(bad).code, 'SUBMISSION_SCHEMA_VIOLATION');
    assert.equal(firstError(bad).path, '/kind');
    assert.deepEqual(bad.structuredContent.packs, []);
    const misspelled = await client.call('list_task_packs', { knd: 'workflow' });
    assert.equal(firstError(misspelled).path, '/knd');
    const huge = await client.call('list_task_packs', { ['k'.repeat(9000)]: 1 });
    assert.equal(huge.isError, true, 'a huge unknown key is still a schema violation, not an internal error');
    assert.equal(firstError(huge).path, '');
    await client.close();
  });

  test('a user without packs gets an empty list, not an error', async () => {
    const client = await connect(await person([]));
    const result = await client.call('list_task_packs', {});
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent.packs, []);
    await client.close();
  });
});

describe('upload_file', () => {
  test('an upload is accepted with its src reference, size, media type and the parser structure; the same bytes give the same reference', async () => {
    const client = await connect(await person());
    const first = await upload(client, MINDMAP, { name: 'map.json' });
    assert.equal(first.isError, false);
    const s = first.structuredContent;
    assert.equal(s.acceptance, 'accepted');
    assert.equal(s.reference, `src:${s.sha256}`);
    assert.equal(s.size, Buffer.byteLength(MINDMAP));
    assert.equal(s.media_type, 'application/json');
    assert.equal((s.structure as { parser?: string }).parser, 'kityminder@1');
    assert.match(first.content[0].text ?? '', /^回执：已受理，引用 src:/);
    const again = await upload(client, MINDMAP, { name: 'map.json' });
    assert.equal(again.structuredContent.reference, s.reference);
    const markdown = await upload(client, '# 标题\n\n正文\n', { name: 'note.md' });
    assert.equal(markdown.structuredContent.media_type, 'text/markdown');
    const sniffed = await upload(client, '{"a":1}');
    assert.equal(sniffed.structuredContent.media_type, 'application/json');
    await client.close();
  });

  test('only an explicit operation capture upload changes provenance from declared to client_captured', async () => {
    const client = await connect(await person());
    const content = '合成操作输出：ORBIT 状态正常\n';
    const ordinary = await upload(client, content);
    assert.equal(ordinary.isError, false);
    const captured = await upload(client, content, { provenance_type: 'client_captured' });
    assert.equal(captured.isError, false);
    assert.equal(captured.structuredContent.reference, ordinary.structuredContent.reference);
    const rows = await server.records.artifacts.records(String(captured.structuredContent.sha256));
    assert.deepEqual(rows.map(row => row.body.provenance_type).sort(), ['client_captured', 'declared']);
    for (const provenance_type of ['observed', 'projected', 'candidate']) {
      const refused = await upload(client, content, { provenance_type });
      assert.equal(refused.isError, true);
      assert.equal(firstError(refused).path, '/provenance_type');
    }
    await client.close();
  });

  test('a credential in the upload is not accepted: CREDENTIAL_IN_UPLOAD, no reference, isError', async () => {
    const client = await connect(await person());
    const result = await upload(client, '配置说明\ndb_password = "Xk9!rT2#qL"\n', { name: 'conf.txt' });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.acceptance, 'not_accepted');
    assert.equal(result.structuredContent.reference, undefined);
    assert.match(String(result.structuredContent.sha256), /^[0-9a-f]{64}$/);
    const error = firstError(result);
    assert.equal(error.code, 'CREDENTIAL_IN_UPLOAD');
    assert.equal(error.fix, PROTOCOL_CODES.CREDENTIAL_IN_UPLOAD.fix);
    assert.match(error.message, /第 2 行/);
    assert.doesNotMatch(JSON.stringify(result), /Xk9!rT2#qL/, 'the credential is never echoed');
    await client.close();
  });

  test('non-canonical base64, a path instead of content, a bad media type or name are schema violations', async () => {
    const client = await connect(await person());
    const padding = await client.call('upload_file', { file_path: 'QR==' });
    assert.equal(padding.isError, true);
    assert.equal(firstError(padding).path, '/file_path');
    assert.equal(padding.structuredContent.acceptance, 'not_accepted');
    const path = await client.call('upload_file', { file_path: './map.json' });
    assert.equal(firstError(path).code, 'SUBMISSION_SCHEMA_VIOLATION');
    const media = await client.call('upload_file', { file_path: b64('x'), media_type: 'not a type' });
    assert.equal(firstError(media).path, '/media_type');
    const name = await client.call('upload_file', { file_path: b64('x'), name: 'a\u0007b' });
    assert.equal(firstError(name).path, '/name');
    await client.close();
  });

  test('an upload over the configured cap is refused whole', async () => {
    const small = await createTestServer({ postgres, limits: { maxUploadBytes: 1024 } });
    try {
      const user = await small.createUser('上传者');
      const client = await small.client(user.token);
      const result = await client.call('upload_file', { file_path: b64('a'.repeat(2048)) });
      assert.equal(result.isError, true);
      assert.match(firstError(result).message, /超过上限 1024 字节/);
    } finally {
      await small.close();
    }
  });
});

describe('start_run, get_nodes, resolve_reference, submit_result', () => {
  test('start_run with an uploaded input and with an external object; a bad argument is a schema violation', async () => {
    const user = await person(['review']);
    const client = await connect(user, { sessionId: 'sess-start-1' });
    const uploaded = await upload(client, MINDMAP);
    const run = await startRun(client, String(uploaded.structuredContent.reference));
    assert.equal(run.isError, false);
    const summary = run.structuredContent.run as { run: string; items: unknown[]; session?: string; root?: string };
    assert.match(summary.run, /^run_/);
    assert.equal(summary.items.length, 3);
    assert.equal(summary.session, 'sess-start-1', 'the service got the session id from the header');
    assert.equal(summary.root, ROOT_1);
    assert.match(run.content[0].text ?? '', new RegExp(`^运行 ${summary.run}：`));
    assert.match(run.content[0].text ?? '', /规程：/);
    const external = await client.call('start_run', { pack: 'review', inputs: { subject: { external: 'tracker:document:42' } } });
    assert.equal(external.isError, false);
    const misspelled = await client.call('start_run', { pack: 'review', inputs: {}, buidl: 'b-1' });
    assert.equal(misspelled.isError, true);
    assert.equal(firstError(misspelled).path, '/buidl');
    assert.equal(misspelled.structuredContent.run, undefined);
    await client.close();
  });

  test('get_nodes reads the run root, a root, subtrees and references by read tier', async () => {
    const user = await person(['review']);
    const client = await connect(user);
    const uploaded = await upload(client, MINDMAP);
    const reference = String(uploaded.structuredContent.reference);
    const run = (await startRun(client, reference)).structuredContent.run as { run: string };
    const byRun = await client.call('get_nodes', { run: run.run });
    assert.equal(byRun.isError, false);
    assert.equal(byRun.structuredContent.root, ROOT_1);
    const nodes = byRun.structuredContent.nodes as { path: string; reference: string }[];
    assert.deepEqual(nodes.map((n) => n.path), ['/', '/catalog']);
    assert.equal(nodes[0].reference, `tree:${ROOT_1}/`);
    const deep = await client.call('get_nodes', { root: ROOT_1, paths: ['/catalog/alpha'], depth: 2 });
    assert.deepEqual((deep.structuredContent.nodes as { path: string }[]).map((n) => n.path), ['/catalog/alpha', '/catalog/alpha/beta']);
    assert.deepEqual(deep.structuredContent.coverage, { complete: true, examined: 2, total: 2 });

    const whole = await client.call('get_nodes', { reference });
    const content = whole.structuredContent.content as { read_tier: string; text?: string; sha256?: string; readable: boolean };
    assert.equal(content.read_tier, 'model_readable');
    assert.equal(content.text, MINDMAP);
    assert.equal(content.readable, true);
    const fragment = await client.call('get_nodes', { reference: `${reference}/kityminder@1/n/n2` });
    assert.equal((fragment.structuredContent.content as { text: string }).text, '用例 甲');
    const tree = await client.call('get_nodes', { reference: `tree:${ROOT_1}/catalog/alpha` });
    assert.equal((tree.structuredContent.content as { text: string }).text, 'alpha');
    const runRecord = server.fakes.runs.runs.get(run.run)!.recordDigest;
    const rec = await client.call('get_nodes', { reference: `rec:${runRecord}#/run` });
    assert.equal((rec.structuredContent.content as { text: string }).text, run.run);
    await client.close();
  });

  test('get_nodes by reference follows the read tier: function bytes give structure only, retain-only gives the note', async () => {
    const admin = server.admin;
    const restricted = await server.records.artifacts.ingest({
      bytes: Buffer.from(MINDMAP.replace('合成用例集', '受限用例集')),
      mediaType: 'application/json',
      origin: { upload: { session: null } },
      author: { user: admin.principal.id },
      provenanceType: 'declared',
      visibility: { readers: [admin.principal.id], admins: true, packs: [], shareable: true },
      readTier: 'function_bytes_only',
    });
    const secret = await server.records.artifacts.ingest({
      bytes: Buffer.from('读取到的页面\ndb_password = "Xk9!rT2#qL"\n'),
      mediaType: 'text/plain',
      origin: { read: { object: 'tracker:page:7' } },
      author: { user: null },
      provenanceType: 'observed',
      visibility: { readers: [], admins: true, packs: [], shareable: false },
    });
    const client = await connect(admin);
    const fn = await client.call('get_nodes', { reference: `src:${restricted.body.sha256}/kityminder@1/n/n2` });
    const fnContent = fn.structuredContent.content as Record<string, unknown>;
    assert.equal(fnContent.read_tier, 'function_bytes_only');
    assert.equal(fnContent.text, undefined);
    assert.equal(fnContent.readable, false);
    assert.ok(fnContent.structure, 'a structure summary instead of text');
    const kept = await client.call('get_nodes', { reference: `src:${secret.body.sha256}` });
    const keptContent = kept.structuredContent.content as Record<string, unknown>;
    assert.equal(keptContent.read_tier, 'retain_only');
    assert.equal(keptContent.readable, false);
    assert.equal(keptContent.note, '含凭据，原文不可读');
    assert.doesNotMatch(JSON.stringify(kept), /Xk9!rT2#qL/);
    await client.close();
  });

  test('get_nodes refuses a call without run, root or reference, and a reference mixed with paths', async () => {
    const client = await connect(await person());
    const none = await client.call('get_nodes', {});
    assert.equal(none.isError, true);
    assert.equal(firstError(none).code, 'SUBMISSION_SCHEMA_VIOLATION');
    const mixed = await client.call('get_nodes', { reference: `tree:${ROOT_1}/`, paths: ['/'] });
    assert.equal(firstError(mixed).path, '/paths');
    const malformed = await client.call('get_nodes', { reference: `tree:${ROOT_1}/x//y` });
    assert.equal(firstError(malformed).code, 'SUBMISSION_SCHEMA_VIOLATION');
    const reference = String((await upload(client, MINDMAP)).structuredContent.reference);
    const missing = await client.call('get_nodes', { reference: `${reference}/kityminder@1/n/no-such-node` });
    assert.equal(missing.isError, true);
    assert.equal(firstError(missing).code, 'REFERENCE_UNRESOLVED');
    assert.equal(missing.structuredContent.content, undefined);
    const parser = await client.call('get_nodes', { reference: `${reference}/nosuchparser@1/x` });
    assert.equal(firstError(parser).code, 'REFERENCE_UNRESOLVED');
    await client.close();
  });

  test('resolve_reference delegates to the runs service; a bad argument is refused with the empty shape', async () => {
    const user = await person();
    const client = await connect(user);
    const reference = String((await upload(client, MINDMAP)).structuredContent.reference);
    const run = (await startRun(client, reference)).structuredContent.run as { run: string };
    const resolved = await client.call('resolve_reference', { run: run.run, text: '合成用例一' });
    assert.equal(resolved.isError, false);
    assert.equal(resolved.structuredContent.resolution, 'resolved');
    assert.match(resolved.content[0].text ?? '', /^解析状态：已解析/);
    const unresolved = await client.call('resolve_reference', { run: run.run, text: '不存在的值' });
    assert.equal(unresolved.isError, false, 'unresolved is an answer, not an error');
    assert.equal(unresolved.structuredContent.resolution, 'unresolved');
    const bad = await client.call('resolve_reference', { run: run.run, text: '' });
    assert.equal(bad.isError, true);
    assert.deepEqual(bad.structuredContent.references, []);
    assert.deepEqual(bad.structuredContent.diagnostics, []);
    await client.close();
  });

  test('submit_result: accepted with partitions and counts (unknown is not an error), not accepted, malformed run, repeat', async () => {
    const user = await person();
    const client = await connect(user);
    const reference = String((await upload(client, MINDMAP)).structuredContent.reference);
    const run = (await startRun(client, reference)).structuredContent.run as { run: string };
    const submission = {
      run: run.run,
      model: 'scripted-model@test',
      items: [
        { item: 'doc-1:n1', handling: 'handled', slots: { findings: [{ text: '期望结果缺失' }] } },
        { item: 'doc-1:n2', handling: 'handled', slots: { unknown: true } },
        { item: 'doc-1:n3', handling: 'skipped', reason: '合成的跳过理由' },
      ],
    };
    const accepted = await client.call('submit_result', submission);
    assert.equal(accepted.isError, false, 'an accepted submission with unknown and incomplete items is not an error');
    assert.equal(accepted.structuredContent.acceptance, 'accepted');
    SubmitResultOutput.parse(accepted.structuredContent);
    assert.deepEqual(accepted.structuredContent.counts, { delivered: 2, rejected: 0, quarantined: 0, incomplete: 1, unknown: 1 });
    assert.equal(accepted.content[0].text?.split('\n')[0], '回执：已受理；分区：已交付 2，已拒收 0，已隔离 0，未完成 1（模型声明跳过 1）；未知 1');
    const repeat = await client.call('submit_result', submission);
    assert.deepEqual((repeat.structuredContent.result as { submission: string }).submission, (accepted.structuredContent.result as { submission: string }).submission);

    const refused = await client.call('submit_result', { ...submission, notes: 'quote-mismatch' });
    assert.equal(refused.isError, true);
    assert.equal(refused.structuredContent.acceptance, 'not_accepted');
    assert.equal(firstError(refused).code, 'QUOTE_MISMATCH');
    assert.ok(refused.structuredContent.result, 'a submission refused against a run it may use carries its result');
    assert.match(refused.content[0].text ?? '', /^回执：未受理/);

    const malformed = await client.call('submit_result', { ...submission, run: 'run_123' });
    assert.equal(malformed.isError, true);
    assert.equal(firstError(malformed).path, '/run');
    assert.equal(malformed.structuredContent.result, undefined);
    await client.close();
  });

  test('submit_result: bounded result lookup recovers its reference or reports an actionable record gap without changing the receipt', async () => {
    const user = await person();
    const client = await connect(user);
    const reference = String((await upload(client, MINDMAP)).structuredContent.reference);
    const summary=(await startRun(client,reference)).structuredContent.run as {run:string;items:Array<{id:string}>};
    const run=summary.run;
    const submission = (n: number) => ({
      run,
      model: 'scripted-model@test',
      items: summary.items.map((item,i)=>({item:item.id,handling:'handled',slots:{findings:i===0?[{text:`第 ${n} 次提交的发现`}]:[]}})),
    });
    const lastReasons = async () => {
      const [line] = (await server.records.callLog.query(server.admin.principal, { userId: user.user.id, tool: 'submit_result', limit: 1 })).items;
      assert.equal(line.admin_note, `管理员理由 ${line.admin_reasons?.length} 条；详见管理员调用日志详情`);
      return (line.admin_reasons ?? []).join('\n');
    };
    server.fakes.runs.script.failNext('getResult', new Error('合成的查找失败'));
    const failed = await client.call('submit_result', submission(1));
    assert.equal(failed.isError, false, failed.content[0].text);
    assert.equal(failed.structuredContent.acceptance, 'accepted', 'the answer stands');
    assert.ok(failed.structuredContent.result, 'with its result');
    assert.match(failed.content[0].text ?? '', /存下的结果 rec:[0-9a-f]{64}/, 'the second lookup recovers the stored record');
    assert.match(await lastReasons(), /defect.result_lookup_miss.*attempt 1/);
    server.fakes.runs.script.answerNext('getResult', null);
    const missing = await client.call('submit_result', submission(2));
    assert.equal(missing.structuredContent.acceptance, 'accepted');
    assert.match(missing.content[0].text ?? '', /存下的结果 rec:[0-9a-f]{64}/);
    server.fakes.runs.script.answerNext('getResult',null);server.fakes.runs.script.answerNext('getResult',null);
    const exhausted=await client.call('submit_result',submission(3));assert.equal(exhausted.structuredContent.acceptance,'accepted');
    assert.match(exhausted.content[0].text??'',/缺少.*结果.*记录引用/);assert.match(exhausted.content[0].text??'',/console\/runs\//);
    assert.ok((exhausted.structuredContent.errors as Array<{code:string}>).some(error=>error.code==='SOURCE_RETRYABLE'));
    const found = await client.call('submit_result', submission(3));
    assert.deepEqual(found.structuredContent.result,exhausted.structuredContent.result);
    assert.deepEqual(found.structuredContent.counts,exhausted.structuredContent.counts);
    assert.match(found.content[0].text ?? '', /存下的结果 rec:[0-9a-f]{64}（/, 'with the lookup working the record is named');
    await client.close();
  });

  test('submit_result passes the raw arguments: a misspelled key reaches the service and is stored as received', async () => {
    const user = await person();
    const client = await connect(user);
    const reference = String((await upload(client, MINDMAP)).structuredContent.reference);
    const run = (await startRun(client, reference)).structuredContent.run as { run: string };
    const raw = { run: run.run, model: 'scripted-model@test', items: [{ item: 'doc-1:n1', handling: 'handled', slot: {} }] };
    const result = await client.call('submit_result', raw);
    assert.equal(result.isError, true);
    assert.equal(firstError(result).code, 'SUBMISSION_SCHEMA_VIOLATION');
    const stored = server.fakes.runs.runs.get(run.run)!.submissions.at(-1)!;
    const record = await server.records.store.get(stored.record);
    assert.equal(record?.schema, 'submission-received@1');
    assert.deepEqual(record?.body, raw, 'the service got the arguments exactly as sent');
    await client.close();
  });

  test('submit_result gets the arguments as received, a member named __proto__ included, and the call log digests the same arguments', async () => {
    const user = await person();
    const client = await connect(user);
    const reference = String((await upload(client, MINDMAP)).structuredContent.reference);
    const run = ((await startRun(client, reference)).structuredContent.run as { run: string }).run;
    await client.close();
    const args = `{"__proto__":{"run":"run_7zzzzzzzzzzzzzzzzzzzzzzzzz"},"run":"${run}","model":"m-1","items":[]}`;
    const reply = await post(user.token, `{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"submit_result","arguments":${args}}}`);
    assert.equal(reply.status, 200);
    const stored = server.fakes.runs.runs.get(run)!.submissions.at(-1)!;
    const record = await server.records.store.get(stored.record);
    assert.deepEqual(Object.keys(record!.body as object).sort(), ['__proto__', 'items', 'model', 'run'], 'the member reached the service as an own member');
    const digest = sha256Hex(canonicalize(JSON.parse(args)));
    const result = (reply.json as { result: { structuredContent: { result?: { submission: string } } } }).result.structuredContent.result;
    assert.equal(result?.submission, digest, 'the service digests the arguments received');
    const [line] = (await server.records.callLog.query(server.admin.principal, { userId: user.user.id, tool: 'submit_result', limit: 1 })).items;
    assert.equal(line.args_digest, digest, 'the call log digests the same arguments');
    // The other tools see the same object: the member is an unknown argument, never a prototype that supplies `kind`.
    const listed = await post(user.token, '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"list_task_packs","arguments":{"__proto__":{"kind":"product"}}}}');
    const structured = (listed.json as { result: { isError: boolean; structuredContent: { errors: { path?: string }[] } } }).result;
    assert.equal(structured.isError, true);
    assert.equal(structured.structuredContent.errors[0].path, '/__proto__');
  });

  test('the content alone carries what a model needs: the source text, items as id | label | summary, the compact slot schema, the claims', async () => {
    const user = await person(['review']);
    const client = await connect(user);
    const reference = String((await upload(client, MINDMAP)).structuredContent.reference);
    const read = await client.call('get_nodes', { reference });
    assert.ok(read.content[0].text?.includes(`原文（${MINDMAP.length} 个字符）：\n${MINDMAP}`), 'the text of a model readable source is in the content');
    const tree = await client.call('get_nodes', { root: ROOT_1, paths: ['/catalog'], depth: 1 });
    assert.match(tree.content[0].text ?? '', /子节点 \/catalog\/alpha alpha/);
    assert.match(tree.content[0].text ?? '', /数据 \{"params":\[\{"name":"name","type":"string"\}\]\}/, 'the entry data of a catalog leaf');
    server.fakes.runs.items = (subject) => Array.from({ length: 60 }, (_, i) => ({ id: `doc-9:n${i}`, label: `合成用例 ${i}`, summary: `摘要 ${i}`, location: subject, fields: {} }));
    try {
      const started = await startRun(client, reference);
      const text = started.content[0].text ?? '';
      const record = server.fakes.runs.runs.get((started.structuredContent.run as { run: string }).run)!.recordDigest;
      for (const i of [0, 49, 50, 59]) assert.ok(text.includes(`\n- doc-9:n${i} | 合成用例 ${i} | 摘要 ${i}\n`), `item ${i} as id | label | summary`);
      // ItemProjection.summary: a long list is id, label and summary; where the items are is said once, by a rule.
      assert.ok(text.includes(`\n位置：每个条目的位置都是 ${reference}\n`), 'the location rule, once');
      assert.ok(!/\n- doc-9:n\d+ \| [^\n]* \| 位置 /.test(text), 'no location column');
      assert.match(text, /\n槽位模式（sha256 [0-9a-f]{64}）：每个已处理的条目给一条 slots/);
      assert.ok(text.includes('\n- findings：评审发现（合成）；陈述的列表；每条：text（必填）: string（发现的说明）；code: string\n'), 'the compact slot schema');
      assert.ok(!text.includes('"$schema"'), 'not the JSON Schema itself');
      assert.ok(text.includes(`完整的槽位模式（JSON Schema，带说明和写法）：get_nodes {"reference":"rec:${record}#/slots/schema"}`), 'where the whole schema is');
    } finally {
      server.fakes.runs.items = null;
    }
    const short = await startRun(client, reference);
    assert.match(short.content[0].text ?? '', /\n- doc-1:n1 \| 合成用例一\n/);
    const runId = (short.structuredContent.run as { run: string }).run;
    const submitted = await client.call('submit_result', { run: runId, model: 'scripted-model@test', items: [{ item: 'doc-1:n1', handling: 'handled', slots: { findings: [{ text: '期望结果缺失' }] } }] });
    const lines = (submitted.content[0].text ?? '').split('\n');
    const finding = lines.findIndex((line) => line.includes('陈述：期望结果缺失'));
    assert.ok(finding > 0, 'the finding claim is in the content');
    assert.match(lines[finding], /^ {4}- 位置：条目 doc-1:n1，要求项 findings；陈述：期望结果缺失；性质与依据等级：.*；生产者：模型，scripted-model@test；有效条件：/);
    assert.match(lines[finding - 1], /^ {2}· findings：/, 'under its requirement');
    const stored = server.fakes.runs.runs.get(runId)!.latest!.record;
    assert.ok(lines.includes(`存下的结果 rec:${stored}（用 get_nodes 按引用读；也可在控制台运行页 /console/runs/${runId} 查看）`), 'the stored result is named');
    await client.close();
  });
});

/** The JSON object that starts at `at` in `text`. */
function jsonAt(text: string, at: number): Record<string, unknown> {
  for (let end = text.indexOf('}', at); end >= 0; end = text.indexOf('}', end + 1)) {
    try {
      return JSON.parse(text.slice(at, end + 1)) as Record<string, unknown>;
    } catch {
      // not the end of the object yet
    }
  }
  throw new Error(`no JSON object at ${at}: ${text.slice(at, at + 80)}`);
}

/** The get_nodes call a text gives after `marker` (in its note, the line before the trace), or null. */
function callAfter(text: string, marker: string): Record<string, unknown> | null {
  const lines = text.split('\n');
  const note = lines.at(-2) ?? '';
  if (!note.startsWith('部分：')) return null;
  const at = note.indexOf(`${marker}get_nodes `);
  return at < 0 ? null : jsonAt(note, at + `${marker}get_nodes `.length);
}

/** The ids of the item lines of a text (`- <id> | ...`). */
const itemIds = (text: string, prefix: string): string[] => text.split('\n').flatMap((line) => (line.startsWith(`- ${prefix}`) ? [line.slice(2, line.indexOf(' | '))] : []));

describe('paging through the server', () => {
  test('a source read by reference is read on with the 下一页 cursor the note gives, every line once; a foreign cursor is refused at /cursor', async () => {
    const client = await connect(await person());
    const markdown = Array.from({ length: 4000 }, (_, i) => `- 第 ${i + 1} 条：合成说明 ${'长'.repeat(i % 23)}`).join('\n');
    const reference = String((await upload(client, markdown, { media_type: 'text/markdown' })).structuredContent.reference);
    const other = String((await upload(client, '另一份合成文本\n')).structuredContent.reference);
    let args: Record<string, unknown> = { reference };
    const seen: string[] = [];
    let pages = 0;
    for (; pages < 100; pages++) {
      const page = await client.call('get_nodes', args);
      assert.equal(page.isError, false, `${JSON.stringify(args)}: ${page.content[0].text?.slice(0, 200)}`);
      const text = page.content[0].text ?? '';
      assert.ok(text.length <= 30_000, `a page is ${text.length} characters`);
      const lines = text.split('\n');
      const from = lines.findIndex((line) => line.startsWith('原文（')) + 1;
      seen.push(...lines.slice(from, lines.length - (lines.at(-2)?.startsWith('部分：') ? 2 : 1)));
      const next = callAfter(text, '下一页：');
      if (next === null) break;
      assert.deepEqual(Object.keys(next).sort(), ['cursor', 'reference'], 'the next page is the same reference with a cursor');
      assert.equal(next.reference, reference);
      args = next;
    }
    assert.ok(pages > 1, 'the text needed more than one page');
    assert.deepEqual(seen, markdown.split('\n'), 'every line once, in order');
    const cursor = String(args.cursor);
    const foreign = await client.call('get_nodes', { reference: other, cursor });
    assert.equal(foreign.isError, true);
    assert.deepEqual([firstError(foreign).code, firstError(foreign).path], ['SUBMISSION_SCHEMA_VIOLATION', '/cursor']);
    assert.match(firstError(foreign).message, /cursor 不是这个引用的翻页位置/);
    assert.equal(foreign.structuredContent.content, undefined);
    const garbage = await client.call('get_nodes', { reference, cursor: 'next-please' });
    assert.equal(firstError(garbage).path, '/cursor');
    for (const [key, value] of [['root', ROOT_1], ['paths', ['/']], ['depth', 1]] as const) {
      const mixed = await client.call('get_nodes', { reference, cursor, [key]: value });
      assert.deepEqual([firstError(mixed).code, firstError(mixed).path], ['SUBMISSION_SCHEMA_VIOLATION', `/${key}`], key);
    }
    // A cursor never reveals whether a reference it does not belong to exists: absent and forbidden stay alike.
    const absent = await client.call('get_nodes', { reference: `src:${'f'.repeat(64)}`, cursor });
    assert.equal(firstError(absent).code, 'SOURCE_UNAVAILABLE');
    await client.close();
  });

  test('start_run items left out are read from the run record with the cursor the note gives, every item once and in order', async () => {
    const user = await person(['review']);
    const client = await connect(user);
    const reference = String((await upload(client, MINDMAP)).structuredContent.reference);
    server.fakes.runs.items = (subject) =>
      Array.from({ length: 3000 }, (_, i) => ({ id: `doc-8:n${i}`, label: `合成用例 ${i}${i % 97 === 0 ? ' 很长的标题'.repeat(40) : ''}`, summary: `摘要 ${i}`, location: `${subject}/kityminder@1/n/n${i}`, fields: {} }));
    try {
      const started = await startRun(client, reference);
      assert.equal(started.isError, false);
      const run = (started.structuredContent.run as { run: string }).run;
      const record = server.fakes.runs.runs.get(run)!.recordDigest;
      const text = started.content[0].text ?? '';
      assert.ok(text.length <= 30_000);
      const shown = itemIds(text, 'doc-8:');
      assert.ok(shown.length > 0 && shown.length < 3000, `the first page shows ${shown.length} items`);
      const first = callAfter(text, '条目：');
      assert.ok(first !== null, 'the note names the cursor call of the items left out');
      assert.equal(first.reference, `rec:${record}#/items`);
      const ids = [...shown];
      let args: Record<string, unknown> = first;
      for (let i = 0; i < 200; i++) {
        const page = await client.call('get_nodes', args);
        assert.equal(page.isError, false, page.content[0].text?.slice(0, 200));
        const pageText = page.content[0].text ?? '';
        assert.ok(pageText.length <= 30_000);
        ids.push(...itemIds(pageText, 'doc-8:'));
        const next = callAfter(pageText, '下一页：');
        if (next === null) break;
        assert.equal(next.reference, `rec:${record}#/items`);
        args = next;
      }
      assert.deepEqual(ids, Array.from({ length: 3000 }, (_, i) => `doc-8:n${i}`), 'start_run and the pages show every item once, in order');
    } finally {
      server.fakes.runs.items = null;
    }
    await client.close();
  });

  test('an empty partition of a stored result reads as empty (every item delivered is the common case); an empty cursor reads the first page', async () => {
    const user = await person(['review']);
    const client = await connect(user);
    const reference = String((await upload(client, MINDMAP)).structuredContent.reference);
    const run = ((await startRun(client, reference)).structuredContent.run as { run: string }).run;
    const items = ['doc-1:n1', 'doc-1:n2', 'doc-1:n3'].map((item) => ({ item, handling: 'handled', slots: { findings: [] } }));
    const accepted = await client.call('submit_result', { run, model: 'scripted-model@test', items });
    assert.equal(accepted.structuredContent.acceptance, 'accepted', accepted.content[0].text);
    assert.equal((accepted.structuredContent.counts as { delivered: number }).delivered, 3, 'every item delivered');
    const stored = server.fakes.runs.runs.get(run)!.latest!.record;
    for (const partition of ['rejected', 'quarantined', 'incomplete']) {
      const read = await client.call('get_nodes', { reference: `rec:${stored}#/partitions/${partition}` });
      assert.equal(read.isError, false, `${partition}: ${read.content[0].text}`);
      assert.match(read.content[0].text ?? '', new RegExp(`部分 rec:${stored}#/partitions/${partition}：条目 0 个\n追踪 `));
    }
    const delivered = await client.call('get_nodes', { reference: `rec:${stored}#/partitions/delivered`, cursor: '' });
    assert.equal(delivered.isError, false, 'an empty cursor is no cursor, as for a subtree');
    assert.match(delivered.content[0].text ?? '', /：条目 3 个/);
    const source = await client.call('get_nodes', { reference });
    const fromEmpty = await client.call('get_nodes', { reference, cursor: '' });
    assert.deepEqual(comparable(fromEmpty), comparable(source), 'the first page, exactly as without a cursor');
    const subtree = await client.call('get_nodes', { run, cursor: '' });
    assert.equal(subtree.isError, false, 'the subtree read takes an empty cursor too');
    await client.close();
  });

  test('submit_result names its stored result, accepted or not; the item details left out are read from it by cursor', async () => {
    const user = await person(['review']);
    const client = await connect(user);
    const reference = String((await upload(client, MINDMAP)).structuredContent.reference);
    server.fakes.runs.items = (subject) => Array.from({ length: 1200 }, (_, i) => ({ id: `doc-7:n${i}`, label: `合成用例 ${i}`, location: `${subject}/kityminder@1/n/n${i}`, fields: {} }));
    try {
      const run = ((await startRun(client, reference)).structuredContent.run as { run: string }).run;
      const items = Array.from({ length: 1200 }, (_, i) => ({ item: `doc-7:n${i}`, handling: 'handled', slots: { findings: [{ text: `第 ${i} 个用例的期望结果缺少判定条件` }] } }));
      const accepted = await client.call('submit_result', { run, model: 'scripted-model@test', items });
      assert.equal(accepted.isError, false);
      const stored = server.fakes.runs.runs.get(run)!.latest!.record;
      const text = accepted.content[0].text ?? '';
      assert.ok(text.includes(`存下的结果 rec:${stored}（`));
      const call = callAfter(text, '条目明细：');
      assert.ok(call !== null && call.reference === `rec:${stored}` && typeof call.cursor === 'string', 'the details left out are read from the stored result by cursor');
      const seen = new Set(itemIds(text, 'doc-7:'));
      let args: Record<string, unknown> = call;
      for (let i = 0; i < 300; i++) {
        const page = await client.call('get_nodes', args);
        assert.equal(page.isError, false, page.content[0].text?.slice(0, 200));
        for (const id of itemIds(page.content[0].text ?? '', 'doc-7:')) seen.add(id);
        const next = callAfter(page.content[0].text ?? '', '下一页：');
        if (next === null) break;
        args = next;
      }
      assert.equal(seen.size, 1200, 'every item of the result is read');
      const refused = await client.call('submit_result', { run, model: 'scripted-model@test', items: [], notes: 'quote-mismatch' });
      assert.equal(refused.isError, true);
      const refusedResult = refused.structuredContent.result as { submission: string };
      const kept = server.fakes.runs.runs.get(run)!.results.get(refusedResult.submission)!.record;
      assert.ok((refused.content[0].text ?? '').includes(`存下的结果 rec:${kept}（`), 'a result that is not accepted is named too');
    } finally {
      server.fakes.runs.items = null;
    }
    await client.close();
  });
});

describe('start_run with the engine\'s detail', () => {
  test('a production run answers its result; the text gives its counts, every requirement, the problems and where the whole result is', async () => {
    const packs = [...defaultPacks(), fakeWorkflowPack('locate', '合成定位', ['application/json'], { factsOnly: true })];
    const other = await createTestServer({ postgres, packs });
    try {
      const user = await other.createUser('定位者');
      await other.assign(user.principal, 'locate');
      const client = await other.client(user.token);
      const reference = String((await client.call('upload_file', { file_path: b64(MINDMAP) })).structuredContent.reference);
      const started = await client.call('start_run', { pack: 'locate', inputs: { subject: { reference } } });
      assert.equal(started.isError, false, started.content[0].text);
      const run = (started.structuredContent.run as { run: string }).run;
      const production = other.fakes.runs.runs.get(run)!.production!;
      assert.deepEqual(started.structuredContent.result, { reference: production.reference, counts: production.counts });
      const lines = (started.content[0].text ?? '').split('\n');
      assert.equal(lines[1], '结果（start_run 时由 Hub 算出）：分区：已交付 3，已拒收 0，已隔离 0，未完成 0；未知 0');
      assert.ok(lines.includes('要求项（满足状态与各层终态的条目数）：'));
      assert.ok(lines.some((line) => /^- structure 结构：满足 2，未满足 1（终态不符合期望 1），未决 0；静态：✓ 通过 2，✗ 不通过 1（阻断 1）；动态：本层不适用$/.test(line)), 'the counts of the requirement');
      const problems = lines.findIndex((line) => line.startsWith('问题与未知（1 条；'));
      assert.ok(problems > 0, 'the problems are listed');
      assert.match(lines[problems + 1], /^- doc-1:n2 \| 合成用例二 \| 已交付 \| structure \| /);
      const whole = lines.findIndex((line) => line.startsWith(`完整结果 ${production.reference}：`));
      assert.ok(whole > 0 && whole < problems && problems < lines.findIndex((line) => line.startsWith('条目（')), 'the result before the items');
      assert.match(lines[whole], /get_nodes \{"reference":"rec:[0-9a-f]{64}"\} 读第一页，再按每页末尾给出的 cursor 接着读/);
      const read = await client.call('get_nodes', { reference: production.reference });
      assert.equal(read.isError, false, 'the whole result is readable by its reference');
      assert.match(read.content[0].text ?? '', new RegExp(`结果 ${production.reference}（运行 ${run}）：回执：已受理`));
      await client.close();
    } finally {
      await other.close();
    }
  });

  test('a text that cannot be laid out from what the engine handed over still answers the stored run: a minimal text, the reason in the admin note', async () => {
    const packs = [...defaultPacks(), fakeWorkflowPack('locate', '合成定位', ['application/json'], { factsOnly: true })];
    const other = await createTestServer({ postgres, packs });
    try {
      const user = await other.createUser('定位者');
      await other.assign(user.principal, 'locate');
      const client = await other.client(user.token);
      const reference = String((await client.call('upload_file', { file_path: b64(MINDMAP) })).structuredContent.reference);
      const runs = other.fakes.runs;
      const original = runs.startRunDetailed.bind(runs);
      // The engine hands over a production result without its partitions: the answer is valid, the text's source is not.
      runs.startRunDetailed = async (...args) => {
        const detail = await original(...args);
        return detail.production === null ? detail : { ...detail, production: { ...detail.production, result: { ...detail.production.result, partitions: undefined as never } } };
      };
      const started = await client.call('start_run', { pack: 'locate', inputs: { subject: { reference } } });
      assert.equal(started.isError, false);
      const run = (started.structuredContent.run as { run: string }).run;
      const result = started.structuredContent.result as { reference: string };
      const lines = (started.content[0].text ?? '').split('\n');
      assert.equal(lines[0], '调用结果：正常');
      assert.ok(lines.includes(`运行 ${run}：任务包 locate@1.0.0`), lines.join('\n'));
      assert.ok(lines.includes(`完整结果 ${result.reference}（用 get_nodes 按引用读）`));
      assert.equal(lines.at(-1), `追踪 ${started.structuredContent.trace}`);
      const [line] = (await other.records.callLog.query(other.admin.principal, { userId: user.user.id, tool: 'start_run', limit: 1 })).items;
      assert.match((line.admin_reasons ?? []).join('\n'), /the text of the start_run answer could not be laid out: TypeError: /);
      assert.equal(line.call_result, 'ok', 'the call is logged as answered');
      await client.close();
    } finally {
      await other.close();
    }
  });

  test('the evidence gaps of the detail are in the text; without the engine\'s detail start_run still answers and no record is named', async () => {
    const user = await person(['review']);
    const client = await connect(user);
    const reference = String((await upload(client, MINDMAP)).structuredContent.reference);
    server.fakes.runs.gaps = { unavailable: [{ external: 'tracker:document:404', role: 'expected' }], gaps: [{ code: 'review.expected_failed', message: '期望来源函数没有给出结果（合成）' }] };
    try {
      const text = (await startRun(client, reference)).content[0].text ?? '';
      assert.ok(text.includes('\n- 数据缺口：期望来源 tracker:document:404：对你不可用\n'));
      assert.ok(text.includes('\n- 数据缺口：review.expected_failed：期望来源函数没有给出结果（合成）\n'));
    } finally {
      server.fakes.runs.gaps = { unavailable: [], gaps: [] };
    }
    await client.close();
    const plain = await createTestServer({ postgres, withoutRunsDetail: true });
    try {
      const owner = await plain.createUser('无详情');
      await plain.assign(owner.principal, 'review');
      const plainClient = await plain.client(owner.token);
      const source = String((await plainClient.call('upload_file', { file_path: b64(MINDMAP) })).structuredContent.reference);
      const started = await plainClient.call('start_run', { pack: 'review', inputs: { subject: { reference: source } } });
      assert.equal(started.isError, false);
      const run = (started.structuredContent.run as { run: string }).run;
      assert.doesNotMatch(started.content[0].text ?? '', /rec:[0-9a-f]{64}/, 'no record reference without the engine\'s detail');
      const submitted = await plainClient.call('submit_result', { run, model: 'm', items: [] });
      assert.ok(!(submitted.content[0].text ?? '').includes('存下的结果'), 'no stored result is named');
      await plainClient.close();
    } finally {
      await plain.close();
    }
  });
});

describe('records by reference', () => {
  test('records decide a source artifact for admins too: one read with a person\'s own credential looks absent to an admin', async () => {
    const owner = await person();
    const personal = await server.records.artifacts.ingest({
      bytes: Buffer.from(`个人凭据读到的页面 ${counter}`),
      mediaType: 'text/plain',
      origin: { read: { object: `tracker:page:${counter}` } },
      author: { user: null },
      provenanceType: 'observed',
      visibility: { readers: [owner.user.id], admins: false, packs: [], shareable: false },
    });
    const admin = await connect(server.admin);
    const byRecord = await admin.call('get_nodes', { reference: `rec:${personal.digest}` });
    const absent = await admin.call('get_nodes', { reference: `rec:${'d'.repeat(64)}` });
    assert.equal(firstError(byRecord).code, 'SOURCE_UNAVAILABLE');
    assert.deepEqual(comparable(byRecord), comparable(absent), 'admins:false and absent look the same');
    assert.equal(firstError(await admin.call('get_nodes', { reference: `src:${personal.body.sha256}` })).code, 'SOURCE_UNAVAILABLE', 'the bytes agree');
    const ownerClient = await connect(owner);
    const own = await ownerClient.call('get_nodes', { reference: `rec:${personal.digest}#/sha256` });
    assert.equal((own.structuredContent.content as { text: string }).text, personal.body.sha256, 'the reader it belongs to reads it');
    await admin.close();
    await ownerClient.close();
  });

  test('a submission runs kept as received JSON text names its run under received: its runner reads it, nobody else', async () => {
    const owner = await person();
    const ownerClient = await connect(owner);
    const reference = String((await upload(ownerClient, MINDMAP)).structuredContent.reference);
    const run = ((await startRun(ownerClient, reference)).structuredContent.run as { run: string }).run;
    const text = Buffer.from(`{"run":"${run}","model":"m","items":[],"notes":"\\ud800"}`);
    const object = await server.records.objects.put(text, 'application/json');
    const stored = await server.records.store.put({
      kind: 'submission',
      schema: 'submission-received@1',
      provenance: 'declared',
      body: { received: { object: object.sha256, size: text.length, non_canonical_path: '/notes', run } },
    });
    const own = await ownerClient.call('get_nodes', { reference: `rec:${stored.digest}#/received/run` });
    assert.equal(own.isError, false);
    assert.equal((own.structuredContent.content as { text: string }).text, run);
    const otherClient = await connect(await person());
    assert.equal(firstError(await otherClient.call('get_nodes', { reference: `rec:${stored.digest}` })).code, 'SOURCE_UNAVAILABLE');
    await ownerClient.close();
    await otherClient.close();
  });

  test('unregistered candidate claims follow ordinary admin-only claim reads', async () => {
    const owner = await person();
    const candidate = await server.records.store.put({ kind: 'claim', schema: 'knowledge-candidate@1', provenance: 'candidate', body: { owner: owner.user.id, statement: '合成候选' } });
    const observation = await server.records.store.put({ kind: 'claim', schema: 'knowledge-observation@1', provenance: 'observed', body: { statement: '合成观察' } });
    const admin = await connect(server.admin);
    const ownerClient = await connect(owner);
    assert.equal((await admin.call('get_nodes', { reference: `rec:${candidate.digest}` })).isError,false);
    assert.equal(firstError(await ownerClient.call('get_nodes', { reference: `rec:${candidate.digest}#/statement` })).code,'SOURCE_UNAVAILABLE');
    assert.equal((await admin.call('get_nodes', { reference: `rec:${observation.digest}` })).isError, false);
    assert.equal(firstError(await ownerClient.call('get_nodes', { reference: `rec:${observation.digest}` })).code, 'SOURCE_UNAVAILABLE');
    await admin.close();
    await ownerClient.close();
  });
});

describe('batches and notes', () => {
  test('a JSON-RPC batch is refused before anything runs: one transport_failure line per request, no call executed', async () => {
    const user = await person();
    const content = `批量里的上传 ${counter}`;
    const batch = JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'upload_file', arguments: { file_path: b64(content) } } },
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_task_packs', arguments: {} } },
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } },
    ]);
    const reply = await post(user.token, batch);
    assert.equal(reply.status, 400);
    assert.equal((reply.json as { error: { code: number } }).error.code, -32600);
    assert.deepEqual(await server.records.artifacts.records(sha256Hex(content)), [], 'the upload in the batch was never ingested');
    const lines = (await server.records.callLog.query(server.admin.principal, { userId: user.user.id, limit: 50, newestFirst: false })).items;
    assert.deepEqual(
      lines.map((line) => [line.tool, line.call_result]),
      [
        ['upload_file', 'transport_failure'],
        ['list_task_packs', 'transport_failure'],
      ],
    );
    for (const line of lines) assert.match((line.admin_reasons ?? []).join('\n'), /JSON-RPC batch refused/);
    const empty = await post(user.token, '[]');
    assert.equal(empty.status, 400);
    const single = await post(user.token, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'upload_file', arguments: { file_path: b64(content) } } }));
    assert.equal(single.status, 200, 'the same call alone is served');
    assert.equal((await server.records.artifacts.records(sha256Hex(content))).length, 1);
  });

  test('a note cut inside a surrogate pair or quoting a NUL never costs the call-log line', async () => {
    const user = await person(['review']);
    const client = await connect(user);
    const absent = await client.call('get_nodes', { root: 'e'.repeat(64), paths: [`/${'a'.repeat(296)}😀`] });
    assert.equal(firstError(absent).code, 'SOURCE_UNAVAILABLE');
    server.fakes.runs.script.failNext('startRun', Object.assign(new Error('read failed at\u0000offset 7\ud800'), { code: 'SOURCE_UNAVAILABLE' }));
    assert.equal(firstError(await client.call('start_run', { pack: 'review', inputs: {} })).code, 'SOURCE_UNAVAILABLE');
    const lines = (await server.records.callLog.query(server.admin.principal, { userId: user.user.id, limit: 20 })).items;
    const nodes = lines.find((line) => line.tool === 'get_nodes');
    assert.ok(nodes, 'the get_nodes line is written');
    assert.match((nodes.admin_reasons ?? []).join('\n'), /is absent or not readable/);
    assert.ok(nodes.admin_reasons?.length);
    assert.ok(nodes.admin_reasons.every(reason => reason.isWellFormed() && !reason.includes('\0')));
    assert.equal(nodes.admin_note, `管理员理由 ${nodes.admin_reasons.length} 条；详见管理员调用日志详情`);
    const start = lines.find((line) => line.tool === 'start_run');
    assert.ok(start, 'the start_run line is written');
    assert.match((start.admin_reasons ?? []).join('\n'), /read failed atoffset 7\ufffd/);
    assert.ok(start.admin_reasons?.every(reason => reason.isWellFormed() && !reason.includes('\0')));
    assert.equal(start.admin_note, `管理员理由 ${start.admin_reasons?.length} 条；详见管理员调用日志详情`);
    await client.close();
  });

  test('short MCP administrator reasons stay out of initial and repaired JSONL files',async()=>{
    const user=await person();const client=await connect(user);
    const original=server.deps.knowledge.getNodes.bind(server.deps.knowledge);
    const marker='SyntheticPrivateReadReason736';
    server.deps.knowledge.getNodes=async()=>{throw new Error(marker);};
    try {
      await client.call('get_nodes',{root:ROOT_1});
      const line=(await server.records.callLog.query(server.admin.principal,{userId:user.user.id,tool:'get_nodes',limit:1})).items[0];
      assert.ok(line.admin_reasons?.some(reason=>reason.includes(marker)));
      assert.ok(!(line.admin_note??'').includes(marker));
      const day=line.at.slice(0,10),file=join(server.records.dataDir,'logs',`calls-${day}.jsonl`);
      const check=async()=>{const bytes=await readFile(file,'utf8');assert.ok(!bytes.includes(marker));assert.ok(!bytes.includes('knowledge reader attempt'));assert.ok(!bytes.includes('admin_reasons'));};
      await check();await rm(file);
      await server.records.callLog.repairFiles({from:day+'T00:00:00.000Z',to:new Date(Date.parse(day+'T00:00:00.000Z')+86400000).toISOString()});
      await check();
    }finally{server.deps.knowledge.getNodes=original;await client.close();}
  });

  test('each administrator reason survives the summary cap and stays out of the model answer',async()=>{
    const user=await person();const client=await connect(user);
    const original=server.deps.knowledge.getNodes.bind(server.deps.knowledge);
    let calls=0;
    server.deps.knowledge.getNodes=async()=>{calls++;throw new Error('TAIL-'+calls+'原因'+calls+'甲'.repeat(1600));};
    try {
      const answer=await client.call('get_nodes',{root:ROOT_1});assert.equal(firstError(answer).code,'SOURCE_RETRYABLE');assert.equal(calls,3);
      assert.ok(!(answer.content[0].text??'').includes('TAIL-'));
      const line=(await server.records.callLog.query(server.admin.principal,{userId:user.user.id,tool:'get_nodes',limit:1})).items[0];
      assert.ok(line.admin_note!.length<=2000);assert.ok(line.admin_reasons?.some(reason=>reason.includes('TAIL-3')&&reason.length>1000));assert.ok(!line.admin_note!.includes('TAIL-3'));
    } finally {server.deps.knowledge.getNodes=original;await client.close();}
  });

  test('when records refuse a note anyway, the line is written without it and the operator log says so', async () => {
    const user = await person();
    const client = await connect(user);
    const callLog = server.records.callLog;
    const append = callLog.append.bind(callLog);
    callLog.append = async (input: CallLogInput) => {
      if (input.adminNote) throw new TypeError('adminNote is 1 to 2000 characters of well-formed text');
      return append(input);
    };
    try {
      assert.equal(firstError(await client.call('get_nodes', { run: 'run_7zzzzzzzzzzzzzzzzzzzzzzzzz' })).code, 'SOURCE_UNAVAILABLE');
    } finally {
      Reflect.deleteProperty(callLog, 'append');
    }
    const [line] = (await server.records.callLog.query(server.admin.principal, { userId: user.user.id, tool: 'get_nodes', limit: 1 })).items;
    assert.ok(line, 'the line is written');
    assert.equal(line.admin_note, null);
    assert.ok(server.logs.some((text) => /管理员备注没有被接受/.test(text)), 'the operator log names the refused note');
    await client.close();
  });
});

describe('neutral answers', () => {
  test('absent equals forbidden: the same neutral answer and empty shape for every tool', async () => {
    const owner = await person(['review']);
    const other = await person(['local-review']);
    const stranger = await person([]);
    const ownerClient = await connect(owner);
    const otherClient = await connect(other);
    const strangerClient = await connect(stranger);
    const reference = String((await upload(ownerClient, MINDMAP)).structuredContent.reference);
    const run = (await startRun(ownerClient, reference)).structuredContent.run as { run: string };
    const absentRun = 'run_7zzzzzzzzzzzzzzzzzzzzzzzzz';
    const absentSha = 'f'.repeat(64);
    const runRecord = server.fakes.runs.runs.get(run.run)!.recordDigest;
    const pairs: [TestMcpClient, string, Record<string, unknown>, Record<string, unknown>][] = [
      [otherClient, 'start_run', { pack: 'review', inputs: { subject: { reference } } }, { pack: 'no-such-pack', inputs: { subject: { reference } } }],
      [otherClient, 'start_run', { pack: 'local-review', inputs: { subject: { reference } } }, { pack: 'local-review', inputs: { subject: { reference: `src:${absentSha}` } } }],
      [otherClient, 'get_nodes', { run: run.run }, { run: absentRun }],
      [otherClient, 'get_nodes', { reference }, { reference: `src:${absentSha}` }],
      [otherClient, 'get_nodes', { reference: `${reference}/kityminder@1/n/n2` }, { reference: `src:${absentSha}/kityminder@1/n/n2` }],
      [otherClient, 'get_nodes', { reference: `rec:${runRecord}` }, { reference: `rec:${absentSha}` }],
      [strangerClient, 'get_nodes', { root: ROOT_1 }, { root: absentSha }],
      [strangerClient, 'get_nodes', { reference: `tree:${ROOT_1}/catalog` }, { reference: `tree:${absentSha}/catalog` }],
      [otherClient, 'resolve_reference', { run: run.run, text: '合成用例一' }, { run: absentRun, text: '合成用例一' }],
      [otherClient, 'submit_result', { run: run.run, model: 'm', items: [] }, { run: absentRun, model: 'm', items: [] }],
    ];
    for (const [client, tool, forbidden, absent] of pairs) {
      const a = await client.call(tool, forbidden);
      const b = await client.call(tool, absent);
      assert.equal(a.isError, true, `${tool} forbidden is an error`);
      assert.equal(firstError(a).code, 'SOURCE_UNAVAILABLE', `${tool} ${JSON.stringify(forbidden).slice(0, 60)}`);
      assert.equal(firstError(a).message, '对你不可用');
      assert.deepEqual(comparable(a), comparable(b), `${tool}: forbidden and absent look the same`);
    }
    // A user's call-log record is not readable by reference: absent and forbidden alike.
    const ownLine = (await server.records.callLog.query(other.principal, { limit: 1 })).items[0];
    const lineAnswer = await otherClient.call('get_nodes', { reference: `rec:${ownLine.digest}` });
    assert.equal(firstError(lineAnswer).code, 'SOURCE_UNAVAILABLE');
    await Promise.all([ownerClient, otherClient, strangerClient].map((c) => c.close()));
  });

  test('the real reason of a neutral answer is in the admin note only', async () => {
    const owner = await person(['review']);
    const other = await person(['review']);
    const ownerClient = await connect(owner);
    const otherClient = await connect(other, { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' });
    const reference = String((await upload(ownerClient, MINDMAP)).structuredContent.reference);
    const run = (await startRun(ownerClient, reference)).structuredContent.run as { run: string };
    const answer = await otherClient.call('get_nodes', { run: run.run });
    assert.equal(firstError(answer).code, 'SOURCE_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(answer), /not visible|absent/);
    const adminView = await server.records.callLog.query(server.admin.principal, { userId: other.user.id, tool: 'get_nodes' });
    assert.match((adminView.items[0].admin_reasons ?? []).join('\n'), /not visible/);
    const ownView = await server.records.callLog.query(other.principal, { tool: 'get_nodes' });
    assert.equal(ownView.items[0].admin_note, undefined, 'a user never sees the admin note');
    assert.equal(ownView.items[0].admin_reasons, undefined, 'a user never sees the private reasons');
    await ownerClient.close();
    await otherClient.close();
  });
});

describe('the isError matrix and output schemas', () => {
  test('isError is true exactly for protocol errors and receipts that are not accepted; every answer conforms to its schema', async () => {
    const user = await person(['review']);
    const client = await connect(user);
    const reference = String((await upload(client, MINDMAP)).structuredContent.reference);
    const run = ((await startRun(client, reference)).structuredContent.run as { run: string }).run;
    const cases: [string, Record<string, unknown>, boolean][] = [
      ['list_task_packs', {}, false],
      ['list_task_packs', { kind: 'nope' }, true],
      ['upload_file', { file_path: b64('合成文本 MATRIX') }, false],
      ['upload_file', { file_path: b64('password = "Xk9!rT2#qL"') }, true],
      ['upload_file', { file_path: 'QR==' }, true],
      ['start_run', { pack: 'review', inputs: { subject: { reference } } }, false],
      ['start_run', { pack: 'review', inputs: {} }, true],
      ['start_run', { pack: 'nope', inputs: {} }, true],
      ['get_nodes', { run }, false],
      ['get_nodes', { reference }, false],
      ['get_nodes', { run: 'run_7zzzzzzzzzzzzzzzzzzzzzzzzz' }, true],
      ['resolve_reference', { run, text: '合成用例一' }, false],
      ['resolve_reference', { run, text: '没有的值' }, false],
      ['resolve_reference', { run: 'run_7zzzzzzzzzzzzzzzzzzzzzzzzz', text: 'x' }, true],
      ['submit_result', { run, model: 'm', items: [{ item: 'doc-1:n1', handling: 'handled', slots: { unknown: true } }] }, false],
      ['submit_result', { run, model: 'm', items: [], notes: 'quote-mismatch' }, true],
      ['submit_result', { run: 'run_123', model: 'm', items: [] }, true],
    ];
    for (const [tool, args, expected] of cases) {
      const result = await client.call(tool, args);
      assert.equal(result.isError, expected, `${tool} ${JSON.stringify(args).slice(0, 80)}`);
      assert.equal(result.structuredContent.call_result, expected ? 'error' : 'ok');
      const parsed = output(tool).safeParse(result.structuredContent);
      assert.ok(parsed.success, `${tool} answer conforms: ${parsed.success ? '' : parsed.error.message}`);
      // D05 R[0], display rule 11: content is one block of plain text; the JSON is the structuredContent only.
      assert.equal(result.content.length, 1);
      assert.equal(result.content[0].type, 'text');
      assert.throws(() => JSON.parse(result.content[0].text ?? ''), SyntaxError, 'the content is plain text, not the JSON of the answer');
      assert.match(result.content[0].text ?? '', new RegExp(`追踪 ${String(result.structuredContent.trace)}$`));
    }
    await client.close();
  });

  test('a service answer that violates its output schema is not sent: an internal error, the reason in the admin note', async () => {
    const user = await person(['review']);
    const client = await connect(user);
    server.fakes.runs.script.answerNext('startRun', { call_result: 'ok', errors: [] });
    await assert.rejects(client.client.callTool({ name: 'start_run', arguments: { pack: 'review', inputs: {} } }), (error: unknown) => {
      assert.ok(error instanceof McpError);
      assert.equal(error.code, -32603);
      assert.match(error.message, /Hub 内部错误/);
      return true;
    });
    server.fakes.runs.script.answerNext('submitResult', { call_result: 'ok', errors: [], acceptance: 'accepted' });
    await assert.rejects(client.client.callTool({ name: 'submit_result', arguments: { run: 'run_7zzzzzzzzzzzzzzzzzzzzzzzzz', model: 'm', items: [] } }), McpError);
    server.fakes.runs.script.answerNext('resolveReference', { call_result: 'error', errors: [], references: [], diagnostics: [] });
    await assert.rejects(client.client.callTool({ name: 'resolve_reference', arguments: { run: 'run_7zzzzzzzzzzzzzzzzzzzzzzzzz', text: 'x' } }), McpError);
    const lines = await server.records.callLog.query(server.admin.principal, { userId: user.user.id });
    const failed = lines.items.filter((line) => ['start_run', 'submit_result', 'resolve_reference'].includes(line.tool));
    assert.equal(failed.length, 3);
    for (const line of failed) {
      assert.equal(line.call_result, 'error');
      assert.match((line.admin_reasons ?? []).join('\n'), /does not conform to its output schema/);
    }
    await client.close();
  });

  test('a thrown error: a registered code becomes its answer, SOURCE_UNAVAILABLE stays neutral, anything else is internal', async () => {
    const user = await person(['review']);
    const client = await connect(user);
    server.fakes.runs.script.failNext('startRun', Object.assign(new Error('同一个键内容不同'), { code: 'IDEMPOTENCY_MISMATCH' }));
    const mismatch = await client.call('start_run', { pack: 'review', inputs: {} });
    assert.equal(firstError(mismatch).code, 'IDEMPOTENCY_MISMATCH');
    assert.equal(firstError(mismatch).fix, PROTOCOL_CODES.IDEMPOTENCY_MISMATCH.fix);
    server.fakes.runs.script.failNext('startRun', Object.assign(new Error('pack secret-pack belongs to another team'), { code: 'SOURCE_UNAVAILABLE' }));
    const neutral = await client.call('start_run', { pack: 'review', inputs: {} });
    assert.equal(firstError(neutral).message, '对你不可用');
    assert.doesNotMatch(JSON.stringify(neutral), /another team/);
    server.fakes.runs.script.failNext('startRun', new Error('connection to 192.0.2.1 refused'));
    await assert.rejects(client.client.callTool({ name: 'start_run', arguments: { pack: 'review', inputs: {} } }), (error: unknown) => {
      assert.ok(error instanceof McpError);
      assert.doesNotMatch(error.message, /192\.0\.2\.1/);
      return true;
    });
    const logEntries = await server.records.callLog.query(server.admin.principal, { userId: user.user.id });
    const internalLine = logEntries.items.find((line) => line.call_result === 'error' && line.admin_reasons?.some(reason => reason.includes('connection to 192.0.2.1 refused')));
    assert.ok(internalLine, 'an internal failure writes private admin reasons');
    assert.equal(internalLine.admin_note, `管理员理由 ${internalLine.admin_reasons?.length} 条；详见管理员调用日志详情`);
    assert.match((internalLine.admin_reasons ?? []).join('\n'), /\bat /);
    assert.doesNotMatch((internalLine.admin_reasons ?? []).join('\n'), /\/Users\//);
    assert.doesNotMatch((internalLine.admin_reasons ?? []).join('\n'), /file:\/\//);
    await client.close();
  });
});

describe('call log, trace and session', () => {
  test('one line per call with the trace id, the session id, the run and the receipt; never the argument content', async () => {
    const user = await person(['review']);
    const client = await connect(user, { sessionId: 'sess-log-1', traceparent: TRACEPARENT });
    const marker = 'MARKER-UPLOAD-7f3a91';
    const uploaded = await upload(client, `合成说明 ${marker}`);
    assert.equal(uploaded.structuredContent.trace, TRACE, 'the trace id of traceparent is the answer trace');
    const reference = String(uploaded.structuredContent.reference);
    const run = await client.call('start_run', { pack: 'review', inputs: { subject: { reference } }, parameters: { note: 'MARKER-PARAM-9c1d' } });
    const runId = (run.structuredContent.run as { run: string }).run;
    await client.call('submit_result', { run: runId, model: 'm', items: [], notes: 'MARKER-SUBMIT-2b8e' });
    await client.call('get_nodes', { run: runId });
    const lines = (await server.records.callLog.query(server.admin.principal, { userId: user.user.id, limit: 100, newestFirst: false })).items;
    const tools = lines.map((line) => line.tool);
    for (const name of ['initialize', 'tools/list', 'upload_file', 'start_run', 'submit_result', 'get_nodes']) assert.ok(tools.includes(name), `${name} is logged`);
    for (const line of lines) {
      assert.equal(line.trace_id, TRACE);
      assert.equal(line.session, 'sess-log-1');
      assert.match(line.args_digest, /^[0-9a-f]{64}$/);
      assert.ok(line.args_size >= 0);
      assert.equal(line.args_preview, null);
    }
    const startLine = lines.find((line) => line.tool === 'start_run')!;
    assert.equal(startLine.run, runId);
    assert.equal(startLine.call_result, 'ok');
    const uploadLine = lines.find((line) => line.tool === 'upload_file')!;
    assert.equal(uploadLine.acceptance, 'accepted');
    const submitLine = lines.find((line) => line.tool === 'submit_result')!;
    assert.equal(submitLine.run, runId);
    const everything = JSON.stringify(lines);
    const files = await readdir(server.records.config.logDir);
    const fileText = (await Promise.all(files.map((f) => readFile(join(server.records.config.logDir, f), 'utf8')))).join('\n');
    for (const text of [everything, fileText]) {
      for (const secret of [marker, b64(`合成说明 ${marker}`), 'MARKER-PARAM-9c1d', 'MARKER-SUBMIT-2b8e']) assert.ok(!text.includes(secret), `call log never holds ${secret.slice(0, 20)}`);
    }
    const bodies = await server.records.store.list({ kind: 'call_log', limit: 500 });
    assert.ok(!JSON.stringify(bodies.items).includes(marker));
    await client.close();
  });

  test('a malformed traceparent gets a new trace id per request', async () => {
    const client = await connect(await person(), { traceparent: '00-00000000000000000000000000000000-00f067aa0ba902b7-01' });
    const a = await client.call('list_task_packs', {});
    const b = await client.call('list_task_packs', {});
    assert.match(String(a.structuredContent.trace), /^[0-9a-f]{32}$/);
    assert.notEqual(a.structuredContent.trace, '0'.repeat(32));
    assert.notEqual(a.structuredContent.trace, b.structuredContent.trace);
    await client.close();
  });

  test('the session id reaches the services as the call log keeps it', async () => {
    const client = await connect(await person(), { sessionId: 'sess-ctx-9' });
    await client.call('list_task_packs', {});
    const reference = String((await upload(client, MINDMAP)).structuredContent.reference);
    await startRun(client, reference);
    const context = server.fakes.runs.contexts.at(-1)!;
    assert.equal(context.sessionId, 'sess-ctx-9');
    assert.match(context.traceId, /^[0-9a-f]{32}$/);
    await client.close();
  });
});

describe('tokens and concurrency', () => {
  test('revoking the token or disabling the account takes effect at the next request', async () => {
    const user = await person();
    const client = await connect(user);
    assert.equal((await client.call('list_task_packs', {})).isError, false);
    const tokens = await server.records.principals.tokens(user.user.id);
    assert.ok(await server.records.principals.revokeToken(server.admin.principal, tokens[0].id));
    const unauthorized = (error: unknown) => (error as { code?: unknown }).code === 401;
    await assert.rejects(client.call('list_task_packs', {}), unauthorized);
    const second = await person();
    const secondClient = await connect(second);
    await server.records.principals.setDisabled(server.admin.principal, second.user.id, true);
    await assert.rejects(secondClient.call('list_task_packs', {}), unauthorized);
    await client.close();
    await secondClient.close();
  });

  test('concurrent calls from several clients all answer, each with its own trace and call-log line', async () => {
    const users = await Promise.all([person(), person(), person()]);
    const clients = await Promise.all(users.map((u) => connect(u)));
    const before = (await server.records.callLog.query(server.admin.principal, { tool: 'upload_file', limit: 500 })).items.length;
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, i) => upload(clients[i % clients.length], `并发上传 ${i}`)),
    );
    assert.ok(results.every((r) => r.isError === false));
    assert.equal(new Set(results.map((r) => r.structuredContent.trace)).size, 24);
    assert.equal(new Set(results.map((r) => r.structuredContent.reference)).size, 24);
    const after = (await server.records.callLog.query(server.admin.principal, { tool: 'upload_file', limit: 500 })).items.length;
    assert.equal(after - before, 24);
    await Promise.all(clients.map((c) => c.close()));
  });
});

describe("the caller's own token in a request (issue #105)", () => {
  const RUN = 'run_01arz3ndektsv4rrffq69g5fav';
  const call = (id: unknown, name: string, args: unknown) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  const submission = (text: string, id: unknown = 1) => JSON.stringify(call(id, 'submit_result', { run: RUN, model: 'synthetic', items: [{ item: 'c1', handling: 'handled', slots: { findings: [{ text, data: { nested: [{ note: text }] } }] } }] }));
  const refused = (reply: { status: number; json: unknown }, secret: string, code = -32602) => {
    assert.equal(reply.status, 400, JSON.stringify(reply.json));
    assert.equal((reply.json as { error?: { code?: number } }).error?.code, code);
    assert.ok(!JSON.stringify(reply.json).includes(secret), 'the answer does not echo the token');
  };
  const send = async (token: string, body: string, headers: Record<string, string> = {}) => {
    const reply = await fetch(server.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, ...headers }, body });
    const text = await reply.text();
    let json: unknown = text;
    try { json = JSON.parse(text); } catch { /* the raw text */ }
    return { status: reply.status, json };
  };
  const linesOf = async (user: TestUser) => (await server.records.callLog.query(server.admin.principal, { userId: user.user.id, limit: 20 })).items;

  test('a submission holding the token, whole, as a run in a nested field or escaped in the JSON text, is refused before it is handled', async () => {
    const user = await person();
    const before = server.fakes.runs.contexts.length;
    const run = user.token.slice(5, 17);
    refused(await post(user.token, submission(user.token)), user.token);
    const reply = await post(user.token, submission(`合成说明 ${run} 结束`, 42));
    refused(reply, run);
    assert.equal((reply.json as { id?: unknown }).id, 42, 'a safe request id is answered back');
    const escaped = submission(`合成说明 ${run}`).replaceAll(run, [...run].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''));
    assert.ok(!escaped.includes(run));
    refused(await post(user.token, escaped), run);
    assert.equal(server.fakes.runs.contexts.length, before, 'the runs service never saw them');
    const lines = await linesOf(user);
    assert.equal(lines.length, 3);
    // What can be logged without the token stays: the tool and the run, with the arguments' digest and size only.
    assert.ok(lines.every(line => line.tool === 'submit_result' && line.run === RUN && line.call_result === 'transport_failure'), JSON.stringify(lines));
    assert.ok(!JSON.stringify(lines).includes(run), 'no line holds the token');
    // Without the token the same submission reaches the runs service.
    await post(user.token, submission('合成说明'));
    assert.equal(server.fakes.runs.contexts.length, before + 1);
  });

  test('a request id holding the token is not answered back', async () => {
    const user = await person();
    const id = `id-${user.token.slice(1, 13)}`;
    const reply = await post(user.token, submission('合成说明', id));
    refused(reply, user.token.slice(1, 13));
    assert.equal((reply.json as { id?: unknown }).id, null);
  });

  test('a deeply nested body holding an escaped run of the token is refused and logged, not failed', async () => {
    const user = await person();
    const run = user.token.slice(8, 20);
    const escaped = [...run].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    const deep = `${'['.repeat(12_000)}"${escaped}"${']'.repeat(12_000)}`;
    refused(await post(user.token, JSON.stringify(call(7, 'list_task_packs', {})).replace('{}', `{"deep":${deep}}`)), run);
    assert.equal((await linesOf(user)).length, 1);
  });

  test('a batch whose upload holds the token is refused for the token, with a line per request', async () => {
    const user = await person();
    const content = `合成文件 ${user.token.slice(30, 42)}`;
    const batch = JSON.stringify([call(1, 'list_task_packs', {}), call(2, 'upload_file', { file_path: b64(content) })]);
    refused(await post(user.token, batch), user.token.slice(30, 42));
    const lines = await linesOf(user);
    assert.deepEqual(lines.map(line => line.tool).sort(), ['list_task_packs', 'upload_file']);
    assert.deepEqual(await server.records.artifacts.records(sha256Hex(Buffer.from(content))), []);
  });

  test('only the token that authenticates the request is looked for: after a rotation the new one is', async () => {
    const user = await person();
    const old = (await server.records.principals.tokens(user.user.id))[0]!;
    const issued = await server.records.principals.issueToken(server.admin.principal, user.user.id, 'rotated');
    assert.ok(await server.records.principals.revokeToken(server.admin.principal, old.id));
    const before = server.fakes.runs.contexts.length;
    refused(await post(issued.token, submission(`轮换后 ${issued.token.slice(20, 32)}`)), issued.token.slice(20, 32));
    assert.equal(server.fakes.runs.contexts.length, before);
    await post(issued.token, submission(`撤销的旧令牌 ${user.token}`));
    assert.equal(server.fakes.runs.contexts.length, before + 1, 'a revoked token is not the caller\'s current token');
  });

  test('a session id, trace context or media type holding the token is refused before any header reaches a log', async () => {
    const user = await person();
    const list = JSON.stringify(call(2, 'list_task_packs', {}));
    const run = user.token.slice(0, 12);
    const headers: Array<Record<string, string>> = [{ 'circle-session-id': `sess-${run}` }, { traceparent: `00-${run}${'0'.repeat(20)}-00f067aa0ba902b7-01` }, { 'content-type': `application/x-${run}` }];
    for (const one of headers) refused(await send(user.token, list, one), run, -32600);
    const content = `合成文件 ${user.token.slice(30, 42)}`;
    refused(await post(user.token, JSON.stringify(call(3, 'upload_file', { file_path: b64(content) }))), user.token.slice(30, 42));
    assert.deepEqual(await server.records.artifacts.records(sha256Hex(Buffer.from(content))), [], 'the file was not stored');
    const lines = await linesOf(user);
    assert.equal(lines.length, 4);
    assert.ok(lines.every(line => line.session === null && line.call_result === 'transport_failure'), JSON.stringify(lines));
    assert.ok(!JSON.stringify(lines).includes(run), 'no line holds the token');
  });
});
