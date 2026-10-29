import assert from 'node:assert/strict';
import { test } from 'node:test';
import { osIsolationAvailable } from '../../../hub/rules/api.ts';
import { startPostgres } from '../../../hub/testing/postgres.ts';
import { parseModel } from '../../skill/mindmap-format/tools/parse-model.ts';
import { locateCandidates } from '../../skill/mindmap-format/tools/locate-quotes.ts';
import { prepareClaims } from './tools/prepare-claims.ts';
import { openBed } from './testing/bed.ts';
import { BUILD, LOCK } from './testing/index.ts';

test('batched claims use the one run declaration and pass the real submission boundary',async t=>{
  if(!(await osIsolationAvailable()))return t.skip('operating-system isolation unavailable');
  const pg=await startPostgres(),bed=await openBed(pg);
  try{
    const node=(id:string,text:string,children:unknown[]=[])=>({data:{id,text,priority:2,...(id==='a'||id==='b'?{resource:['Functional']}:{})},children});
    const doc={root:node('root','合成脑图',[node('a','合成用例甲',[node('a-step','合成步骤甲')]),node('b','合成用例乙',[node('b-step','合成步骤乙')])])};
    const raw=JSON.stringify(doc),bytes=Buffer.from(raw),parsed=parseModel(bytes);
    bed.agile.put('1001',{bytes,title:'合成脑图',folders:['合成产品线','030：合成测试项目','101：10.8.1','201: 10.8.1-R1-2026/1','探测']});
    const identity={model_id:'synthetic-model',model_family_id:'synthetic-family'};
    const started=await bed.service.startRunDetailed(bed.runner,{pack:'template-gap',product:LOCK.names[0],build:BUILD,model_identity:identity,inputs:{documents:[{external:'agile:mindmap:1001'}]}},bed.call());
    assert.equal(started.answer.call_result,'ok',JSON.stringify(started.answer.errors));const run=started.answer.run!;
    const located=locateCandidates(raw,parsed,[{item:'1001:a',selector:'n/a-step',text:'合成步骤甲'},{item:'1001:b',selector:'n/b-step',text:'合成步骤乙'}]);
    const claims=prepareClaims(located,[{ordinal:1,category_id:'audit_log',statement:'合成判断甲'},{ordinal:2,category_id:'functional',statement:'合成判断乙'}],{run});
    const input={run:run.run,items:[{item:run.items[0].id,handling:'handled',slots:{coverage:claims}}]};
    const answer=await bed.service.submitResult(bed.runner,input,bed.call());assert.equal(answer.acceptance,'accepted',JSON.stringify(answer.errors));
    const stored=await bed.kit.store.find({key:'runs.submission.run',value:run.run,kind:'submission',limit:10});
    assert.equal(stored.items.length,1);assert.deepEqual(stored.items[0].body,input,'the original model-less submission stays unchanged');
    const result=JSON.stringify(answer.result);assert.ok(result.includes('audit_log'));assert.ok(result.includes('functional'));assert.ok(result.includes('synthetic-model'));
  }finally{await bed.close();await pg.stop();}
});
