import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {RunRecord} from '../../../contracts/src/run.ts';
import type {LoadedWorkflow} from '../../ports.ts';
import {Refusal,protocolError} from './errors.ts';
import {predecessorInputRefusal} from './predecessor-defaults.ts';
test('predecessor hints keep the frozen external revision and exclude unrelated slots',()=>{
 const identity='doc:doc:synthetic-topology@'+'a'.repeat(64);
 const predecessor={sources:[{slot:'inventory',external:identity,reference:'src:'+'b'.repeat(64)},{slot:'other',external:'doc:doc:unrelated',reference:'src:'+'c'.repeat(64)}]} as unknown as RunRecord;
 const workflow={workflow:{inputs:[{slot:'inventory'}]}} as LoadedWorkflow;
 const error=new Refusal([protocolError('SOURCE_ABSENT','合成不存在',{path:'/inputs/inventory',fix:'请提供有效输入'})],'synthetic admin note');
 assert.throws(()=>predecessorInputRefusal(error,predecessor,workflow),(caught:unknown)=>{
  assert.ok(caught instanceof Refusal);assert.equal(caught.adminNote,error.adminNote);assert.equal(caught.errors[0].code,error.errors[0].code);assert.equal(caught.errors[0].path,error.errors[0].path);
  assert.ok(caught.errors[0].fix!.includes(identity));assert.ok(!caught.errors[0].fix!.includes('unrelated'));assert.match(caught.errors[0].fix!,/未自动沿用或改变绑定/);return true;
 });
 assert.throws(()=>predecessorInputRefusal(error,null,workflow),caught=>caught===error);
 const fault=new Error('synthetic fault');assert.throws(()=>predecessorInputRefusal(fault,predecessor,workflow),caught=>caught===fault);
});
