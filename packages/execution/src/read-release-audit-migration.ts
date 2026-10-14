import type {Migration} from '../../storage/src/index.ts';
export const readReleaseAuditMigration:Migration={version:30,name:'Audit bounded read releases and retain ambiguous write outcomes',sql:`
CREATE TEMP TABLE released_reads ON COMMIT DROP AS
 SELECT o.* FROM operations o WHERE o.source_effect='read' AND
 (o.status='unknown' OR (o.status='failed' AND o.result->'error'->>'code'='UPSTREAM_TIMEOUT'))
 AND NOT EXISTS(SELECT 1 FROM audit a WHERE a.tenant_id=o.tenant_id AND a.action='operation.read-unknown-released' AND a.detail->>'operationId'=o.operation_id);
UPDATE operations o SET status='failed',result=jsonb_build_object('error',jsonb_build_object('code','UPSTREAM_TIMEOUT','message','Read authority expired; retry the query','details',jsonb_build_object('sideEffects','none'))),updated_at=clock_timestamp() FROM released_reads r WHERE o.operation_id=r.operation_id AND o.status='unknown';
DELETE FROM leases WHERE operation_id IN (SELECT operation_id FROM released_reads);
UPDATE tasks t SET phase='failed',stage='done',result_status='failed',result=o.result,updated_at=clock_timestamp() FROM operations o JOIN released_reads r USING(operation_id)
 WHERE o.task_id=t.task_id AND o.input_revision_id=t.input_revision_id AND t.phase='unknown'
 AND NOT EXISTS(SELECT 1 FROM operations w WHERE w.task_id=t.task_id AND w.input_revision_id=t.input_revision_id AND w.source_effect='write' AND w.status='unknown');
-- Migration 29 is immutable. Repair tasks it marked failed if a current write
-- outcome is still unknown; do not infer a result or restore expired authority.
UPDATE tasks t SET phase='unknown',stage='reconcile',result_status=NULL,result=NULL,updated_at=clock_timestamp()
 WHERE t.phase='failed' AND t.result->'error'->>'code'='UPSTREAM_TIMEOUT'
 AND EXISTS(SELECT 1 FROM released_reads r WHERE r.task_id=t.task_id AND r.input_revision_id=t.input_revision_id)
 AND EXISTS(SELECT 1 FROM operations w WHERE w.task_id=t.task_id AND w.input_revision_id=t.input_revision_id AND w.source_effect='write' AND w.status='unknown');
INSERT INTO audit(tenant_id,scope_id,principal_id,action,detail)
 SELECT tenant_id,scope_id,'system:migration','operation.read-unknown-released',jsonb_build_object('operationId',operation_id,'taskId',task_id,'inputRevisionId',input_revision_id,'sourceEffect','read','migration',30) FROM released_reads;
WITH numbered AS(SELECT r.*,row_number() OVER(ORDER BY operation_id) AS ordinal FROM released_reads r), clock AS(UPDATE event_clock SET value=value+(SELECT count(*) FROM released_reads) WHERE singleton RETURNING value)
 INSERT INTO outbox(seq,task_id,kind,payload) SELECT clock.value-(SELECT count(*) FROM released_reads)+n.ordinal,n.task_id,'operation.read-unknown-released',jsonb_build_object('operationId',n.operation_id,'inputRevisionId',n.input_revision_id,'sourceEffect','read','migration',30) FROM numbered n CROSS JOIN clock;
UPDATE resources r SET frozen=EXISTS(SELECT 1 FROM operations o WHERE o.tenant_id=r.tenant_id AND o.resource_id=r.resource_id AND o.source_effect='write' AND o.status='unknown')
 WHERE EXISTS(SELECT 1 FROM released_reads x WHERE x.tenant_id=r.tenant_id AND x.resource_id=r.resource_id);
`};
