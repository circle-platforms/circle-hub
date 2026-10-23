import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { INDEX } from './store.ts';
import { sandboxSkip } from './testing/harness.ts';
import { standardDocument, toyMap } from './testing/mindmap.ts';
import { openRetryHarness } from './testing/retry-harness.ts';
let postgres:TemporaryPostgres;
const skip=await sandboxSkip();
before(async()=>{postgres=await startPostgres();});after(async()=>{await postgres?.stop();});
for(const mode of ['recover','exhaust','retain','missing'])test(`data-only fragment ${mode} performs the available recovery step`,{skip},async()=>{
  const h=await openRetryHarness(postgres,{review:{dynamicFindings:true},dataQuotes:true});
  try{
    const doc=standardDocument();doc.groups=[{...doc.groups[0],cases:[doc.groups[0].cases[0]]}];
    const source=await h.upload(h.alice,toyMap(doc));
    const run=(await h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',version:'10.6.1',build:'Rel_MEADOW_10_6_1_7',inputs:{map:{reference:source}}},h.call())).run!;
    const ref=run.sources.find(row=>row.external?.startsWith('toy:story:'))!.reference;
    const sha=ref.slice(4).split('/')[0];const original=h.kit.artifacts.source.bind(h.kit.artifacts);let reads=0;
    h.kit.artifacts.source=async(...args)=>{
      if(args[1]!==sha)return original(...args);reads++;
      if(mode==='missing')return null;
      if(mode==='exhaust'||mode==='recover'&&reads<3)throw new Error('SyntheticFragmentReadFailure');
      const value=await original(...args);return mode==='retain'&&value?{...value,bytes:null,readTier:'retain_only'}:value;
    };
    const submission={run:run.run,model:'synthetic-model',items:[{item:run.items[0].id,handling:'handled',slots:{findings:[{text:'合成引文',code:'edge_case_gap',rank:'major',quotes:[{reference:run.items[0].location,text:run.items[0].label}],data:{expected_quote:{reference:ref,text:'分区编号 1 到 8'}}}]}}],cross_item:[{nature:'judgment',statement:'一般',grounds:[],code:'draft_level',rank:'P4'}]};
    const answer=await h.service.submitResult(h.alice,submission,h.call());
    assert.equal(reads,mode==='recover'||mode==='exhaust'?3:1);
    assert.ok(!JSON.stringify(answer).includes('SyntheticFragmentReadFailure'));
    if(mode==='exhaust'){
      assert.equal(answer.result,undefined);assert.equal(answer.acceptance,'not_accepted');assert.match(answer.errors[0].fix??'',/管理员/);
      const actions=(await h.kit.store.find({key:INDEX.actionRun,value:run.run,kind:'action'})).items;
      assert.ok(actions.some(row=>(row.body as {result:string}).result==='error'));return;
    }
    assert.equal(answer.acceptance,'accepted',JSON.stringify(answer.errors));
    const claims=Object.values(answer.result!.partitions).flat().flatMap(item=>item.requirements).flatMap(req=>req.claims);
    if(mode==='recover')assert.ok(!claims.some(claim=>claim.statement.verdict==='unknown'),JSON.stringify(claims));
    else {
      assert.ok(claims.some(claim=>claim.statement.verdict==='unknown'));
      if(mode==='retain') {
        const retained=claims.find(claim=>(claim.statement.data?.unread_sources as Array<{reference:string}>|undefined)?.some(source=>source.reference===ref));
        assert.ok(retained,'data-only retain-only references keep typed unread source evidence');
        assert.equal(retained.statement.reason,'awaiting_step');
        const unread=(retained.statement.data!.unread_sources as Array<Record<string,unknown>>)[0];
        assert.equal(unread.reason,'credential_unreadable');
        assert.match(String(unread.missing_fact),/管理员.*接受/);assert.match(String(unread.next_action),/请求管理员.*接受.*重新核验/);
        assert.match(retained.statement.text,/管理员.*接受.*重新核验/);
      }
    }
  }finally{await h.close();}
});
