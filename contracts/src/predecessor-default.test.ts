import assert from 'node:assert/strict';
import {test} from 'node:test';
import {WorkflowInput} from './pack.ts';
import {RunRecord,RunSummary,InputSlotSummary} from './run.ts';
import {runRecord} from './fixtures.ts';
const reference=`rec:${'a'.repeat(64)}`;
const slot={slot:'review',role:'artifact_under_verification',description:'合成待复核结果',accepts:['application/json'],required:true,many:false};
test('an artifact slot can explicitly declare the predecessor workflow supplying its default result',()=>{
  assert.ok(WorkflowInput.safeParse({...slot,default_from_predecessor:{pack:'synthetic-draft'}}).success);
  assert.ok(InputSlotSummary.safeParse({...slot,default_from_predecessor:{pack:'synthetic-draft'}}).success,'tools retain the declared default source');
  assert.ok(WorkflowInput.safeParse(slot).success,'legacy input slots remain valid');
  for(const value of [{...slot,role:'subject'},{...slot,accepts:['application/octet-stream']}])assert.ok(!WorkflowInput.safeParse({...value,default_from_predecessor:{pack:'synthetic-draft'}}).success);
  assert.ok(WorkflowInput.safeParse({slot:'target',role:'subject',description:'合成评审对象',accepts:['application/json'],required:true,many:false,default_from_predecessor:{pack:'synthetic-draft',slot:'subject'}}).success);
  assert.ok(WorkflowInput.safeParse({...slot,many:true,from_runs:{pack:'synthetic-draft'}}).success);
  assert.ok(!WorkflowInput.safeParse({...slot,default_from_predecessor:{pack:'synthetic-draft'},from_runs:{pack:'synthetic-draft'}}).success);
  assert.ok(!WorkflowInput.safeParse({...slot,default_from_predecessor:{pack:'bad@version'}}).success);
});
test('defaulted input provenance is frozen in the run and summary without fragment references or duplicate slots',()=>{
  const input_defaults=[{slot:'review',predecessor:runRecord.run,reference}];
  const parsed=RunRecord.safeParse({...runRecord,predecessor:runRecord.run,input_defaults});
  assert.ok(parsed.success);
  assert.deepEqual(parsed.data.input_defaults,input_defaults);
  assert.ok(Object.hasOwn(RunSummary.shape,'input_defaults'));
  assert.ok(RunRecord.safeParse(runRecord).success,'historical runs need no invented provenance');
  assert.ok(!RunRecord.safeParse({...runRecord,input_defaults:[{...input_defaults[0],reference:reference+'#/body'}]}).success);
  assert.ok(!RunRecord.safeParse({...runRecord,input_defaults:[...input_defaults,...input_defaults]}).success);
  assert.ok(RunRecord.safeParse({...runRecord,input_defaults:[input_defaults[0],{slot:'review',predecessor:runRecord.run,reference:`rec:${'b'.repeat(64)}`}]}).success,'one slot can record several resolved results');
});
