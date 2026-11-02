// Sharing tests use only synthetic observed captures and temporary records, including legacy untrusted verification flags.
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { SpaceEntryBody, SpaceVersionBody } from '../../contracts/src/spaces.ts';
import { canonicalize, sha256Hex } from '../records/api.ts';
import { makeWorld, startPostgres } from './test-support.ts';
import type { TemporaryPostgres } from '../testing/postgres.ts';

let postgres: TemporaryPostgres;
before(async()=>{postgres=await startPostgres();});
after(()=>postgres?.stop());
const note=(statement:string,path='/notes')=>({kind:'observation',statement,path});
async function observed(w:Awaited<ReturnType<typeof makeWorld>>,personal=false){
  return w.kit.artifacts.ingest({bytes:Buffer.from('合成来源：每次保留两份。'),mediaType:'text/plain',origin:{read:{object:'synthetic:document:one'}},author:{user:w.user.id,declared:null},provenanceType:'observed',visibility:{readers:[w.user.id,w.outsider.id],admins:!personal,packs:[],shareable:false},readTier:'model_readable'});
}
async function verified(w:Awaited<ReturnType<typeof makeWorld>>,personal=false){
  const source=await observed(w,personal);
  return w.knowledge.spaces!.write(w.user,{...note('合成保留规则'),grounds:[{reference:'src:'+source.body.sha256,quotation:'每次保留两份'}]});
}
const share=(w:Awaited<ReturnType<typeof makeWorld>>,entry:Awaited<ReturnType<typeof verified>>)=>w.knowledge.spaces!.share(w.user,{root:entry.root,path:'/notes',entry:entry.entry});

test('verified knowledge merges once with provenance and history without consulting another personal space',async t=>{
  const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!;
  const entry=await verified(w);
  await spaces.write(w.outsider,note('合成保留规则'));
  const receipt=await share(w,entry);assert.equal(receipt.status,'merged');assert.ok(receipt.team_root);
  const team=await spaces.entry(w.outsider,receipt.team_root,'/notes',entry.entry);assert.equal(team?.body.by,w.user.id);assert.equal(team?.body.shared_from?.root,entry.root);
  assert.equal((await spaces.entry(w.user,entry.root,'/notes',entry.entry))?.row.status,'verified');
  assert.equal((await spaces.history(w.user,'team')).items[0].body.reason,'提交共享');
  const duplicate=await share(w,entry);assert.equal(duplicate.code,'SHARE_DUPLICATE');assert.equal((await spaces.shareHistory(w.user)).items.length,2);
  assert.deepEqual((await spaces.shareHistory(w.outsider)).items,[]);
  await assert.rejects(spaces.share(w.outsider,{root:entry.root,path:'/notes',entry:entry.entry}));
});

test('concurrent identical submissions merge once and preserve both personal originals',async t=>{
  const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!,first=await verified(w);
  const source=await observed(w),second=await spaces.write(w.outsider,{...note('合成保留规则'),grounds:[{reference:'src:'+source.body.sha256,quotation:'每次保留两份'}]});
  const receipts=await Promise.all([share(w,first),spaces.share(w.outsider,{root:second.root,path:'/notes',entry:second.entry})]);
  assert.deepEqual(receipts.map(row=>row.status).sort(),['merged','rejected']);
  assert.equal(receipts.find(row=>row.status==='rejected')?.code,'SHARE_DUPLICATE');
  assert.equal((await spaces.current('team'))?.body.entries.length,1);
  assert.equal((await spaces.entry(w.user,first.root,'/notes',first.entry))?.row.status,'verified');
  assert.equal((await spaces.entry(w.outsider,second.root,'/notes',second.entry))?.row.status,'verified');
});

