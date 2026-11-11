import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {ResultSummaryBody} from './result-summary.ts';
import {MODEL_VERSION,RECORD_KINDS} from '../generated/protocol.ts';
const model=JSON.parse(readFileSync(new URL('../model.json',import.meta.url),'utf8'));
const run='run_'+'0'.repeat(26),digest='a'.repeat(64),submission='b'.repeat(64);
const body={run,result:digest,submission,acceptance:'accepted',system_input:false,
 statistics:{result:'delivered_pending',pending:1,checks:[{layer:'static',terminal:'unchecked',unknown:true,count:1},{layer:'dynamic',terminal:'pass',unknown:false,count:2}],blockers:[{code:'synthetic.code',count:1},{reason:'check_error',count:2}]},
 grounds:['src:'+'c'.repeat(64),'rec:'+'d'.repeat(64)+'#/partitions/delivered/0','tree:'+'e'.repeat(64)+'/synthetic/folder'],bound:['c'.repeat(64)],unavailable_references:['src:'+'f'.repeat(64)]};

test('model 43 adds the result_summary kind and the W08 rule that says what it is',()=>{
 assert.equal(model.version,43);assert.equal(MODEL_VERSION,43);
 assert.ok((RECORD_KINDS as readonly string[]).includes('result_summary'));
 const w08=model.elements.find((e:{id:string})=>e.id==='W08');
 assert.ok(w08.rules[6].includes('result_summary')&&w08.rules[6].includes('result-summary@1')&&w08.rules[6].includes('决定 153'));
 assert.ok(w08.rules[6].includes('结果记录不改写')&&w08.rules[6].includes('没有摘要的结果'),'the result stays the authority, and a result without a summary is read whole');
 assert.equal(w08.rules[0],'各项计数由条目推算，不另存','the counts are still not stored in the result');
 assert.ok(w08.changes43[0].includes('result_summary'));
});

test('a result summary is a closed shape of the facts a list needs of a result',()=>{
 assert.deepEqual(ResultSummaryBody.parse(body),body);
 assert.deepEqual(ResultSummaryBody.parse({...body,acceptance:'not_accepted',system_input:true,statistics:{result:'awaiting',pending:0,checks:[],blockers:[]},grounds:[],bound:[],unavailable_references:[]}).statistics.result,'awaiting');
 for(const wrong of [
  {...body,extra:1},
  {...body,run:'not-a-run'},
  {...body,result:'short'},
  {...body,acceptance:'maybe'},
  {...body,system_input:'rec:'+digest},
  {...body,statistics:{...body.statistics,result:'done'}},
  {...body,statistics:{...body.statistics,pending:-1}},
  {...body,statistics:{...body.statistics,checks:[{layer:'static',terminal:'no-such-terminal',unknown:false,count:1}]}},
  {...body,statistics:{...body.statistics,checks:[{layer:'static',terminal:'pass',unknown:false,count:0}]}},
  {...body,statistics:{...body.statistics,blockers:[{reason:'no-such-reason',count:1}]}},
  {...body,statistics:{...body.statistics,extra:[]}},
  {...body,grounds:['not a reference']},
  {...body,unavailable_references:['https://synthetic.invalid/']},
  (({result:_,...rest})=>rest)(body),
 ])assert.equal(ResultSummaryBody.safeParse(wrong).success,false,JSON.stringify(wrong).slice(0,120));
});
