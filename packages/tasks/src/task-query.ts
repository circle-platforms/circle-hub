import type {Auth} from './auth.ts';import type {AuthContext,TaskPageQuery} from '../../contracts/src/index.ts';import type {z} from 'zod';import type {Transaction} from '../../storage/src/index.ts';import type {FacetColumns} from '../../storage/src/faceted-query.ts';
export const taskColumns:FacetColumns={id:'t.task_id',created:'t.created_at',updated:'t.updated_at',scopeId:'t.scope_id',owner:'t.principal_id',productLineId:"t.context->>'productLineId'",flowVersion:'t.flow_version',status:'t.phase',lifecycle:'t.phase'};
const currentApproval="a.task_id=t.task_id AND a.input_revision_id=t.input_revision_id";
export const taskException=`CASE WHEN t.phase='unknown' THEN 'unknown'
 WHEN EXISTS(SELECT 1 FROM approvals a WHERE ${currentApproval} AND (a.status='expired' OR a.status='open' AND a.expires_at<=clock_timestamp())) THEN 'expired'
 WHEN EXISTS(SELECT 1 FROM pending_inputs i WHERE i.task_id=t.task_id AND i.input_revision_id=t.input_revision_id AND (i.status='expired' OR i.status='open' AND i.expires_at<=clock_timestamp())) THEN 'expired'
 WHEN EXISTS(SELECT 1 FROM approvals a WHERE ${currentApproval} AND a.status='superseded') THEN 'superseded'
 WHEN t.phase='failed' THEN 'failed' END`;
export type TaskQuery=z.infer<typeof TaskPageQuery>;
export async function taskQueryPlan(auth:Auth,ctx:AuthContext,query:TaskQuery,tx:Transaction){
 const p=await auth.check(ctx,'tasks.read',query.scopeId,tx),params:any[]=[p.tenantId,p.scopes,p.principalId,ctx.run?.taskId??null],bind=(value:any)=>{params.push(value);return `$${params.length}`;},clauses=["t.tenant_id=$1 AND t.scope_id=ANY($2::text[]) AND (t.context->>'privateOwnerId' IS NULL OR t.context->>'privateOwnerId'=$3) AND ($4::text IS NULL OR t.task_id=$4 OR t.context->>'parentRunTaskId'=$4)"];
 if(query.kind)clauses.push(`CASE t.capability_pack_id WHEN 'asset-tool' THEN 'tool' WHEN 'asset-index' THEN 'index' ELSE 'work' END=${bind(query.kind)}`);if(query.capabilityPackId)clauses.push(`t.capability_pack_id=${bind(query.capabilityPackId)}`);
 const active="t.phase NOT IN ('delivered','failed','cancelled')";let waiting='t.created_at';
 if(query.queue==='submittedByMe')clauses.push(`t.principal_id=$3 AND ${active}`);
 if(query.queue==='assignedToMe'){clauses.push(`t.assignee_principal_id=$3 AND ${active}`);waiting='COALESCE(t.assigned_at,t.created_at)';}
 if(query.queue==='awaitingMyInput'){clauses.push("t.principal_id=$3 AND EXISTS(SELECT 1 FROM pending_inputs i WHERE i.task_id=t.task_id AND i.input_revision_id=t.input_revision_id AND i.kind<>'approval' AND i.status='open' AND i.expires_at>clock_timestamp())");waiting="(SELECT min(i.created_at) FROM pending_inputs i WHERE i.task_id=t.task_id AND i.input_revision_id=t.input_revision_id AND i.kind<>'approval' AND i.status='open' AND i.expires_at>clock_timestamp())";}
 if(query.queue==='awaitingMyApproval'){
  const scopes:string[]=[],self:string[]=[];if(ctx.kind==='user'&&!ctx.run)for(const scope of p.scopes)if(p.scopeGrants?.[scope]?.includes('assets.approve')&&await auth.roles.role(ctx,scope,tx)==='admin'){scopes.push(scope);if((await auth.roles.eligibility(ctx,scope,ctx.principalId,tx)).eligible)self.push(scope);}
  clauses.push(`EXISTS(SELECT 1 FROM approvals a WHERE ${currentApproval} AND a.status='open' AND a.expires_at>clock_timestamp() AND t.scope_id=ANY(${bind(scopes)}::text[]) AND (a.applicant_id<>$3 OR t.scope_id=ANY(${bind(self)}::text[])))`);waiting=`(SELECT min(a.created_at) FROM approvals a WHERE ${currentApproval} AND a.status='open' AND a.expires_at>clock_timestamp())`;
 }
 if(query.queue==='exceptions'){clauses.push(`(${taskException}) IS NOT NULL`);waiting='t.updated_at';if(query.exception)clauses.push(`(${taskException})=${bind(query.exception)}`);}
 return {policy:p,from:'tasks t',visible:clauses.join(' AND '),params,columns:taskColumns,waiting};
}
