// Relations are generic: synthetic terms and notes, no product dialect or model calls.
import assert from 'node:assert/strict';
import {canonicalBytes} from '../records/api.ts';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRunsService} from '../runs/api.ts';
import {FakeWorkflowStore} from '../runs/engine/testing/workflows.ts';
import {writePack} from '../runs/engine/testing/packs.ts';
import {osIsolationAvailable} from '../rules/api.ts';
import { after,before,test } from 'node:test';
import { runRecord as baseRun } from '../../contracts/src/fixtures.ts';
import {KnowledgeBuildBody} from '../../contracts/src/knowledge.ts';
import { RunRecord } from '../../contracts/src/run.ts';
import { newId } from '../records/api.ts';
import { LINK_MATCH } from '../../contracts/generated/vocabulary.ts';
import { LinkDeclaration,Producer, type KnownBuild } from '../../contracts/src/product.ts';
import { LinksView } from '../../contracts/src/views.ts';
import { createKnowledgeReader } from './api.ts';
import { resolveLiteral,LinkReading } from './links.ts';
import {Lru} from './store.ts';
import {withReadCache} from './read-cache.ts';
import { catalogXml,extraProducer,makeWorld,startPostgres,type World } from './test-support.ts';
import type { TemporaryPostgres } from '../testing/postgres.ts';
import type { ExternalReadContext } from '../ports.ts';
let postgres:TemporaryPostgres;
before(async()=>{postgres=await startPostgres();});after(async()=>{await postgres?.stop();});
const rule=LinkDeclaration.parse({id:'mentions',field:'mentions',namespace:'/terms',match:LINK_MATCH[1],entry_kind:'definition',normalize:{lowercase:true}});
const nodes=new Map([['/',new Set<string>()],['/terms',new Set<string>()],['/terms/alpha',new Set(['definition'])],['/terms/alpha/long',new Set(['definition'])],['/terms/branch',new Set<string>()],['/terms/branch/leaf',new Set(['definition'])],['/terms/raw',new Set(['case'])]]);
test('exact and longest-prefix matching preserve undeclared spelling and report the last reachable node',()=>{
  const exact={...rule,match:LINK_MATCH[0],normalize:undefined};
  assert.equal(resolveLiteral(exact,'alpha',nodes).target,'/terms/alpha');
  assert.equal(resolveLiteral(exact,'alpha value',nodes).target,null);
  assert.equal(resolveLiteral(exact,'ALPHA',nodes).target,null);
  const matched=resolveLiteral(rule,'ALPHA long HostName',nodes);
  assert.equal(matched.target,'/terms/alpha/long');assert.deepEqual(matched.remainder,['HostName']);
  assert.deepEqual(resolveLiteral(rule,'branch',nodes),{target:null,attempted_path:'/terms/branch',stopped_at:'/terms/branch',remainder:['branch']});
  assert.equal(resolveLiteral(rule,'raw',nodes).target,null);
  assert.equal(resolveLiteral(rule,'gone',nodes).stopped_at,'/terms');
});
const fragments=[{parser:'xml@1',selector:'x/catalog'}];
function content(path:string,kind:string,statement:string,mentions?:string[]){return {path,kind,statement,data:mentions?{mentions}:{},fragments,applicability:null};}
const entries=[content('/terms/alpha','definition','Alpha'),content('/terms/alpha/long','definition','Long'),content('/terms/branch/leaf','definition','Leaf'),content('/terms/raw','case','Raw'),content('/notes/one','behaviour','One line\nAnother line',['ALPHA host','alpha long value','branch','gone']),content('/notes/two','behaviour','Another source',['branch'])];
const build:KnownBuild={name:'Rel_WIDGET_10_6_1_1',family:'WIDGET',line:'10.6.1',base:'Rel_WIDGET_10_6_1_1',platform:null,built_at:'2026-10-01T00:00:00Z',released_at:'2026-10-02T00:00:00Z',sources:{tree:'site:tree:links'},root:null};
async function fixture(t:{after(fn:()=>Promise<void>):void},links:typeof rule[]|null=[rule],limits?:{pageNodes?:number;maxViewBytes?:number;inlineRows?:number},sourceEntries:unknown[]=entries){
  const w=await makeWorld(postgres,{pack:{id:'widget',names:['WIDGET'],declaration:{catalogs:[],producers:[extraProducer('entities',{entries:sourceEntries})],...(links===null?{}:{links})}},...(limits?{knowledge:{limits}}:{})});t.after(()=>w.close());
  w.external.set('site:tree:links',{bytes:catalogXml({sample:[{name:'node'}]}),mediaType:'application/xml'});
  const first=await w.knowledge.produceTree({product:w.product,build});assert.ok(first.ok,first.reason??'');
  await w.knowledge.reconcileLine('widget','10.6.1',w.admin);
  const reader=createKnowledgeReader(w.knowledge);
  const read=async(query='',composition?:string|null)=>{
    const id='knowledge:links:widget:10.6.1'+(query?'?'+query:'');
    return reader.read(id,{principal:w.admin,run:null,purpose:'synthetic',...(composition!==undefined?{composition}:{})});
  };
  const json=async(result:Awaited<ReturnType<typeof read>>)=>{assert.ok(result.ok,result.ok?'':result.reason);const bytes=await w.kit.objects.get(result.artifacts[0].artifact.body.sha256);assert.ok(bytes);return {bytes,view:LinksView.parse(JSON.parse(Buffer.from(bytes).toString('utf8')))};};
  return {w,first,read,json};
}
test('forward/reverse views, grouped drift and totals survive every page, and repeated reads are byte-identical',async t=>{
  const f=await fixture(t);const first=await f.json(await f.read('limit=1')),again=await f.json(await f.read('limit=1'));
  assert.deepEqual(first.bytes,again.bytes);assert.deepEqual(first.view.totals,{entries:2,literals:5,links:2,drift_literals:2,drift_occurrences:3});
  const all=[first.view];while(all.at(-1)!.next)all.push((await f.json(await f.read('limit=1&cursor='+all.at(-1)!.next))).view);
  assert.equal(all.flatMap(v=>v.links).length,2);assert.equal(all.flatMap(v=>v.drift.flatMap(g=>g.occurrences)).length,3);
  assert.ok(all.every(v=>JSON.stringify(v.totals)===JSON.stringify(first.view.totals)));
  const reverse=(await f.json(await f.read('target=%2Fterms%2Falpha'))).view;
  assert.equal(reverse.links.length,1);assert.deepEqual(reverse.links[0].remainder,['host']);
  const forward=(await f.json(await f.read('prefix=%2Fnotes%2Ftwo'))).view;
  assert.equal(forward.totals?.drift_occurrences,1);assert.equal(forward.drift[0].stopped_at,'/terms/branch');
  const page=await f.w.knowledge.getNodes({root:f.first.root!,paths:['/terms/alpha'],depth:0,composition:f.first.composition},f.w.admin);
  assert.equal(page?.nodes[0].backlinks?.total,1);assert.equal(page?.nodes[0].backlinks?.entries[0].summary,'One line Another line');
});
test('a new declaration produces the same root, a new composition and pointer, while an old lock stays unchanged',async t=>{
  const f=await fixture(t,[rule],{pageNodes:1});const old=await f.json(await f.read());
  const nodePage=await f.w.knowledge.getNodes({root:f.first.root!,paths:['/'],depth:2},f.w.admin);assert.ok(nodePage?.next);
  f.w.product.product.links=[{...rule,normalize:undefined}];f.w.product.digest='d'.repeat(64);
  const second=await f.w.knowledge.produceTree({product:f.w.product,build});assert.ok(second.ok,second.reason??'');assert.equal(second.root,f.first.root);assert.notEqual(second.composition,f.first.composition);
  const moved=await f.w.knowledge.reconcileLine('widget','10.6.1',f.w.admin);assert.ok(moved.moved);
  assert.equal((await f.w.knowledge.currentRoot('widget','10.6.1'))?.composition,second.composition);
  assert.deepEqual((await f.json(await f.read('',f.first.composition!))).bytes,old.bytes);
  const pinned=await createKnowledgeReader(f.w.knowledge).read('knowledge:links:widget:10.6.1@'+f.first.composition,{principal:f.w.admin,run:null,purpose:'revision replay'});
  assert.deepEqual((await f.json(pinned)).bytes,old.bytes);
  const current=(await f.json(await f.read())).view;assert.equal(current.totals?.links,1);assert.equal(current.composition,second.composition);
  const next=await f.w.knowledge.getNodes({root:f.first.root!,paths:['/'],depth:2,cursor:nodePage.next},f.w.admin);assert.ok(next);assert.ok(next.nodes.every(n=>!n.backlinks||n.backlinks.composition===f.first.composition));
});
test('a true legacy composition stays untouched and yields one page-level repair note',async t=>{
  const f=await fixture(t,null),original=await f.w.knowledge.store.composition(f.first.composition!);assert.ok(original);
  const body=structuredClone(original);delete body.links;
  const legacy=await f.w.kit.store.withTransaction(tx=>f.w.knowledge.store.putRoot(body,tx));
  const view=(await f.json(await f.read('',legacy.digest))).view;
  assert.equal(view.configured,false);assert.equal(view.totals,null);assert.match(view.notes.join(''),/这份组成没有链接声明.*重新生产/);
  const page=await f.w.knowledge.getNodes({root:f.first.root!,composition:legacy.digest,paths:['/'],depth:2},f.w.admin);
  assert.ok(page);assert.match(page.coverage.note??'',/这份组成没有链接声明/);assert.ok(page.nodes.every(node=>node.backlinks===undefined));
  assert.deepEqual(await f.w.knowledge.store.composition(legacy.digest),body);
});

