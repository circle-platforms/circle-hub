import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { MemberDeletionBody } from '../../contracts/src/spaces.ts';
import { createTestServer } from './testing.ts';

test('H2: memberDeletions.preview counts bot-runtime/files and finish() removes only that member directory without breaking MemberDeletionBody', async (t) => {
  const hub = await createTestServer();
  t.after(() => hub.close());

  const alice = await hub.createUser('附件清理甲');
  const bob = await hub.createUser('附件保留乙');
  const memberDir = (userId: string) =>
    join(hub.deps.config.dataDir, 'bot-runtime', 'files', createHash('sha256').update(userId).digest('hex'));

  const aliceDir = memberDir(alice.principal.id);
  const bobDir = memberDir(bob.principal.id);
  await mkdir(aliceDir, { recursive: true, mode: 0o700 });
  await mkdir(bobDir, { recursive: true, mode: 0o700 });
  const a1 = Buffer.from('synthetic-bot-file-one'); // 22 bytes
  const a2 = Buffer.from('second-file-bytes'); // 17 bytes
  const digest1 = createHash('sha256').update(a1).digest('hex');
  const digest2 = createHash('sha256').update(a2).digest('hex');
  await writeFile(join(aliceDir, digest1), a1);
  await writeFile(join(aliceDir, digest2), a2);
  await writeFile(join(bobDir, digest1), a1);

  const preview = await hub.records.memberDeletions!.preview(hub.admin.principal, alice.principal.id);
  assert.deepEqual(preview.bot_files, {
    count: 2,
    bytes: a1.length + a2.length,
  });
  // Existing 6-field technical counts & schema remain unchanged and backward-compatible with release/2026-11-23.
  assert.deepEqual(Object.keys(preview.counts).sort(), [
    'archives',
    'attributions',
    'objects',
    'payloads',
    'private_versions',
    'records',
  ]);

  const intent = await hub.records.memberDeletions!.prepare(hub.admin.principal, {
    ...preview,
    operation_id: randomUUID(),
  });
  MemberDeletionBody.parse(intent);
  const receipt = await hub.records.memberDeletions!.finish(
    hub.admin.principal,
    alice.principal.id,
    intent.operation_id,
  );
  MemberDeletionBody.parse({ ...receipt, record: undefined }.record === undefined ? intent : receipt);

  await assert.rejects(access(aliceDir), 'deleted member bot-runtime/files folder must be removed');
  await access(join(bobDir, digest1));
});
