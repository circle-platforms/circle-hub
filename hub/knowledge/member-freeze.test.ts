// Real transactions and explicit barriers exercise both orders for each personal write path.
import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {makeWorld,startPostgres} from './test-support.ts';
import {barrier,reaches,waitForUserUpdateLock} from '../testing/member-freeze.ts';
import {sha256Hex} from '../records/api.ts';
let postgres:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
type World=Awaited<ReturnType<typeof makeWorld>>;
async function prepare(w:World,path:string){
 const spaces=w.knowledge.spaces!,memory=w.knowledge.memory!;
 if(path==='knowledge')return ()=>spaces.write(w.user,{kind:'observation',statement:'合成冻结知识',grounds:[]});
 if(path==='source import')return ()=>spaces.importFile(w.user,Buffer.from('合成冻结原文'),'text/plain','合成冻结原文.txt');
 if(path==='memory')return ()=>memory.write(w.user,{client_key:'synthetic-freeze-memory',expected_version:null,title:'合成冻结记忆',markdown:'合成偏好正文',path:'/'});
 const raw=await w.kit.artifacts.ingest({bytes:Buffer.from('合成待保存原文'),mediaType:'text/plain',name:'合成待保存原文.txt',origin:{upload:{session:'synthetic-freeze-source'}},author:{user:w.user.id},provenanceType:'declared',visibility:{readers:[w.user.id],admins:false,packs:[],shareable:false}});
 return ()=>spaces.archiveSource(w.user,{artifact:raw.digest,message:'archive:'+raw.digest,space:w.user.id,path:'/'});
}
for(const path of ['knowledge','source import','source archive','memory']){
 test(`deactivation wins against a queued ${path} write without leaving records or private bytes`,async t=>{
  const w=await makeWorld(postgres);t.after(w.close);const write=await prepare(w,path),entered=barrier(),release=barrier(),lock=w.kit.store.lock.bind(w.kit.store),before=await w.kit.store.watermark!();
  w.kit.store.lock=async(key,tx)=>{if(key==='knowledge-space:'+w.user.id){entered.release();await release.promise;}return lock(key,tx);};
  const writing=write();const rejected=assert.rejects(writing,{code:'SOURCE_UNAVAILABLE'});void rejected.catch(()=>{});
  try{await reaches(entered,writing);await w.kit.principals.setDisabled(w.admin,w.user.id,true);}finally{release.release();}
  await rejected;assert.equal(await w.kit.store.watermark!(),before);assert.equal(await w.knowledge.spaces!.current(w.user.id),null);assert.equal((await w.kit.memoryIndex!.heads(w.user.id)).length,0);if(path==='source import')assert.equal(await w.kit.objects.get(sha256Hex(Buffer.from('合成冻结原文'))),null);
 });
 test(`an authorized ${path} commit finishes before deactivation and survives restoration unchanged`,async t=>{
  const w=await makeWorld(postgres);t.after(w.close);const write=await prepare(w,path),entered=barrier(),release=barrier(),active=w.kit.principals.lockActive.bind(w.kit.principals);let once=false;
  w.kit.principals.lockActive=async(...args)=>{const actor=await active(...args);if(args[0].id===w.user.id&&!once){once=true;entered.release();await release.promise;}return actor;};
  const writing=write();await reaches(entered,writing);const disabling=w.kit.principals.setDisabled(w.admin,w.user.id,true);
  try{await waitForUserUpdateLock(w.kit);assert.equal((await w.kit.principals.get(w.user.id))!.disabled,false);}finally{release.release();}
  await writing;await disabling;const root=await w.knowledge.spaces!.current(w.user.id),heads=await w.kit.memoryIndex!.heads(w.user.id),mark=await w.kit.store.watermark!();
  await w.kit.principals.setDisabled(w.admin,w.user.id,false);assert.deepEqual(await w.knowledge.spaces!.current(w.user.id),root);assert.deepEqual(await w.kit.memoryIndex!.heads(w.user.id),heads);assert.equal(await w.kit.store.watermark!(),mark);
 });
}