test('unknown declarations are refused before source reads, and unauthorized readers get no relation view',async t=>{
  const f=await fixture(t);const reader=createKnowledgeReader(f.w.knowledge);
  assert.equal((await reader.read('knowledge:links:widget:10.6.1',{principal:f.w.outsider,run:null,purpose:'synthetic'})).ok,false);
  const before=f.w.external.reads.length;f.w.product.product.links=[{...rule,normalize:{guess:true}} as any];
  const failed=await f.w.knowledge.produceTree({product:f.w.product,build});assert.equal(failed.ok,false);assert.equal(f.w.external.reads.length,before);
});
test('a stale same-root composition refresh cannot replace a newer pointer observation',async t=>{
  const f=await fixture(t);const pointerName='knowledge/widget/10.6.1';const observed=await f.w.kit.pointers.get(pointerName);assert.ok(observed);
  const second=await f.w.knowledge.produceTree({product:f.w.product,build});assert.ok(second.ok);
  const newest=await f.w.knowledge.produceTree({product:f.w.product,build});assert.ok(newest.ok);
  const moved=await f.w.knowledge.moveRoot('widget','10.6.1',f.first.root!,newest.root!,newest.action,{by:f.w.admin,expected_action:observed.action,composition:newest.composition!});assert.ok(moved.moved);
  const stale=await f.w.knowledge.moveRoot('widget','10.6.1',f.first.root!,second.root!,second.action,{by:f.w.admin,expected_action:observed.action,composition:second.composition!});assert.equal(stale.moved,false);
  assert.equal((await f.w.knowledge.currentRoot('widget','10.6.1'))?.composition,newest.composition);
});
test('byte truncation removes only detail rows, never totals or the ability to resume',async t=>{
  const f=await fixture(t,[rule],{maxViewBytes:5800});const first=(await f.json(await f.read('limit=200'))).view;
  assert.ok(first.truncated);assert.equal(first.totals?.drift_occurrences,3);assert.ok(first.next);
  const wrong=await f.read('prefix=%2Fnotes%2Ftwo&cursor='+first.next);assert.equal(wrong.ok,false);
  const pages=[first];while(pages.at(-1)!.next)pages.push((await f.json(await f.read('limit=200&cursor='+pages.at(-1)!.next))).view);
  assert.ok(pages.every(page=>JSON.stringify(page.totals)===JSON.stringify(first.totals)));
  assert.equal(pages.flatMap(page=>page.links).length,2);
  assert.equal(pages.flatMap(page=>page.drift.flatMap(group=>group.occurrences)).length,3);
});

