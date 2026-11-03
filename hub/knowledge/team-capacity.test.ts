// Team history has an independent quota; private purge cycles never release retained team bytes.
import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {makeWorld,startPostgres} from './test-support.ts';
import {createKnowledge} from './api.ts';
import {createTestParserRegistry} from '../testing/parsers.ts';
import {SpaceSourceBody} from '../../contracts/src/spaces.ts';
let postgres:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
type World=Awaited<ReturnType<typeof makeWorld>>;
async function ready(w:World,owner:World['user'],name:string,count=1,kb=200){
 const spaces=w.knowledge.spaces!,grounds=[],files=[];
 for(let n=0;n<count;n++){
  const bytes=Buffer.concat([Buffer.from('合成引文 '+name+' '+n+'\n'),Buffer.from('synthetic content\n'.repeat(Math.ceil(kb*1024/18)))]),file=await spaces.importFile(owner,bytes,'text/plain','合成团队原文.txt','/sources',name+'-'+n);files.push(file);
  const source=(await w.kit.store.findMany({kind:'knowledge_space_source',key:'knowledge.space.source_hash',values:[file.body.sha256]})).find(row=>SpaceSourceBody.parse(row.body).artifact===file.digest)!;
  await spaces.attributeSource(owner,source.digest,file.digest);grounds.push({reference:'src:'+file.body.sha256,quotation:'合成引文'});
 }
 const entry=await spaces.write(owner,{kind:'observation',statement:'合成团队容量 '+name,grounds});return {files,input:{root:entry.root,path:'/',entry:entry.entry}};
}
test('three purge/resume cycles cannot reset the independent team quota or leave refused original copies',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!;assert.equal((await spaces.usage(w.admin,'team')).limit,10*1024**3);await spaces.setCapacity(w.admin,'team',600*1024);
 let retained=0,last:Awaited<ReturnType<typeof ready>>|undefined;
 for(let n=0;n<3;n++){
  const p=await ready(w,w.user,'cycle-'+n,2);last=p;
  if(n===0){assert.equal((await spaces.share(w.user,p.input)).status,'merged');retained=(await spaces.usage(w.admin,'team')).used;assert.ok(retained>400000&&retained<600*1024);}
  else{const before=await w.kit.store.watermark!();await assert.rejects(spaces.share(w.user,p.input),(e:any)=>e.code==='SPACE_CAPACITY_EXCEEDED'&&e.message.includes('团队空间')&&!e.detail.capacity);assert.equal(await w.kit.store.watermark!(),before);for(const file of p.files)await assert.rejects(readFile(join(w.kit.dataDir,'objects',file.body.sha256.slice(0,2),file.body.sha256)),{code:'ENOENT'});assert.equal((await spaces.usage(w.admin,'team')).used,retained);}
  if(n<2){const epoch=(await w.kit.personalPayloads!.scope(w.user.id)).epoch;await w.kit.personalPayloads!.purge(w.user,epoch);assert.equal((await spaces.usage(w.admin,'team')).used,retained);const state=await w.kit.personalSync!.state(w.user);await w.kit.personalSync!.resume(w.user,state.epoch,state.state_version);assert.equal((await spaces.usage(w.user)).used,0);}
 }
 await assert.rejects(spaces.usage(w.user,'team'),{code:'SOURCE_UNAVAILABLE'});await assert.rejects(spaces.setCapacity(w.user,'team',10000000),{code:'SOURCE_UNAVAILABLE'});
 await spaces.setCapacity(w.admin,'team',2*1024**2);assert.equal((await spaces.share(w.user,last!.input)).status,'merged');assert.equal((await spaces.current('team'))!.body.entries.length,2);
});
test('independent sharing instances cannot jointly overrun one team allowance',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!,a=await ready(w,w.user,'first',1,300),b=await ready(w,w.outsider,'second',1,300),other=createKnowledge({records:w.kit,packs:w.packs,external:w.external,parsers:createTestParserRegistry()}).spaces!;
 await spaces.setCapacity(w.admin,'team',500*1024);const results=await Promise.allSettled([spaces.share(w.user,a.input),other.share(w.outsider,b.input)]);
 assert.equal(results.filter(r=>r.status==='fulfilled'&&r.value.status==='merged').length,1);assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.code==='SPACE_CAPACITY_EXCEEDED').length,1);assert.ok((await spaces.usage(w.admin,'team')).used<=500*1024);
});
test('team imports and archive writes use the exact locked quota and preserve content after lowering it',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!,file=await w.kit.artifacts.ingest({bytes:Buffer.from('合成团队读取原文'),mediaType:'text/plain',origin:{read:{object:'synthetic:doc:team-quota'}},author:{user:w.admin.id},provenanceType:'observed',visibility:{readers:[w.admin.id],admins:true,packs:[],shareable:false}});
 await spaces.ensure(w.admin,'team');await spaces.setCapacity(w.admin,'team',0);const before=await w.kit.store.watermark!(),write=()=>spaces.write(w.admin,{kind:'observation',statement:'合成受限团队导入',grounds:[{reference:'src:'+file.body.sha256,quotation:'团队读取'}]},null,'team');
 await assert.rejects(write(),(e:any)=>e.code==='SPACE_CAPACITY_EXCEEDED'&&e.detail.capacity.space==='team'&&e.detail.capacity.limit===0);assert.equal(await w.kit.store.watermark!(),before);
 const archive=()=>spaces.archiveSource(w.admin,{artifact:file.digest,message:'archive:'+file.digest,space:'team',path:'/archive'});await assert.rejects(archive(),{code:'SPACE_CAPACITY_EXCEEDED'});assert.equal(await w.kit.store.watermark!(),before);
 await spaces.setCapacity(w.admin,'team',1024**2);await archive();await write();const used=(await spaces.usage(w.admin,'team')).used;assert.ok(used>file.body.size);const root=await spaces.current('team');await spaces.setCapacity(w.admin,'team',0);assert.deepEqual(await spaces.current('team'),root);assert.equal((await spaces.usage(w.admin,'team')).over,used);assert.ok((await spaces.source(w.outsider,file.body.sha256))?.bytes);
});
test('team memory history shares the same quota without weakening current session limits',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!,memory=w.knowledge.memory;
 await spaces.setCapacity(w.admin,'team',0);const input={space:'team',title:'合成团队偏好',markdown:'合成内容',expected_version:null,client_key:'team-quota-retry'};await assert.rejects(memory.write(w.admin,input),{code:'SPACE_CAPACITY_EXCEEDED'});assert.equal((await w.kit.memoryIndex!.heads('team')).length,0);
 await spaces.setCapacity(w.admin,'team',1024**2);const saved=await memory.write(w.admin,input),usage=await spaces.usage(w.admin,'team');assert.ok(usage.memory>0);await spaces.setCapacity(w.admin,'team',usage.used);await assert.rejects(memory.write(w.admin,{space:'team',document:saved.document,expected_version:saved.version,markdown:'合成新内容',client_key:'team-quota-change'}),{code:'SPACE_CAPACITY_EXCEEDED'});assert.equal((await memory.read(w.admin,saved.document)).markdown,'合成内容');
});
