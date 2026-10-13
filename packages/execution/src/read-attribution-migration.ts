import type {Migration} from '../../storage/src/index.ts';
export const readAttributionMigration:Migration={version:38,name:'Make historical multi-read task results and audit links deterministic',sql:`
CREATE TEMP TABLE deterministic_read_results ON COMMIT DROP AS
 SELECT t.task_id,t.tenant_id,t.scope_id,t.input_revision_id,array_agg(DISTINCT o.operation_id ORDER BY o.operation_id) AS operation_ids
 FROM tasks t JOIN operations o ON o.task_id=t.task_id AND o.input_revision_id=t.input_revision_id
 WHERE t.phase='failed' AND t.result->'error'->>'code'='UPSTREAM_TIMEOUT' AND o.source_effect='read' AND o.status='failed'
 AND EXISTS(SELECT 1 FROM audit a WHERE a.action='operation.read-unknown-released' AND a.detail->>'migration'='36' AND a.detail->>'operationId'=o.operation_id)
 AND NOT EXISTS(SELECT 1 FROM operations w WHERE w.task_id=t.task_id AND w.input_revision_id=t.input_revision_id AND w.source_effect='write' AND w.status='unknown')
 GROUP BY t.task_id,t.tenant_id,t.scope_id,t.input_revision_id HAVING count(DISTINCT o.operation_id)>1;
UPDATE tasks t SET result=jsonb_build_object('error',jsonb_build_object('code','UPSTREAM_TIMEOUT','message','Read authority expired; retry the query','details',jsonb_build_object('sideEffects','none','operationIds',d.operation_ids))),updated_at=clock_timestamp()
 FROM deterministic_read_results d WHERE t.task_id=d.task_id AND t.result IS DISTINCT FROM jsonb_build_object('error',jsonb_build_object('code','UPSTREAM_TIMEOUT','message','Read authority expired; retry the query','details',jsonb_build_object('sideEffects','none','operationIds',d.operation_ids)));
INSERT INTO audit(tenant_id,scope_id,principal_id,action,detail)
 SELECT d.tenant_id,d.scope_id,'system:migration','task.read-release-result-aggregated',jsonb_build_object('taskId',d.task_id,'inputRevisionId',d.input_revision_id,'operationIds',d.operation_ids,'migration',38)
 FROM deterministic_read_results d WHERE NOT EXISTS(SELECT 1 FROM audit a WHERE a.action='task.read-release-result-aggregated' AND a.detail->>'taskId'=d.task_id AND a.detail->>'inputRevisionId'=d.input_revision_id AND a.detail->>'migration'='38');
INSERT INTO audit(tenant_id,scope_id,principal_id,action,detail)
 SELECT a.tenant_id,a.scope_id,'system:migration','task.read-release-audit-links-completed',jsonb_build_object('correctsAudit',a.id::text,'taskId',a.detail->>'taskId','inputRevisionId',a.detail->>'inputRevisionId','migration',38,'historicalPhase','unprovable',
 'relatedAudits',COALESCE((SELECT jsonb_agg(original.id::text ORDER BY original.id) FROM audit original WHERE original.action='operation.read-unknown-released' AND original.detail->>'migration'='30' AND original.detail->>'taskId'=a.detail->>'taskId' AND original.detail->>'inputRevisionId'=a.detail->>'inputRevisionId'),'[]'::jsonb))
 FROM audit a WHERE a.action='task.read-release-phase-compensated' AND a.detail->>'migration'='36'
 AND NOT EXISTS(SELECT 1 FROM audit c WHERE c.action='task.read-release-audit-links-completed' AND c.detail->>'correctsAudit'=a.id::text);
`};