test('an existing run is found by its writer index and cannot be redirected to a newer composition',async t=>{
  const f=await fixture(t),old=await f.json(await f.read());
  const run=newId('run'),basis=structuredClone(baseRun.target_basis[0]);
  basis.statement.data={field:'build',value:build.name,root:f.first.root,composition:f.first.composition} as any;
  basis.validity.bound=[f.first.root!,f.first.composition!];
  const body=RunRecord.parse({...baseRun,run,runner:f.w.user.id,product:'widget',version:build.line,build:build.name,root:f.first.root,target_basis:[basis],started_at:new Date().toISOString()});
  await f.w.kit.store.put({kind:'run',schema:'run@1',provenance:'observed',body,index:[{key:'runs.id',value:run}]});
  f.w.product.product.links=[{...rule,normalize:undefined}];f.w.product.digest='e'.repeat(64);
  const next=await f.w.knowledge.produceTree({product:f.w.product,build});assert.ok(next.ok);await f.w.knowledge.reconcileLine('widget',build.line,f.w.admin);
  const reader=createKnowledgeReader(f.w.knowledge),context:ExternalReadContext={principal:f.w.user,run,purpose:'stored run'};
  const locked=await f.json(await reader.read('knowledge:links:widget:10.6.1',context));
  const pinnedNotes=old.view.notes.map(note=>note==='这条产品线还没有不分版本的根；下一步：同步这条产品线'?'本次锁定范围没有不分版本的根；下一步：以同样输入新开运行，非运行读取请从首页重读当前范围（需要时先同步这条产品线）':note);
  assert.deepEqual(locked.bytes,canonicalBytes({...old.view,notes:pinnedNotes}));
  assert.equal((await reader.read('knowledge:links:widget:10.6.1?composition='+next.composition,context)).ok,false);
  assert.equal((await reader.read('knowledge:links:widget:'+build.name,{...context,composition:next.composition,build:build.name})).ok,false,'a supplied context must not replace the stored run composition');

});

test('unplaced occurrences use citable root addresses resolved against their selected composition',async t=>{
  const unplaced={...content('/notes/unplaced','behaviour','Unplaced note',['gone']),path:null};
  const f=await fixture(t,[rule],undefined,[...entries,unplaced]);
  const view=(await f.json(await f.read())).view,occurrence=view.drift.flatMap(group=>group.occurrences).find(source=>source.summary==='Unplaced note');
  assert.ok(occurrence);assert.ok(occurrence.reference.startsWith('tree:'+f.first.root+'/@'));
  const entry=occurrence.reference.split('@').at(-1)!;
  const read=await f.w.knowledge.treeReader({composition:f.first.composition}).read(f.first.root!,'/',entry,{user:f.w.admin.id,role:'admin'});
  assert.equal(read?.text,'Unplaced note');assert.ok(read?.grounds?.length);
  assert.equal(await f.w.knowledge.treeReader().read(f.first.root!,'/',entry,{user:f.w.outsider.id,role:'user'}),null);
  assert.equal(view.totals?.drift_occurrences,4);
});

