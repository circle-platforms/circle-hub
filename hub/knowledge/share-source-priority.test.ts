// Equal bytes do not choose an uploader: sharing prefers exact signed captures in the declared order.
import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {SpaceSourceBody} from '../../contracts/src/spaces.ts';
import type {Principal} from '../records/api.ts';
import {makeWorld,startPostgres} from './test-support.ts';
let postgres:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
const bytes=Buffer.from('合成相同原文：保留两份。');
async function capture(w:Awaited<ReturnType<typeof makeWorld>>,by:Principal,session:string,signed=true){
 const spaces=w.knowledge.spaces!,file=await spaces.importFile(by,bytes,'text/plain','合成相同原文.txt','/sources',session);
 const source=(await w.kit.store.findMany({kind:'knowledge_space_source',key:'knowledge.space.source_hash',values:[file.body.sha256]})).find(row=>SpaceSourceBody.parse(row.body).artifact===file.digest)!;
 const proof=signed?await spaces.attributeSource(by,source.digest,file.digest):null;
 const entry=await spaces.write(by,{kind:'observation',statement:'合成署名顺序 '+session,path:'/notes',grounds:[{reference:'src:'+file.body.sha256,quotation:'保留两份'}]});
 return {file,proof,entry,input:{root:entry.root,path:'/notes',entry:entry.entry}};
}
for(const teamFirst of [false,true])test(`the sharer owns the selected signed capture even with an earlier ${teamFirst?'team':'granted private'} copy`,async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!,a=await capture(w,w.user,'synthetic-earlier');
 await spaces.grant(w.user,{path:'/sources',audience:'member',member:w.outsider.id});
 if(teamFirst)assert.equal((await spaces.share(w.user,a.input)).status,'merged');
 const b=await capture(w,w.outsider,'synthetic-own'),original=await w.kit.store.get(b.file.digest);
 assert.equal(a.file.body.sha256,b.file.body.sha256);assert.notEqual(a.file.digest,b.file.digest);
 const result=await spaces.share(w.outsider,b.input);assert.equal(result.status,'merged');assert.ok(result.team_root);
 const entry=await spaces.entry(w.admin,result.team_root,'/notes',b.entry.entry);assert.deepEqual(entry?.body.source_attributions,[b.proof!.record]);
 const facts=await spaces.entryAttributions(w.admin,result.team_root,'/notes',b.entry.entry);assert.equal(facts[0].by,w.outsider.id);assert.equal(facts[0].record,b.proof!.record);
 const held=await spaces.source(w.admin,b.file.body.sha256,undefined,'model',facts[0].artifact);assert.equal(held?.artifact.body.author.user,w.outsider.id);
 assert.deepEqual(await w.kit.store.get(b.file.digest),original);assert.equal(await w.kit.artifacts.source(w.user,b.file.body.sha256,{record:b.file.digest}),null);
});
test('an existing team capture wins over another readable signer without signing the sharers own equal bytes',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!,a=await capture(w,w.user,'synthetic-team');
 const first=await spaces.share(w.user,a.input);assert.equal(first.status,'merged');const team=(await spaces.entryAttributions(w.admin,first.team_root!,'/notes',a.entry.entry))[0];
 const c=await capture(w,w.admin,'synthetic-other-private');await spaces.grant(w.admin,{path:'/sources',audience:'member',member:w.outsider.id});
 const b=await capture(w,w.outsider,'synthetic-unsigned',false),result=await spaces.share(w.outsider,b.input);assert.equal(result.status,'merged');
 const facts=await spaces.entryAttributions(w.admin,result.team_root!,'/notes',b.entry.entry);assert.equal(facts[0].artifact,team.artifact);assert.equal(facts[0].record,a.proof!.record);assert.notEqual(facts[0].record,c.proof!.record);
 assert.equal((await spaces.sourceAttribution(w.outsider,b.file.body.sha256,b.file.digest)).status,'unsigned');
});
test('another readable signed capture is the last choice and a revoked capture is never borrowed',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!,a=await capture(w,w.user,'synthetic-granted');
 await spaces.grant(w.user,{path:'/sources',audience:'member',member:w.outsider.id});const b=await capture(w,w.outsider,'synthetic-unsigned-fallback',false);
 const checked=await spaces.precheckShare(w.outsider,b.input);assert.equal(checked.ok,true);
 await spaces.grant(w.user,{path:'/sources',audience:'member',member:w.outsider.id,revoke:true});assert.equal((await spaces.share(w.outsider,b.input)).code,'SHARE_UPLOAD_UNSIGNED');
 await spaces.grant(w.user,{path:'/sources',audience:'member',member:w.outsider.id});const result=await spaces.share(w.outsider,b.input);assert.equal(result.status,'merged');
 const facts=await spaces.entryAttributions(w.admin,result.team_root!,'/notes',b.entry.entry);assert.equal(facts[0].by,w.user.id);assert.equal(facts[0].record,a.proof!.record);
 assert.equal((await spaces.sourceAttribution(w.outsider,b.file.body.sha256,b.file.digest)).status,'unsigned');
});
