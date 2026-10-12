import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sha256} from '../../packages/contracts/src/index.ts';
import {setup,type Harness} from './harness.ts';

async function grant(h:Harness){
  const grants=['knowledge.read','knowledge.ingest','knowledge.submit','knowledge.publish'];
  for(const id of ['prn_alice','prn_bob','prn_outsider','prn_limited'])await h.db.query('UPDATE policies SET grants=grants || $2::jsonb WHERE principal_id=$1',[id,JSON.stringify(grants)]);
  await h.db.query("UPDATE policies SET grants=grants || '[\"knowledge.review\"]'::jsonb WHERE principal_id='prn_bob'");
  await h.db.query("UPDATE policies SET grants=grants || '[\"admin.manage\"]'::jsonb WHERE principal_id='prn_alice'");
}
async function source(h:Harness,category='product',text='Feature alpha is available',revision='1',readers=['prn_alice','prn_bob']){
  const bytes=Buffer.from(text);
  return h.request('/v1/knowledge/sources',{scopeId:'scp_lab',sourceId:category==='product'?'fixture/manual':'fixture/session',revision,path:'/synthetic/manual.txt',knowledgeCategory:category,
    sourceType:category==='product'?'document':'shared-session',parserVersion:'fixture/1',contentBase64:bytes.toString('base64'),sha256:sha256(bytes),
    acl:{sourceReaders:readers,platformReaders:readers},...(category==='consolidated'?{sharing:{allowed:true,teamPromotion:true}}:{})});
}
async function claim(h:Harness,src:any,value:unknown='available'){
  const evidence=await h.request('/v1/knowledge/evidence',{sourceRecordId:src.recordId,start:0,end:src.payload.raw.size});
  const entity=await h.request('/v1/knowledge/entities',{sourceRecordId:src.recordId,subject:'feature-alpha',kind:'feature',name:'Feature alpha',aliases:['alpha'],attributes:{}});
  const candidate=await h.request('/v1/knowledge/claims',{scopeId:'scp_lab',subject:'feature-alpha',predicate:'availability',value,evidenceIds:[evidence.recordId],entityIds:[entity.recordId],origin:'model'});
  return {evidence,entity,candidate};
}
async function approve(h:Harness,candidate:any){
  await h.request(`/v1/knowledge/claims/${candidate.recordId}/request-review`,{reviewerId:'prn_bob'});
  const review=await h.request(`/v1/knowledge/reviews/${candidate.recordId}`,undefined,'bob');assert.equal(review.claim.recordId,candidate.recordId);
  return h.request(`/v1/knowledge/claims/${candidate.recordId}/review`,{decision:'approve',promote:true,reason:'Synthetic independent review',ruleVersion:'human-review/1'},'bob');
}

test('Act R2.3: six records pin product originals and an independently reviewed claim to a stable snapshot',async t=>{
  const h=await setup(t);await grant(h);const src=await source(h),{candidate,evidence,entity}=await claim(h,src);
  assert.equal(candidate.state,'candidate');await approve(h,candidate);
  const snapshot=await h.request('/v1/knowledge/snapshots',{scopeId:'scp_lab',knowledgeCategory:'product',expectedSnapshotId:null});
  assert.equal(snapshot.state,'published');assert.ok(snapshot.payload.records.some((r:any)=>r.recordId===candidate.recordId));
  assert.ok(snapshot.payload.records.some((r:any)=>r.recordId===evidence.recordId));assert.ok(snapshot.payload.records.some((r:any)=>r.recordId===entity.recordId));
  const kinds=new Set(snapshot.payload.records.map((r:any)=>r.kind));for(const kind of ['SourceRevision','Evidence','Entity','Claim','Assessment'])assert.ok(kinds.has(kind));
  assert.equal(snapshot.kind,'KnowledgeSnapshot');assert.equal(snapshot.sha256,sha256(snapshot.payload.canonicalManifest));
  const downloaded=await fetch(`${h.url}/v1/knowledge/records/${snapshot.recordId}/content`,{headers:{authorization:`Bearer ${await h.login()}`}});assert.equal(downloaded.status,200);assert.equal(sha256(Buffer.from(await downloaded.arrayBuffer())),snapshot.sha256);
  const found=await h.request('/v1/knowledge/search?mode=exact&q=feature-alpha');assert.equal(found.items.length,1);assert.equal(found.items[0].knowledgeCategory,'product');
  assert.equal(found.items[0].payload.evidenceIds[0],evidence.recordId);assert.equal(found.items[0].snapshotId,snapshot.recordId);
  await h.stop();await h.startServer();assert.equal((await h.request('/v1/knowledge/search?mode=exact&q=feature-alpha')).items[0].recordId,candidate.recordId);
});