test('a malformed scoped literal is diagnosed without failing production and its count survives pagination',async t=>{
  const bad={...content('/notes/bad','behaviour','Malformed synthetic source'),data:{mentions:17}};
  const f=await fixture(t,[{...rule,target_producers:['entities'],source_producers:['entities']}],undefined,[...entries,bad]);
  assert.ok(f.first.warnings.some(warning=>warning.includes('字面字段 mentions 不符合')));
  const pages:LinksView[]=[];let cursor:string|null=null;
  do{
    const page:LinksView=(await f.json(await f.read('limit=1'+(cursor?'&cursor='+cursor:'')))).view;
    assert.equal(page.totals?.diagnosed_entries,1);pages.push(page);cursor=page.next;
  }while(cursor);
  const diagnostics=pages.flatMap(page=>page.diagnostics??[]);
  assert.equal(diagnostics.length,1);assert.equal(diagnostics[0].path,'/notes/bad');assert.equal(diagnostics[0].reason,'no_check');
});

test('accepted source coverage serves the same links to members without probing their raw-source permission',async t=>{
  const statement='password = FtpSyntheticCoverage7349';
  const data=[...entries,content('/notes/accepted','behaviour',statement,['alpha'])];
  const w=await makeWorld(postgres,{pack:{id:'widget',names:['WIDGET'],declaration:{catalogs:[],producers:[extraProducer('entities',{entries:data})],links:[rule]}}});t.after(()=>w.close());
  const bytes=Buffer.from(catalogXml({sample:[{name:'node'}]})+'\n<!-- '+statement+' -->');
  const source=await w.kit.artifacts.ingest({bytes,mediaType:'application/xml',origin:{read:{object:'site:tree:links'}},author:{user:null},provenanceType:'observed',visibility:{readers:[],admins:true,packs:[],shareable:false}});
  assert.ok(source.body.scan.findings.length>0);
  await w.kit.artifacts.acceptFindings(w.admin,source.body.sha256,'合成样例，不是凭据');
  assert.equal(await w.kit.artifacts.source(w.user,source.body.sha256),null);
  w.external.set('site:tree:links',{bytes,mediaType:'application/xml'});
  const produced=await w.knowledge.produceTree({product:w.product,build});assert.ok(produced.ok,produced.reason??'');
  await w.knowledge.reconcileLine('widget',build.line,w.admin);
  const raw=w.kit.artifacts.source.bind(w.kit.artifacts);let probes=0;
  t.mock.method(w.kit.artifacts,'source',async(...args:Parameters<typeof raw>)=>{if(args[1]===source.body.sha256)probes++;return raw(...args);});
  const reader=createKnowledgeReader(w.knowledge),answers:Uint8Array[]=[];
  for(const principal of [w.admin,w.user]){
    const result=await reader.read('knowledge:links:widget:10.6.1',{principal,run:null,purpose:'synthetic'});
    assert.ok(result.ok,result.ok?'':result.reason);
    const answer=await w.kit.objects.get(result.artifacts[0].artifact.body.sha256);assert.ok(answer);answers.push(answer);
  }
  assert.deepEqual(answers[0],answers[1]);assert.equal(probes,0);
});

test('no-rule productions snapshot an empty declaration and omit unrelated backlink blocks',async t=>{
  const empty=await fixture(t,null),body=await empty.w.knowledge.store.composition(empty.first.composition!);
  assert.deepEqual(body?.links,[]);
  const view=(await empty.json(await empty.read())).view;assert.equal(view.configured,true);assert.equal(view.totals?.links,0);
  const page=await empty.w.knowledge.getNodes({root:empty.first.root!,paths:['/'],depth:2},empty.w.admin);
  assert.ok(page);assert.equal(page.coverage.note,undefined);assert.ok(page.nodes.every(node=>node.backlinks===undefined));
  const linked=await fixture(t);
  const notes=await linked.w.knowledge.getNodes({root:linked.first.root!,paths:['/notes'],depth:2},linked.w.admin);
  assert.ok(notes);assert.ok(notes.nodes.every(node=>node.backlinks===undefined));
});
test('a run without a composition receives a new-run action rather than being asked for a run again',async t=>{
  const f=await fixture(t),page=await f.w.knowledge.getNodes({root:f.first.root!,composition:null,paths:['/'],depth:2},f.w.admin);
  assert.ok(page);assert.match(page.coverage.note??'',/运行.*组成.*新.*运行/);assert.doesNotMatch(page.coverage.note??'',/请给出运行|移动.*指针/);
});
test('a historical root points to a concrete composition view instead of moving the current pointer',async t=>{
  const f=await fixture(t);f.w.product.product.producers=[Producer.parse(extraProducer('entities',{entries:[...entries,content('/new','behaviour','New synthetic node')]}))];
  f.w.product.digest='f'.repeat(64);
  const next=await f.w.knowledge.produceTree({product:f.w.product,build});assert.ok(next.ok);assert.notEqual(next.root,f.first.root);
  await f.w.knowledge.reconcileLine('widget',build.line,f.w.admin);
  const page=await f.w.knowledge.getNodes({root:f.first.root!,paths:['/terms/alpha'],depth:0},f.w.admin);
  assert.ok(page);assert.match(page.coverage.note??'',/knowledge:links:widget:/);assert.ok(page.coverage.note?.includes('composition='+f.first.composition));
  assert.doesNotMatch(page.coverage.note??'',/移动.*指针/);
});

