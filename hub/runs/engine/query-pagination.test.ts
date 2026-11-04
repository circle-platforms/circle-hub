// Engine pagination over real records: no pack function, external system or model is executed here.
import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {runRecord} from '../../../contracts/src/fixtures.ts';
import {RunRecord} from '../../../contracts/src/run.ts';
import {newId,withReadScope,artifactShareKey} from '../../records/api.ts';
import {startPostgres} from '../../testing/postgres.ts';
import {openHarness} from './testing/harness.ts';
import {putRun} from './store.ts';
import {createRequestService} from '../../requests/api.ts';
import {Database} from '../../records/db.ts';
let postgres:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
test('run cursors follow body dates and tie ids across append order, skip unreadable candidates and remain bound to reader and pack',async t=>{
 const h=await openHarness(postgres);t.after(h.close);const records:RunRecord[]=[];
 for(let n=0;n<74;n++){
  const body=RunRecord.parse({...runRecord,run:newId('run'),runner:n%3===0?h.bob.id:h.alice.id,pack:`${h.review.pack.id}@${h.review.pack.version}`,pack_digest:h.review.pack.digest,requirements:[],sources:[],items:[],target_basis:[],started_at:`2026-11-0${1+n%3}T08:00:00.000Z`,client_key:'synthetic-page-'+n});
  records.push(body);await putRun(h.kit.store,body,`2026-11-03T09:00:${String(n%60).padStart(2,'0')}.000Z`);
 }
 // Sharing makes some non-owned runs visible; a private workflow and its sources keep their independent gates.
 const shared=records.find(r=>r.runner===h.alice.id)!;await h.kit.authorizations.share(h.admin,shared.run,[h.bob.id]);
 const compare=(a:RunRecord,b:RunRecord)=>a.started_at===b.started_at?(a.run===b.run?0:a.run<b.run?1:-1):a.started_at<b.started_at?1:-1;
 const expected=records.filter(r=>r.runner===h.bob.id||r.run===shared.run).sort(compare).map(r=>r.run);
 const seen:string[]=[];let cursor:string|null=null,firstCursor='';
 do{const page=await h.service.listRuns(h.bob,{limit:4,cursor});seen.push(...page.items.map(r=>r.run));if(!firstCursor)firstCursor=page.next??'';cursor=page.next;if(cursor)assert.equal(page.items.length,4,'unreadable candidates do not create short intermediate pages');}while(cursor);
 assert.deepEqual(seen,expected);assert.equal(new Set(seen).size,seen.length);
 assert.deepEqual(await h.service.listRuns(h.alice,{limit:4,cursor:firstCursor}),{items:[],next:null});
 assert.deepEqual(await h.service.listRuns(h.bob,{pack:h.verify.pack.id,limit:4,cursor:firstCursor}),{items:[],next:null});
 assert.deepEqual(await h.service.listRuns(h.bob,{cursor:'invalid'}),{items:[],next:null});
 await h.kit.authorizations.unshare(h.admin,shared.run,h.bob.id);assert.ok(!(await h.service.listRuns(h.bob,{limit:500})).items.some(r=>r.run===shared.run),'a later call does not reuse a revoked share');
 const admin=await h.service.listRuns(h.admin,{limit:500});assert.deepEqual(admin.items.map(r=>r.run),[...records].sort(compare).map(r=>r.run));
 const sparse=await h.kit.principals.createUser(h.admin,'合成稀疏读者'),allowed=[...records].sort(compare).slice(-2);
 for(const row of allowed)await h.kit.authorizations.share(h.admin,row.run,[sparse.id]);
 const originalQuery=Database.prototype.query;let sparseQueries=0;Database.prototype.query=(async function(this:Database,...args:Parameters<typeof originalQuery>){sparseQueries++;return originalQuery.apply(this,args);}) as typeof originalQuery;
 let sparsePage:Awaited<ReturnType<typeof h.service.listRuns>>;
 try{sparsePage=await h.service.listRuns(sparse,{limit:1});}finally{Database.prototype.query=originalQuery;}
 assert.deepEqual(sparsePage.items.map(row=>row.run),[allowed[0].run]);assert.ok(sparsePage.next,'readable runs beyond two wholly unreadable candidate batches still fill a page');
 const sparseLast=await h.service.listRuns(sparse,{limit:1,cursor:sparsePage.next});assert.deepEqual(sparseLast.items.map(row=>row.run),[allowed[1].run]);assert.equal(sparseLast.next,null);
 t.diagnostic(`Sparse reader: 2 of 74 runs visible, a 1-row first page beyond 64 hidden candidates uses ${sparseQueries} SQL calls`);
 const candidates=h.kit.store.runCandidates;
 for(const [at,id]of [[records[0].started_at+'\0',records[0].run],[records[0].started_at,records[0].run+'\0'],['\0',records[0].run]]){
  const cursor=Buffer.from(JSON.stringify({reader:h.admin.id,pack:null,at,id})).toString('base64url');
  const native=await h.service.listRuns(h.admin,{limit:5,cursor});h.kit.store.runCandidates=undefined;
  try{assert.deepEqual(native,await h.service.listRuns(h.admin,{limit:5,cursor}),'untrusted cursor strings retain the original lexical continuation semantics');}finally{h.kit.store.runCandidates=candidates;}
 }

});
test('batched readability keeps exact captures private, honors later grants and does not lend ownership to a shared reader',async t=>{
 const h=await openHarness(postgres);t.after(h.close);
 const secret=await h.kit.artifacts.ingest({bytes:Buffer.from('合成私人输入'),mediaType:'text/plain',origin:{upload:{session:null}},author:{user:h.alice.id},provenanceType:'declared',visibility:{readers:[h.alice.id],admins:false,packs:[],shareable:false}});
 const rows:RunRecord[]=[];
 for(let i=0;i<4;i++){const run=RunRecord.parse({...runRecord,run:newId('run'),runner:h.alice.id,pack:`${h.review.pack.id}@${h.review.pack.version}`,pack_digest:h.review.pack.digest,requirements:[],items:[],target_basis:[],sources:i%2?[{reference:'src:'+secret.body.sha256,artifact:secret.digest,role:'subject'}]:[],client_key:'synthetic-readable-'+i});await putRun(h.kit.store,run,new Date(run.started_at).toISOString());await h.kit.authorizations.share(h.admin,run.run,[h.bob.id]);rows.push(run);}
 const first=await h.service.listRuns(h.bob,{limit:1});assert.equal(first.items.length,1);assert.ok(first.items[0].sources.length===0);
 const all=await h.service.listRuns(h.bob,{limit:20});assert.deepEqual(new Set(all.items.map(r=>r.run)),new Set(rows.filter(r=>!r.sources.length).map(r=>r.run)));
 assert.equal(await h.service.getRun(h.bob,rows[1].run),null);assert.equal(await h.service.getRun(h.admin,rows[1].run),null,'admin metadata visibility does not lend private input access');
 await h.kit.authorizations.share(h.admin,'src:'+secret.body.sha256,[h.bob.id]);
 // This capture was explicitly non-shareable: a generic share is not an ACL widening operation.
 assert.equal(await h.service.getRun(h.bob,rows[1].run),null);
 const shareable=await h.kit.artifacts.ingest({bytes:Buffer.from('合成可分享采集'),mediaType:'text/plain',origin:{upload:{session:null}},author:{user:h.alice.id},provenanceType:'declared',visibility:{readers:[h.alice.id],admins:true,packs:[],shareable:true}});
 const granted=RunRecord.parse({...rows[0],run:newId('run'),client_key:'synthetic-later-grant',sources:[{reference:'src:'+shareable.body.sha256,artifact:shareable.digest,role:'subject'}]});await putRun(h.kit.store,granted,new Date(granted.started_at).toISOString());await h.kit.authorizations.share(h.admin,granted.run,[h.bob.id]);
 assert.equal(await h.service.getRun(h.bob,granted.run),null);
 await h.kit.authorizations.share(h.admin,artifactShareKey(shareable),[h.bob.id]);assert.ok(await h.service.getRun(h.bob,granted.run),'a subsequent scope sees the new exact-capture grant');
 await h.kit.authorizations.unshare(h.admin,artifactShareKey(shareable),h.bob.id);assert.equal(await h.service.getRun(h.bob,granted.run),null,'subsequent scope rechecks source revocation');
 await withReadScope(async()=>{assert.equal((await h.service.listRuns(h.alice,{limit:20})).items.length,5);assert.equal(await h.service.getRun(h.bob,rows[1].run),null,'an owner read in the same scope never lends their private input to another reader');assert.equal((await h.service.listRuns(h.bob,{limit:20})).items.length,2);});
});

