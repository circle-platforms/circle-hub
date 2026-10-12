import type {Migration} from '../../storage/src/index.ts';
export const graphMigration:Migration={version:12,name:'Six category marked knowledge records and atomic stable snapshots',sql:`
CREATE TABLE knowledge_records(record_id text PRIMARY KEY,kind text NOT NULL CHECK(kind IN ('SourceRevision','Evidence','Entity','Claim','Assessment','KnowledgeSnapshot')),
 tenant_id text NOT NULL,scope_id text NOT NULL,owner_id text NOT NULL,knowledge_category text NOT NULL CHECK(knowledge_category IN ('product','consolidated')),
 source_type text NOT NULL,visibility text NOT NULL CHECK(visibility IN ('personal','team')),state text NOT NULL,
 identity_key text NOT NULL,request_hash text NOT NULL,sha256 text NOT NULL,payload jsonb NOT NULL,reference_ids text[] NOT NULL,
 search_text text NOT NULL DEFAULT '',reviewer_id text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,scope_id,kind,identity_key));
CREATE TABLE knowledge_references(record_id text NOT NULL REFERENCES knowledge_records,reference_id text NOT NULL REFERENCES knowledge_records,
 PRIMARY KEY(record_id,reference_id));
CREATE TABLE knowledge_source_heads(tenant_id text NOT NULL,scope_id text NOT NULL,identity_key text NOT NULL,
 record_id text NOT NULL REFERENCES knowledge_records,PRIMARY KEY(tenant_id,scope_id,identity_key));
CREATE TABLE knowledge_stable(tenant_id text NOT NULL,scope_id text NOT NULL,knowledge_category text NOT NULL,
 record_id text NOT NULL REFERENCES knowledge_records,PRIMARY KEY(tenant_id,scope_id,knowledge_category));
CREATE INDEX knowledge_partition ON knowledge_records(tenant_id,scope_id,kind);
CREATE INDEX knowledge_fulltext ON knowledge_records USING gin(to_tsvector('simple',search_text));
ALTER TABLE entity_observations ADD COLUMN knowledge_category text NOT NULL DEFAULT 'product';
ALTER TABLE entity_observations ADD COLUMN knowledge_source_type text NOT NULL DEFAULT 'manual-observation';
`};
