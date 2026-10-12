import type {Migration} from '../../storage/src/index.ts';
export const ingestionMigration:Migration={version:19,name:'Durable source projection outbox and incremental product snapshot members',sql:`
ALTER TABLE knowledge_source_heads ADD COLUMN generation bigint NOT NULL DEFAULT 1;
CREATE TABLE knowledge_projection_jobs(job_id text PRIMARY KEY,job_key text NOT NULL UNIQUE,task_id text NOT NULL REFERENCES tasks,
 origin_task_id text NOT NULL REFERENCES tasks,tenant_id text NOT NULL,scope_id text NOT NULL,owner_id text NOT NULL,payload jsonb NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed')),attempts integer NOT NULL DEFAULT 0,
 lease_until timestamptz,error jsonb,progress integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE INDEX knowledge_projection_pending ON knowledge_projection_jobs(status,created_at);
CREATE TABLE knowledge_indexed_sources(source_id text NOT NULL REFERENCES knowledge_records,package_id text NOT NULL,rule_version text NOT NULL,
 generation bigint NOT NULL,PRIMARY KEY(source_id,package_id,rule_version));
CREATE TABLE knowledge_active_statements(tenant_id text NOT NULL,scope_id text NOT NULL,statement_key text NOT NULL,
 claim_id text NOT NULL REFERENCES knowledge_records,source_ids text[] NOT NULL,member_ids text[] NOT NULL,
 PRIMARY KEY(tenant_id,scope_id,statement_key));
CREATE INDEX knowledge_active_sources ON knowledge_active_statements USING gin(source_ids);
CREATE TABLE knowledge_projection_members(job_id text NOT NULL REFERENCES knowledge_projection_jobs,statement_key text NOT NULL,
 claim_id text NOT NULL REFERENCES knowledge_records,source_ids text[] NOT NULL,member_ids text[] NOT NULL,PRIMARY KEY(job_id,statement_key));
WITH RECURSIVE closure(root,record_id) AS(
 SELECT c.record_id,c.record_id FROM knowledge_records c JOIN knowledge_stable s ON s.tenant_id=c.tenant_id AND s.scope_id=c.scope_id AND s.knowledge_category='product'
 JOIN knowledge_records snapshot ON snapshot.record_id=s.record_id WHERE c.kind='Claim' AND c.state='reviewed' AND c.record_id=ANY(snapshot.reference_ids)
 UNION SELECT p.root,unnest(r.reference_ids) FROM closure p JOIN knowledge_records r ON r.record_id=p.record_id
),members AS(
 SELECT p.root,array_agg(p.record_id) AS ids,array_agg(p.record_id) FILTER(WHERE r.kind='SourceRevision') AS sources
 FROM closure p JOIN knowledge_records r ON r.record_id=p.record_id GROUP BY p.root
)
INSERT INTO knowledge_active_statements(tenant_id,scope_id,statement_key,claim_id,source_ids,member_ids)
 SELECT c.tenant_id,c.scope_id,'legacy:'||c.record_id,c.record_id,coalesce(m.sources,'{}'),m.ids||coalesce(
 (SELECT array_agg(a.record_id) FROM knowledge_records a WHERE a.kind='Assessment' AND a.payload->>'claimId'=c.record_id),'{}')
 FROM members m JOIN knowledge_records c ON c.record_id=m.root;
`};