test('a run page retains off-page pending requests, answer state and pack filters while query batches stay bounded',async t=>{
 const h=await openHarness(postgres);t.after(h.close);const rows:Awaited<ReturnType<typeof putRun>>[]=[];
 const add=async(n:number)=>{const body=RunRecord.parse({...runRecord,run:newId('run'),runner:h.alice.id,pack:`${h.review.pack.id}@${h.review.pack.version}`,pack_digest:h.review.pack.digest,requirements:[],sources:[],items:[],target_basis:[],client_key:'synthetic-bounds-'+n});rows.push(await putRun(h.kit.store,body,new Date(body.started_at).toISOString()));};
 for(let n=0;n<42;n++)await add(n);
 const requests=createRequestService(h.kit,()=>new Date('2026-10-22T08:00:00.000Z'));
 const input={kind:'repair' as const,audience:h.alice.id,due:'2026-10-21T00:00:00.000Z',missing:'合成待回应事项',next_action:'提交完整修复',code:'not_covered'};
 const page=await h.service.listRuns(h.alice,{limit:4}),off=rows.find(r=>!page.items.some(run=>run.run===r.body.run))!;
 const pending=await requests.write({...input,run:off.body.run,source:off.digest});
 const answered=await requests.write({...input,run:rows[0].body.run,source:rows[0].digest,missing:'合成已回应事项'});await requests.answer(answered.digest,rows[1].digest);
 const other=RunRecord.parse({...off.body,run:newId('run'),client_key:'synthetic-other-pack',pack:`${h.verify.pack.id}@${h.verify.pack.version}`,pack_digest:h.verify.pack.digest});const otherRecord=await putRun(h.kit.store,other,new Date(other.started_at).toISOString());
 const different=await requests.write({...input,run:other.run,source:otherRecord.digest});
 const all=await h.service.listRuns(h.alice,{limit:4});assert.deepEqual(new Set(all.requests?.map(r=>r.record)),new Set([pending.digest,different.digest]));assert.deepEqual(all.overdue_requests?.map(r=>r.record),all.requests?.map(r=>r.record));
 const filtered=await h.service.listRuns(h.alice,{pack:h.review.pack.id,limit:4});assert.deepEqual(filtered.requests?.map(r=>r.record),[pending.digest]);assert.equal((await h.service.listRequests!(h.alice)).find(r=>r.record===answered.digest)?.answered_by,rows[1].digest);
 const original=Database.prototype.query;let calls=0;Database.prototype.query=(async function(this:Database,...args:Parameters<typeof original>){calls++;return original.apply(this,args);}) as typeof original;t.after(()=>{Database.prototype.query=original;});
 calls=0;await h.service.listRuns(h.alice,{limit:4});const small=calls;
 for(let n=42;n<142;n++)await add(n);
 calls=0;await h.service.listRuns(h.alice,{limit:4});assert.equal(calls,small,'additional off-page runs do not add per-run queries to the same readable page');
});

