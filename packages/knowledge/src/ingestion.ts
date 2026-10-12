import {ApiError,canonicalHash,newId,requireCondition,type AuthContext} from '../../contracts/src/index.ts';
import type {Store,Transaction} from '../../storage/src/index.ts';
import type {Tasks} from '../../tasks/src/index.ts';
import type {KnowledgeGraph} from './graph.ts';
import {ProductRecords} from './product-records.ts';
import type {ToolPackage,ConnectorProfile} from '../../connectors/src/tool-packages.ts';

export class Ingestions {
  store:Store;tasks:Tasks;graph:KnowledgeGraph;packages:ToolPackage[];
  constructor(store:Store,tasks:Tasks,graph:KnowledgeGraph,packages:ToolPackage[]){Object.assign(this,{store,tasks,graph,packages});this.store=store;this.tasks=tasks;this.graph=graph;this.packages=packages;}
  async enqueue(tx:Transaction,task:any,packageId:string,ruleVersion:string,profile:ConnectorProfile,sources:any[]):Promise<any>{
    const key=canonicalHash([task.tenantId,task.scopeId,task.principalId,packageId,ruleVersion,sources.map(source=>[source.sourceRecordId,source.generation]).sort()]);
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key]);
    const prior=(await tx.query('SELECT job_id,task_id,status FROM knowledge_projection_jobs WHERE job_key=$1',[key])).rows[0];if(prior)return {jobId:prior.job_id,taskId:prior.task_id,status:prior.status};
    const ctx={principalId:task.principalId,tenantId:task.tenantId,kind:'user'} as AuthContext,jobId=newId('rec');
    const accepted=await this.tasks.submit(ctx,{scopeId:task.scopeId,title:'Index retained source observations',capabilityPackId:'asset-index',idempotencyKey:key,input:{originTaskId:task.taskId,packageId,ruleVersion,sourceRecords:sources.map(source=>source.sourceRecordId)}},tx);
    await tx.query('UPDATE tasks SET context=$2 WHERE task_id=$1',[accepted.taskId,JSON.stringify({privateOwnerId:task.principalId})]);
    await tx.query('INSERT INTO knowledge_projection_jobs(job_id,job_key,task_id,origin_task_id,tenant_id,scope_id,owner_id,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[jobId,key,accepted.taskId,task.taskId,task.tenantId,task.scopeId,task.principalId,JSON.stringify({packageId,ruleVersion,profile,sources})]);
    await this.tasks.emit(tx,accepted.taskId,'knowledge.indexing.queued',{jobId,originTaskId:task.taskId});return {jobId,taskId:accepted.taskId,status:'queued'};
  }
  async runOnce():Promise<void>{
    const job=await this.store.transaction(async tx=>{
      const row=(await tx.query("SELECT * FROM knowledge_projection_jobs WHERE status='queued' OR status='running' AND lease_until<clock_timestamp() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];if(!row)return;
      const updated=(await tx.query("UPDATE knowledge_projection_jobs SET status='running',attempts=attempts+1,lease_until=clock_timestamp()+interval '5 minutes' WHERE job_id=$1 RETURNING *",[row.job_id])).rows[0];
      await this.tasks.stage(tx,await this.tasks.internal(tx,row.task_id),'running','source-index','knowledge.indexing.started',{jobId:row.job_id,attempt:updated.attempts});return updated;
    });if(!job)return;
    const ctx={principalId:job.owner_id,tenantId:job.tenant_id,kind:'user'} as AuthContext;
    try{
      const payload=job.payload,pack=this.packages.find(pack=>pack.id===payload.packageId);requireCondition(pack&&pack.projection&&pack.projection.version===payload.ruleVersion,'UNSUPPORTED_VERSION','Pinned source projector is not installed');
      const originals=[],references=new Map<string,any>(),pending=new Set<string>();
      for(const ref of payload.sources){const evidence=await this.graph.get(ctx,ref.evidenceId),source=await this.graph.get(ctx,ref.sourceRecordId);requireCondition(evidence.sha256===ref.sha256&&evidence.payload.sourceRecordId===source.recordId,'SOURCE_HASH_MISMATCH','Queued source evidence differs');
        const bytes=await this.graph.objects.objects.getObject({Bucket:'evidence',Key:ref.sha256});originals.push({path:evidence.payload.path,bytes,sha256:ref.sha256,mediaType:'application/octet-stream',etag:null,requestKey:ref.requestKey});references.set(evidence.payload.path,ref);
        const indexed=(await this.store.pool.query('SELECT generation FROM knowledge_indexed_sources WHERE source_id=$1 AND package_id=$2 AND rule_version=$3',[ref.sourceRecordId,payload.packageId,payload.ruleVersion])).rows[0];if(Number(indexed?.generation)!==ref.generation)pending.add(evidence.payload.path);
      }
      const observations=(await pack.projection!.extract(originals,payload.profile)).filter(observation=>pending.has(observation.sourcePath)),products=new ProductRecords(this.graph);
      for(let start=0;start<observations.length;start+=200)await this.store.transaction(async tx=>{
        await this.held(tx,job);const task=await this.tasks.internal(tx,job.task_id);const cancelled=(await tx.query('SELECT cancel_requested FROM tasks WHERE task_id=$1',[job.task_id])).rows[0].cancel_requested;requireCondition(!cancelled,'DECISION_CONFLICT','Index task cancellation requested');
        for(const ref of payload.sources)await this.graph.get(ctx,ref.sourceRecordId,tx);
        await products.importBatch(tx,ctx,job.scope_id,job.job_id,payload.ruleVersion,observations.slice(start,start+200),references);
        await tx.query('UPDATE knowledge_projection_jobs SET progress=$2,lease_until=clock_timestamp()+interval \'5 minutes\' WHERE job_id=$1',[job.job_id,Math.min(observations.length,start+200)]);
        await this.tasks.emit(tx,task.taskId,'knowledge.indexing.progress',{jobId:job.job_id,processed:Math.min(observations.length,start+200),total:observations.length});
      });
      await this.store.transaction(async tx=>{
        await this.held(tx,job);for(const ref of payload.sources){await this.graph.get(ctx,ref.sourceRecordId,tx);await tx.query('INSERT INTO knowledge_indexed_sources(source_id,package_id,rule_version,generation) VALUES($1,$2,$3,$4) ON CONFLICT(source_id,package_id,rule_version) DO UPDATE SET generation=EXCLUDED.generation',[ref.sourceRecordId,payload.packageId,payload.ruleVersion,ref.generation]);}
        await products.publishIncremental(tx,ctx,job.scope_id,job.job_id,payload.sources);
        await tx.query("UPDATE knowledge_projection_jobs SET status='succeeded',lease_until=NULL WHERE job_id=$1",[job.job_id]);const task=await this.tasks.internal(tx,job.task_id);
        await tx.query("UPDATE tasks SET result_status='succeeded',result=$2 WHERE task_id=$1",[task.taskId,JSON.stringify({jobId:job.job_id,indexed:observations.length,artifacts:[],evidence:[],unmapped:[]})]);await this.tasks.stage(tx,task,'delivered','done','knowledge.indexing.completed',{jobId:job.job_id,indexed:observations.length});
      });
    }catch(error){await this.store.transaction(async tx=>{await this.held(tx,job);const failure={code:error instanceof ApiError?error.code:'INTERNAL_ERROR',message:'Retained source indexing failed'};await tx.query("UPDATE knowledge_projection_jobs SET status='failed',error=$2,lease_until=NULL WHERE job_id=$1",[job.job_id,JSON.stringify(failure)]);await this.tasks.fail(tx,await this.tasks.internal(tx,job.task_id),failure);});}
  }
  async held(tx:Transaction,job:any):Promise<void>{const current=(await tx.query("SELECT 1 FROM knowledge_projection_jobs WHERE job_id=$1 AND status='running' AND attempts=$2 AND lease_until>clock_timestamp() FOR UPDATE",[job.job_id,job.attempts])).rowCount;requireCondition(current,'FENCING_STALE','Source indexing lease was replaced or expired');}
}
