// Separate read-side lifecycle regression. The existing historical byte-equality assertions are untouched.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {parse,type DefaultTreeAdapterMap} from 'parse5';
import {canonicalBytes} from '../../hub/records/api.ts';
import {startPostgres} from '../../hub/testing/postgres.ts';
import {stagePack} from '../../packs/workflow/case-review/packaging.ts';
import {PACK_DIR} from '../../packs/workflow/case-review/api.ts';
import {signPack} from '../../hub/runs/packs/testing/builder.ts';
import {openBed} from './support/hub.ts';
import {openConsole} from './support/console.ts';
import {draft,startReview} from './support/review.ts';

type Node=DefaultTreeAdapterMap['node'];
function text(node:Node):string{return node.nodeName==='#text'?('value'in node?node.value:''):'childNodes'in node?node.childNodes.map(text).join(''):'';}
function conditions(document:string):string[]{
 const found:string[]=[];
 function fields(node:Node){
  if('childNodes'in node){for(const [i,child]of node.childNodes.entries())if(child.nodeName==='dt'&&text(child)==='有效条件'){
   const next=node.childNodes.slice(i+1).find(candidate=>candidate.nodeName==='dd');assert.ok(next);found.push(text(next));
  }else fields(child);}
 }
 function sections(node:Node){
  if('childNodes'in node){
   if(node.nodeName==='section'&&node.childNodes.some(child=>child.nodeName==='h2'&&text(child)==='分区清单')){fields(node);return;}
   node.childNodes.forEach(sections);
  }
 }
 sections(parse(document));return found;
}
const WITHDRAWN='规则已撤回（版本已下架）';

test('T7-4 read-time effective conditions survive new-version reassignment and agree for users and administrators',async t=>{
 const postgres=await startPostgres();t.after(()=>postgres.stop());
 const bed=await openBed({postgres});t.after(()=>bed.close());
 const client=await bed.connect(bed.reviewer,'synthetic-withdrawal-lifecycle');
 const user=await openConsole(bed.hub,bed.reviewer.token),admin=await openConsole(bed.hub,bed.hub.admin.token);
 const bytes=Buffer.from(JSON.stringify({root:{data:{id:'root',text:'合成生命周期'},children:[{data:{id:'case',text:'合成结论',priority:2,resource:['functional']},children:[{data:{id:'expected',text:'ready'}}]}]}}));
 const reference=await client.upload(bytes,'synthetic-lifecycle.km.json');
 const run=await startReview(client,{product:bed.second.names[0],version:'2.1',inputs:{subject:{reference}}});
 const submitted=await client.call('submit_result',draft(run));assert.equal(submitted.out.acceptance,'accepted');
 const detail=(await bed.hub.deps.runs.getRun(bed.reviewer.principal,run.run))!,resultDigest=detail.latest!.record;
 const storedRuns=await bed.hub.records.store.find({kind:'run',key:'runs.id',value:run.run});assert.equal(storedRuns.items.length,1);
 const runDigest=storedRuns.items[0].digest;
 const originalRun=canonicalBytes(await bed.hub.records.store.get(runDigest)),originalResult=canonicalBytes(await bed.hub.records.store.get(resultDigest));
 const unchanged=async()=>{
  assert.deepEqual(canonicalBytes(await bed.hub.records.store.get(runDigest)),originalRun);
  assert.deepEqual(canonicalBytes(await bed.hub.records.store.get(resultDigest)),originalResult);
  assert.equal((await bed.hub.deps.runs.getRun(bed.reviewer.principal,run.run))!.latest!.record,resultDigest);
  assert.equal((await bed.hub.records.store.find({kind:'validation_result',key:'runs.result.run',value:run.run})).items.length,1);
  const source=await bed.hub.records.artifacts.source(bed.reviewer.principal,reference.slice(4));assert.ok(source?.bytes);assert.deepEqual(Buffer.from(source.bytes),bytes);
 };
 const read=async()=>{
  const ordinary=await user.get('/console/runs/'+run.run),administrator=await admin.get('/console/runs/'+run.run);
  assert.equal(ordinary.status,200);assert.equal(administrator.status,200);
  const a=conditions(ordinary.body),b=conditions(administrator.body);assert.ok(a.length>0);assert.deepEqual(a,b);
  return a;
 };
 await t.test('before withdrawal no conclusion effective condition displays the withdrawal label',async()=>{
  assert.ok((await read()).every(value=>!value.startsWith(WITHDRAWN)));await unchanged();
 });
 const [id,version]=run.pack.split('@');
 await bed.hub.hub.registry.retire(bed.hub.admin.principal,id,version,'合成版本下架');
 await t.test('after withdrawal every conclusion effective condition displays the current qualifier',async()=>{
  assert.ok((await read()).every(value=>value.startsWith(WITHDRAWN)));await unchanged();
 });
 const directory=await mkdtemp(join(tmpdir(),'synthetic-rule-successor-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 await stagePack(PACK_DIR,directory);
 const parts=version.split('.').map(Number);assert.equal(parts.length,3);assert.ok(parts.every(Number.isSafeInteger));parts[2]++;
 const nextVersion=parts.join('.');await signPack(directory,{version:nextVersion});
 const published=await bed.hub.hub.registry.publish(bed.hub.admin.principal,directory);assert.ok(published.ok,JSON.stringify(published));
 await bed.hub.hub.registry.unassign(bed.hub.admin.principal,bed.reviewer.user.id,id);
 await bed.hub.hub.registry.assign(bed.hub.admin.principal,bed.reviewer.user.id,id);
 await t.test('a newly published and reassigned version cannot remove the old frozen-version qualifier',async()=>{
  assert.ok((await read()).every(value=>value.startsWith(WITHDRAWN)));
  const fresh=await startReview(client,{product:bed.second.names[0],version:'2.1',inputs:{subject:{reference}}});
  assert.equal(fresh.pack,id+'@'+nextVersion);
  const accepted=await client.call('submit_result',draft(fresh));assert.equal(accepted.out.acceptance,'accepted');
  const active=await user.get('/console/runs/'+fresh.run);assert.equal(active.status,200);
  const activeConditions=conditions(active.body);assert.ok(activeConditions.length>0);assert.ok(activeConditions.every(value=>!value.startsWith(WITHDRAWN)));
  await unchanged();
 });
 await t.test('ordinary users and administrators see identical qualifiers after reassignment',async()=>{
  assert.ok((await read()).every(value=>value.startsWith(WITHDRAWN)));await unchanged();
 });
});
