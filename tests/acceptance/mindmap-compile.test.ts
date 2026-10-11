import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { zipSync, strToU8 } from 'fflate';
import readWorkbook from 'read-excel-file/node';
import { setup } from './harness.ts';
import { sha256 } from '../../packages/contracts/src/index.ts';

test('mindmap HTTP story uploads, dispatches to a separate worker, verifies and delivers immutable artifacts', async t => {
  const h = await setup(t); await h.startWorker();
  const login = await h.raw('/v1/auth/dev-login', { body: { username: 'alice', password: 'synthetic-only-password' } });
  assert.equal(login.status, 200); assert.ok(login.body.data.token);
  const packs = await h.request('/v1/packs');
  assert.ok(packs.some((pack: any) => pack.capabilityPackId === 'mindmap-compile'));
  const samples = new URL('../../references/platform/snapshot/samples/v05/', import.meta.url);
  const expected = JSON.parse(await readFile(new URL('smp-v05-02.json', samples), 'utf8'));
  const content = await readFile(new URL('smp-v05-01-content.json', samples));
  const cases = [
    ['content.json', content],
    ['topic-tree.json', await readFile(new URL('smp-v05-01-topic-tree.json', samples))],
    ['synthetic.xmind', Buffer.from(zipSync({ 'content.json': content, 'metadata.json': strToU8('{"creator":"synthetic"}') }))],
  ] as const;
  for (const [fileName, bytes] of cases) {
    const source = await h.request('/v1/sources', { scopeId: 'scp_lab', fileName, contentBase64: bytes.toString('base64') });
    assert.equal(source.sha256, sha256(bytes)); assert.equal(source.size, bytes.length);
    const submission = { scopeId: 'scp_lab', title: 'Compile V05', capabilityPackId: 'mindmap-compile',
      input: { sourceRevisionId: source.sourceRevisionId }, idempotencyKey: `mindmap-${fileName}` };
    const original = await h.request('/v1/tasks/submit', submission);
    const duplicate = await h.request('/v1/tasks/submit', submission);
    assert.equal(duplicate.taskId, original.taskId); assert.equal(duplicate.deduplicated, true);
    await h.phase(original.taskId, 'delivered');
    const result = await h.request(`/v1/tasks/${original.taskId}/result`);
    assert.equal(result.status, 'succeeded'); assert.equal(result.artifacts.length, 1); assert.equal(result.verification.rowCount, 8);
    const reference = result.artifacts[0];
    const downloaded = await fetch(`${h.url}/v1/artifacts/${reference.artifactId}/content`, { headers: { authorization: `Bearer ${await h.login()}` } });
    assert.equal(downloaded.status, 200);
    const workbook = Buffer.from(await downloaded.arrayBuffer()); assert.equal(sha256(workbook), reference.sha256);
    const sheets = await readWorkbook(workbook, { trim: false });
    const columns = expected.workbook.sheets[0].columns.map((column: any) => column.name);
    assert.deepEqual(sheets[0].data.slice(1).map(row => row.map(value => value ?? '')),
      expected.expectedRows.map((row: any) => columns.map((column: string) => row[column])));
    const resubmitted = await h.request('/v1/tasks/submit', { ...submission, idempotencyKey: `new-key-${fileName}` });
    await h.phase(resubmitted.taskId, 'delivered');
    const second = await h.request(`/v1/tasks/${resubmitted.taskId}/result`);
    assert.equal(second.artifacts[0].artifactId, reference.artifactId);
    await h.reject(`/v1/artifacts/${reference.artifactId}/content`, undefined, 'FORBIDDEN_SCOPE', 'outsider');
  }
  assert.equal((await h.db.query('SELECT count(*)::integer AS count FROM artifacts')).rows[0].count, 3);
  const receipts = (await h.db.query('SELECT * FROM operations')).rows;
  assert.ok(receipts.every(row => row.worker_id === 'lab-east-01' && row.fencing_token > 0 && row.status === 'succeeded'));
  await h.stop(h.server, 'SIGKILL'); await h.startServer();
  assert.equal((await h.request('/v1/packs'))[0].capabilityPackId, 'mindmap-compile');
});

test('mindmap partial and invalid input preserve their actual outcome and scope', async t => {
  const h = await setup(t); await h.startWorker();
  const partial = [{ rootTopic: { title: 'root', children: { attached: [{ title: 'module', children: { attached: [{ title: 'test', markers: ['priority-1'] }] } }] } } }];
  const bytes = Buffer.from(JSON.stringify(partial));
  const uploaded = await fetch(`${h.url}/v1/sources`, { method: 'POST', headers: { authorization: `Bearer ${await h.login()}`,
    'content-type': 'application/octet-stream', 'x-scope-id': 'scp_lab', 'x-file-name': encodeURIComponent('partial content.json') }, body: bytes });
  assert.equal(uploaded.status, 201); const source = (await uploaded.json() as any).data;
  const task = await h.request('/v1/tasks/submit', { scopeId: 'scp_lab', capabilityPackId: 'mindmap-compile',
    input: { sourceRevisionId: source.sourceRevisionId }, idempotencyKey: 'partial-key' });
  await h.phase(task.taskId, 'delivered');
  const result = await h.request(`/v1/tasks/${task.taskId}/result`); assert.equal(result.status, 'partial'); assert.ok(result.unmapped.length);
  await h.reject('/v1/tasks/submit', { scopeId: 'scp_second', capabilityPackId: 'mindmap-compile',
    input: { sourceRevisionId: source.sourceRevisionId }, idempotencyKey: 'cross-source-key' }, 'FORBIDDEN_SCOPE');
  const invalid = await h.request('/v1/sources', { scopeId: 'scp_lab', fileName: 'invalid.json', contentBase64: Buffer.from('broken').toString('base64') });
  const failed = await h.request('/v1/tasks/submit', { scopeId: 'scp_lab', capabilityPackId: 'mindmap-compile',
    input: { sourceRevisionId: invalid.sourceRevisionId }, idempotencyKey: 'invalid-key' });
  await h.phase(failed.taskId, 'failed');
  const failure = await h.request(`/v1/tasks/${failed.taskId}/result`);
  assert.equal(failure.status, 'failed'); assert.equal(failure.error.code, 'INVALID_MINDMAP'); assert.deepEqual(failure.artifacts, []);
});
