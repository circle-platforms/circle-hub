import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutorRegistry, ExecutorDefinition, type RegisteredExecutor } from '../dispatch/api.ts';
import { definition } from '../dispatch/testing/definition.ts';
import type { RecordsKit, Principal, ArtifactSource } from '../records/api.ts';
import { executorCommand, type JobCommandSession } from './cli-job.ts';
import { UsageError } from './errors.ts';

const admin: Principal = { id: 'usr_0123456789abcdefghjkmnpqrs', name: '合成管理员', role: 'admin' };
const hash = 'a'.repeat(64), reference = 'src:' + hash;
function fixture(bytes: Uint8Array | null = Buffer.from(JSON.stringify(definition('http://127.0.0.1/mcp')))) {
  const reads: unknown[][] = [], lines: string[] = [];
  const records = { artifacts: { source: async (...args: unknown[]) => { reads.push(args); return bytes === null ? null : { bytes } as ArtifactSource; } }, objects: { get: () => { throw new Error('raw objects are forbidden'); } } } as unknown as RecordsKit;
  const session: JobCommandSession = { ctx: { io: { cwd: tmpdir() } }, options: { readSecret: async () => { throw new Error('stdin is forbidden'); } }, out: line => lines.push(line), err: line => lines.push(line), admin: async () => admin, records: async () => records, hub: async () => ({ dispatch: null, records, executorRegistry: new ExecutorRegistry(records) }) };
  return { session, records, reads, lines };
}
function registered(input: unknown): RegisteredExecutor {
  return { id: 'exe_0123456789abcdefghjkmnpqrs', digest: hash, resolved_digest: hash, definition: ExecutorDefinition.parse(input), variables: [] } as unknown as RegisteredExecutor;
}

test('executor add and update read authorized upload references and keep local file input', async t => {
  const f = fixture(), seen: unknown[] = [];
  t.mock.method(ExecutorRegistry.prototype, 'add', async (by: Principal, input: unknown, name?:string) => { assert.equal(by, admin);assert.equal(name,'synthetic-runner'); seen.push(input); return registered(input); });
  t.mock.method(ExecutorRegistry.prototype, 'update', async (by: Principal, id: string, input: unknown) => { assert.equal(by, admin); assert.equal(id, 'synthetic-executor'); seen.push(input); return registered(input); });
  assert.equal(await executorCommand(f.session, ['add', '--name=synthetic-runner', '--reference=' + reference]), 0);
  assert.equal(await executorCommand(f.session, ['update', 'synthetic-executor', '--reference=' + reference]), 0);
  assert.deepEqual(f.reads, [[admin, hash, { consumer: 'function' }], [admin, hash, { consumer: 'function' }]]);
  const directory = await mkdtemp(join(tmpdir(), 'hub-executor-input-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'definition.json'); await writeFile(file, JSON.stringify(definition('http://127.0.0.1/mcp')));
  assert.equal(await executorCommand(f.session, ['add', '--name=synthetic-runner', file]), 0);
  assert.equal(seen.length, 3);
  assert.doesNotMatch(f.lines.join('\n'), /127\.0\.0\.1|password/);
});

test('executor upload input rejects mixed sources, fragments, withheld bytes and stale administrator access', async t => {
  let writes = 0; t.mock.method(ExecutorRegistry.prototype, 'add', async () => { writes++; throw new Error('must not write'); });
  const f = fixture();
  for (const args of [['add', '--name=synthetic-runner', 'file.json', '--reference=' + reference], ['add'], ['list', '--reference=' + reference], ['add', '--name=synthetic-runner', '--reference=' + reference + '/text@1/l/1'], ['add', '--name=synthetic-runner', '--reference=rec:' + hash]]) await assert.rejects(executorCommand(f.session, args), UsageError);
  assert.equal(f.reads.length, 0);
  for (const value of [null, { bytes: null }]) {
    const denied = fixture(); denied.records.artifacts.source = async () => value as ArtifactSource | null;
    await assert.rejects(executorCommand(denied.session, ['add', '--name=synthetic-runner', '--reference=' + reference]));
  }
  const revoked = fixture(); revoked.session.admin = async () => { throw new Error('管理员已停用'); };
  await assert.rejects(executorCommand(revoked.session, ['add', '--name=synthetic-runner', '--reference=' + reference]), /管理员已停用/);
  assert.equal(revoked.reads.length, 0); assert.equal(writes, 0);
});

test('executor CLI exposes schema field paths without endpoint, CA or credential input values', async () => {
  const secret = 'SyntheticCredentialNeverEcho42';
  for (const [input, field] of [[definition('http://192.0.2.1/mcp?secret=' + secret), '/endpoint'], [{ ...definition('https://192.0.2.1/mcp'), ca: secret }, '/ca']] as const) {
    const f = fixture(Buffer.from(JSON.stringify(input)));
    await assert.rejects(executorCommand(f.session, ['add', '--name=synthetic-runner', '--reference=' + reference]), error => error instanceof UsageError && error.message.includes(field) && !error.message.includes(secret) && !error.message.includes('192.0.2.1'));
  }
});
