import {z} from 'zod';
import {canonicalHash,canonicalJson,requireCondition,sha256,type AuthContext} from '../../contracts/src/index.ts';
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
  async import(tx:Transaction,ctx:AuthContext,scopeId:string,assetId:string,ruleVersion:string,values:ProductObservation[],returns:Map<string,{evidenceId:string;sha256:string}>):Promise<void>{
    const graph=this.graph;requireCondition(ruleVersion.length>0&&ruleVersion.length<=100,'INVALID_PAYLOAD','Projection version is required');
    for(const value of values){
      const observation=ProductObservation.parse(value),ref=returns.get(observation.sourcePath);requireCondition(ref,'EVIDENCE_INSUFFICIENT','Projection has no verified original');
      const evidence=await graph.row(ref.evidenceId,tx),source=evidence&&await graph.row(evidence.payload.sourceRecordId,tx);
      requireCondition(evidence?.sha256===ref.sha256&&source?.knowledge_category==='product'&&source.owner_id===ctx.principalId&&source.tenant_id===ctx.tenantId&&source.scope_id===scopeId,'SOURCE_HASH_MISMATCH','Projection source binding differs');
      const settings={category:'product',sourceType:source.source_type,visibility:'team',state:'observed'};
      const entityPayload={sourceRecordId:source.record_id,...observation.entity,aliases:[]};
      const entity=await graph.save(tx,ctx,'Entity',scopeId,canonicalHash([ruleVersion,entityPayload]),entityPayload,[source.record_id],settings);
      const payload={scopeId,subject:observation.entity.subject,predicate:observation.predicate,value:observation.value,conditions:{...observation.conditions,connectorAssetId:assetId},
        evidenceIds:[evidence.record_id],entityIds:[entity.recordId],origin:'script',sourcePaths:[observation.sourcePath],projectionVersion:ruleVersion};
      const claim=await graph.save(tx,ctx,'Claim',scopeId,canonicalHash([ctx.principalId,ruleVersion,payload]),payload,[evidence.record_id,entity.recordId],{...settings,state:'candidate',searchText:[payload.subject,payload.predicate,canonicalJson(payload.value)].join(' ')});
      const assessment={claimId:claim.recordId,assessor:'script',assessorId:ctx.principalId,questionVersion:ruleVersion,decision:'approve',reason:'Deterministic extraction of the observed source structure',checks:{originalSha256:'passed',references:'passed',semantic:'not-asserted'}};
      await graph.save(tx,ctx,'Assessment',scopeId,canonicalHash([claim.recordId,assessment]),assessment,[claim.recordId],{...settings,state:'recorded'});
      await tx.query("UPDATE knowledge_records SET state='reviewed' WHERE record_id=$1 AND state='candidate'",[claim.recordId]);
    }
    // An empty successful revision must also exclude its superseded observations.
    await this.publish(tx,ctx,scopeId);
  }
  async publish(tx:Transaction,ctx:AuthContext,scopeId:string):Promise<void>{
    const graph=this.graph;await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[canonicalJson(['stable',ctx.tenantId,scopeId,'product'])]);
    const claims=(await tx.query("SELECT * FROM knowledge_records WHERE tenant_id=$1 AND scope_id=$2 AND knowledge_category='product' AND kind='Claim' AND state='reviewed' AND visibility='team' ORDER BY created_at DESC,record_id DESC",[ctx.tenantId,scopeId])).rows;
    const records=new Map<string,any>(),currentStatements=new Set<string>();
    for(const claim of claims){
      const closure=await graph.closure(claim,tx);let current=true;
      for(const source of closure.filter(row=>row.kind==='SourceRevision'))if(!(await tx.query('SELECT 1 FROM knowledge_source_heads WHERE record_id=$1',[source.record_id])).rowCount){current=false;break;}
      if(!current)continue;
      const key=canonicalHash([claim.owner_id,claim.payload.subject,claim.payload.predicate,claim.payload.conditions]);if(currentStatements.has(key))continue;currentStatements.add(key);
      for(const member of closure)records.set(member.record_id,member);
      const assessments=(await tx.query("SELECT * FROM knowledge_records WHERE kind='Assessment' AND payload->>'claimId'=$1 ORDER BY record_id",[claim.record_id])).rows;
      for(const assessment of assessments)for(const member of await graph.closure(assessment,tx))records.set(member.record_id,member);
    }
    const members=[...records.values()].sort((a,b)=>a.record_id.localeCompare(b.record_id)).map(row=>({recordId:row.record_id,kind:row.kind,sha256:row.sha256,knowledgeCategory:row.knowledge_category,sourceType:row.source_type}));
    const canonicalManifest=canonicalJson({schemaVersion:'knowledge/1',knowledgeCategory:'product',records:members}),digest=sha256(canonicalManifest);
    const snapshot=await graph.save(tx,ctx,'KnowledgeSnapshot',scopeId,digest,{records:members,canonicalManifest,checks:{referenceClosure:'passed',candidateExclusion:'passed',semanticCompleteness:'not-asserted'}},members.map(row=>row.recordId),{category:'product',sourceType:'reviewed-records',visibility:'team',state:'published',digest});
    await tx.query(`INSERT INTO knowledge_stable(tenant_id,scope_id,knowledge_category,record_id) VALUES($1,$2,'product',$3)
      ON CONFLICT(tenant_id,scope_id,knowledge_category) DO UPDATE SET record_id=EXCLUDED.record_id`,[ctx.tenantId,scopeId,snapshot.recordId]);
  }
}
