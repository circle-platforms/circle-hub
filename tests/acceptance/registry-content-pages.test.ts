import assert from 'node:assert/strict';
import {test} from 'node:test';
import {canonicalJson,newId,sha256} from '../../packages/contracts/src/index.ts';
import {LocalObjects} from '../../packages/knowledge/src/objects.ts';
import {setup,type Harness} from './harness.ts';

async function source(h:Harness,text:string,scopeId='scp_lab'){
 return h.request('/v1/sources',{scopeId,fileName:'synthetic-original.txt',contentBase64:Buffer.from(text).toString('base64')});
}
async function waiting(h:Harness,privateTask=false){
 const task=privateTask?await h.request('/v1/tasks/submit',{scopeId:'scp_lab',capabilityPackId:'skill-run',input:{requiredFields:['payload']},idempotencyKey:newId('task')}):await h.submit({requiredFields:['target']});
 await h.phase(task.taskId,'waiting-input');return task;
}
async function evidence(h:Harness,task:any,label:string){
 const bytes=Buffer.from(canonicalJson({label})),digest=sha256(bytes),id=newId('evd');await new LocalObjects(h.scratch+'/objects').putObject({Bucket:'evidence',Key:digest,Body:bytes});
 await h.db.query('INSERT INTO evidence(evidence_id,tenant_id,scope_id,task_id,input_revision_id,operation_id,kind,sha256,size,object_key,metadata) VALUES($1,$2,$3,$4,$5,NULL,$6,$7,$8,$7,$9)',[id,'tnt_lab','scp_lab',task.taskId,task.inputRevisionId,label,digest,bytes.length,JSON.stringify({fixture:'synthetic'})]);return id;
}
async function artifact(h:Harness,tasks:any[],label:string){
 const bytes=Buffer.from(label),digest=sha256(bytes),id=newId('art');await new LocalObjects(h.scratch+'/objects').putObject({Bucket:'evidence',Key:digest,Body:bytes});
 await h.db.query('INSERT INTO artifacts(artifact_id,tenant_id,scope_id,compilation_key,sha256,size,object_key,file_name,media_type,metadata) VALUES($1,$2,$3,$4,$5,$6,$5,$7,$8,$9)',[id,'tnt_lab','scp_lab',label,digest,bytes.length,'synthetic-output.txt','text/plain',JSON.stringify({fixture:'synthetic'})]);
 for(const task of tasks)await h.db.query('INSERT INTO artifact_bindings(task_id,input_revision_id,artifact_id,role) VALUES($1,$2,$3,$4)',[task.taskId,task.inputRevisionId,id,label]);return id;
}
const query='view=page&scopeId=scp_lab&sort=age&order=asc&limit=1';

test('Registry content pages: source totals and keysets apply scope and caller bindings before limits',async t=>{
 const h=await setup(t),one=await source(h,'synthetic-source-one'),two=await source(h,'synthetic-source-two');await source(h,'synthetic-other-scope','scp_second');
 const first=await h.request('/v1/sources?'+query);assert.equal(first.total,2);assert.equal(first.items.length,1);assert.ok(first.cursor);assert.ok([one.sourceRevisionId,two.sourceRevisionId].includes(first.items[0].sourceRevisionId));
 const next=await h.request('/v1/sources?'+query+'&cursor='+encodeURIComponent(first.cursor));assert.equal(next.total,2);assert.equal(next.items.length,1);assert.notEqual(first.items[0].sourceRevisionId,next.items[0].sourceRevisionId);assert.equal(next.cursor,null);
 await h.reject('/v1/sources?'+query+'&cursor='+encodeURIComponent(first.cursor),undefined,'INVALID_PAYLOAD','bob');await h.reject('/v1/sources?view=page&limit=101',undefined,'INVALID_PAYLOAD');await h.reject('/v1/sources?view=page&scopeId=scp_hidden',undefined,'FORBIDDEN_SCOPE');assert.deepEqual((await h.request('/v1/sources?view=page',undefined,'outsider')).items,[]);
});

