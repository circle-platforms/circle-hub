import assert from 'node:assert/strict';
import {test} from 'node:test';
import {RunRecord,RunSummary} from './run.ts';
import {runRecord,summary} from './fixtures.ts';
const legacy=(value:typeof runRecord|typeof summary)=>{
 const body=structuredClone(value);
 for(const row of body.requirements){delete (row as Partial<typeof row>).rules;delete (row as Partial<typeof row>).run_interpreters;}
 return body;
};
test('historical run records retain absent ruling fields without weakening public summaries',()=>{
 const old=legacy(runRecord);
 const parsed=RunRecord.safeParse(old);
 assert.equal(parsed.success,true);
 assert.deepEqual(parsed.data,old,'reading history must not insert defaults into original record bodies');
 assert.equal(RunSummary.safeParse(legacy(summary)).success,false);
 const half=legacy(runRecord);half.requirements[0].rules=[];
 assert.equal(RunRecord.safeParse(half).success,false,'a partial new summary is not a legacy row');
});
