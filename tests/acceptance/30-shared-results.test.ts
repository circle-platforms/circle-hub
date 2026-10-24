// Synthetic production sharing over the real MCP, records and CLI boundaries; no deployment action is performed.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { osIsolationAvailable } from '../../hub/rules/api.ts';
import { writePack } from '../../hub/runs/engine/testing/packs.ts';
import { adminCommands } from '../../hub/server/cli-admin.ts';
import type { CliContext } from '../../hub/server/api.ts';
import { memoryOperatorTokens } from '../../hub/server/assemble/operator-token.ts';
import { recordDigest } from '../../hub/refs/api.ts';
import { openBed, type Bed } from './support/hub.ts';
import { connect, type McpClient } from './support/mcp.ts';
const pack = 'synthetic-sharing';
const skip = await osIsolationAvailable() ? false : 'sandbox-exec is unavailable';
let postgres: TemporaryPostgres; let bed: Bed; let directory: string;
let owner: McpClient; let viewer: McpClient; let outsider: McpClient;
let readerId: string; let runId: string; let original: string;
async function command(name: string,args: string[]) {
  const output: string[]=[];
  const ctx: CliContext={io:{cwd:directory,env:{},stdout:s=>output.push(s),stderr:s=>output.push(s)},config:()=>bed.hub.hub.config,records:async()=>bed.hub.records,deps:async()=>bed.hub.deps,actingAdmin:async()=>bed.hub.admin.principal};
  const cmd=adminCommands({tokens:()=>memoryOperatorTokens(bed.hub.admin.token,'synthetic-home')}).find(c=>c.name===name)!;
  assert.equal(await cmd.run(args,ctx),0,output.join('\n'));
}
before(async()=>{
  if(skip)return;
  postgres=await startPostgres();directory=await mkdtemp(join(tmpdir(),'shared-production-'));
  const source='src:'+'a'.repeat(64)+'/json@1/p/totals';
  const folder=await writePack(directory,{id:pack,version:'1.0.0',kind:'workflow',title:'合成视图事实',description:'核对冻结视图的类型字段',files:{
    'workflow.json':{json:{schema:'workflow@1',inputs:[{slot:'view',role:'subject',description:'冻结视图',accepts:['application/json','knowledge:facets'],required:true,many:false}],parameters:[],product:{catalogs:['commands@1']},subject:'view',projection:{module:'functions/project.ts'}}},
    'requirements.json':{json:{schema:'requirements@1',requirements:[{key:'summary',name:'视图类型',description:'类型字段存在',target:'item',required:true,accepted_producer:'fact',checks:['shape'],layers:['static'],done_rule:'bookkeeping',error_handling:[]}]}},
    'checks.json':{json:{schema:'checks@1',checks:[{id:'shape',interpreter:'structure@1',table:'tables/shape.json',applies:'item',judges:'subject',tier:'advisory'}]}},
    'slots.schema.json':{json:{schema:'slots@1',item:{},run:{}}},'SKILL.md':'# 合成视图事实\n由 Hub 核对冻结视图，不调用模型。\n',
    'functions/project.ts':"export default input => ({items:[{id:'summary',label:'视图类型',location:{parser:'json@1',selector:'p/totals'},fields:{schema:input.inputs[0].model.schema}}],warnings:[]});",
    'tables/shape.json':{json:{schema:'structure@1',origin:'合成视图要求',nodes:'$',item:'/item',location:'/location',rules:[{fields:[{path:'/fields/schema',required:true,type:'string'}]}]}},
    'samples/positive/shape.json':{json:{id:'shape_positive',check:'shape',source:'author',note:'合成正例',subject:{item:'summary',location:source,fields:{schema:'facet-view@1'}},expect:[{verdict:'support'}]}},
    'samples/negative/shape.json':{json:{id:'shape_negative',check:'shape',source:'author',note:'合成反例',subject:{item:'summary',location:source,fields:{}},expect:[{verdict:'refute',code:'core.structure.required_empty'}]}},
  }});
  bed=await openBed({postgres,packs:[folder],syncOneName:false});
  const author=await bed.user('合成生产者',[pack]);const reader=await bed.user('合成分享读者',[pack]);readerId=reader.principal.id;
  const other=await bed.user('合成旁观者',[]);
  owner=await bed.connect(author);viewer=await bed.connect(reader);outsider=await bed.connect(other);
  const view=`knowledge:facets:${bed.product.line}:${bed.site.RELEASED}?kind=case&by=module`;
  const started=await owner.call('start_run',{pack,product:bed.product.names[0],build:bed.site.RELEASED,client_key:'synthetic-share-key',inputs:{view:{external:view}}});
  assert.equal(started.isError,false,JSON.stringify(started.out.errors));runId=started.out.run!.run;original=started.out.run!.sources.find(s=>s.slot==='view')!.reference;
});
after(async()=>{await owner?.close();await viewer?.close();await outsider?.close();await bed?.close();await postgres?.stop();if(directory)await rm(directory,{recursive:true,force:true});});
test('administrator production sharing is read only, carries generated evidence and follows assignment and withdrawal', {skip}, async()=>{
  const detail=(await bed.hub.hub.runs.getRun(bed.hub.admin.principal,runId))!;
  const run=(await bed.hub.records.store.find({kind:'run',key:'runs.id',value:runId,limit:1})).items[0];
  const result='rec:'+detail.production!.record;
  const denied=await viewer.call('get_nodes',{reference:result});assert.equal(denied.isError,true);
  await command('share',['production',pack,'--reason','合成验收只读分享']);
  for(const reference of ['rec:'+run.digest,result,original]){
    const answer=await viewer.call('get_nodes',{reference,run:runId});assert.equal(answer.isError,false,JSON.stringify(answer.out.errors));assert.equal(answer.out.content?.readable,true);
    if(reference==='rec:'+run.digest){ const body=JSON.parse(answer.out.content!.text!); assert.deepEqual(body,run.body); assert.equal(recordDigest({kind:run.kind,schema:run.schema,provenance:run.provenance,created_at:run.created_at,body}),run.digest); }
  }
  assert.equal((await viewer.call('get_nodes',{reference:original})).isError,true);
  const hidden=await outsider.call('get_nodes',{reference:result,run:runId});assert.equal(hidden.isError,true);
  const nonexistent=await outsider.call('get_nodes',{reference:'rec:'+'f'.repeat(64)});
  assert.deepEqual(hidden.out.errors.map(e=>e.code),nonexistent.out.errors.map(e=>e.code));
  const submit=await viewer.call('submit_result',{run:runId,model:'synthetic',items:[]});assert.equal(submit.isError,true);assert.equal(submit.out.errors[0].code,'SOURCE_UNAVAILABLE');
  const ownSource=await viewer.upload(Buffer.from(JSON.stringify({schema:'synthetic-view@1',totals:{}})),'synthetic-view.json','application/json');
  const own=await viewer.call('start_run',{pack,product:bed.product.names[0],build:bed.site.RELEASED,client_key:'synthetic-share-key',inputs:{view:{reference:ownSource}}});assert.equal(own.isError,false,JSON.stringify(own.out.errors));assert.notEqual(own.out.run!.run,runId);
  await bed.hub.hub.registry.unassign(bed.hub.admin.principal,readerId,pack);
  assert.equal((await viewer.call('get_nodes',{reference:result,run:runId})).isError,true);
  assert.equal((await viewer.call('get_nodes',{reference:original,run:runId})).isError,true);
  await bed.hub.hub.registry.assign(bed.hub.admin.principal,readerId,pack);
  await command('unshare',['production',pack]);
  assert.equal((await viewer.call('get_nodes',{reference:result,run:runId})).isError,true);
  assert.equal((await viewer.call('get_nodes',{reference:original,run:runId})).isError,true);
});
