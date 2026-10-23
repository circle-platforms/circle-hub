import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { createEngineContext } from './deps.ts';
import { buildScope } from './exact.ts';
import { HubReadFailure } from './retry-read.ts';
import { INDEX } from './store.ts';
import { sandboxSkip } from './testing/harness.ts';
import { standardDocument, toyMap } from './testing/mindmap.ts';
import { openRetryHarness } from './testing/retry-harness.ts';
let postgres: TemporaryPostgres;
const skip = await sandboxSkip();
before(async () => { postgres = await startPostgres(); });
after(async () => { await postgres?.stop(); });

for (const exhaust of [false,true]) test(`command candidate read retries and records exhaustion=${exhaust}`, {skip}, async () => {
  const h=await openRetryHarness(postgres);
  try {
    const doc=standardDocument(); doc.groups=[{...doc.groups[0],cases:[doc.groups[0].cases[0]]}];
    const source=await h.upload(h.alice,toyMap(doc));
    const run=(await h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',version:'10.6.1',build:'Rel_MEADOW_10_6_1_7',inputs:{map:{reference:source}}},h.call())).run!;
    const bound=run.sources.find(value=>value.external?.startsWith('toy:story:'))!;
    const sha=bound.reference.slice(4).split('/')[0];const original=h.kit.artifacts.source.bind(h.kit.artifacts);let reads=0;
    h.kit.artifacts.source=async(...args)=>{if(args[1]===sha){reads++;if(exhaust||reads<3)throw new Error('SyntheticCandidateReadFailure');}return original(...args);};
    const answer=await h.service.submitResult(h.alice,{run:run.run,model:'synthetic-model',items:[{item:run.items[0].id,handling:'handled',slots:{findings:[{text:'合成发现',code:'edge_case_gap',rank:'major',grounds:[run.items[0].location],commands:[{command:'分区编号 1 到 8',present:true}]}]}}],cross_item:[{nature:'judgment',statement:'一般',grounds:[],code:'draft_level',rank:'P4'}]},h.call());
    assert.equal(reads,3);assert.equal(answer.acceptance,exhaust?'not_accepted':'accepted',JSON.stringify(answer.errors));
    const actions=(await h.kit.store.find({key:INDEX.actionRun,value:run.run,kind:'action'})).items;
    assert.ok(actions.some(row=>(row.body as {action:string}).action==='validate'));
    if(exhaust){assert.equal(answer.result,undefined);assert.match(answer.errors[0].fix??'',/管理员/);}
    assert.ok(!JSON.stringify(answer).includes('SyntheticCandidateReadFailure'));
  } finally {await h.close();}
});

for(const part of ['record','catalog'] as const) for(const exhaust of [false,true]) test(`scope ${part} read retries exhaustion=${exhaust}`,{skip},async()=>{
  const h=await openRetryHarness(postgres);
  try{
    const source=await h.upload(h.alice,toyMap(standardDocument()));
    const started=(await h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',version:'10.6.1',build:'Rel_MEADOW_10_6_1_7',inputs:{map:{reference:source}}},h.call())).run!;
    const run=(await h.service.getRun(h.alice,started.run))!.run;
    const ctx=createEngineContext({records:h.kit,workflows:h.workflows,packs:h.packs,knowledge:h.knowledge,external:h.external});
    let reads=0;const failure=()=>{reads++;if(exhaust||reads<3)throw new Error('SyntheticScopeReadFailure');};
    if(part==='record'){
      const record=(await h.kit.store.find({key:INDEX.runId,value:run.run,kind:'run'})).items[0];
      run.sources=[{reference:`rec:${record.digest}`,role:'expected'}];
      const get=h.kit.store.get.bind(h.kit.store);h.kit.store.get=async(...args)=>{if(args[0]===record.digest)failure();return get(...args);};
    }else{const catalog=h.knowledge.catalog.bind(h.knowledge);h.knowledge.catalog=async(...args)=>{failure();return catalog(...args);};}
    const work=buildScope(ctx,run,h.review,h.alice,'function');
    if(exhaust)await assert.rejects(work,error=>error instanceof HubReadFailure&&error.reason==='check_error');else await work;
    assert.equal(reads,3);
  }finally{await h.close();}
});
