import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GetNodesInput, UploadFileInput } from './tools.ts';
import { SpaceEntryInput, SpaceGrantBody } from './spaces.ts';
test('personal entries require no product and upload accepts exactly one payload mode', () => {
  const entry = SpaceEntryInput.parse({ kind: 'observation', statement: '合成笔记' });
  assert.equal(entry.applicability, null);
  assert.deepEqual(entry.grounds, []);
  assert.equal(UploadFileInput.safeParse({ personal_entry: entry }).success, true);
  assert.equal(UploadFileInput.safeParse({}).success, false);
  assert.equal(UploadFileInput.safeParse({ personal_entry: entry, file_path: 'YQ==' }).success, false);
  assert.equal(UploadFileInput.safeParse({ file_path: 'YQ==', space: 'team' }).success, false);
});
test('space reads retain the six-tool interface and member grants name exactly one account', () => {
  assert.equal(GetNodesInput.safeParse({ search: '合成知识', scope: 'shared' }).success, true);
  assert.equal(GetNodesInput.safeParse({ search: 'x'.repeat(201) }).success, false);
  const grant = { space: 'usr_' + '0'.repeat(26), path: '/', audience: 'member', member: null, action: 'grant', by: 'usr_' + '0'.repeat(26), at: '2026-11-02T00:00:00.000Z' };
  assert.equal(SpaceGrantBody.safeParse(grant).success, false);
  assert.equal(SpaceGrantBody.safeParse({ ...grant, audience: 'administrators' }).success, true);
});
