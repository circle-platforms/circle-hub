// Exact synthetic uploads and temporary PostgreSQL; declarations never replace source or reader checks.
import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import type {z} from 'zod';
import {SourceAttributionBody,SpaceSourceBody} from '../../contracts/src/spaces.ts';
import {makeWorld,startPostgres} from './test-support.ts';
import type {TemporaryPostgres} from '../testing/postgres.ts';
let postgres:TemporaryPostgres;
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
const bytes=Buffer.from('合成署名原文：保留两份。');
async function prepare(w:Awaited<ReturnType<typeof makeWorld>>,session='synthetic-capture-a',statement='合成署名知识'){
 const spaces=w.knowledge.spaces!,file=await spaces.importFile(w.user,bytes,'text/plain','合成原文.txt','/sources',session);
 const source=(await w.kit.store.find<z.infer<typeof SpaceSourceBody>>({kind:'knowledge_space_source',key:'knowledge.space.source_hash',value:file.body.sha256})).items.find(row=>row.body.artifact===file.digest)!;
 const entry=await spaces.write(w.user,{kind:'observation',statement,path:'/notes',grounds:[{reference:'src:'+file.body.sha256,quotation:'保留两份'}]});
 return {file,source,entry,input:{root:entry.root,path:'/notes',entry:entry.entry}};
}
test('the uploader signs an exact private capture and sharing preserves it beside a declared team copy',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!,p=await prepare(w),original=await w.kit.store.get(p.file.digest);
 assert.equal((await spaces.precheckShare(w.user,p.input)).checks.find(row=>row.code==='SHARE_UPLOAD_UNSIGNED')?.fix.includes('确认为团队来源…'),true);
 const proof=await spaces.attributeSource(w.user,p.source.digest,p.file.digest);assert.equal(proof.by,w.user.id);assert.equal(proof.audience,'team');
 assert.equal((await spaces.current('team')),null,'signing does not publish a team object');
 assert.equal(await spaces.source(w.outsider,p.file.body.sha256),null);assert.equal(await w.kit.artifacts.source(w.outsider,p.file.body.sha256),null);
 assert.equal((await spaces.sourceAttribution(w.user,p.file.body.sha256,p.file.digest)).status,'attributed');
 const count=(await w.kit.store.list({kind:'knowledge_source_attribution'})).items.length;
 assert.equal((await spaces.precheckShare(w.user,p.input)).ok,true);assert.equal((await w.kit.store.list({kind:'knowledge_source_attribution'})).items.length,count);
 const shared=await spaces.share(w.user,p.input);assert.equal(shared.status,'merged',JSON.stringify(shared));assert.ok(shared.team_root);
 const team=await spaces.entry(w.outsider,shared.team_root,'/notes',p.entry.entry);assert.deepEqual(team?.body.source_attributions,[proof.record]);
 const facts=await spaces.entryAttributions(w.outsider,shared.team_root,'/notes',p.entry.entry);assert.equal(facts[0].by,w.user.id);assert.notEqual(facts[0].artifact,p.file.digest);
 const read=await spaces.source(w.outsider,p.file.body.sha256,undefined,'model',facts[0].artifact);assert.ok(read?.bytes);assert.deepEqual(Buffer.from(read.bytes),bytes);assert.equal(read.artifact.body.provenance_type,'declared');
 assert.equal(await w.kit.artifacts.source(w.outsider,p.file.body.sha256,{record:p.file.digest}),null,'the original ACL stays private');assert.deepEqual(await w.kit.store.get(p.file.digest),original);
 const edited=await spaces.write(w.admin,{kind:'observation',statement:'合成管理员修订',replaces:p.entry.entry,grounds:[{reference:'src:'+p.file.body.sha256,quotation:'保留两份'}]},null,'team');assert.deepEqual((await spaces.entry(w.admin,edited.root,'/',edited.entry))?.body.source_attributions,[proof.record]);
 assert.equal(await w.kit.artifacts.mayDeclareUpload(w.user,p.file.digest),false,'a team signature never makes the private capture an ordinary run declaration');
 const other=await spaces.write(w.outsider,{kind:'observation',statement:'合成团队来源复用',grounds:[{reference:'src:'+p.file.body.sha256,quotation:'保留两份'}]});assert.equal((await spaces.share(w.outsider,{root:other.root,path:'/',entry:other.entry})).status,'merged','already published declared team sources can be reused');
});
test('foreign accounts cannot sign, equal-byte captures do not inherit declarations, and concurrent repeats are idempotent',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!,p=await prepare(w);
 for(const actor of [w.admin,w.outsider])await assert.rejects(spaces.attributeSource(actor,p.source.digest,p.file.digest),{code:'SOURCE_UNAVAILABLE'});
 const proofs=await Promise.all(Array.from({length:5},()=>spaces.attributeSource(w.user,p.source.digest,p.file.digest)));assert.equal(new Set(proofs.map(p=>p.record)).size,1);assert.equal((await w.kit.store.list({kind:'knowledge_source_attribution'})).items.length,1);
 const twin=await prepare(w,'synthetic-capture-b','合成第二采集知识');assert.equal(twin.file.body.sha256,p.file.body.sha256);assert.notEqual(twin.file.digest,p.file.digest);
 await assert.rejects(spaces.attributeSource(w.user,p.source.digest,twin.file.digest),{code:'SOURCE_UNAVAILABLE'});
 assert.equal((await spaces.sourceAttribution(w.user,twin.file.body.sha256,twin.file.digest)).status,'unsigned');
 // Make the signed capture unavailable so this fixture still isolates the unsigned equal-byte capture.
 const read=spaces.source.bind(spaces);spaces.source=(by,hash,run,consumer,capture)=>capture===p.file.digest?Promise.resolve(null):read(by,hash,run,consumer,capture??(hash===twin.file.body.sha256?twin.file.digest:undefined));
 assert.equal((await spaces.share(w.user,twin.input)).code,'SHARE_UPLOAD_UNSIGNED');
 await spaces.attributeSource(w.user,twin.source.digest,twin.file.digest);assert.equal((await spaces.share(w.user,twin.input)).status,'merged');
});
test('forged joins, unreadable captures and stopped uploaders never gain source eligibility',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!,p=await prepare(w);
 const falseBody=SourceAttributionBody.parse({space:w.outsider.id,source:p.source.digest,artifact:p.file.digest,sha256:p.file.body.sha256,by:w.outsider.id,at:new Date().toISOString(),audience:'team'});
 await w.kit.store.put({kind:'knowledge_source_attribution',schema:'knowledge-source-attribution@1',provenance:'declared',body:falseBody,index:[{key:'knowledge.source.attribution.capture',value:p.file.digest}]});
 assert.equal((await spaces.share(w.user,p.input)).code,'SHARE_UPLOAD_UNSIGNED');
 const source=w.kit.artifacts.source.bind(w.kit.artifacts);w.kit.artifacts.source=async (...args)=>args[2]?.record===p.file.digest?null:source(...args);
 await assert.rejects(spaces.attributeSource(w.user,p.source.digest,p.file.digest),{code:'SOURCE_UNAVAILABLE'});w.kit.artifacts.source=source;
 await spaces.attributeSource(w.user,p.source.digest,p.file.digest);assert.equal((await spaces.precheckShare(w.user,p.input)).ok,true);
 w.kit.artifacts.source=async (...args)=>args[2]?.record===p.file.digest?null:source(...args);
 assert.equal((await spaces.precheckShare(w.user,p.input)).ok,false,'a prior signature cannot replace current readability');
 assert.equal((await spaces.share(w.user,p.input)).status,'rejected');assert.equal((await spaces.current('team'))?.body.entries.length,0);w.kit.artifacts.source=source;
 await w.kit.principals.setDisabled(w.admin,w.user.id,true);await assert.rejects(spaces.attributeSource(w.user,p.source.digest,p.file.digest),{code:'SOURCE_UNAVAILABLE'});
});
test('team alias failures roll back the entire sharing transaction while retaining the personal declaration',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!,p=await prepare(w);await spaces.attributeSource(w.user,p.source.digest,p.file.digest);await spaces.ensure(w.user,'team');
 const before=await spaces.current('team'),captures=await w.kit.artifacts.records(p.file.body.sha256),ingest=w.kit.artifacts.ingest.bind(w.kit.artifacts);
 w.kit.artifacts.ingest=async(input,tx)=>{if(input.visibility.admins)throw new Error('synthetic team-copy failure');return ingest(input,tx);};
 await assert.rejects(spaces.share(w.user,p.input),/synthetic team-copy failure/);w.kit.artifacts.ingest=ingest;
 assert.deepEqual(await spaces.current('team'),before);assert.equal((await spaces.shareHistory(w.user)).items.length,0);assert.equal((await w.kit.artifacts.records(p.file.body.sha256)).length,captures.length);assert.equal((await w.kit.store.list({kind:'knowledge_source_attribution'})).items.length,1);
 assert.equal((await spaces.share(w.user,p.input)).status,'merged');
});