const keepBuild=async(w:World,spec:KnownBuild)=>{
  const {root,...info}=spec;
  return w.knowledge.store.putBuild(KnowledgeBuildBody.parse({product:'widget',build:info,pack:{id:w.product.id,version:w.product.version,digest:w.product.digest},plan:null,sync:null}));
};
test('named alias targets use the frozen composition while another named build with the same root is independent',async t=>{
  const f=await fixture(t),alias={...build,name:'Rel_ALIAS_10_6_1_1',base:build.name};
  await keepBuild(f.w,alias);
  const other={...build,name:'Rel_WIDGET_10_6_1_2',base:'Rel_WIDGET_10_6_1_2'};
  f.w.product.product.links=[{...rule,normalize:undefined}];f.w.product.digest='c'.repeat(64);
  const otherRoot=await f.w.knowledge.produceTree({product:f.w.product,build:other});assert.ok(otherRoot.ok);assert.equal(otherRoot.root,f.first.root);
  const refreshed=await f.w.knowledge.produceTree({product:f.w.product,build});assert.ok(refreshed.ok);assert.notEqual(refreshed.composition,f.first.composition);
  const reader=createKnowledgeReader(f.w.knowledge),context:ExternalReadContext={principal:f.w.admin,run:newId('run'),purpose:'pending run',composition:f.first.composition,build:alias.name};
  const target=(await f.json(await reader.read('knowledge:links:widget:'+alias.name,context))).view;
  assert.equal(target.composition,f.first.composition);assert.equal(target.build.build,alias.name);assert.equal(target.totals?.links,2);
  const independent=(await f.json(await reader.read('knowledge:links:widget:'+other.name,context))).view;
  assert.equal(independent.composition,otherRoot.composition);assert.equal(independent.totals?.links,1);
  const legacy={principal:context.principal,run:context.run,purpose:'legacy caller',composition:f.first.composition};
  assert.equal((await f.json(await reader.read('knowledge:links:widget:'+build.line,legacy))).view.composition,f.first.composition);
});

async function linksWorkflow(t:{after(fn:()=>Promise<void>):void},f:Awaited<ReturnType<typeof fixture>>){
  const directory=await mkdtemp(join(tmpdir(),'links-binding-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const path=await writePack(directory,{id:'links-input',version:'1.0.0',kind:'workflow',title:'合成关联输入',description:'合成关联读取',
    files:{
      'SKILL.md':'Read the frozen synthetic input',
      'workflow.json':{json:{schema:'workflow@1',inputs:[{slot:'view',role:'subject',description:'Synthetic links',accepts:['knowledge:links','application/json'],required:true,many:false}],parameters:[],product:{id:'widget',catalogs:[]},subject:'view',projection:{module:'functions/project.ts'}}},
      'requirements.json':{json:{schema:'requirements@1',requirements:[{key:'source',name:'合成输入',description:'Synthetic source',target:'item',required:true,done_rule:'bookkeeping',layers:['static'],accepted_producer:'fact',checks:['source'],error_handling:[]}]}},
      'checks.json':{json:{schema:'checks@1',checks:[{id:'source',title:'合成输入',function:{module:'functions/check.ts'},applies:'item',judges:'subject',tier:'blocking',basis:'Synthetic source data'}]}},
      'functions/check.ts':"export default ()=>[{verdict:'support',statement:'已核对合成输入',grounds:[],tier:'blocking'}];",
      'slots.schema.json':{json:{schema:'slots@1',item:{},run:{}}},
      'functions/project.ts':"export default function(input:any){const value=input.inputs[0].model;return {items:[{id:'view',label:'合成关联',location:{slot:'view',parser:'json@1',selector:'p/schema'},fields:{composition:value.composition,links:value.totals.links}}],warnings:[]};}",
    }});
  const workflows=new FakeWorkflowStore();await workflows.add(path);workflows.assign(f.w.user.id,'links-input');
  return workflows;
}
test('start_run binds a named links view through a workflow input before persisting the alias target',async t=>{
  const f=await fixture(t),alias={...build,name:'Rel_ALIAS_10_6_1_3',base:build.name};await keepBuild(f.w,alias);
  const workflows=await linksWorkflow(t,f);
  const reader=createKnowledgeReader(f.w.knowledge);let captured:ExternalReadContext|undefined;
  const external={accepts:(id:string)=>reader.accepts(id),read:async(id:string,context:ExternalReadContext)=>{
    captured=context;
    assert.equal((await f.w.kit.store.find({key:'runs.id',value:context.run!,kind:'run',limit:1})).items.length,0);
    f.w.product.product.links=[{...rule,normalize:undefined}];f.w.product.digest='b'.repeat(64);
    const changed=await f.w.knowledge.produceTree({product:f.w.product,build});assert.ok(changed.ok);assert.notEqual(changed.composition,f.first.composition);
    return reader.read(id,context);
  }};
  const service=createRunsService({records:f.w.kit,workflows,packs:f.w.packs,knowledge:f.w.knowledge,external,sandbox:{requireOsIsolation:await osIsolationAvailable()}});
  const result=await service.startRun(f.w.user,{pack:'links-input',product:'WIDGET',build:alias.name,inputs:{view:{external:'knowledge:links:widget:'+alias.name}}},{traceId:'1'.repeat(32),sessionId:null});
  assert.equal(result.call_result,'ok',JSON.stringify(result.errors));assert.equal(captured?.build,alias.name);assert.equal(captured?.composition,f.first.composition);
  assert.equal(result.run?.items[0].fields.composition,f.first.composition);assert.equal(result.run?.items[0].fields.links,2);
});

