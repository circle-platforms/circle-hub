// Grant changes and deactivation serialize against the exact private owners used by a team share.
import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {makeWorld,startPostgres} from './test-support.ts';
import {barrier,reaches,waitForUserUpdateLock} from '../testing/member-freeze.ts';
import {SpaceSourceBody} from '../../contracts/src/spaces.ts';
let postgres:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
async function prepare(w:Awaited<ReturnType<typeof makeWorld>>){
 const spaces=w.knowledge.spaces!,file=await spaces.importFile(w.user,Buffer.from('合成他人署名原文'),'text/plain','合成原文.txt','/shared');
 const source=(await w.kit.store.findMany({kind:'knowledge_space_source',key:'knowledge.space.source_hash',values:[file.body.sha256]})).find(row=>SpaceSourceBody.parse(row.body).artifact===file.digest)!;
 await spaces.attributeSource(w.user,source.digest,file.digest);await spaces.grant(w.user,{path:'/shared',audience:'member',member:w.outsider.id});
 const entry=await spaces.write(w.outsider,{kind:'observation',statement:'合成借用原文分享',grounds:[{reference:'src:'+file.body.sha256,quotation:'署名原文'}]});await spaces.ensure(w.outsider,'team');
 return {file,input:{root:entry.root,path:'/',entry:entry.entry}};
}
for(const change of ['deactivation','revocation']){
 test(`sharing keeps the grantor locked until the team copy commits before ${change}`,async t=>{
  const w=await makeWorld(postgres);t.after(w.close);const p=await prepare(w),spaces=w.knowledge.spaces!,entered=barrier(),release=barrier(),ingest=w.kit.artifacts.ingest.bind(w.kit.artifacts),lock=w.kit.store.lock.bind(w.kit.store),locks:string[]=[];
  w.kit.store.lock=async(key,tx)=>{locks.push(key);return lock(key,tx);};
  w.kit.artifacts.ingest=async(input,tx)=>{if(input.visibility.admins){entered.release();await release.promise;}return ingest(input,tx);};
  const sharing=spaces.share(w.outsider,p.input);await reaches(entered,sharing);
  assert.deepEqual(locks,[...new Set([w.user.id,w.outsider.id])].sort().map(id=>'knowledge-space:'+id).concat('knowledge-space:team'));
  const changing=change==='deactivation'?w.kit.principals.setDisabled(w.admin,w.user.id,true):spaces.grant(w.user,{path:'/shared',audience:'member',member:w.outsider.id,revoke:true});
  try{await waitForUserUpdateLock(w.kit,change==='deactivation'?'SELECT * FROM users WHERE id = $1 FOR UPDATE':'SELECT pg_advisory_xact_lock($1, hashtext($2))');}finally{release.release();}
  assert.equal((await sharing).status,'merged');await changing;assert.equal((await spaces.current('team'))!.body.entries.length,1);
 });
 test(`${change} completed before dependency admission prevents a later team copy`,async t=>{
  const w=await makeWorld(postgres);t.after(w.close);const p=await prepare(w),spaces=w.knowledge.spaces!,entered=barrier(),release=barrier(),lock=w.kit.store.lock.bind(w.kit.store);let once=false;
  w.kit.store.lock=async(key,tx)=>{if(key==='knowledge-space:'+w.user.id&&!once){once=true;entered.release();await release.promise;}return lock(key,tx);};
  const sharing=spaces.share(w.outsider,p.input).then(value=>value,error=>error);await reaches(entered,sharing);
  try{if(change==='deactivation')await w.kit.principals.setDisabled(w.admin,w.user.id,true);else await spaces.grant(w.user,{path:'/shared',audience:'member',member:w.outsider.id,revoke:true});}finally{release.release();}
  const outcome=await sharing;assert.notEqual(outcome.status,'merged');assert.ok(outcome.status==='rejected'||outcome.code==='SOURCE_UNAVAILABLE');assert.equal((await spaces.current('team'))!.body.entries.length,0);
 });
}