test('Registry content pages: sources obey current knowledge ACLs without exposing hidden names or counts',async t=>{
 const h=await setup(t),bytes=Buffer.from('synthetic-product-source'),base={scopeId:'scp_lab',sourceId:'synthetic/manual',path:'/synthetic/manual.txt',knowledgeCategory:'product',sourceType:'document',parserVersion:'fixture/1',acl:{sourceReaders:['prn_alice','prn_bob'],platformReaders:['prn_alice','prn_bob']}};
 const old=await h.request('/v1/knowledge/sources',{...base,revision:'1',contentBase64:bytes.toString('base64')});assert.equal((await h.request('/v1/sources?view=page',undefined,'bob')).total,1);
 await h.request('/v1/knowledge/sources',{...base,revision:'2',contentBase64:Buffer.from('synthetic-private-source').toString('base64'),acl:{sourceReaders:['prn_alice'],platformReaders:['prn_alice']}});
 assert.equal((await h.request('/v1/sources?view=page',undefined,'bob')).total,0);await h.reject(`/v1/sources/${old.payload.raw.sourceRevisionId}/content`,undefined,'SOURCE_FORBIDDEN','bob');assert.equal((await h.request('/v1/sources?view=page')).total,2);
});

test('Registry content pages: evidence and artifact pages inherit private task visibility and avoid duplicate bindings',async t=>{
 const h=await setup(t),publicOne=await waiting(h),publicTwo=await waiting(h),personal=await waiting(h,true),publicEvidence=await evidence(h,publicOne,'synthetic-public'),privateEvidence=await evidence(h,personal,'synthetic-private'),shared=await artifact(h,[publicOne,publicTwo,personal],'synthetic-shared-artifact'),privateArtifact=await artifact(h,[personal],'synthetic-private-artifact');
 const ownEvidence=await h.request('/v1/evidence?view=page');assert.equal(ownEvidence.total,2);assert.equal((await h.request('/v1/evidence?view=page',undefined,'bob')).total,1);assert.equal((await h.request('/v1/evidence?view=page',undefined,'bob')).items[0].evidenceId,publicEvidence);await h.reject(`/v1/evidence/${privateEvidence}/content`,undefined,'FORBIDDEN_SCOPE','bob');
 const ownArtifacts=await h.request('/v1/artifacts?view=page');assert.equal(ownArtifacts.total,2);const visible=await h.request('/v1/artifacts?view=page',undefined,'bob');assert.equal(visible.total,1);assert.equal(visible.items[0].artifactId,shared);await h.reject(`/v1/artifacts/${privateArtifact}/content`,undefined,'FORBIDDEN_SCOPE','bob');
 for(const path of ['/v1/evidence','/v1/artifacts']){assert.equal((await h.request(path+'?view=page&owner=prn_alice',undefined,'bob')).total,1);await h.reject(path+'?view=page&productLineId=imaginary',undefined,'INVALID_PAYLOAD');assert.equal((await h.request(path+'?view=page',undefined,'outsider')).total,0);}
});

test('Registry content pages: sources inherit historical and current enterprise observation readers',async t=>{
 const h=await setup(t),raw=await source(h,'synthetic-enterprise-original'),entity=newId('ent'),revision=newId('erev');
 await h.db.query('INSERT INTO entities(entity_id,tenant_id,scope_id,source_system,source_type,external_id) VALUES($1,$2,$3,$4,$5,$6)',[entity,'tnt_lab','scp_lab','synthetic','document','fixture-object']);
 await h.db.query('INSERT INTO entity_observations(entity_revision_id,entity_id,observation_key,request_hash,type_package_id,type_package_version,type_id,source_revision,source_revision_id,attributes,source_readers,platform_readers,observer_id,origin) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',[revision,entity,'fixture-observation','a'.repeat(64),'fixture','1.0.0','document','1',raw.sourceRevisionId,'{}',JSON.stringify(['prn_alice']),JSON.stringify(['prn_alice']),'prn_alice','manual-observation']);await h.db.query('UPDATE entities SET current_revision_id=$2 WHERE entity_id=$1',[entity,revision]);
 assert.equal((await h.request('/v1/sources?view=page',undefined,'bob')).total,0);assert.equal((await h.request('/v1/sources?view=page')).total,1);await h.reject(`/v1/sources/${raw.sourceRevisionId}/content`,undefined,'OBJECT_NOT_VISIBLE','bob');
});