test('unverified notes, private credentials and unsigned uploads stay personal with registered refusals',async t=>{
  const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!;
  const unverified=await spaces.write(w.user,note('合成尚未核验笔记'));assert.equal((await share(w,unverified)).code,'SHARE_UNVERIFIED');
  const personal=await verified(w,true);assert.equal((await share(w,personal)).code,'SHARE_PERSONAL_SOURCE');
  const file=await spaces.importFile(w.user,Buffer.from('合成上传原文'),'text/plain','synthetic.txt');
  const upload=await spaces.write(w.user,{...note('合成上传声明','/uploads'),grounds:[{reference:'src:'+file.body.sha256,quotation:'合成上传原文'}]});
  const rejected=await spaces.share(w.user,{root:upload.root,path:'/uploads',entry:upload.entry});assert.equal(rejected.code,'SHARE_UPLOAD_UNSIGNED');
  assert.equal((await spaces.current('team'))?.body.entries.length,0);
});

// A correctly addressed synthetic imported record can carry an untrusted verification flag. Publication must recheck it.
async function claimedEntry(w:Awaited<ReturnType<typeof makeWorld>>,changes:Partial<SpaceEntryBody>){
  const spaces=w.knowledge.spaces!,saved=await verified(w),version=(await spaces.version(saved.root))!,row=version.body.entries.find(row=>row.entry===saved.entry)!;
  const previous=SpaceEntryBody.parse((await w.kit.store.get(row.record))!.body);
  const body=SpaceEntryBody.parse({...previous,...changes});body.entry=sha256Hex(canonicalize(body.content));
  const record=await w.kit.store.put({kind:'knowledge_space_entry',schema:'knowledge-space-entry@1',provenance:'declared',body});
  const snapshot=SpaceVersionBody.parse({...version.body,parent:version.root,entries:[{path:'/notes',entry:body.entry,record:record.digest,status:'verified'}],reason:'合成导入条目'});
  const root=await w.kit.store.put({kind:'knowledge_space_version',schema:'knowledge-space-version@1',provenance:'projected',body:snapshot,index:[{key:'knowledge.space.version',value:w.user.id}]});
  return {root:root.digest,entry:body.entry};
}

test('sharing rechecks missing references, exact quotations and credentials rather than trusting saved verification',async t=>{
  for(const [which,code] of [['missing','SHARE_GROUND_UNRESOLVED'],['quote','SHARE_QUOTE_MISMATCH'],['credential','SHARE_CREDENTIALS']] as const){
    const w=await makeWorld(postgres);t.after(w.close);const source=await observed(w);
    const entry=await claimedEntry(w,which==='credential'?{content:{kind:'observation',statement:'DB_PASSWORD=hunter22x',data:{},applicability:null}}:{grounds:[{reference:'src:'+(which==='missing'?'a'.repeat(64):source.body.sha256),quotation:which==='quote'?'每次保留三份':'每次保留两份'}]});
    const receipt=await w.knowledge.spaces!.share(w.user,{root:entry.root,path:'/notes',entry:entry.entry});assert.equal(receipt.code,code,which);assert.ok(!JSON.stringify(receipt).includes('hunter22x'));assert.equal((await w.knowledge.spaces!.current('team'))?.body.entries.length,0);
  }
});

test('submitters withdraw only their own team entries and withdrawn grounds propagate without rewriting dependants',async t=>{
  const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!,entry=await verified(w),merged=await share(w,entry);assert.ok(merged.team_root&&merged.reference);
  const dependent=await spaces.write(w.outsider,{...note('合成依赖笔记','/dependent'),grounds:[{reference:merged.reference,quotation:'合成保留规则'}]});
  await assert.rejects(spaces.withdraw(w.outsider,entry.entry,'team'));
  await spaces.withdraw(w.user,entry.entry,'team');
  assert.equal((await share(w,entry)).code,'SHARE_DUPLICATE','withdrawal does not allow the same content to overwrite its team history');
  const view=await spaces.entry(w.outsider,dependent.root,'/dependent',dependent.entry);assert.ok(view);assert.ok(view.grounds_withdrawn.includes(merged.reference));assert.equal(view.row.status,'verified');
  assert.equal((await spaces.entry(w.admin,merged.team_root,'/notes',entry.entry))?.row.status,'withdrawn');
});
