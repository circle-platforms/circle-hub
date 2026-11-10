import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {accepted,runRecord,RECOVERY,claim as fixtureClaim} from '../../../contracts/src/fixtures.ts';
import {ValidationResult} from '../../../contracts/src/validation.ts';
import {RunRecord} from '../../../contracts/src/run.ts';
import {newId,withReadScope,IntegrityError} from '../../records/api.ts';
import {runStatistics} from '../statistics.ts';
import {Database,createPool} from '../../records/db.ts';
import {startPostgres} from '../../testing/postgres.ts';
import {openHarness} from './testing/harness.ts';
import {putRun,putResult} from './store.ts';
let pg:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{pg=await startPostgres();});after(()=>pg?.stop());

test('compact statistics use verified current heads and preserve private grounds, revocation and unknowns',async t=>{
 const h=await openHarness(pg);t.after(h.close);
 const input=await h.kit.artifacts.ingest({bytes:Buffer.from('合成统计原件'),mediaType:'text/plain',origin:{read:{object:'synthetic:document:statistics'}},author:{user:null},provenanceType:'observed',visibility:{readers:[h.alice.id,h.bob.id],admins:true,packs:[],shareable:false}});
 const run=RunRecord.parse({...runRecord,run:newId('run'),runner:h.alice.id,pack:`${h.review.pack.id}@${h.review.pack.version}`,pack_digest:h.review.pack.digest,requirements:[],sources:[{reference:'src:'+input.body.sha256,artifact:input.digest,role:'subject'}],items:[],target_basis:[],client_key:'synthetic-statistics'});
 const stored=await putRun(h.kit.store,run,new Date(run.started_at).toISOString());
 const result=ValidationResult.parse({...accepted,run:run.run,submission:stored.digest,cross_item:[],partitions:{delivered:[{item:'synthetic-item',label:'合成未知',location:'src:'+input.body.sha256,requirements:[{requirement:'synthetic',status:'pending',claims:[],layers:[{layer:'static',terminal:'unchecked',reason:'check_error',...RECOVERY,exit:{...RECOVERY.exit,audience:{user:h.alice.id}}}]}]}],rejected:[],incomplete:[],quarantined:[]}});
 await putResult(h.kit.store,result,new Date(run.started_at).toISOString());await h.kit.authorizations.share(h.admin,run.run,[h.bob.id]);
 const compare=async()=>{for(const by of [h.alice,h.bob,h.admin])await withReadScope(async()=>{const full=await h.service.getRunSummary!(by,run.run),small=await h.service.getRunStatistics!(by,run.run);assert.ok(full&&small);assert.deepEqual(small,runStatistics(full));assert.ok(!JSON.stringify(small).includes(input.body.sha256));});};await compare();
 const secret=await h.kit.artifacts.ingest({bytes:Buffer.from('合成私人结论依据'),mediaType:'text/plain',origin:{upload:{session:null}},author:{user:h.alice.id},provenanceType:'declared',visibility:{readers:[h.alice.id],admins:false,packs:[],shareable:false}});const hidden=structuredClone(result);hidden.submission='a'.repeat(64);hidden.partitions.delivered[0].location='src:'+secret.body.sha256;await putResult(h.kit.store,hidden,new Date(run.started_at).toISOString());await compare();assert.equal((await h.service.getRunStatistics!(h.admin,run.run))!.result,'awaiting');
 await h.kit.authorizations.unshare(h.admin,run.run,h.bob.id);assert.equal(await h.service.getRunStatistics!(h.bob,run.run),null);assert.equal(await h.service.getRunStatistics!(h.admin,newId('run')),null);await h.kit.principals.setDisabled(h.admin,h.alice.id,true);assert.equal(await h.service.getRunStatistics!(h.alice,run.run),null);
});

test('statistics release their isolated record cache before returning to the page and still refuse corrupt stored bodies',async t=>{
 const h=await openHarness(pg);t.after(h.close);const run=RunRecord.parse({...runRecord,run:newId('run'),runner:h.alice.id,pack:`${h.review.pack.id}@${h.review.pack.version}`,pack_digest:h.review.pack.digest,requirements:[],sources:[],items:[],target_basis:[],client_key:'synthetic-retention'});const record=await putRun(h.kit.store,run,new Date(run.started_at).toISOString());
 const result=ValidationResult.parse({...accepted,run:run.run,submission:record.digest,cross_item:[],partitions:{delivered:[{item:'synthetic',label:'合成',location:'src:'+'a'.repeat(64),requirements:[{requirement:'synthetic',status:'satisfied',claims:[fixtureClaim],layers:[{layer:'static',terminal:'pass'}]}]}],rejected:[],incomplete:[],quarantined:[]}});const claim=result.partitions.delivered[0].requirements[0].claims[0];assert.ok(claim);claim.statement.text='synthetic large statement '.repeat(50000);const written=await putResult(h.kit.store,result,new Date(run.started_at).toISOString());
 const database=new Database(createPool(h.kit.database,1));t.after(()=>database.end());
 const findBatch=h.kit.store.findBatch!.bind(h.kit.store);let batches=0;h.kit.store.findBatch=async(...args)=>{batches++;return findBatch(...args);};
 await withReadScope(async()=>{const small=await h.service.getRunStatistics!(h.alice,run.run);assert.ok(small);assert.ok(JSON.stringify(small).length<2048);const first=batches;await h.service.getRunStatistics!(h.alice,run.run);assert.ok(batches>first,'each summary owns and releases its full verified-record cache rather than borrowing a page cache');});
 const corrupt=async(sql:string)=>{await database.transaction(async tx=>{await database.query("SET LOCAL session_replication_role='replica'",[],tx);await database.query(sql,[written.digest],tx);});};
 await corrupt("UPDATE records SET body=body || ' ' WHERE digest=$1");assert.deepEqual(await h.service.getRunStatistics!(h.alice,run.run),runStatistics({run:{...run,requirements:[]},latest:{record:written.digest,result},production:null}),'canonical-equivalent whitespace stays readable');
 await corrupt("UPDATE records SET body=replace(body,'synthetic large statement','synthetic altered statement') WHERE digest=$1");await assert.rejects(h.service.getRunStatistics!(h.alice,run.run),IntegrityError);
});
