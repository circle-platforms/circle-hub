import {ApiError,requireCondition,type AuthContext,type RegistryPageQuery} from '../../contracts/src/index.ts';
import {facetedPage} from '../../storage/src/faceted-query.ts';
import type {Transaction} from '../../storage/src/index.ts';
import type {Knowledge} from './index.ts';
import type {KnowledgeGraph} from './graph.ts';

type Collection='sources'|'evidence'|'artifacts';
type Metadata=Record<string,any>;
const accessDenied=new Set(['FORBIDDEN_ACTION','FORBIDDEN_SCOPE','SOURCE_FORBIDDEN','OBJECT_NOT_VISIBLE','ASSET_NOT_VISIBLE']);
// Authorization operates on metadata in one snapshot. Original bytes are never
// fetched for listing, and count/keyset limiting only see authorized identifiers.
export class KnowledgeRegistryPages{
 knowledge:Knowledge;graph:KnowledgeGraph;
 constructor(knowledge:Knowledge,graph:KnowledgeGraph){this.knowledge=knowledge;this.graph=graph;}
 async permitted(check:()=>Promise<unknown>){try{await check();return true;}catch(error){if(error instanceof ApiError&&accessDenied.has(error.code))return false;throw error;}}
 async authority(ctx:AuthContext,grant:string,scope:string|undefined,tx:Transaction){const policy=await this.knowledge.auth.policy(ctx,tx);if(scope)requireCondition(policy.scopes.includes(scope),'FORBIDDEN_SCOPE','Scope is outside the authenticated principal policy');return {...policy,scopes:policy.scopes.filter(id=>(!scope||id===scope)&&policy.scopeGrants?.[id]?.includes(grant))};}
 taskReadable(ctx:AuthContext,task:Metadata){return (!task.context?.privateOwnerId||task.context.privateOwnerId===ctx.principalId)&&(!ctx.run||task.task_id===ctx.run.taskId||task.context?.parentRunTaskId===ctx.run.taskId);}
 async authorizedRows(ctx:AuthContext,kind:Collection|'knowledge'|'control',tx:Transaction,scope?:string):Promise<Metadata[]>{
  const grant=kind==='sources'?'sources.read':kind==='knowledge'?'knowledge.read':kind==='control'?'tasks.read':'evidence.read',p=await this.authority(ctx,grant,scope,tx);
  if(!p.scopes.length)return [];
  if(kind==='sources'){
   const candidates=(await tx.query('SELECT s.* FROM sources s WHERE s.tenant_id=$1 AND s.scope_id=ANY($2::text[])',[p.tenantId,p.scopes])).rows,rows=[];
   for(const row of candidates)if(await this.permitted(()=>this.knowledge.sourceAccess?.(ctx,row.source_revision_id,tx)??Promise.resolve()))rows.push(row);return rows;
  }
  if(kind==='evidence')return (await tx.query(`SELECT e.*,t.principal_id AS owner_id FROM evidence e JOIN tasks t USING(task_id)
   WHERE e.tenant_id=$1 AND e.scope_id=ANY($2::text[]) AND (t.context->>'privateOwnerId' IS NULL OR t.context->>'privateOwnerId'=$3)
   AND ($4::text IS NULL OR t.task_id=$4 OR t.context->>'parentRunTaskId'=$4)`,[p.tenantId,p.scopes,p.principalId,ctx.run?.taskId??null])).rows;
  if(kind==='artifacts'){
   const candidates=(await tx.query('SELECT a.* FROM artifacts a WHERE a.tenant_id=$1 AND a.scope_id=ANY($2::text[])',[p.tenantId,p.scopes])).rows;
   const tasks=(await tx.query(`SELECT b.artifact_id,t.task_id,t.principal_id,t.context FROM artifact_bindings b JOIN tasks t USING(task_id)
    JOIN artifacts a USING(artifact_id) WHERE a.tenant_id=$1 AND a.scope_id=ANY($2::text[])`,[p.tenantId,p.scopes])).rows,bindings=new Map<string,Metadata[]>();
   for(const task of tasks){const list=bindings.get(task.artifact_id)??[];list.push(task);bindings.set(task.artifact_id,list);}
   return candidates.filter(row=>{const bound=bindings.get(row.artifact_id)??[],readable=bound.filter(task=>this.taskReadable(ctx,task));if(bound.length&&!readable.length)return false;row.readable_owners=[...new Set(readable.map(task=>task.principal_id))];return true;});
  }
  if(kind==='knowledge'){
   const candidates=(await tx.query("SELECT r.* FROM knowledge_records r WHERE r.tenant_id=$1 AND r.scope_id=ANY($2::text[]) AND r.kind IN ('SourceRevision','Evidence')",[p.tenantId,p.scopes])).rows,rows=[];
   for(const row of candidates)if(await this.graph.visible(ctx,row,tx))rows.push(row);return rows;
  }
  return (await tx.query('SELECT evidence_id,tenant_id,scope_id,principal_id,sha256,created_at FROM mcp_control_receipts WHERE tenant_id=$1 AND scope_id=ANY($2::text[]) AND principal_id=$3',[p.tenantId,p.scopes,p.principalId])).rows;
 }
 async page(ctx:AuthContext,kind:Collection,query:RegistryPageQuery){return this.knowledge.store.transaction(async tx=>{
  await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');const rows=await this.authorizedRows(ctx,kind,tx,query.scopeId),column=kind==='sources'?'source_revision_id':kind==='evidence'?'evidence_id':'artifact_id',ids=rows.filter(row=>kind!=='artifacts'||!query.owner||row.readable_owners.includes(query.owner)).map(row=>row[column]);
  const owner=kind==='sources'?'r.principal_id':kind==='evidence'?'t.principal_id':undefined,from=kind==='evidence'?'evidence r JOIN tasks t USING(task_id)':`${kind} r`;
  // Artifact owner is a readable binding applicant, never a hidden binding's
  // applicant. The authorized id set already applies that many-to-many facet.
  const pageQuery=kind==='artifacts'&&query.owner?Object.fromEntries(Object.entries(query).filter(([key])=>key!=='owner')) as RegistryPageQuery:query;
  return facetedPage(tx,ctx,`knowledge:${kind}:${query.owner??''}`,pageQuery,from,`r.${column}=ANY($1::text[])`,[ids],{id:`r.${column}`,created:'r.created_at',updated:'r.created_at',scopeId:'r.scope_id',...(owner?{owner}:{})},'r.*',row=>kind==='sources'?{...this.knowledge.sourceReference(row),downloadPath:`/v1/sources/${row.source_revision_id}/content`}:kind==='artifacts'?this.knowledge.artifactReference(row):{evidenceId:row.evidence_id,kind:row.kind,taskId:row.task_id,inputRevisionId:row.input_revision_id,sha256:row.sha256,size:Number(row.size),downloadPath:`/v1/evidence/${row.evidence_id}/content`});
 });}
 async resources(ctx:AuthContext,query:RegistryPageQuery){return this.knowledge.store.transaction(async tx=>{
  await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');const allowed:{id:string;kind:string;owners:string[]}[]=[];
  for(const kind of ['sources','evidence','artifacts','knowledge','control'] as const){for(const row of await this.authorizedRows(ctx,kind,tx,query.scopeId))allowed.push({id:kind==='sources'?row.source_revision_id:kind==='evidence'||kind==='control'?row.evidence_id:kind==='artifacts'?row.artifact_id:row.record_id,kind,owners:kind==='artifacts'?row.readable_owners:[kind==='sources'||kind==='control'?row.principal_id:row.owner_id]});}
  const ids=allowed.filter(row=>!query.owner||row.owners.includes(query.owner)).map(row=>row.id),pageQuery=query.owner?Object.fromEntries(Object.entries(query).filter(([key])=>key!=='owner')) as RegistryPageQuery:query;
  const from=`(SELECT s.source_revision_id AS id,'sources' AS origin,'source' AS kind,s.scope_id,s.principal_id AS owner_id,s.sha256,'application/octet-stream' AS media_type,s.created_at FROM sources s
   UNION ALL SELECT e.evidence_id,'evidence','evidence',e.scope_id,t.principal_id,e.sha256,'application/json',e.created_at FROM evidence e JOIN tasks t USING(task_id)
   UNION ALL SELECT a.artifact_id,'artifacts','artifact',a.scope_id,NULL,a.sha256,a.media_type,a.created_at FROM artifacts a
   UNION ALL SELECT r.record_id,'knowledge',CASE r.kind WHEN 'Evidence' THEN 'evidence' ELSE 'source' END,r.scope_id,r.owner_id,r.sha256,'application/octet-stream',r.created_at FROM knowledge_records r WHERE r.kind IN ('SourceRevision','Evidence')
   UNION ALL SELECT c.evidence_id,'control','evidence',c.scope_id,c.principal_id,c.sha256,'application/json',c.created_at FROM mcp_control_receipts c) r`;
  return facetedPage(tx,ctx,`knowledge:resources:${query.owner??''}`,pageQuery,from,'r.id=ANY($1::text[])',[ids],{id:'r.id',created:'r.created_at',updated:'r.created_at',scopeId:'r.scope_id'},'r.*',row=>({uri:`hub://${row.kind}/${row.id}`,id:row.id,origin:row.origin,sha256:row.sha256,mediaType:row.media_type}));
 });}
}