test('Act R2.3: source ACL changes hide historical evidence snapshots and raw bytes from another principal',async t=>{
  const h=await setup(t);await grant(h);const src=await source(h),{candidate}=await claim(h,src);await approve(h,candidate);
  await h.request('/v1/knowledge/snapshots',{scopeId:'scp_lab',knowledgeCategory:'product',expectedSnapshotId:null});
  assert.equal((await h.request('/v1/knowledge/search?mode=prefix&q=feature',undefined,'bob')).items.length,1);
  await source(h,'product','Feature alpha changed','2',['prn_alice']);
  assert.equal((await h.request('/v1/knowledge/search?mode=prefix&q=feature',undefined,'bob')).items.length,0);
  await h.reject(`/v1/knowledge/records/${src.recordId}`,undefined,'SOURCE_FORBIDDEN','bob');
  await h.reject(`/v1/sources/${src.payload.raw.sourceRevisionId}/content`,undefined,'SOURCE_FORBIDDEN','bob');
  for(const user of ['outsider','limited']){assert.equal((await h.request('/v1/knowledge/search?mode=prefix&q=feature',undefined,user)).items.length,0);await h.reject(`/v1/knowledge/records/${candidate.recordId}`,undefined,'SOURCE_FORBIDDEN',user);}
});

test('Act R2.3: opted-in personal consolidation candidates stay out of snapshots and flag product conflicts',async t=>{
  const h=await setup(t);await grant(h);const product=await source(h),{candidate:official}=await claim(h,product);await approve(h,official);
  await h.request('/v1/knowledge/snapshots',{scopeId:'scp_lab',knowledgeCategory:'product',expectedSnapshotId:null});
  const personal=await source(h,'consolidated','A synthetic shared correction says alpha is unavailable'),{candidate}=await claim(h,personal,'unavailable');
  assert.equal(candidate.visibility,'personal');assert.equal(candidate.knowledgeCategory,'consolidated');
  const found=await h.request('/v1/knowledge/search?mode=prefix&q=feature&includeCandidates=true');
  assert.equal(found.items[0].knowledgeCategory,'product');assert.ok(found.items.some((r:any)=>r.recordId===candidate.recordId&&r.conflicts.some((c:any)=>c.recordId===official.recordId)));
  assert.ok(!(await h.request('/v1/knowledge/search?mode=prefix&q=feature&includeCandidates=true',undefined,'bob')).items.some((r:any)=>r.recordId===candidate.recordId));
  await h.reject(`/v1/knowledge/records/${candidate.recordId}`,undefined,'SOURCE_FORBIDDEN','bob');
  const snapshot=await h.request('/v1/knowledge/snapshots',{scopeId:'scp_lab',knowledgeCategory:'consolidated',expectedSnapshotId:null});assert.ok(!snapshot.payload.records.some((r:any)=>r.recordId===candidate.recordId));
  await approve(h,candidate);await h.request('/v1/knowledge/snapshots',{scopeId:'scp_lab',knowledgeCategory:'consolidated',expectedSnapshotId:snapshot.recordId});
  const promoted=await h.request('/v1/knowledge/search?mode=exact&q=feature-alpha',undefined,'bob');assert.equal(promoted.items.length,2);assert.equal(promoted.items[0].recordId,official.recordId);
  const current=await h.request(`/v1/knowledge/records/${official.recordId}`);assert.equal(current.payload.value,'available');
});