test('a node page builds relations once even when full relation facts cannot enter the shared cache',async t=>{
  const f=await fixture(t),set=Lru.prototype.set,facts=LinkReading.prototype.facts;let calls=0,rejectCompact=true;
  t.mock.method(Lru.prototype,'set',function(this:Lru<unknown,unknown>,key:unknown,value:unknown,weight?:number){
    if(value!==null&&typeof value==='object'&&(('links'in value&&'drift'in value)||(rejectCompact&&'targets'in value)))return;
    return set.call(this,key,value,weight);
  });
  t.mock.method(LinkReading.prototype,'facts',async function(this:LinkReading,...args:Parameters<typeof facts>){calls++;return facts.apply(this,args);});
  const page=await f.w.knowledge.getNodes({root:f.first.root!,paths:['/terms'],depth:2},f.w.admin);assert.ok(page);assert.ok(page.nodes.length>2);
  assert.equal(calls,1);assert.equal(page.nodes.find(node=>node.path==='/terms/alpha')?.backlinks?.total,1);
  rejectCompact=false;
  await withReadCache(async()=>{
    await f.w.knowledge.getNodes({root:f.first.root!,paths:['/terms'],depth:2},f.w.admin);assert.equal(calls,2);
    await f.w.knowledge.getNodes({root:f.first.root!,paths:['/terms'],depth:2},f.w.admin);assert.equal(calls,2,'the compact per-target cache is reusable within this read');
  });
  await f.w.knowledge.getNodes({root:f.first.root!,paths:['/terms'],depth:2},f.w.admin);assert.equal(calls,3,'a completed read releases its compact per-target cache');
});
test('a missing unrelated relation node preserves the requested definitions and gives a positioned repair action',async t=>{
  const f=await fixture(t),root=await f.w.knowledge.store.node(f.first.root!);assert.ok(root);
  const missing=root.children.find(child=>child.name==='notes')!.digest,read=f.w.knowledge.store.node.bind(f.w.knowledge.store);
  t.mock.method(f.w.knowledge.store,'node',async(digest:string)=>digest===missing?null:read(digest));
  const page=await f.w.knowledge.getNodes({root:f.first.root!,paths:['/terms/alpha'],depth:0},f.w.admin);
  assert.ok(page);assert.equal(page.nodes[0].entries[0].statement,'Alpha');
  assert.ok(page.coverage.note?.includes(missing));assert.match(page.coverage.note??'',/下一步.*管理员.*可信备份.*重新核验/);assert.doesNotMatch(page.coverage.note??'',/Claude|重建|重读/);
  const refusal=await f.read();assert.ok(!refusal.ok);assert.ok(refusal.reason.includes(missing));assert.match(refusal.reason,/可信备份.*重新核验/);assert.doesNotMatch(refusal.reason,/Claude|重建|重读/);
});

test('equal root content does not expose an unplaced row from an unreadable product composition',async t=>{
  const f=await fixture(t),privateEntry={...content('/private','behaviour','Private synthetic note',['gone']),path:null};
  const hidden={...f.w.product,id:'hidden',product:{...f.w.product.product,id:'hidden',names:['HIDDEN'],producers:[Producer.parse(extraProducer('entities',{entries:[...entries,privateEntry]}))]}};
  f.w.packs.add(hidden);
  t.mock.method(f.w.packs,'readableProducts',async()=>new Set(['widget']));
  const produced=await f.w.knowledge.produceTree({product:hidden,build});assert.ok(produced.ok,produced.reason??'');assert.equal(produced.root,f.first.root);
  const composition=await f.w.knowledge.store.composition(produced.composition!);assert.ok(composition);
  const entry=composition.unplaced[0].entry;
  assert.equal(await f.w.knowledge.treeReader().read(f.first.root!,'/',entry,{user:f.w.user.id,role:'user'}),null);
  assert.equal((await f.w.knowledge.treeReader().read(f.first.root!,'/',entry,{user:f.w.admin.id,role:'admin'}))?.text,'Private synthetic note');
});


