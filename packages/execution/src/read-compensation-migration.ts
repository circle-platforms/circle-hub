import type {Migration} from '../../storage/src/index.ts';
export const readCompensationMigration:Migration={version:36,name:'Compensate historical read release attribution without changing migration history',sql:`
CREATE TEMP TABLE current_read_releases ON COMMIT DROP AS
 SELECT * FROM operations WHERE source_effect='read' AND status='unknown';
UPDATE operations o SET status='failed',result=jsonb_build_object('error',jsonb_build_object('code','UPSTREAM_TIMEOUT','message','Read authority expired; retry the query','details',jsonb_build_object('sideEffects','none'))),updated_at=clock_timestamp()
 FROM current_read_releases r WHERE o.operation_id=r.operation_id;
DELETE FROM leases WHERE operation_id IN (SELECT operation_id FROM current_read_releases);
UPDATE tasks t SET phase='failed',stage='done',result_status='failed',result=o.result,updated_at=clock_timestamp()
 FROM operations o JOIN current_read_releases r USING(operation_id)
 WHERE t.task_id=o.task_id AND t.input_revision_id=o.input_revision_id AND t.phase='unknown'
 AND NOT EXISTS(SELECT 1 FROM operations w WHERE w.task_id=t.task_id AND w.input_revision_id=t.input_revision_id AND w.status='unknown' AND w.source_effect='write');
CREATE TEMP TABLE current_phase_repairs ON COMMIT DROP AS
 SELECT t.* FROM tasks t WHERE t.phase='failed' AND t.result->'error'->>'code'='UPSTREAM_TIMEOUT'
 AND EXISTS(SELECT 1 FROM operations w WHERE w.task_id=t.task_id AND w.input_revision_id=t.input_revision_id AND w.status='unknown' AND w.source_effect='write')
 AND (EXISTS(SELECT 1 FROM current_read_releases r WHERE r.task_id=t.task_id AND r.input_revision_id=t.input_revision_id)
 OR EXISTS(SELECT 1 FROM audit a WHERE a.action='operation.read-unknown-released' AND a.detail->>'migration'='30' AND a.detail->>'taskId'=t.task_id AND a.detail->>'inputRevisionId'=t.input_revision_id));
CREATE TEMP TABLE phase_attributions ON COMMIT DROP AS
 SELECT t.* FROM tasks t WHERE EXISTS(SELECT 1 FROM current_phase_repairs p WHERE p.task_id=t.task_id)
 OR (EXISTS(SELECT 1 FROM audit a WHERE a.action='operation.read-unknown-released' AND a.detail->>'migration'='30' AND a.detail->>'taskId'=t.task_id AND a.detail->>'inputRevisionId'=t.input_revision_id)
 AND EXISTS(SELECT 1 FROM operations w WHERE w.task_id=t.task_id AND w.input_revision_id=t.input_revision_id AND w.status='unknown' AND w.source_effect='write'));
UPDATE tasks t SET phase='unknown',stage='reconcile',result_status=NULL,result=NULL,updated_at=clock_timestamp()
 FROM current_phase_repairs p WHERE t.task_id=p.task_id;
INSERT INTO audit(tenant_id,scope_id,principal_id,action,detail)
 SELECT tenant_id,scope_id,'system:migration','operation.read-unknown-released',jsonb_build_object('operationId',operation_id,'taskId',task_id,'inputRevisionId',input_revision_id,'sourceEffect','read','migration',36,'originalState','unknown') FROM current_read_releases;
INSERT INTO audit(tenant_id,scope_id,principal_id,action,detail)
 SELECT a.tenant_id,a.scope_id,'system:migration','operation.read-release-compensated',jsonb_build_object('correctsAudit',a.id::text,'operationId',a.detail->>'operationId','taskId',a.detail->>'taskId','migration',36,'originalState','unprovable','leasesRestored',false,
 'explanation','30 的释放集合把当时已是 failed+UPSTREAM_TIMEOUT 的 read 也计入；29 释放时没有状态日志，这些操作在 29 之前的原始状态无法证明',
 'leaseExplanation','租约已被 30 删除且不恢复；failed 的 read 可重试、不持租约')
 FROM audit a WHERE a.action='operation.read-unknown-released' AND a.detail->>'migration'='30'
 AND NOT EXISTS(SELECT 1 FROM audit c WHERE c.action='operation.read-release-compensated' AND c.detail->>'correctsAudit'=a.id::text);
INSERT INTO audit(tenant_id,scope_id,principal_id,action,detail)
 SELECT p.tenant_id,p.scope_id,'system:migration','task.read-release-phase-compensated',jsonb_build_object('taskId',p.task_id,'inputRevisionId',p.input_revision_id,'originalPhase',p.phase,'originalPhaseBasis','observed-immediately-before-migration-36','historicalPhase','unprovable','migration',36,
 'correctsAudit',(SELECT min(a.id)::text FROM audit a WHERE a.action='operation.read-unknown-released' AND a.detail->>'migration'='30' AND a.detail->>'taskId'=p.task_id),'reason','Current write outcome remains unknown; historical migration 29 phase is not reconstructed')
 FROM phase_attributions p WHERE NOT EXISTS(SELECT 1 FROM audit c WHERE c.action='task.read-release-phase-compensated' AND c.detail->>'taskId'=p.task_id AND c.detail->>'inputRevisionId'=p.input_revision_id AND c.detail->>'migration'='36');
WITH numbered AS(SELECT r.*,row_number() OVER(ORDER BY operation_id) AS ordinal FROM current_read_releases r),clock AS(UPDATE event_clock SET value=value+(SELECT count(*) FROM current_read_releases) WHERE singleton RETURNING value)
 INSERT INTO outbox(seq,task_id,kind,payload) SELECT clock.value-(SELECT count(*) FROM current_read_releases)+n.ordinal,n.task_id,'operation.read-unknown-released',jsonb_build_object('operationId',n.operation_id,'inputRevisionId',n.input_revision_id,'sourceEffect','read','migration',36) FROM numbered n CROSS JOIN clock;
UPDATE resources r SET frozen=EXISTS(SELECT 1 FROM operations o WHERE o.tenant_id=r.tenant_id AND o.resource_id=r.resource_id AND o.status='unknown' AND o.source_effect='write')
 WHERE EXISTS(SELECT 1 FROM current_read_releases x WHERE x.tenant_id=r.tenant_id AND x.resource_id=r.resource_id);
`};