test('a listing that opts out of the request fields reads no request, however many exist',async t=>{
 const h=await openHarness(postgres);t.after(h.close);
 const body=RunRecord.parse({...runRecord,run:newId('run'),runner:h.alice.id,pack:`${h.review.pack.id}@${h.review.pack.version}`,pack_digest:h.review.pack.digest,requirements:[],sources:[],items:[],target_basis:[],client_key:'synthetic-no-request-fields'});
 const run=await putRun(h.kit.store,body,new Date(body.started_at).toISOString()),requests=createRequestService(h.kit);
 for(let n=0;n<3;n++)await requests.write({run:body.run,source:run.digest,kind:'repair',audience:h.alice.id,due:'2026-10-21T00:00:00.000Z',missing:'合成缺口'+n,next_action:'原样重交',code:'not_covered'});
 const original=Database.prototype.query;let scans=0;
 Database.prototype.query=(async function(this:Database,...args:Parameters<typeof original>){if(args[1]?.[0]==='request')scans++;return original.apply(this,args);}) as typeof original;t.after(()=>{Database.prototype.query=original;});
 const full=await h.service.listRuns(h.alice,{limit:4});
 assert.equal(full.requests?.length,3);assert.ok(scans>0,'the full listing reads the requests');
 scans=0;const plain=await h.service.listRuns(h.alice,{limit:4,requests:false});
 assert.equal(scans,0,'the opted-out listing reads none');
 assert.deepEqual(plain,{items:full.items,next:full.next});
 assert.equal((await h.service.listRequests!(h.alice,body.run)).length,3,'the listed run still names its own requests');
});