test('Registry content pages: shared metadata authority limits run partitions and knowledge or control access without reading original bytes',async t=>{
 const h=await setup(t),current=await waiting(h),child=await waiting(h),unrelated=await waiting(h);await h.db.query('UPDATE tasks SET context=$2 WHERE task_id=$1',[child.taskId,JSON.stringify({parentRunTaskId:current.taskId})]);
 const currentEvidence=await evidence(h,current,'synthetic-run-current'),childEvidence=await evidence(h,child,'synthetic-run-child'),otherEvidence=await evidence(h,unrelated,'synthetic-run-unrelated'),currentArtifact=await artifact(h,[current],'synthetic-run-current-artifact'),childArtifact=await artifact(h,[child],'synthetic-run-child-artifact');await artifact(h,[unrelated],'synthetic-run-unrelated-artifact');
 const sourceRecord=await h.request('/v1/knowledge/sources',{scopeId:'scp_lab',sourceId:'synthetic/run-manual',revision:'1',path:'/synthetic/run-manual.txt',knowledgeCategory:'product',sourceType:'document',parserVersion:'fixture/1',contentBase64:Buffer.from('synthetic-knowledge-resource').toString('base64'),acl:{sourceReaders:['prn_alice'],platformReaders:['prn_alice']}}),controlId=newId('mcr');
 await h.db.query('INSERT INTO mcp_control_receipts(tenant_id,principal_id,scope_id,name,idempotency_key,args_digest,result,evidence_id,sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$6)',['tnt_lab','prn_alice','scp_lab','hub.synthetic_read','synthetic-list-control','a'.repeat(64),'{}',controlId]);
 const [{Store},{Auth},{Knowledge},{KnowledgeGraph},{KnowledgeRegistryPages},{RegistryPageQuery}]=await Promise.all([import('../../packages/storage/src/index.ts'),import('../../packages/tasks/src/auth.ts'),import('../../packages/knowledge/src/index.ts'),import('../../packages/knowledge/src/graph.ts'),import('../../packages/knowledge/src/registry-pages.ts'),import('../../packages/contracts/src/index.ts')]);
 const store=Object.create(Store.prototype) as InstanceType<typeof Store>;store.pool=h.db;let reads=0;const objects={async putObject(){throw new Error('Listing must not store original bytes');},async getObject(){reads++;throw new Error('Listing must not read original bytes');}},auth=new Auth(store),knowledge=new Knowledge(store,auth,objects),graph=new KnowledgeGraph(store,auth,knowledge);knowledge.sourceAccess=(ctx,id,tx)=>graph.checkSourceAccess(ctx,id,tx);
 const registry=new KnowledgeRegistryPages(knowledge,graph),run={principalId:'prn_alice',tenantId:'tnt_lab',kind:'user' as const,run:{taskId:current.taskId,tools:[],scopes:['scp_lab'],grants:['sources.read','evidence.read','tasks.read']}},query=RegistryPageQuery.parse({view:'page',limit:100});
 const evd=await registry.page(run,'evidence',query);assert.equal(evd.total,2);assert.deepEqual(new Set(evd.items.map(item=>item.evidenceId)),new Set([currentEvidence,childEvidence]));assert.ok(!evd.items.some(item=>item.evidenceId===otherEvidence));const art=await registry.page(run,'artifacts',query);assert.equal(art.total,2);assert.deepEqual(new Set(art.items.map(item=>item.artifactId)),new Set([currentArtifact,childArtifact]));
 const runResources=await registry.resources(run,query);assert.ok(!runResources.items.some(item=>item.id===sourceRecord.recordId));assert.ok(runResources.items.some(item=>item.id===controlId));assert.ok(!runResources.items.some(item=>item.id===otherEvidence));
 const own=await registry.resources({principalId:'prn_alice',tenantId:'tnt_lab',kind:'user'},query);assert.ok(own.items.some(item=>item.id===sourceRecord.recordId));assert.ok(own.items.some(item=>item.id===controlId));const other=await registry.resources({principalId:'prn_bob',tenantId:'tnt_lab',kind:'user'},query);assert.ok(!other.items.some(item=>item.id===sourceRecord.recordId));assert.ok(!other.items.some(item=>item.id===controlId));assert.equal(reads,0);
});
