// JSON keys receive the same conservative token check as string values.
import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {openTestRecords} from '../testing/records.ts';
import {startPostgres,type TemporaryPostgres} from '../testing/postgres.ts';
let pg:TemporaryPostgres;before(async()=>{pg=await startPostgres();});after(()=>pg?.stop());
test('token-shaped keys at every object depth need explicit not-secret confirmation',async t=>{
 const kit=await openTestRecords({postgres:pg});t.after(()=>kit.close());const admin=(await kit.principals.bootstrapAdmin('合成管理员')).user;
 const key='SyntheticMixedToken42';const values=[{[key]:'ordinary'},{outer:[{[key]:false}]}];
 for(const [index,value] of values.entries()){
  const name='DEMO_DATA_'+index;const before=(await kit.variables.list(admin)).length;
  await assert.rejects(kit.variables.setVariable(admin,name,value,'合成设置'),error=>error instanceof Error&&error.message.includes('--not-secret')&&!error.message.includes(key));
  assert.equal((await kit.variables.list(admin)).length,before);
  const allowed=await kit.variables.setVariable(admin,name,value,'合成确认',{notSecret:true});assert.equal(allowed.value.version,1);assert.match(allowed.value.decision.body.note??'',/--not-secret/);
  assert.deepEqual(await kit.variables.valueAt(name,allowed.value.decision.digest),value);
 }
 await kit.variables.setVariable(admin,'DEMO_ORDINARY',{build_name:'ordinary'},'合成普通字段');
});