test('one request reuses the protected global request list across run pages, without lending it to another reader',async t=>{
 const h=await openHarness(postgres);t.after(h.close);
 const body=RunRecord.parse({...runRecord,run:newId('run'),runner:h.alice.id,pack:`${h.review.pack.id}@${h.review.pack.version}`,pack_digest:h.review.pack.digest,requirements:[],sources:[],items:[],target_basis:[],client_key:'synthetic-request-reuse'});
 const run=await putRun(h.kit.store,body,new Date(body.started_at).toISOString()),requests=createRequestService(h.kit);
 const record=await requests.write({run:body.run,source:run.digest,kind:'repair',audience:h.alice.id,due:'2026-10-21T00:00:00.000Z',missing:'合成缺口',next_action:'原样重交',code:'not_covered'});
 const original=Database.prototype.query;let calls=0;
 Database.prototype.query=(async function(this:Database,...args:Parameters<typeof original>){calls++;return original.apply(this,args);}) as typeof original;t.after(()=>{Database.prototype.query=original;});
 await withReadScope(async()=>{
  assert.equal((await h.service.listRuns(h.admin,{limit:1})).requests?.[0].record,record.digest);
  const before=calls;assert.equal((await h.service.listRequests!(h.admin))[0].record,record.digest);assert.equal(calls,before,'a second protected global listing adds no SQL');
  assert.deepEqual(await h.service.listRequests!(h.bob),[],'a different reader rechecks visibility in the same outer request');
 });
 await requests.answer(record.digest,run.digest);
 assert.equal((await h.service.listRequests!(h.admin))[0].answered_by,run.digest,'a fresh request observes an answer');
});

test('malformed sort headers do not disable readable run pages or repeat through cursors in native and fallback stores',async t=>{
 const h=await openHarness(postgres);t.after(h.close);const valid:RunRecord[]=[];
 for(let n=0;n<3;n++){const body=RunRecord.parse({...runRecord,run:newId('run'),runner:h.alice.id,pack:`${h.review.pack.id}@${h.review.pack.version}`,pack_digest:h.review.pack.digest,requirements:[],sources:[],items:[],target_basis:[],started_at:`2026-11-0${n+1}T08:00:00.000Z`,client_key:'synthetic-malformed-'+n});valid.push(body);await putRun(h.kit.store,body,body.started_at);}
 const malformed:Awaited<ReturnType<typeof h.kit.store.put>>[]=[];
 for(const changes of [{started_at:undefined},{run:undefined},{started_at:'not-a-date'},{run:'not-a-run'}]){
  const body={...valid[0],...changes};malformed.push(await h.kit.store.put({kind:'run',schema:'run@1',provenance:'declared',body:Object.fromEntries(Object.entries(body).filter(([,value])=>value!==undefined))}));
 }
 const native=h.kit.store.runCandidates;
 // Raw candidates are integrity checked; malformed business headers are diagnosed by the engine, not a store-wide failure.
 assert.ok((await native!.call(h.kit.store,{limit:20})).some(row=>row.digest===malformed[0].digest));
 for(const enabled of [true,false]){
  h.kit.store.runCandidates=enabled?native:undefined;
  for(const by of [h.admin,h.alice,h.bob]){
   const seen:string[]=[];let cursor:string|null=null;let pages=0;
   do{const page=await h.service.listRuns(by,{limit:1,cursor});seen.push(...page.items.map(run=>run.run));cursor=page.next;assert.ok(++pages<=4,'malformed candidates cannot repeat indefinitely');}while(cursor);
   assert.deepEqual(seen,by===h.bob?[]:valid.toReversed().map(run=>run.run));
  }
 }
 h.kit.store.runCandidates=native;
 for(const row of malformed)assert.ok(h.logs.some(log=>log.what==='list_runs'&&log.detail.includes(row.digest)),'each malformed record has an administrator diagnostic');
 const continued=await native!.call(h.kit.store,{after:[valid[0].started_at,valid[0].run],limit:20});
 assert.ok(continued.every(row=>row.body&&typeof(row.body as RunRecord).started_at==='string'&&typeof(row.body as RunRecord).run==='string'),'NULL headers do not bypass a cursor');
});
