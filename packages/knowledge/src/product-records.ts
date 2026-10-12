import {z} from 'zod';
import {canonicalHash,canonicalJson,newId,requireCondition,sha256,type AuthContext} from '../../contracts/src/index.ts';
import type {Transaction} from '../../storage/src/index.ts';
import type {KnowledgeGraph} from './graph.ts';

export const ProductObservation=z.object({sourcePath:z.string(),entity:z.object({subject:z.string().min(1).max(500),kind:z.string().min(1).max(100),name:z.string().min(1).max(500),attributes:z.record(z.string(),z.unknown())}),
  predicate:z.string().min(1).max(200),value:z.unknown(),conditions:z.record(z.string(),z.unknown()).default({})}).strict();
export type ProductObservation=z.infer<typeof ProductObservation>;

// Installed deterministic projectors supply observations from verified raw bytes.
// This sink never publishes a model/manual candidate as a program observation.
export class ProductRecords {
  graph:KnowledgeGraph;
  constructor(graph:KnowledgeGraph){this.graph=graph;}
  async batch(tx:Transaction,ctx:AuthContext,scopeId:string,kind:string,entries:{key:string;payload:any;refs:string[];sourceType:string;state:string;searchText?:string}[]):Promise<any[]>{
    if(!entries.length)return [];
    const rows=entries.map(entry=>({record_id:newId('knr'),kind,tenant_id:ctx.tenantId,scope_id:scopeId,owner_id:ctx.principalId,knowledge_category:'product',source_type:entry.sourceType,visibility:'team',state:entry.state,
      identity_key:entry.key,request_hash:canonicalHash({kind,payload:entry.payload,references:entry.refs,category:'product',sourceType:entry.sourceType}),sha256:canonicalHash(entry.payload),payload:entry.payload,reference_ids:entry.refs,search_text:entry.searchText??''}));
    await tx.query(`INSERT INTO knowledge_records(record_id,kind,tenant_id,scope_id,owner_id,knowledge_category,source_type,visibility,state,identity_key,request_hash,sha256,payload,reference_ids,search_text)
      SELECT record_id,kind,tenant_id,scope_id,owner_id,knowledge_category,source_type,visibility,state,identity_key,request_hash,sha256,payload,reference_ids,search_text
      FROM jsonb_to_recordset($1::jsonb) AS r(record_id text,kind text,tenant_id text,scope_id text,owner_id text,knowledge_category text,source_type text,visibility text,state text,identity_key text,request_hash text,sha256 text,payload jsonb,reference_ids text[],search_text text)
      ON CONFLICT(tenant_id,scope_id,kind,identity_key) DO NOTHING`,[JSON.stringify(rows)]);
    const saved=(await tx.query('SELECT * FROM knowledge_records WHERE tenant_id=$1 AND scope_id=$2 AND kind=$3 AND identity_key=ANY($4::text[])',[ctx.tenantId,scopeId,kind,rows.map(row=>row.identity_key)])).rows,map=new Map(saved.map(row=>[row.identity_key,row]));
    for(const row of rows)requireCondition(map.get(row.identity_key)?.request_hash===row.request_hash,'IDEMPOTENCY_MISMATCH','Source projection identity has different content');
    await tx.query(`INSERT INTO knowledge_references(record_id,reference_id) SELECT r.record_id,unnest(r.reference_ids) FROM knowledge_records r
      WHERE tenant_id=$1 AND scope_id=$2 AND kind=$3 AND identity_key=ANY($4::text[]) ON CONFLICT DO NOTHING`,[ctx.tenantId,scopeId,kind,rows.map(row=>row.identity_key)]);
    return rows.map(row=>map.get(row.identity_key));
  }
  async importBatch(tx:Transaction,ctx:AuthContext,scopeId:string,jobId:string,ruleVersion:string,values:ProductObservation[],returns:Map<string,any>):Promise<void>{
    const observations=values.map(value=>ProductObservation.parse(value)),sourceIds=[...new Set(observations.map(value=>returns.get(value.sourcePath)?.sourceRecordId))];
    const sources=(await tx.query("SELECT * FROM knowledge_records WHERE record_id=ANY($1::text[]) AND kind='SourceRevision' AND tenant_id=$2 AND scope_id=$3 AND owner_id=$4",[sourceIds,ctx.tenantId,scopeId,ctx.principalId])).rows,map=new Map(sources.map(source=>[source.record_id,source]));
    const items=observations.map(observation=>{const ref=returns.get(observation.sourcePath),source=map.get(ref?.sourceRecordId);requireCondition(source&&source.knowledge_category==='product','SOURCE_FORBIDDEN','Projection source exceeds its owner partition');return {observation,ref,source};});
    const entities=await this.batch(tx,ctx,scopeId,'Entity',items.map(({observation,source})=>{const payload={sourceRecordId:source.record_id,...observation.entity,aliases:[]};return {key:canonicalHash([ruleVersion,payload]),payload,refs:[source.record_id],sourceType:source.source_type,state:'observed'};}));
    const claims=await this.batch(tx,ctx,scopeId,'Claim',items.map(({observation,ref,source},index)=>{
      const payload={scopeId,subject:observation.entity.subject,predicate:observation.predicate,value:observation.value,conditions:{...observation.conditions,connectorAssetId:source.payload.asset.assetId},evidenceIds:[ref.evidenceId],entityIds:[entities[index].record_id],origin:'script',sourcePaths:[observation.sourcePath],projectionVersion:ruleVersion};
      return {key:canonicalHash([ctx.principalId,ruleVersion,payload]),payload,refs:[ref.evidenceId,entities[index].record_id],sourceType:source.source_type,state:'candidate',searchText:[payload.subject,payload.predicate,canonicalJson(payload.value)].join(' ')};
    }));
    const assessments=await this.batch(tx,ctx,scopeId,'Assessment',claims.map(claim=>{const payload={claimId:claim.record_id,assessor:'script',assessorId:ctx.principalId,questionVersion:ruleVersion,decision:'approve',reason:'Deterministic extraction of the observed source structure',checks:{originalSha256:'passed',references:'passed',semantic:'not-asserted'}};return {key:canonicalHash([claim.record_id,payload]),payload,refs:[claim.record_id],sourceType:claim.source_type,state:'recorded'};}));
    await tx.query("UPDATE knowledge_records SET state='reviewed' WHERE record_id=ANY($1::text[]) AND state='candidate'",[claims.map(claim=>claim.record_id)]);
    const members=claims.map((claim,index)=>({job_id:jobId,statement_key:canonicalHash([ctx.principalId,claim.payload.subject,claim.payload.predicate,claim.payload.conditions]),claim_id:claim.record_id,source_ids:[items[index].source.record_id],member_ids:[claim.record_id,entities[index].record_id,assessments[index].record_id,items[index].ref.evidenceId,items[index].source.record_id]}));
    await tx.query(`INSERT INTO knowledge_projection_members(job_id,statement_key,claim_id,source_ids,member_ids)
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS m(job_id text,statement_key text,claim_id text,source_ids text[],member_ids text[])
      ON CONFLICT(job_id,statement_key) DO UPDATE SET claim_id=EXCLUDED.claim_id,source_ids=EXCLUDED.source_ids,member_ids=EXCLUDED.member_ids`,[JSON.stringify(members)]);
    await this.graph.auth.audit(ctx,'knowledge.projected-batch',{ruleVersion,claims:claims.map(claim=>claim.record_id)},scopeId,tx);
  }
  async publishIncremental(tx:Transaction,ctx:AuthContext,scopeId:string,jobId:string,sources:any[]):Promise<void>{
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[canonicalJson(['stable',ctx.tenantId,scopeId,'product'])]);
    const obsolete=sources.map(source=>source.supersededSourceId).filter(Boolean);
    if(obsolete.length)await tx.query('DELETE FROM knowledge_active_statements WHERE tenant_id=$1 AND scope_id=$2 AND source_ids && $3::text[]',[ctx.tenantId,scopeId,obsolete]);
    // A newer projector may change statement identities for unchanged bytes.
    // Replace its full source projection, retaining unrelated/manual statements.
    if(sources.length)await tx.query(`DELETE FROM knowledge_active_statements a USING knowledge_records r
      WHERE a.claim_id=r.record_id AND a.tenant_id=$1 AND a.scope_id=$2 AND a.source_ids && $3::text[]
      AND r.payload->>'projectionVersion' IS NOT NULL`,[ctx.tenantId,scopeId,sources.map(source=>source.sourceRecordId)]);
    await tx.query(`INSERT INTO knowledge_active_statements(tenant_id,scope_id,statement_key,claim_id,source_ids,member_ids)
      SELECT $1,$2,m.statement_key,m.claim_id,m.source_ids,m.member_ids FROM knowledge_projection_members m WHERE m.job_id=$3
      AND EXISTS(SELECT 1 FROM knowledge_source_heads h WHERE h.record_id=m.source_ids[1])
      ON CONFLICT(tenant_id,scope_id,statement_key) DO UPDATE SET claim_id=EXCLUDED.claim_id,source_ids=EXCLUDED.source_ids,member_ids=EXCLUDED.member_ids`,[ctx.tenantId,scopeId,jobId]);
    const members=(await tx.query(`SELECT r.record_id AS "recordId",r.kind,r.sha256,r.knowledge_category AS "knowledgeCategory",r.source_type AS "sourceType"
      FROM knowledge_records r JOIN(SELECT DISTINCT unnest(member_ids) AS record_id FROM knowledge_active_statements WHERE tenant_id=$1 AND scope_id=$2) m USING(record_id) ORDER BY r.record_id`,[ctx.tenantId,scopeId])).rows;
    const canonicalManifest=canonicalJson({schemaVersion:'knowledge/1',knowledgeCategory:'product',records:members}),digest=sha256(canonicalManifest);
    const snapshot=await this.graph.save(tx,ctx,'KnowledgeSnapshot',scopeId,digest,{records:members,canonicalManifest,checks:{referenceClosure:'passed',candidateExclusion:'passed',semanticCompleteness:'not-asserted'}},members.map(row=>row.recordId),{category:'product',sourceType:'reviewed-records',visibility:'team',state:'published',digest});
    await tx.query(`INSERT INTO knowledge_stable(tenant_id,scope_id,knowledge_category,record_id) VALUES($1,$2,'product',$3) ON CONFLICT(tenant_id,scope_id,knowledge_category) DO UPDATE SET record_id=EXCLUDED.record_id`,[ctx.tenantId,scopeId,snapshot.recordId]);
  }
}
