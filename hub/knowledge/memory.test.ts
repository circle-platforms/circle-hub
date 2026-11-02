import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {makeWorld,startPostgres} from './test-support.ts';
import type {TemporaryPostgres} from '../testing/postgres.ts';
import {MemoryDocuments} from './memory.ts';
import {MemoryVersionBody} from '../../contracts/src/memory.ts';
let postgres:TemporaryPostgres;
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
const create=(markdown='合成偏好',key='create')=>({title:'合成记忆',markdown,path:'/preferences',expected_version:null,client_key:key});
test('disabled grantees can be revoked and disabled personal memories stay hidden from every recipient',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const memory=w.knowledge.memory,saved=await memory.write(w.user,create());
 await memory.grant(w.user,{path:'/',audience:'member',member:w.outsider.id});
 await w.kit.principals.setDisabled(w.admin,w.outsider.id,true);
 assert.ok((await memory.grants(w.user)).some(grant=>grant.member===w.outsider.id));
 await memory.grant(w.user,{path:'/',audience:'member',member:w.outsider.id,revoke:true});
 await w.kit.principals.setDisabled(w.admin,w.outsider.id,false);
 await assert.rejects(memory.read(w.outsider,saved.document),{code:'SOURCE_UNAVAILABLE'});
 await memory.grant(w.user,{path:'/',audience:'member',member:w.outsider.id});await memory.grant(w.user,{path:'/',audience:'administrators'});
 await memory.write(w.user,{document:saved.document,expected_version:saved.version,enabled:false,client_key:'hide-disabled'});
 for(const recipient of [w.outsider,w.admin]){assert.equal((await memory.items(recipient,'shared')).length,0);await assert.rejects(memory.read(recipient,saved.document),{code:'SOURCE_UNAVAILABLE'});}
 assert.equal((await memory.read(w.user,saved.document)).state,'disabled');
});
test('unchanged writes preserve the version and idempotency while every new revision checks historical capacity',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const memory=w.knowledge.memory;
 const first=await memory.write(w.user,create()),saved=await memory.write(w.user,{document:first.document,expected_version:first.version,enabled:false,client_key:'initial-disable'});
 const usage=await memory.usage(w.user);await w.knowledge.spaces!.setCapacity(w.admin,w.user.id,usage.history);
 const versions=async()=>(await w.kit.store.find({kind:'memory_version',key:'memory.version.document',value:saved.document})).items.length;
 const before=await versions();
 for(let n=0;n<3;n++){const input={document:saved.document,expected_version:saved.version,enabled:false,client_key:'unchanged-'+n};const receipt=await memory.write(w.user,input);assert.equal(receipt.unchanged,true);assert.equal(receipt.version,saved.version);assert.deepEqual(await memory.write(w.user,input),receipt);}
 assert.equal(await versions(),before);assert.deepEqual(await memory.usage(w.user),usage);
 await assert.rejects(memory.write(w.user,{document:saved.document,expected_version:saved.version,title:'合成修改',enabled:false,client_key:'unchanged-0'}),{code:'IDEMPOTENCY_MISMATCH'});
 for(const [key,changes] of [['title',{title:'合成修改'}],['path',{path:'/new'}],['state',{enabled:true}]] as const)await assert.rejects(memory.write(w.user,{document:saved.document,expected_version:saved.version,...changes,client_key:'capacity-'+key}),{code:'SPACE_CAPACITY_EXCEEDED'});
 assert.equal(await versions(),before);
});
test('active memory quotas count UTF-8 titles and paths and protect both session list and body reads',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const memory=w.knowledge.memory;
 const input={...create('','metadata-cap'),title:'合成标题',path:'/路径'},size=Buffer.byteLength(input.title+input.path);
 w.kit.memoryIndex!.limits.spaceBytes=size-1;
 await assert.rejects(memory.write(w.user,input),{code:'MEMORY_SPACE_LIMIT'});
 w.kit.memoryIndex!.limits.spaceBytes=size;
 const saved=await memory.write(w.user,{...input,client_key:'metadata-exact'});assert.equal((await memory.usage(w.user)).active,size);assert.equal((await memory.usage(w.user)).activeDocuments,1);
 w.kit.memoryIndex!.limits.spaceBytes=size-1;
 await assert.rejects(memory.query(w.user,{scope:'personal',for_session:true}),{code:'MEMORY_SPACE_LIMIT'});
 await assert.rejects(memory.query(w.user,{document:saved.document,version:saved.version,for_session:true}),{code:'MEMORY_SPACE_LIMIT'});
 assert.equal((await memory.read(w.user,saved.document)).markdown,'');
});
test('twenty active team memories are bounded even with empty bodies and replacements keep the same count',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const memory=w.knowledge.memory,sources=[];
 for(let n=0;n<21;n++)sources.push(await memory.write(w.user,{...create('','proliferation-'+n),title:'合成记忆 '+n,enabled:false}));
 let first:Awaited<ReturnType<typeof memory.share>>|undefined;
 for(let n=0;n<20;n++){const source=sources[n],shared=await memory.share(w.user,{document:source.document,version:source.version,client_key:'team-'+n});assert.equal(shared.ok,true);first??=shared;}
 const last=sources[20],input={document:last.document,version:last.version,client_key:'team-cap'};
 const before=await w.kit.store.watermark!(),plan=await memory.share(w.user,{...input,check_only:true});assert.equal(plan.ok,false);assert.equal(plan.checks.find(check=>check.check==='size')?.code,'MEMORY_SPACE_LIMIT');assert.equal(await w.kit.store.watermark!(),before);
 assert.equal((await memory.share(w.user,input)).ok,false);assert.equal((await memory.usage(w.admin,'team')).activeDocuments,20);
 const changed=await memory.write(w.user,{document:sources[0].document,expected_version:sources[0].version,title:'合成修订标题',client_key:'replace-at-cap'});
 assert.equal((await memory.share(w.user,{document:changed.document,version:changed.version,client_key:'replace-at-cap'})).share?.team_document,first!.share!.team_document);
 assert.equal((await memory.usage(w.admin,'team')).activeDocuments,20);
 w.kit.memoryIndex!.limits.spaceDocuments=19;
 await assert.rejects(memory.query(w.outsider,{scope:'team',for_session:true}),{code:'MEMORY_SPACE_LIMIT'});
 const team=await memory.read(w.admin,first!.share!.team_document!);
 await assert.rejects(memory.query(w.outsider,{document:team.document,version:team.version,for_session:true}),{code:'MEMORY_SPACE_LIMIT'});
});
test('separate memory services serialize active document caps and disabling frees exactly one slot',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const memory=w.knowledge.memory,other=new MemoryDocuments(w.knowledge.__context,w.knowledge.spaces!);
 w.kit.memoryIndex!.limits.spaceDocuments=1;
 const results=await Promise.allSettled([memory.write(w.user,create('','count-one')),other.write(w.user,create('','count-two'))]);
 assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.filter(result=>result.status==='rejected'&&result.reason.code==='MEMORY_SPACE_LIMIT').length,1);
 const saved=results.find((result):result is PromiseFulfilledResult<Awaited<ReturnType<typeof memory.write>>>=>result.status==='fulfilled')!.value;
 await memory.write(w.user,{document:saved.document,expected_version:saved.version,enabled:false,client_key:'free-count'});
 assert.equal((await memory.usage(w.user)).activeDocuments,0);
 await other.write(w.user,create('','count-three'));assert.equal((await memory.usage(w.user)).activeDocuments,1);
});
test('memory writes are versioned, optimistic and idempotent; pagination preserves Unicode and invalidates old sessions',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const memory=w.knowledge.memory;
 const text='合成偏好。'.repeat(1200),first=await memory.write(w.user,create(text));
 assert.equal((await memory.write(w.user,create(text))).version,first.version);
 await assert.rejects(memory.write(w.user,{...create('不同正文')}),{code:'IDEMPOTENCY_MISMATCH'});
 const one=await memory.query(w.user,{document:first.document,version:first.version,for_session:true});assert.ok(one.memory_document?.next);
 const two=await memory.query(w.user,{document:first.document,version:first.version,for_session:true,cursor:one.memory_document!.next!});assert.equal(one.memory_document!.markdown+two.memory_document!.markdown,text);
 const updated=await memory.write(w.user,{document:first.document,expected_version:first.version,enabled:false,client_key:'disable'});
 const version=MemoryVersionBody.parse((await w.kit.store.get(updated.version))!.body);assert.equal(version.markdown,null);assert.equal(version.content_version,first.version);
 assert.equal((await memory.read(w.user,first.document,first.version)).state,'superseded');assert.equal((await memory.usage(w.user)).active,0);
 await assert.rejects(memory.write(w.user,{document:first.document,expected_version:first.version,markdown:'新正文',client_key:'stale'}),{code:'MEMORY_VERSION_CONFLICT'});
 await assert.rejects(memory.query(w.user,{document:first.document,version:first.version,for_session:true,cursor:one.memory_document!.next!}),{code:'SOURCE_UNAVAILABLE'});
 const before=await memory.usage(w.user);await memory.rebuild(w.user);assert.deepEqual(await memory.usage(w.user),before);await memory.rebuild(w.user);assert.deepEqual(await memory.usage(w.user),before);
});
test('refused credentials and size limits retain one safe audit and no content or quota writes',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const memory=w.knowledge.memory;
 const secret='DB_PASSWORD=synthetic-secret-2498';
 const failures:Error[]=[];
 for(let n=0;n<2;n++)await assert.rejects(memory.write(w.user,create(secret,'secret')),error=>{assert.equal((error as {code:string}).code,'MEMORY_CREDENTIALS_DETECTED');failures.push(error as Error);return true;});
 assert.match(failures[0].message,/Markdown 正文第 1 行/);assert.equal(failures[1].message,failures[0].message);
 assert.equal((await w.kit.store.list({kind:'memory_document'})).items.length,0);assert.equal((await w.kit.store.list({kind:'memory_version'})).items.length,0);
 const audit=await w.kit.store.find({kind:'action',key:'memory.refusal.by',value:w.user.id});assert.equal(audit.items.length,1);assert.ok(!JSON.stringify(audit).includes(secret));assert.ok(!JSON.stringify(audit).includes('synthetic-secret-2498'));
 assert.equal((await memory.usage(w.user)).history,0);
 w.kit.memoryIndex!.limits.documentBytes=8;await assert.rejects(memory.write(w.user,{...create('一二三','disabled-limit'),enabled:false}),{code:'MEMORY_DOCUMENT_LIMIT'});await assert.rejects(memory.write(w.user,create('一二三','limit')),{code:'MEMORY_DOCUMENT_LIMIT'});assert.equal((await memory.usage(w.user)).active,0);
});
test('active quotas are serialized across services, disable frees active bytes, and knowledge shares historical capacity',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const memory=w.knowledge.memory,other=new MemoryDocuments(w.knowledge.__context,w.knowledge.spaces!);
 w.kit.memoryIndex!.limits.spaceBytes=Buffer.byteLength(create().title+create().path)+10;
 const results=await Promise.allSettled([memory.write(w.user,create('123456','one')),other.write(w.user,create('abcdef','two'))]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.code==='MEMORY_SPACE_LIMIT').length,1);
 const saved=results.find((r):r is PromiseFulfilledResult<Awaited<ReturnType<typeof memory.write>>>=>r.status==='fulfilled')!.value;
 await memory.write(w.user,{document:saved.document,expected_version:saved.version,enabled:false,client_key:'off'});assert.equal((await memory.usage(w.user)).active,0);
 const after=await memory.write(w.user,create('abcdef','three'));assert.equal(after.bytes,6);
 const usage=await memory.usage(w.user);await w.knowledge.spaces!.setCapacity(w.admin,w.user.id,usage.history);
 await assert.rejects(w.knowledge.spaces!.write(w.user,{kind:'observation',statement:'超过记忆共用容量'}),{code:'SPACE_CAPACITY_EXCEEDED'});
 w.kit.memoryIndex!.limits.spaceBytes=48000;
 await assert.rejects(memory.write(w.user,create('x','capacity')),{code:'SPACE_CAPACITY_EXCEEDED'});
});
test('memory grants are independent of knowledge; recipients browse current text without session loading or history',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const memory=w.knowledge.memory;
 await w.knowledge.spaces!.directory(w.user,'/preferences');await w.knowledge.spaces!.grant(w.user,{path:'/',audience:'administrators'});
 const saved=await memory.write(w.user,create());await assert.rejects(memory.read(w.admin,saved.document),{code:'SOURCE_UNAVAILABLE'});
 await memory.grant(w.user,{path:'/',audience:'member',member:w.outsider.id});assert.equal((await memory.read(w.outsider,saved.document)).auto_load_allowed,false);
 await assert.rejects(memory.read(w.outsider,saved.document,saved.version,true),{code:'SOURCE_UNAVAILABLE'});
 const changed=await memory.write(w.user,{document:saved.document,expected_version:saved.version,markdown:'修订偏好',client_key:'edit'});
 await assert.rejects(memory.read(w.outsider,saved.document,saved.version),{code:'SOURCE_UNAVAILABLE'});
 assert.equal((await memory.read(w.outsider,saved.document)).version,changed.version);
 await memory.grant(w.user,{path:'/',audience:'member',member:w.outsider.id,revoke:true});assert.equal((await memory.items(w.outsider,'shared')).length,0);
 await memory.grant(w.user,{path:'/',audience:'member',member:w.outsider.id});assert.equal((await memory.items(w.outsider,'shared')).length,1);
 await memory.grant(w.user,{path:'/',audience:'administrators'});assert.equal((await memory.items(w.admin,'shared')).length,1);
 await w.kit.principals.setDisabled(w.admin,w.user.id,true);await assert.rejects(memory.read(w.admin,saved.document),{code:'SOURCE_UNAVAILABLE'});
});
test('re-sharing supersedes the prior team version unless an administrator changed it, and previews never write',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const memory=w.knowledge.memory;let saved=await memory.write(w.user,create());
 const share=(key:string,check_only=false)=>({document:saved.document,version:saved.version,client_key:key,check_only});
 const before=await w.kit.store.watermark!(),plan=await memory.share(w.user,share('first',true));assert.equal(plan.effect,'create');assert.equal(await w.kit.store.watermark!(),before);
 const first=await memory.share(w.user,share('first'));assert.ok(first.share?.team_document&&first.share.team_version);const team=first.share.team_document;
 saved=await memory.write(w.user,{document:saved.document,expected_version:saved.version,markdown:'第二版',client_key:'second'});
 const replacement=await memory.share(w.user,share('replace',true));assert.equal(replacement.effect,'replace');assert.equal(replacement.replaces,team);
 const second=await memory.share(w.user,share('replace'));assert.equal(second.share?.team_document,team);assert.equal((await memory.read(w.admin,team,first.share.team_version)).state,'superseded');
 assert.equal((await memory.share(w.user,share('replace'))).record,second.record);
 const admin=await memory.write(w.admin,{space:'team',document:team,expected_version:second.share!.team_version,markdown:'管理员修订',client_key:'admin'});
 saved=await memory.write(w.user,{document:saved.document,expected_version:saved.version,markdown:'第三版',client_key:'third'});
 assert.equal((await memory.share(w.user,share('new',true))).effect,'create');const third=await memory.share(w.user,share('new'));
 assert.notEqual(third.share?.team_document,team);assert.equal((await memory.read(w.user,team)).version,admin.version);assert.equal((await memory.read(w.user,team)).markdown,'管理员修订');
 await assert.rejects(memory.write(w.user,{space:'team',document:team,expected_version:admin.version,markdown:'无权覆盖',client_key:'denied'}),{code:'SOURCE_UNAVAILABLE'});
});
test('administrator-disabled team memory cannot be revived or copied by re-sharing the same personal document',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const memory=w.knowledge.memory;
 let source=await memory.write(w.user,create('合成旧约定','disable-latch'));
 const share=(key:string)=>({document:source.document,version:source.version,client_key:key});
 const first=await memory.share(w.user,share('latch-first')),team=first.share!.team_document!;
 const ready=await memory.share(w.user,{...share('latch-next'),check_only:true});assert.equal(ready.ok,true);
 const disabled=await memory.write(w.admin,{space:'team',document:team,expected_version:first.share!.team_version,enabled:false,client_key:'latch-disable'});
 const before=await w.kit.store.watermark!(),plan=await memory.share(w.user,{...share('latch-next'),check_only:true});
 assert.equal(plan.ok,false);assert.equal(plan.checks[0].code,'MEMORY_TEAM_DISABLED');assert.equal(plan.checks[0].message,'团队记忆已被管理员停用，请联系管理员');assert.deepEqual(plan.checks.map(check=>check.state),['violation','unchecked','unchecked']);assert.equal(await w.kit.store.watermark!(),before);
 const refused=await memory.share(w.user,share('latch-next'));assert.equal(refused.share?.code,'MEMORY_TEAM_DISABLED');assert.equal(refused.share?.team_document,null);assert.equal((await memory.read(w.admin,team)).version,disabled.version);
 source=await memory.write(w.user,{document:source.document,expected_version:source.version,title:'修订合成约定',markdown:'合成新约定',client_key:'latch-revised'});
 assert.equal((await memory.share(w.user,share('latch-revised'))).ok,false);assert.equal((await memory.items(w.admin,'team')).length,1);
 const unrelated=await memory.write(w.user,create('另一篇合成约定','latch-other'));assert.equal((await memory.share(w.user,{document:unrelated.document,version:unrelated.version,client_key:'latch-other'})).ok,true);
 await memory.write(w.admin,{space:'team',document:team,expected_version:disabled.version,enabled:true,client_key:'latch-enable'});
 const next=await memory.share(w.user,share('latch-after-enable'));assert.equal(next.ok,true);assert.notEqual(next.share?.team_document,team,'administrator-maintained text is preserved');
 const current=await memory.read(w.admin,team);await memory.write(w.admin,{space:'team',document:team,expected_version:current.version,enabled:false,client_key:'latch-old-disable'});
 assert.equal((await memory.share(w.user,{...share('latch-old-lineage'),check_only:true})).ok,false,'an earlier disabled team copy cannot be bypassed with a later share');
});
test('metadata pages are bounded in UTF-8 bytes and version changes invalidate their cursors',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const memory=w.knowledge.memory;
 const saved=[];for(let n=0;n<10;n++)saved.push(await memory.write(w.user,{...create('合成','page-'+n),title:'合'.repeat(250),path:'/'+'字'.repeat(1000)}));
 const seen=new Set<string>();let cursor:string|undefined;let firstCursor:string|undefined;
 do{const result=await memory.query(w.user,{scope:'personal',cursor});assert.ok(result.memory_page);assert.ok(Buffer.byteLength(JSON.stringify(result.memory_page))<=16000);for(const row of result.memory_page.items){assert.ok(!seen.has(row.document));seen.add(row.document);}cursor=result.memory_page.next??undefined;firstCursor??=cursor;}while(cursor);
 assert.equal(seen.size,10);assert.ok(firstCursor);
 await memory.write(w.user,{document:saved[0].document,expected_version:saved[0].version,enabled:false,client_key:'page-change'});
 await assert.rejects(memory.query(w.user,{scope:'personal',cursor:firstCursor}),{code:'MEMORY_CURSOR_STALE'});
});
test('history is owner or team-administrator only and sensitive share paths never enter receipts',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const memory=w.knowledge.memory;
 const saved=await memory.write(w.user,create());await memory.grant(w.user,{path:'/',audience:'member',member:w.outsider.id});
 assert.equal((await memory.history(w.user,saved.document)).items.length,1);
 await assert.rejects(memory.history(w.outsider,saved.document),{code:'SOURCE_UNAVAILABLE'});
 const secret='/DB_PASSWORD=synthetic-secret-9837';
 for(const key of ['credentials','early-size']){
  if(key==='early-size')w.kit.memoryIndex!.limits.spaceBytes=0;
  const input={document:saved.document,version:saved.version,team_path:secret,client_key:key};
  const before=await w.kit.store.watermark!(),plan=await memory.share(w.user,{...input,check_only:true});assert.equal(plan.ok,false);assert.equal(plan.target_path,undefined);assert.equal(await w.kit.store.watermark!(),before);
  const refused=await memory.share(w.user,input);assert.equal(refused.share?.target_path,undefined);assert.ok(!JSON.stringify(refused).includes('synthetic-secret-9837'));assert.ok(!JSON.stringify((await w.kit.store.get(refused.record!))?.body).includes('synthetic-secret-9837'));
 }
});
