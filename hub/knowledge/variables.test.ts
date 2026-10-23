import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {makeWorld,startPostgres,standardSite,DEFAULT_SYNC,DEFAULT_PRODUCERS,type World} from './test-support.ts';
import type {TemporaryPostgres} from '../testing/postgres.ts';
import {formatSyncReport} from './cli.ts';
let postgres:TemporaryPostgres;
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
const declaration={
 variables:[{name:'DEMO_SYNC_NOTE',description:'Synthetic note',schema:{type:'string'},default:'synthetic default'},{name:'DEMO_EXTRA',description:'Synthetic entries',schema:{type:'array',items:{type:'object'}},default:[]}],
 sync:{...DEFAULT_SYNC,options:{note:'${var:DEMO_SYNC_NOTE}'}},
 producers:DEFAULT_PRODUCERS.map(p=>({...p,params:{extra:'${var:DEMO_EXTRA}'}})),
};
async function world(t:any):Promise<World>{const w=await makeWorld(postgres,{pack:{declaration}});t.after(()=>w.close());standardSite(w.external);return w;}
test('real sync refuses every unset variable before reading or writing; dry run uses declared defaults',async t=>{
 const w=await world(t);const before=(await w.kit.store.list({kind:'tree_root',limit:500})).items.length;
 const report=await w.knowledge.syncProduct(w.product);
 assert.match(report.error??'',/DEMO_SYNC_NOTE.*circle-hub var set DEMO_SYNC_NOTE --file/);
 assert.match(report.error??'',/DEMO_EXTRA/);assert.equal(w.external.reads.length,0);
 assert.equal((await w.kit.store.list({kind:'tree_root',limit:500})).items.length,before);
 const dry=await w.knowledge.syncProduct(w.product,{dryRun:true});assert.equal(dry.error,null);
 assert.match(formatSyncReport(dry),/DEMO_SYNC_NOTE.*默认值/);
 assert.equal(dry.plan.note,'synthetic default');
 assert.equal((await w.kit.store.list({kind:'tree_root',limit:500})).items.length,before);
});
test('one sync pins its variable decisions through reads, options, production and composition',async t=>{
 const w=await world(t);
 const note=await w.kit.variables.setVariable(w.admin,'DEMO_SYNC_NOTE','first','合成设置');
 await w.kit.variables.setVariable(w.admin,'DEMO_EXTRA',[],'合成设置');
 const seen:Array<ReadonlyMap<string,string>|undefined>=[];
 const read=w.external.read.bind(w.external);w.external.read=async(id,ctx)=>{
  seen.push(ctx.variables);
  if(seen.length===1)await w.kit.variables.setVariable(w.admin,'DEMO_SYNC_NOTE','second','合成改变');
  return read(id,ctx);
 };
 const first=await w.knowledge.syncProduct(w.product,{options:{note:'caller override'}});
 assert.equal(first.error,null);assert.equal(first.plan.note,'caller override');assert.ok(first.counts.produced>0);
 assert.ok(seen.every(s=>s===seen[0]&&s?.get('DEMO_SYNC_NOTE')===note.value.decision.digest));
 const produced=first.builds.find(b=>b.composition)!;
 const composition=await w.knowledge.store.composition(produced.composition!);
 assert.ok(composition?.variables?.some(v=>v.name==='DEMO_SYNC_NOTE'&&v.decision===note.value.decision.digest));
 const second=await w.knowledge.syncProduct(w.product);assert.match(second.builds.find(b=>b.outcome==='produced')?.reason??'',/变量 DEMO_SYNC_NOTE 从第 1 版变为第 2 版/);
 assert.ok(second.builds.filter(b=>b.outcome==='produced').every(b=>b.calls?.made===0&&b.calls.reused>0));
 const third=await w.knowledge.syncProduct(w.product);assert.equal(third.counts.produced,0);
 const roots=second.builds.filter(b=>b.root).map(b=>b.root);assert.deepEqual(third.builds.filter(b=>b.root).map(b=>b.root),roots);
 const plans=await w.kit.store.find<any>({kind:'action',key:'knowledge.sync',value:first.sync,limit:100});
 assert.ok(plans.items.some(a=>a.body.detail.variables?.some((v:any)=>v.at.endsWith('#/sync/options/note'))));
});
test('invalid stored values fail sync deterministically without leaking values or reading pages',async t=>{
 const w=await world(t);
 await w.kit.variables.setVariable(w.admin,'DEMO_SYNC_NOTE',17,'合成错误类型');await w.kit.variables.setVariable(w.admin,'DEMO_EXTRA',[],'合成设置');
 const report=await w.knowledge.syncProduct(w.product);assert.match(report.error??'',/DEMO_SYNC_NOTE.*不合.*circle-hub var set/);assert.equal(w.external.reads.length,0);
});


test('expanded parameter limits fail before external reads',async t=>{
 const w=await makeWorld(postgres,{pack:{declaration},knowledge:{sandbox:{requireOsIsolation:false,plan:{inputBytes:20}}}});t.after(()=>w.close());standardSite(w.external);
 await w.kit.variables.setVariable(w.admin,'DEMO_SYNC_NOTE','a'.repeat(40),'合成大小');await w.kit.variables.setVariable(w.admin,'DEMO_EXTRA',[],'合成设置');
 const report=await w.knowledge.syncProduct(w.product);assert.match(report.error??'',/DEMO_SYNC_NOTE.*circle-hub var set/);assert.match(report.error??'',/sync\/options/);assert.equal(w.external.reads.length,0);
});

test('direct production also refuses unset declarations before reading sources',async t=>{
 const w=await world(t);
 const result=await w.knowledge.produceTree({product:w.product,build:{name:'DemoBuild',family:'ACME',line:'10.6',base:'DemoBuild',platform:null,built_at:null,released_at:null,sources:{tree:'site:tree:demo'},root:null}});
 assert.equal(result.ok,false);assert.match(result.reason??'',/DEMO_SYNC_NOTE.*circle-hub var set/);assert.equal(w.external.reads.length,0);
});

test('an oversized literal option names the pack repair rather than an invented variable',async t=>{
 const w=await makeWorld(postgres,{pack:{declaration:{sync:{...DEFAULT_SYNC,options:{note:'a'.repeat(40)}}}},knowledge:{sandbox:{requireOsIsolation:false,plan:{inputBytes:20}}}});t.after(()=>w.close());
 const report=await w.knowledge.syncProduct(w.product);assert.match(report.error??'',/发布新版本/);assert.doesNotMatch(report.error??'',/undefined/);assert.equal(w.external.reads.length,0);
});
