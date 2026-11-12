import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import pg from 'pg';
import {createKnowledge} from './api.ts';
import {createTestParserRegistry} from '../testing/parsers.ts';
import {makeWorld,startPostgres} from './test-support.ts';
import {legacyRootSource} from './testing-capacity.ts';
import {historyUsage,chargedBytes,forgetCapacityCharges,type RecordStore,type Transaction} from '../records/api.ts';
import {barrier,reaches} from '../testing/member-freeze.ts';
let postgres:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
test('legacy root usage is rederived, a later write is refused at the true limit and all original records remain unchanged',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!,legacy=await legacyRootSource(w.kit,w.user),before=await w.kit.store.watermark!();
 assert.equal((await spaces.usage(w.user)).used,legacy.expected);assert.equal(await w.kit.store.watermark!(),before,'GET usage appends nothing');
 await spaces.setCapacity(w.admin,w.user.id,16384);const mark=await w.kit.store.watermark!();
 await assert.rejects(spaces.write(w.user,{kind:'observation',statement:'合成少计后必须拒收'}),(error:any)=>{assert.equal(error.code,'SPACE_CAPACITY_EXCEEDED');assert.equal(error.detail.capacity.used,legacy.expected);assert.equal(error.detail.capacity.remaining,0);assert.ok(error.detail.capacity.requested>0);return true;});
 assert.equal(await w.kit.store.watermark!(),mark);assert.deepEqual(await w.kit.store.get(legacy.record!.digest),legacy.record);assert.deepEqual(Buffer.from((await w.kit.objects.get(legacy.file.body.sha256))!),legacy.bytes);
 await spaces.setCapacity(w.admin,w.user.id,legacy.expected+20000);await spaces.write(w.user,{kind:'observation',statement:'合成调高后重试'});assert.equal((await spaces.usage(w.user)).knowledge,(await spaces.current(w.user.id))!.body.used_bytes);assert.equal((await spaces.usage(w.user)).used,(await spaces.usage(w.admin,w.user.id)).used);
});
test('an inflated legacy counter is metadata, not charged bytes, and memory history is independent of mutable totals',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!,legacy=await legacyRootSource(w.kit,w.user,Number.MAX_SAFE_INTEGER),memory=w.knowledge.memory;
 assert.equal((await spaces.usage(w.user)).used,legacy.expected);
 const doc=await memory.write(w.user,{title:'合成记忆容量',markdown:'合成保留内容',path:'/',expected_version:null,client_key:'synthetic-count'}),heads=await w.kit.memoryIndex!.heads(w.user.id),history=(await memory.usage(w.user)).history;
 await w.kit.store.withTransaction(tx=>w.kit.memoryIndex!.rebuild(w.user.id,heads,0,tx));assert.equal((await memory.usage(w.user)).history,history);const actual=(await spaces.usage(w.user)).used;
 await spaces.setCapacity(w.admin,w.user.id,actual);await assert.rejects(memory.write(w.user,{document:doc.document,expected_version:doc.version,markdown:'合成新增内容',client_key:'synthetic-memory-denial'}),{code:'SPACE_CAPACITY_EXCEEDED'});assert.equal((await memory.read(w.user,doc.document)).markdown,'合成保留内容');
});
test('usage is owner/admin metadata, requires intact records, and does not initialize an empty space',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!,mark=await w.kit.store.watermark!();
 assert.equal((await spaces.usage(w.user)).used,0);assert.equal(await spaces.current(w.user.id),null);assert.equal(await w.kit.store.watermark!(),mark);await assert.rejects(spaces.usage(w.outsider,w.user.id),{code:'SOURCE_UNAVAILABLE'});
 const legacy=await legacyRootSource(w.kit,w.user),many=w.kit.store.getMany.bind(w.kit.store);w.kit.store.getMany=async <B>(ids:readonly string[],tx?:Transaction)=>{const records=await many<B>(ids,tx);records.delete(legacy.file.digest);return records;};
 await assert.rejects(spaces.usage(w.user),{name:'IntegrityError'});
});
for(const path of ['knowledge','source','memory'])test(`${path} charges the exact admission size, refuses one byte short and retries with the same request after a raise`,async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!;
 const write=()=>path==='knowledge'?spaces.write(w.user,{kind:'observation',statement:'合成精确边界'}):path==='source'?spaces.importFile(w.user,Buffer.from('合成精确原文'),'text/plain','合成容量.txt'):w.knowledge.memory.write(w.user,{title:'合成精确记忆',markdown:'合成正文',expected_version:null,client_key:'same-capacity-retry'});
 await spaces.setCapacity(w.admin,w.user.id,0);let requested=0;await assert.rejects(write(),(e:any)=>{requested=e.detail.capacity.requested;assert.ok(requested>0);return e.code==='SPACE_CAPACITY_EXCEEDED';});
 await spaces.setCapacity(w.admin,w.user.id,requested-1);await assert.rejects(write(),{code:'SPACE_CAPACITY_EXCEEDED'});assert.equal((await spaces.usage(w.user)).used,0);
 await spaces.setCapacity(w.admin,w.user.id,requested);await write();assert.equal((await spaces.usage(w.user)).used,requested);assert.equal((await spaces.usage(w.user)).remaining,0);
});
test('a quota reduction completed while a write is queued is rechecked inside the committing lock',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!,entered=barrier(),release=barrier(),lock=w.kit.store.lock.bind(w.kit.store);let once=false;const other=createKnowledge({records:w.kit,packs:w.packs,external:w.external,parsers:createTestParserRegistry()}).spaces!;
 w.kit.store.lock=async(key,tx)=>{if(key==='knowledge-space:'+w.user.id&&!once){once=true;entered.release();await release.promise;}return lock(key,tx);};
 const write=spaces.write(w.user,{kind:'observation',statement:'合成并发调额'}),refused=assert.rejects(write,{code:'SPACE_CAPACITY_EXCEEDED'});void refused.catch(()=>{});
 try{await reaches(entered,write);await other.setCapacity(w.admin,w.user.id,0);}finally{release.release();}await refused;assert.equal(await spaces.current(w.user.id),null);
});
test('an already locked write commits first, then a lower quota preserves its content and refuses the next write',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!,entered=barrier(),release=barrier(),lock=w.kit.store.lock.bind(w.kit.store);let locks=0;const other=createKnowledge({records:w.kit,packs:w.packs,external:w.external,parsers:createTestParserRegistry()}).spaces!;
 w.kit.store.lock=async(key,tx)=>{await lock(key,tx);if(key==='knowledge-space:'+w.user.id&&++locks===2){entered.release();await release.promise;}};
 const writing=spaces.write(w.user,{kind:'observation',statement:'合成先提交内容'});await reaches(entered,writing);const reducing=other.setCapacity(w.admin,w.user.id,0),client=new pg.Client({...w.kit.database,ssl:false});await client.connect();
 try{let blocked=false;for(let n=0;n<500;n++){const r=await client.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query=$1 AND cardinality(pg_blocking_pids(pid))>0",['SELECT pg_advisory_xact_lock($1, hashtext($2))']);if(r.rowCount){blocked=true;break;}await new Promise(r=>setTimeout(r,10));}assert.ok(blocked,'the quota setter must wait for the committing space lock');}finally{release.release();await client.end();}
 const saved=await writing;await reducing;assert.ok(await spaces.entry(w.user,saved.root,'/',saved.entry));assert.ok((await spaces.usage(w.user)).over>0);await assert.rejects(spaces.write(w.user,{kind:'observation',statement:'合成后续拒收'}),{code:'SPACE_CAPACITY_EXCEEDED'});
});


test('exact historical capacity keeps what each version admitted: a later call reads the new version alone, and from nothing the history is three batches whatever its length',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!,legacy=await legacyRootSource(w.kit,w.user);let expected=legacy.expected;
 for(let n=0;n<12;n++){
  const saved=await spaces.write(w.user,{kind:'observation',statement:'合成容量批量条目 '+n}),version=await spaces.version(saved.root),row=version!.body.entries.find(row=>row.entry===saved.entry)!,entry=await w.kit.store.get(row.record);
  expected+=chargedBytes(version!.body)+chargedBytes(entry!.body);
  if(n!==2&&n!==11)continue;
  let batches=0,scalars=0,asked=0;const store=new Proxy(w.kit.store,{get(target,key){const method=Reflect.get(target,key,target);if(key==='getMany')return(...args:unknown[])=>{batches++;asked+=(args[0] as unknown[]).length;return Reflect.apply(method,target,args);};if(key==='get')return(...args:unknown[])=>{scalars++;return Reflect.apply(method,target,args);};return typeof method==='function'?method.bind(target):method;}}) as RecordStore;
  // The writes above already worked out the older versions: only the newest, its parent and the entry it adds are read.
  assert.deepEqual(await historyUsage(store,w.user.id),{knowledge:expected,memory:0,used:expected});assert.ok(asked<=3,`read ${asked} records for one new version`);assert.equal(scalars,0,'a version or source must not add a scalar read');
  // Asked again, nothing of the history is read.
  batches=0;asked=0;assert.deepEqual(await historyUsage(store,w.user.id),{knowledge:expected,memory:0,used:expected});assert.equal(batches,0);
  // From nothing: the versions, what they admitted, and the originals' captures, three batches at three versions and at twelve.
  forgetCapacityCharges();batches=0;asked=0;
  assert.deepEqual(await historyUsage(store,w.user.id),{knowledge:expected,memory:0,used:expected},'the same figure worked out afresh');assert.equal(batches,3,'one batch of versions, one of admitted records and one of captures');assert.ok(asked>=2*(n+1));assert.equal(scalars,0);
 }
});
