import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MemberDeletionBody,TeamSourceAttributionBody} from './spaces.ts';
import {AccountStatusSchema,AccountDisplayNameSchema,labelOf,uiLabelOf} from '../generated/vocabulary.ts';
const id='usr_'+'0'.repeat(26),sha='a'.repeat(64),at='2026-11-03T00:00:00.000Z';
test('member deletion receipts and team declaration credentials are closed digest-only shapes',()=>{
 const deletion={operation_id:'00000000-0000-4000-8000-000000000003',member:id,by:id,at,epoch:'00000000-0000-4000-8000-000000000001',purge_manifest:sha,counts:{records:1,payloads:2,objects:0,attributions:1,archives:0,private_versions:0}};
 assert.deepEqual(MemberDeletionBody.parse(deletion),deletion);
 for(const extra of [{path:'/synthetic-private'},{title:'synthetic-private'},{body:'synthetic-private'},{credentials:'synthetic-only'},{manifest:[sha]}])assert.throws(()=>MemberDeletionBody.parse({...deletion,...extra}));
 assert.throws(()=>MemberDeletionBody.parse({...deletion,counts:{...deletion.counts,paths:['/synthetic-private']}}));assert.throws(()=>MemberDeletionBody.parse({...deletion,counts:{...deletion.counts,objects:-1}}));
 const receipt={team_source:sha,declaration:sha,uploader:id,declared_at:at,artifact:sha,sha256:sha,by:id,at};assert.deepEqual(TeamSourceAttributionBody.parse(receipt),receipt);
 for(const extra of [{path:'/synthetic-private'},{quotation:'synthetic-private'},{name:'synthetic-private.txt'}])assert.throws(()=>TeamSourceAttributionBody.parse({...receipt,...extra}));
 assert.equal(AccountStatusSchema.parse('deleted'),'deleted');assert.equal(labelOf('account_status','deleted'),'已删除');assert.equal(uiLabelOf('account_status','deleted'),'已删除');assert.equal(AccountDisplayNameSchema.parse('deleted_member'),'deleted_member');assert.equal(labelOf('account_display_name','deleted_member'),'已删除的成员');assert.equal(uiLabelOf('account_display_name','deleted_member'),'已删除的成员');
});
