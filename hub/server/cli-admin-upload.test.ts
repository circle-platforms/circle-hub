import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { docCommand } from './cli-admin.ts';
import type { Session } from './cli-session.ts';
import { UsageError } from './errors.ts';

const hash = 'b'.repeat(64), reference = 'src:' + hash, admin = { id: 'synthetic-admin', name: '合成管理员', role: 'admin' };
function fixture(source: { bytes: Uint8Array | null; mediaType?: string } | null = { bytes: Buffer.from('合成清单'), mediaType: 'application/json' }) {
  const reads: unknown[][] = [], writes: unknown[][] = [];
  const session = { ctx: { io: { cwd: tmpdir() } }, viewer: async () => admin, admin: async () => admin, out: () => {}, records: async () => ({ artifacts: { source: async (...args: unknown[]) => { reads.push(args); return source; } }, objects: { get: () => { throw new Error('raw object read'); } } }), hub: async () => ({ docs: { put: async (...args: unknown[]) => { writes.push(args); return { name: 'synthetic-topology', sha256: hash, size: 12, created: true }; } } }) };
  return { session, reads, writes };
}

test('doc put accepts a permitted uploaded original and retains local CLI file input', async t => {
  const f = fixture();
  assert.equal(await docCommand(f.session as unknown as Session, ['put', 'synthetic-topology', '--reference=' + reference]), 0);
  assert.deepEqual(f.reads, [[admin, hash, { consumer: 'function' }]]);
  assert.deepEqual(f.writes[0].slice(0, 2), [admin, 'synthetic-topology']);
  assert.deepEqual(Buffer.from(f.writes[0][2] as Uint8Array), Buffer.from('合成清单'));
  assert.deepEqual(f.writes[0][3], { fileName: 'synthetic-topology.json', mediaType: 'application/json' }, 'the uploaded original keeps its media type');
  const directory = await mkdtemp(join(tmpdir(), 'hub-doc-input-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'topology.json'); await writeFile(path, '合成本机清单');
  assert.equal(await docCommand(f.session as unknown as Session, ['put', 'synthetic-topology', path]), 0);
  assert.equal(f.writes.length, 2); assert.equal(f.reads.length, 1);
});

test('doc put refuses an uploaded original whose media type no core parser reads, without publishing', async () => {
  const f = fixture({ bytes: Buffer.from('合成清单'), mediaType: 'application/octet-stream' });
  await assert.rejects(docCommand(f.session as unknown as Session, ['put', 'synthetic-topology', '--reference=' + reference]), /媒体类型是 application\/octet-stream，Hub 没有能读它的解析器/);
  assert.equal(f.writes.length, 0);
});

test('doc put refuses unauthorized or withheld uploads and mixed input without publishing', async () => {
  for (const source of [null, { bytes: null }]) {
    const f = fixture(source);
    await assert.rejects(docCommand(f.session as unknown as Session, ['put', 'synthetic-topology', '--reference=' + reference]));
    assert.equal(f.writes.length, 0);
  }
  const f = fixture();
  await assert.rejects(docCommand(f.session as unknown as Session, ['put', 'synthetic-topology', 'file.json', '--reference=' + reference]), UsageError);
  assert.equal(f.writes.length, 0); assert.equal(f.reads.length, 0);
  f.session.admin = async () => { throw new Error('管理员已停用'); };
  await assert.rejects(docCommand(f.session as unknown as Session, ['put', 'synthetic-topology', '--reference=' + reference]));
  assert.equal(f.reads.length, 0);
});
