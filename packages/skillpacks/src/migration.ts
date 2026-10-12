import type {Migration} from '../../storage/src/index.ts';
export const skillMigration:Migration={version:14,name:'Sealed skill package approvals and constrained ephemeral run tokens',sql:`
CREATE TABLE skill_packages(skill_pack_id text PRIMARY KEY,tenant_id text NOT NULL,scope_id text NOT NULL,owner_id text NOT NULL,
 digest text NOT NULL,manifest jsonb NOT NULL,files jsonb NOT NULL,trial jsonb NOT NULL,asset_id text NOT NULL,asset_version text NOT NULL,
 approval_task_id text NOT NULL REFERENCES tasks,approval_id text,status text NOT NULL DEFAULT 'candidate',created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,scope_id,owner_id,digest),FOREIGN KEY(asset_id,asset_version) REFERENCES asset_versions(asset_id,version));
ALTER TABLE auth_tokens ADD COLUMN constraints jsonb;
`};
