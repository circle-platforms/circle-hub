import type {Migration} from '../../storage/src/index.ts';
export const readEffectMigration:Migration={version:29,name:'Distinguish upstream read effects and release historical read freezes',sql:`
ALTER TABLE operations ADD COLUMN source_effect text NOT NULL DEFAULT 'write' CHECK(source_effect IN ('read','write'));
UPDATE operations SET source_effect='read' WHERE name='tools.invoke' AND effects->'writes'='[]'::jsonb;
UPDATE operations SET status='failed',result=jsonb_build_object('error',jsonb_build_object('code','UPSTREAM_TIMEOUT','message','Read authority expired; retry the query','details',jsonb_build_object('sideEffects','none'))),updated_at=clock_timestamp() WHERE source_effect='read' AND status='unknown';
DELETE FROM leases WHERE operation_id IN (SELECT operation_id FROM operations WHERE source_effect='read' AND status='failed');
UPDATE tasks t SET phase='failed',stage='done',result_status='failed',result=o.result,updated_at=clock_timestamp() FROM operations o WHERE o.task_id=t.task_id AND o.input_revision_id=t.input_revision_id AND o.source_effect='read' AND o.status='failed' AND t.phase='unknown';
UPDATE resources r SET frozen=EXISTS(SELECT 1 FROM operations o WHERE o.tenant_id=r.tenant_id AND o.resource_id=r.resource_id AND o.status='unknown' AND o.source_effect='write');
`};
