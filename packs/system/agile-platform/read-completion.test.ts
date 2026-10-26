import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ReadPlanOutput,MAX_READ_ROUNDS} from '../../../contracts/src/resources.ts';
import {rootsPlan,rootsContent,ROOTS_KEY} from './functions/agile.ts';

test('the final allowed round reads every remaining announced page before claiming completion',()=>{
  const responses:Record<string,any>={};const keys:string[]=[];let done=false;
  for(let round=1;round<=MAX_READ_ROUNDS;round++) {
    const plan=rootsPlan({round,external:{key:ROOTS_KEY},settings:{roots:['7811']},responses});
    assert.ok(ReadPlanOutput.safeParse(plan).success);
    for(const request of plan.requests){
      assert.ok(!keys.includes(request.key));keys.push(request.key);
      const page=Number((request.body as any)?.page);
      responses[request.key]={ok:true,json:request.route==='subtree'?{code:1000,data:[]}:{code:1000,total:490,data:page===49?[{id:7811,label:'合成 10.6 产品'}]:[]}};
    }
    if(plan.done){done=true;break;}
  }
  assert.equal(done,true);assert.equal(keys.filter(key=>key.startsWith('page-')).length,49);
  const {content}=rootsContent({roots:['7811']},responses);
  assert.equal(content.roots[0].title,'合成 10.6 产品');assert.equal(content.complete,true);
});

test('mindmap and search use one aggregate read rather than silently dropping roots after ten',async()=>{
  const {mindmapPlan,searchPlan}=await import('./functions/agile.ts');const roots=Array.from({length:25},(_,n)=>String(7000+n));
  for(const plan of [mindmapPlan({round:1,external:{key:'9901'},settings:{roots}}),searchPlan({round:1,external:{key:'health'},settings:{roots}})]) {
    assert.deepEqual(plan.reads,[{external:'agile:tree:roots'}]);
  }
  const plan=rootsPlan({round:1,external:{key:ROOTS_KEY},settings:{roots},responses:{}});
  assert.equal(plan.requests.filter(r=>r.route==='subtree').length,25);
});