test('backlinks omit target-local sources and offer a callable composition-pinned view',async t=>{
  const f=await fixture(t,[rule],undefined,[...entries,content('/terms/alpha','behaviour','Self mention',['alpha'])]);
  const result=await f.w.knowledge.getNodes({root:f.first.root!,paths:['/terms/alpha'],depth:0},f.w.admin);
  assert.ok(result);const backlinks=result.nodes[0].backlinks!;
  assert.equal(backlinks.total,1);assert.ok(backlinks.entries.every(e=>e.path!=='/terms/alpha'));
  const view=(backlinks as unknown as {view_id:string}).view_id;
  assert.ok(view.includes('target=%2Fterms%2Falpha'));assert.ok(view.includes('composition='+f.first.composition));
  const reader=createKnowledgeReader(f.w.knowledge);
  const read=await reader.read(view,{principal:f.w.admin,run:null,purpose:'synthetic'});assert.ok(read.ok);
  const complete=(await f.json(read)).view;assert.equal(complete.totals?.links,backlinks.total);assert.ok(complete.links.every(edge=>edge.path!=='/terms/alpha'));
  const forward=(await f.json(await f.read())).view;assert.ok(forward.links.some(edge=>edge.path==='/terms/alpha'));
});


test('production drift warnings truncate only complete literals with an explicit remainder marker',async t=>{
  const literals=Array.from({length:40},(_,i)=>'missing'+String(i).padStart(2,'0')+'x'.repeat(35));
  const f=await fixture(t,[rule],undefined,[...entries.filter(e=>e.kind==='definition'),content('/notes/list','behaviour','Synthetic drift list',literals)]);
  const warning=f.first.warnings.find(w=>w.includes('（漂移事实）：'))!;
  assert.ok(warning.includes('有 40 个字面'));assert.ok(warning.endsWith(' 等'));
  const details=warning.split('（漂移事实）：')[1].slice(0,-2).split('、');
  assert.ok(details.length>0&&details.length<40);assert.ok(details.every(value=>literals.includes(value)));
  assert.ok(warning.split('（漂移事实）：')[1].length<=800);
});


test('a historical composition hint binds through start_run while another build is the target',async t=>{
  const f=await fixture(t);f.w.product.product.producers=[Producer.parse(extraProducer('entities',{entries:[...entries,content('/new','behaviour','New root')]}))];f.w.product.digest='f'.repeat(64);
  assert.ok((await f.w.knowledge.produceTree({product:f.w.product,build})).ok);await f.w.knowledge.reconcileLine('widget',build.line,f.w.admin);
  const other={...build,name:'Rel_WIDGET_10_6_2_1',base:'Rel_WIDGET_10_6_2_1',line:'10.6.2'};
  const produced=await f.w.knowledge.produceTree({product:f.w.product,build:other});assert.ok(produced.ok);await f.w.knowledge.reconcileLine('widget',other.line,f.w.admin);
  const page=await f.w.knowledge.getNodes({root:f.first.root!,paths:['/terms/alpha'],depth:0},f.w.admin);assert.ok(page);
  const hint=page.coverage.note?.match(/knowledge:links:[^\s；]+/u)?.[0];assert.ok(hint);
  const workflows=await linksWorkflow(t,f),external=createKnowledgeReader(f.w.knowledge);
  const service=createRunsService({records:f.w.kit,workflows,packs:f.w.packs,knowledge:f.w.knowledge,external,sandbox:{requireOsIsolation:await osIsolationAvailable()}});
  const result=await service.startRun(f.w.user,{pack:'links-input',product:'WIDGET',build:other.name,inputs:{view:{external:hint}}},{traceId:'2'.repeat(32),sessionId:null});
  assert.equal(result.call_result,'ok',JSON.stringify(result.errors));assert.equal(result.run?.items[0].fields.composition,f.first.composition);
});
test('a root current on multiple lines reports an ambiguous current composition rather than history',async t=>{
  const f=await fixture(t),other={...build,name:'Rel_WIDGET_10_6_2_1',base:'Rel_WIDGET_10_6_2_1',line:'10.6.2'};
  assert.ok((await f.w.knowledge.produceTree({product:f.w.product,build:other})).ok);await f.w.knowledge.reconcileLine('widget',other.line,f.w.admin);
  const page=await f.w.knowledge.getNodes({root:f.first.root!,paths:['/terms/alpha'],depth:0},f.w.admin);assert.ok(page);
  assert.match(page.coverage.note??'',/没有唯一当前组成/);assert.doesNotMatch(page.coverage.note??'',/历史根/);
});


test('malformed relation source diagnostics occur once on the node page rather than once per target',async t=>{
  const malformed={...content('/notes/bad','behaviour','Malformed synthetic field'),data:{mentions:17}};
  const f=await fixture(t,[rule],undefined,[...entries,malformed]);
  const page=await f.w.knowledge.getNodes({root:f.first.root!,paths:['/terms'],depth:2},f.w.admin);assert.ok(page);assert.ok(page.nodes.length>2);
  assert.equal((JSON.stringify(page).match(/有不合形状/g)??[]).length,1);
  assert.match(page.coverage.note??'',/不合形状/);assert.ok(page.nodes.every(node=>!node.backlinks?.notes.some(note=>note.includes('不合形状'))));
});


