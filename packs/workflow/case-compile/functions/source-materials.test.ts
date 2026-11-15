import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceFileName, sourceMaterialNames, readSourceManifest, readSourceBytes } from './source-materials.ts';
import { sha256 } from './generated/skills/run-tools/hub-client/index.ts';
const a = Buffer.from('{"synthetic":"a"}'), b = Buffer.from('{"synthetic":"b"}'), c = Buffer.from('{"synthetic":"c"}');
test('names use the explicit media declaration and stable collision-free repeated-slot ordinals', () => {
  assert.equal(sourceFileName('contract', 'application/json'), 'contract.json'); assert.equal(sourceFileName('subject', 'text/plain', 1), 'subject.2.txt'); assert.equal(sourceFileName('opaque', 'application/octet-stream'), 'opaque');
  assert.throws(() => sourceFileName('../escape', 'application/json'));
  const rows = [{slot:'subject',reference:`src:${sha256(a)}`,media_type:'application/json'},{slot:'subject',reference:`src:${sha256(b)}`,media_type:'application/json'},{slot:'subject-1',reference:`src:${sha256(c)}`,media_type:'application/json'},{slot:'contract',reference:`src:${sha256(a)}`,media_type:'application/json'},{slot:'record',reference:`rec:${'f'.repeat(64)}`}];
  assert.deepEqual(sourceMaterialNames(rows), ['sources/subject.json','sources/subject.2.json','sources/subject-1.json','sources/subject.json',null]);
});
test('manifest readers consume recorded pointers for both named sources and legacy digest files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-materials-'));
  try {
    await mkdir(join(root, 'sources')); await writeFile(join(root, 'sources', sha256(a)), a); await writeFile(join(root, 'sources', 'profile.json'), b);
    const rows = [{slot:'contract',reference:`src:${sha256(a)}`,file:`sources/${sha256(a)}`},{slot:'profile',reference:`src:${sha256(b)}`,file:'sources/profile.json'},{slot:'record',reference:`rec:${'f'.repeat(64)}`,file:null}];
    await writeFile(join(root, 'sources.json'), JSON.stringify(rows));
    assert.equal((await readSourceManifest(root)).length, 3); assert.deepEqual(Buffer.from(await readSourceBytes(root,'contract')),a); assert.deepEqual(Buffer.from(await readSourceBytes(root,'profile')),b);
    await writeFile(join(root,'sources','profile.json'),'changed'); await assert.rejects(()=>readSourceBytes(root,'profile'));
  } finally { await rm(root,{recursive:true,force:true}); }
});
test('a missing manifest supports the old root JSON layout but invalid or escaping manifests never fall back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-material-legacy-'));
  try {
    await writeFile(join(root,'contract.json'),a); assert.deepEqual(Buffer.from(await readSourceBytes(root,'contract')),a);
    await writeFile(join(root,'sources.json'),'not JSON'); await assert.rejects(()=>readSourceBytes(root,'contract'));
    await writeFile(join(root,'sources.json'),JSON.stringify([{slot:'contract',reference:`src:${sha256(a)}`,file:'../outside'}])); await assert.rejects(()=>readSourceManifest(root)); assert.deepEqual(await readFile(join(root,'contract.json')),a);
  } finally { await rm(root,{recursive:true,force:true}); }
});
test('manifest file links and source links never provide material bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-material-link-'));
  try {
    await writeFile(join(root,'outside'),a); await mkdir(join(root,'sources')); await symlink(join(root,'outside'),join(root,'sources','linked'));
    await writeFile(join(root,'sources.json'),JSON.stringify([{slot:'contract',reference:`src:${sha256(a)}`,file:'sources/linked'}])); await assert.rejects(()=>readSourceManifest(root));
  } finally { await rm(root,{recursive:true,force:true}); }
});
