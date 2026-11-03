import {SpaceQuotaBody} from './spaces.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GetNodesInput, UploadFileInput } from './tools.ts';
import { SpaceEntryInput, SpaceGrantBody, SpaceVersionBody } from './spaces.ts';
test('personal entries require no product and upload accepts exactly one payload mode', () => {
  const entry = SpaceEntryInput.parse({ kind: 'observation', statement: '合成笔记' });
  assert.equal(entry.applicability, null);
  assert.deepEqual(entry.grounds, []);
  assert.equal(UploadFileInput.safeParse({ personal_entry: entry }).success, true);
  assert.equal(UploadFileInput.safeParse({}).success, false);
  assert.equal(UploadFileInput.safeParse({ personal_entry: entry, file_path: 'YQ==' }).success, false);
  assert.equal(UploadFileInput.safeParse({ file_path: 'YQ==', space: 'team' }).success, false);
});
test('only a Hub-maintained team snapshot can omit its account actor',()=>{
  const version={space:'team',parent:null,tree:'a'.repeat(64),directories:['/'],entries:[],by:null,at:'2026-11-02T00:00:00.000Z',reason:'合成系统登记',used_bytes:0};
  assert.equal(SpaceVersionBody.safeParse(version).success,true);
  const owner='usr_'+'0'.repeat(26);
  assert.equal(SpaceVersionBody.safeParse({...version,space:owner}).success,false);
  assert.equal(SpaceVersionBody.safeParse({...version,space:owner,by:owner}).success,true);
  assert.equal(SpaceVersionBody.safeParse({...version,by:owner}).success,true,'old account-attributed team versions remain readable');
});
test('space reads retain the six-tool interface and member grants name exactly one account', () => {
  assert.equal(GetNodesInput.safeParse({ search: '合成知识', scope: 'shared' }).success, true);
  assert.equal(GetNodesInput.safeParse({ search: 'x'.repeat(201) }).success, false);
  const grant = { space: 'usr_' + '0'.repeat(26), path: '/', audience: 'member', member: null, action: 'grant', by: 'usr_' + '0'.repeat(26), at: '2026-11-02T00:00:00.000Z' };
  assert.equal(SpaceGrantBody.safeParse(grant).success, false);
  assert.equal(SpaceGrantBody.safeParse({ ...grant, audience: 'administrators' }).success, true);
});


test('quota records accept the existing team identifier without accepting arbitrary owners',()=>{
 const base={bytes:10*1024**3,by:'usr_01arzte2b0dy6pj8cd4avj118p',at:'2026-11-03T00:00:00.000Z'};
 assert.equal(SpaceQuotaBody.parse({...base,space:'team'}).space,'team');assert.ok(SpaceQuotaBody.safeParse({...base,space:base.by}).success);assert.equal(SpaceQuotaBody.safeParse({...base,space:'unknown'}).success,false);
});
