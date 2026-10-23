// Relations are generic: synthetic terms and notes, no product dialect or model calls.
import assert from 'node:assert/strict';
import { after,before,test } from 'node:test';
import { runRecord as baseRun } from '../../contracts/src/fixtures.ts';
import { RunRecord } from '../../contracts/src/run.ts';
import { newId } from '../records/api.ts';
import { LINK_MATCH } from '../../contracts/generated/vocabulary.ts';
import { LinkDeclaration,Producer, type KnownBuild } from '../../contracts/src/product.ts';
import { LinksView } from '../../contracts/src/views.ts';
import { createKnowledgeReader } from './api.ts';
import { resolveLiteral } from './links.ts';
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
async function fixture(t:{after(fn:()=>Promise<void>):void},links:typeof rule[]|null=[rule],limits?:{pageNodes?:number;maxViewBytes?:number},sourceEntries:unknown[]=entries){
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
  const locked=await f.json(await reader.read('knowledge:links:widget:10.6.1',context));assert.deepEqual(locked.bytes,old.bytes);
  assert.equal((await reader.read('knowledge:links:widget:10.6.1?composition='+next.composition,context)).ok,false);
});

test('unplaced occurrences retain directly resolvable entry references rather than invented tree membership',async t=>{
  const unplaced={...content('/notes/unplaced','behaviour','Unplaced note',['gone']),path:null};
  const f=await fixture(t,[rule],undefined,[...entries,unplaced]);
  const view=(await f.json(await f.read())).view,occurrence=view.drift.flatMap(group=>group.occurrences).find(source=>source.summary==='Unplaced note');
  assert.ok(occurrence);assert.match(occurrence.reference,/^entry:[a-f0-9]{64}$/);
  assert.equal((await f.w.knowledge.store.entry(occurrence.reference.slice(6)))?.statement,'Unplaced note');
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
