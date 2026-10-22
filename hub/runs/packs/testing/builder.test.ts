import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { PackManifest } from '../../../../contracts/src/pack.ts';
import { readPackDirectory } from '../directory.ts';
import { corruptByte, editJson, productPack, signPack, systemPack, temporaryDirectory, withFiles, workflowPack, writePack } from './builder.ts';

let temp: { path: string; remove: () => Promise<void> };
before(async () => {
  temp = await temporaryDirectory();
});
after(() => temp?.remove());

test('written packs of every kind carry a manifest the contracts accept and that matches the files', async () => {
  for (const [i, pack] of [workflowPack(), productPack(), systemPack()].entries()) {
    const written = await writePack(join(temp.path, `k${i}`), pack);
    assert.ok(PackManifest.safeParse(JSON.parse(await readFile(join(written.dir, 'pack.json'), 'utf8'))).success, pack.kind);
    const read = await readPackDirectory(written.dir);
    assert.ok(read.ok, `${pack.kind}: ${JSON.stringify(!read.ok && read.problems)}`);
    assert.equal(read.pack.digest, written.digest);
  }
});

test('corrupting one byte breaks the manifest unless the pack is signed again, which changes the digest', async () => {
  const written = await writePack(join(temp.path, 'c'), workflowPack());
  assert.equal(await corruptByte(written.dir, 'SKILL.md', { offset: 2 }), null);
  const broken = await readPackDirectory(written.dir);
  assert.ok(!broken.ok && broken.problems.some((p) => p.rule === 'manifest.digest_mismatch'));
  const resigned = await corruptByte(written.dir, 'SKILL.md', { offset: 3, resign: true });
  assert.ok(resigned);
  const read = await readPackDirectory(written.dir);
  assert.ok(read.ok);
  assert.equal(read.pack.digest, resigned.digest);
  assert.notEqual(resigned.digest, written.digest);
  const bumped = await signPack(written.dir, { version: '1.0.1' });
  assert.equal(bumped.manifest.version, '1.0.1');
  assert.notEqual(bumped.digest, resigned.digest);
});

test('descriptions are edited by copy', () => {
  const pack = workflowPack();
  const edited = editJson<Record<string, any>>(pack, 'checks.json', (c) => void (c.checks[0].tier = 'advisory'));
  assert.equal((pack.files['checks.json'] as Record<string, any>).checks[0].tier, 'blocking');
  assert.equal((edited.files['checks.json'] as Record<string, any>).checks[0].tier, 'advisory');
  const removed = withFiles(pack, { 'knowledge.json': null });
  assert.ok('knowledge.json' in pack.files && !('knowledge.json' in removed.files));
});