test('Act R2.3: evidence bytes consent content keys and snapshot compare-and-swap are enforced',async t=>{
  const h=await setup(t);await grant(h);const src=await source(h),same=await source(h);assert.equal(same.recordId,src.recordId);assert.equal(same.deduplicated,true);
  const altered={scopeId:'scp_lab',sourceId:'fixture/manual',revision:'1',path:'/synthetic/manual.txt',knowledgeCategory:'product',sourceType:'document',parserVersion:'fixture/1',contentBase64:Buffer.from('changed').toString('base64'),acl:{sourceReaders:['prn_alice'],platformReaders:['prn_alice']}};
  await h.reject('/v1/knowledge/sources',altered,'IDEMPOTENCY_MISMATCH');
  await h.reject('/v1/knowledge/evidence',{sourceRecordId:src.recordId,start:0,end:src.payload.raw.size+1},'INVALID_PAYLOAD');
  await h.reject('/v1/knowledge/evidence',{sourceRecordId:src.recordId,start:0,end:7,quoteBase64:Buffer.from('incorrect').toString('base64')},'SOURCE_HASH_MISMATCH');
  await h.reject('/v1/knowledge/sources',{...altered,sourceId:'unshared',revision:'1',knowledgeCategory:'consolidated',sourceType:'shared-session'},'SHARING_REQUIRED');
  const {candidate}=await claim(h,src);await h.reject(`/v1/knowledge/claims/${candidate.recordId}/review`,{decision:'approve',promote:true,reason:'self',ruleVersion:'human-review/1'},'SELF_APPROVAL');
  const a=await h.request('/v1/knowledge/snapshots',{scopeId:'scp_lab',knowledgeCategory:'product',expectedSnapshotId:null});
  await h.reject('/v1/knowledge/snapshots',{scopeId:'scp_lab',knowledgeCategory:'product',expectedSnapshotId:null},'INPUT_REVISION_STALE');
  const b=await h.request('/v1/knowledge/snapshots',{scopeId:'scp_lab',knowledgeCategory:'product',expectedSnapshotId:a.recordId});assert.equal(b.recordId,a.recordId);
});

test('Act R2.3: exact prefix directory and PostgreSQL full text retrieval use authorized published records',async t=>{
  const h=await setup(t);await grant(h);const src=await source(h,'product','Synthetic TLS feature alpha supports secure transport'),{candidate}=await claim(h,src);await approve(h,candidate);
  await h.request('/v1/knowledge/snapshots',{scopeId:'scp_lab',knowledgeCategory:'product',expectedSnapshotId:null});
  for(const query of ['mode=exact&q=feature-alpha','mode=prefix&q=feature','mode=directory&q=/synthetic/','mode=fulltext&q=transport'])assert.equal((await h.request(`/v1/knowledge/search?${query}`)).items.length,1);
  for(const query of ['limit=0','limit=101','limit=1.5'])await h.reject(`/v1/knowledge/search?${query}`,undefined,'INVALID_PAYLOAD');
});

test('Act R2.3: personal consolidation requires matching reviewed product evidence before automatic promotion',async t=>{
  const h=await setup(t);await grant(h);const product=await source(h),{candidate:official}=await claim(h,product);await approve(h,official);
  const personal=await source(h,'consolidated','Synthetic shared discovery agrees with the source'),{candidate}=await claim(h,personal);
  const verified=await h.request(`/v1/knowledge/claims/${candidate.recordId}/review`,{decision:'approve',promote:true,reason:'Exact fixed-source agreement',ruleVersion:'ignored-untrusted-rule',productClaimId:official.recordId});
  assert.equal(verified.assessment.payload.assessor,'script');assert.equal(verified.assessment.payload.questionVersion,'exact-reviewed-product-match/1');
  const another=await claim(h,personal,'different');await h.reject(`/v1/knowledge/claims/${another.candidate.recordId}/review`,{decision:'approve',promote:true,reason:'Incorrect comparison',ruleVersion:'fixture/1',productClaimId:official.recordId},'ARTIFACT_VERIFICATION_FAILED');
});
