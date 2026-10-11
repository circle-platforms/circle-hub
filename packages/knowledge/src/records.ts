import {canonicalHash,canonicalJson,newId,sha256,requireCondition,type AuthContext,type ConclusionKind,type Task} from '../../contracts/src/index.ts';
import type {Transaction} from '../../storage/src/index.ts';
import {Knowledge} from './index.ts';

export class Records extends Knowledge {
  async snapshot(tx:Transaction,ctx:AuthContext,scopeId:string,ids:string[]):Promise<any>{
    const sources=await Promise.all(ids.map(id=>this.source(ctx,id,scopeId,tx)));sources.sort((a,b)=>a.sourceRevisionId.localeCompare(b.sourceRevisionId));
    const digest=canonicalHash(sources),row=(await tx.query(`INSERT INTO knowledge_snapshots(snapshot_id,tenant_id,scope_id,sha256,sources)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,scope_id,sha256) DO UPDATE SET sha256=EXCLUDED.sha256 RETURNING *`,[newId('snap'),ctx.tenantId,scopeId,digest,JSON.stringify(sources)])).rows[0];
    return {snapshotId:row.snapshot_id,sha256:row.sha256,sources:row.sources};
  }
  async readEvidence(ctx:AuthContext,id:string,tx:Transaction):Promise<any>{
    const row=(await tx.query('SELECT * FROM evidence WHERE evidence_id=$1',[id])).rows[0];requireCondition(row,'TARGET_NOT_FOUND','Evidence not found');
    const policy=await this.auth.check(ctx,'evidence.read',row.scope_id,tx);requireCondition(policy.tenantId===row.tenant_id,'FORBIDDEN_SCOPE','Evidence belongs to another tenant');
    const bytes=await this.objects.getObject({Bucket:'evidence',Key:row.sha256});return {...row,content:JSON.parse(bytes.toString())};
  }
  async record(tx:Transaction,task:Task,kind:ConclusionKind,body:Record<string,unknown>):Promise<any>{
    const id=newId('rec'),evidenceId=newId('evd'),bytes=Buffer.from(canonicalJson({conclusionId:id,inputRevisionId:task.inputRevisionId,kind,body})),digest=sha256(bytes);
    await this.objects.putObject({Bucket:'evidence',Key:digest,Body:bytes});
    await tx.query(`INSERT INTO evidence(evidence_id,tenant_id,scope_id,task_id,input_revision_id,kind,sha256,size,object_key,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$7,$9)`,[evidenceId,task.tenantId,task.scopeId,task.taskId,task.inputRevisionId,kind,digest,bytes.length,JSON.stringify({recordId:id})]);
    await tx.query('INSERT INTO conclusions(conclusion_id,task_id,input_revision_id,kind,evidence_id,body) VALUES($1,$2,$3,$4,$5,$6)',[id,task.taskId,task.inputRevisionId,kind,evidenceId,JSON.stringify(body)]);
    return {conclusionId:id,inputRevisionId:task.inputRevisionId,kind,body,evidence:{evidenceId,kind,sha256:digest,size:bytes.length,downloadPath:`/v1/evidence/${evidenceId}/content`}};
  }
  async conclusion(ctx:AuthContext,taskId:string,id:string,tx:Transaction):Promise<any>{
    const row=(await tx.query('SELECT * FROM conclusions WHERE conclusion_id=$1 AND task_id=$2',[id,taskId])).rows[0];requireCondition(row,'TARGET_NOT_FOUND','Conclusion not found in this task');
    const evidence=await this.readEvidence(ctx,row.evidence_id,tx);
    requireCondition(evidence.content.conclusionId===id&&evidence.content.inputRevisionId===row.input_revision_id&&evidence.content.kind===row.kind&&canonicalHash(evidence.content.body)===canonicalHash(row.body),'SOURCE_HASH_MISMATCH','Conclusion metadata differs from its immutable evidence');
    return {conclusionId:id,inputRevisionId:row.input_revision_id,kind:row.kind,body:row.body,
      evidence:{evidenceId:row.evidence_id,kind:row.kind,sha256:evidence.sha256,size:Number(evidence.size),downloadPath:`/v1/evidence/${row.evidence_id}/content`}};
  }
  async reportArtifact(tx:Transaction,task:Task,content:unknown):Promise<any>{
    const bytes=Buffer.from(canonicalJson(content)),digest=sha256(bytes),key=canonicalHash({taskId:task.taskId,inputRevisionId:task.inputRevisionId,kind:'delivery-report'});
    await this.objects.putObject({Bucket:'evidence',Key:digest,Body:bytes});
    const row=(await tx.query(`INSERT INTO artifacts(artifact_id,tenant_id,scope_id,compilation_key,sha256,size,object_key,file_name,media_type,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$5,$7,'application/json','{}') ON CONFLICT(tenant_id,scope_id,compilation_key) DO UPDATE SET compilation_key=EXCLUDED.compilation_key RETURNING *`,
      [newId('art'),task.tenantId,task.scopeId,key,digest,bytes.length,`${task.taskId}-report.json`])).rows[0];
    await tx.query("INSERT INTO artifact_bindings(task_id,input_revision_id,artifact_id,role) VALUES($1,$2,$3,'delivery-report') ON CONFLICT DO NOTHING",[task.taskId,task.inputRevisionId,row.artifact_id]);return this.artifactReference(row);
  }
}