test('root entry reads skip unrelated unplaced parts and reuse a composition membership index',async t=>{
  const loose=Array.from({length:2200},(_,i)=>({...content('/loose','behaviour','Loose synthetic '+i),path:null}));
  const f=await fixture(t,[rule],{inlineRows:1},[...entries,content('/','behaviour','Placed root statement'),...loose]);
  for(const digit of ['d','e']){f.w.product.digest=digit.repeat(64);const next=await f.w.knowledge.produceTree({product:f.w.product,build});assert.ok(next.ok);assert.equal(next.root,f.first.root);}
  const root=await f.w.knowledge.store.node(f.first.root!);assert.ok(root);assert.equal(root.entries.length,1);
  const part=f.w.knowledge.store.part.bind(f.w.knowledge.store);let reads=0;
  t.mock.method(f.w.knowledge.store,'part',async(...args:Parameters<typeof part>)=>{if(args[0]==='tree_root-unplaced@1')reads++;return part(...args);});
  const reader=f.w.knowledge.treeReader();
  assert.ok(await reader.read(f.first.root!,'/',root.entries[0],{user:f.w.admin.id,role:'admin'}));assert.equal(reads,0);
  const comp=await f.w.knowledge.store.composition(f.first.composition!);assert.ok(comp?.parts?.unplaced);assert.ok(comp.parts.unplaced.length>=2);
  const body=await part('tree_root-unplaced@1',comp.parts.unplaced[0].record);assert.ok(body);const entry=body.rows[0].entry;
  await withReadCache(async()=>{
    const first=await reader.read(f.first.root!,'/',entry,{user:f.w.admin.id,role:'admin'});assert.ok(first);assert.ok(reads>0);
    reads=0;const again=await reader.read(f.first.root!,'/',entry,{user:f.w.admin.id,role:'admin'});assert.ok(again);assert.deepEqual(again,first);assert.equal(reads,0);
  });
  reads=0;assert.ok(await reader.read(f.first.root!,'/',entry,{user:f.w.admin.id,role:'admin'}));assert.ok(reads>0,'membership payloads are released after the enclosing read');
});

test('link request refusals keep their reason and bare id while genuine failures remain view errors',async t=>{
  const f=await fixture(t),first=(await f.json(await f.read('limit=1'))).view;assert.ok(first.next);
  const reader=createKnowledgeReader(f.w.knowledge);
  for(const query of ['rule=absent','prefix=%2Fnotes%2Ftwo&cursor='+first.next,'limit=0']){
    const bare='knowledge:links:widget:10.6.1?'+query;
    const result=await reader.read(bare+'@'+f.first.composition,{principal:f.w.admin,run:null,purpose:'synthetic'});
    assert.ok(!result.ok);assert.equal(result.id,bare);assert.doesNotMatch(result.reason,/知识视图出错|^Error:/);
  }
  const small=await fixture(t,[rule],{maxViewBytes:4350}),bare='knowledge:links:widget:10.6.1';
  const tooLarge=await createKnowledgeReader(small.w.knowledge).read(bare+'@'+small.first.composition,{principal:small.w.admin,run:null,purpose:'synthetic'});
  assert.ok(!tooLarge.ok);assert.equal(tooLarge.id,bare);assert.match(tooLarge.reason,/字节上限/);assert.doesNotMatch(tooLarge.reason,/知识视图出错|^Error:/);
  t.mock.method(LinkReading.prototype,'page',async()=>{throw new Error('synthetic unexpected page failure');});
  const failed=await reader.read(bare+'@'+f.first.composition,{principal:f.w.admin,run:null,purpose:'synthetic'});assert.ok(!failed.ok);assert.match(failed.reason,/知识视图出错/);
});

test('link pagination retains the product-wide snapshot when its pointer moves between pages',async t=>{
 const f=await fixture(t);
 const producer=Producer.parse({...extraProducer('scope_docs',{entries:[{...content('/scope','case','Scope document'),data:{document:'synthetic-scope'}}]},{tree:{external:'site:tree:links'}}),unversioned:true});
 f.w.product.product.producers.push(producer);f.w.product.digest='d'.repeat(64);
 const firstScope=await f.w.knowledge.produceTree({product:f.w.product,build:null});assert.ok(firstScope.ok);
 await f.w.knowledge.moveRoot('widget',null,null,firstScope.root!,firstScope.action);
 const first=(await f.json(await f.read('limit=1'))).view;assert.ok(first.next);
 producer.params={entries:[{...content('/scope','case','Changed scope document'),data:{document:'synthetic-scope'}}]};f.w.product.digest='e'.repeat(64);
 const nextScope=await f.w.knowledge.produceTree({product:f.w.product,build:null});assert.ok(nextScope.ok);
 await f.w.knowledge.moveRoot('widget',null,firstScope.root,nextScope.root!,nextScope.action);
 const second=(await f.json(await f.read('limit=1&cursor='+encodeURIComponent(first.next)))).view;
 assert.equal(second.unversioned?.composition,firstScope.composition);
 assert.notEqual(second.unversioned?.composition,nextScope.composition);
});
