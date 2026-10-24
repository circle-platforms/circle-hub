import assert from 'node:assert/strict';
import {test} from 'node:test';
import {canonicalBytes} from '../records/api.ts';
import {setup} from './testing/context.ts';
import {probes} from './testing/probes.ts';

for(const ownership of ['staging_directory','none','missing','unexpected','stale-constant']) {
  test(`result attribution ${ownership} is assessed separately from version certification`,async t=>{
    const c=await setup({extraTools:['inspect_seat'],alter:(name,value)=>{
      const args=c.endpoint.calls.filter(e=>e.params.name===name).at(-1)?.params.arguments as Record<string,unknown>;
      if(name==='inspect_seat')return {output:args.command==='inspect version'?'version: synthetic-build':`address: 192.0.2.${Number(args.seat)+1}/24`};
      if(name==='read_blob')return {...value,...(ownership==='missing'?{}:{ownership:ownership==='stale-constant'?'staging_directory':ownership}),ownership_reason:(ownership==='staging_directory'||ownership==='stale-constant')?null:'ambiguous_reports',rows:[{id:'synthetic-case',outcome:'good',log:'SYNTHETIC_END',stale:ownership==='stale-constant'}]};
      return value;
    }});t.after(()=>c.close());
    const manifest=await c.kit.artifacts.ingest({bytes:canonicalBytes({id:'synthetic-bed',devices:[1,2].map(n=>({interfaces:[{address:`192.0.2.${n}/24`}]}))}),mediaType:'application/json',origin:{upload:{session:'synthetic'}},author:{user:c.owner.id},provenanceType:'declared',visibility:{readers:[c.owner.id],admins:true,packs:[],shareable:false}});
    c.detail.run.sources=c.detail.run.sources.map(s=>s.slot==='synthetic-manifest'?{...s,reference:`src:${manifest.body.sha256}`}:s);
    (c.detail.latest!.result.partitions.delivered[0].requirements[0].claims[0].statement.data as any).bed.manifest_sha256=manifest.body.sha256;
    c.effectDocument.effects[0].parameters.values.manifest_sha256=[manifest.body.sha256];
    const proof=await c.kit.artifacts.ingest({bytes:new TextEncoder().encode('synthetic attribution certification'),mediaType:'text/plain',origin:{upload:{session:'synthetic'}},author:{user:c.admin.id},provenanceType:'declared',visibility:{readers:[c.admin.id],admins:true,packs:[],shareable:false}});
    await c.registry.update(c.admin,c.executor.id,{...c.executor.definition,manifest_sha256:manifest.body.sha256,allowed_tools:[...c.executor.definition.allowed_tools,'inspect_seat'],probes,premises:{result_ownership:{version:'1',evidence:[`src:${proof.body.sha256}`]}},result:{...c.executor.definition.result,ownership:{pointer:'/ownership',value:'staging_directory',reason:'/ownership_reason'},request_id:'/request',log:'/log',log_stale:'/stale',closing_marker:'SYNTHETIC_END'}});
    await c.freezeExecutor();
    const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
    const source=await c.kit.artifacts.source(c.owner,state.result!.slice(4));assert.ok(source?.bytes);
    const report=JSON.parse(new TextDecoder().decode(source.bytes));
    assert.equal(report.rows[0].reported_terminal,'pass');
    assert.equal(report.rows[0].dynamic_terminal,(ownership==='staging_directory'||ownership==='stale-constant')?'pass':'no_verdict');
    if(ownership!=='staging_directory' && ownership!=='stale-constant') {
      assert.ok(report.rows[0].missing_facts.includes('owned'));
      assert.equal(report.ownership.matched,false);assert.equal(report.ownership.reason,'ambiguous_reports');
      assert.match(report.rows[0].next_action,/派发日志.*收集器目录.*保留证据/);
    }
  });
}
