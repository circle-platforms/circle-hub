import type {Migration} from '../../storage/src/index.ts';
export const automationMigration:Migration={version:15,name:'Durable schedule and connector event occurrences with Circle output channels',sql:`
CREATE TABLE automation_events(id bigserial PRIMARY KEY,event_id text NOT NULL UNIQUE,tenant_id text NOT NULL,scope_id text NOT NULL,
 source_asset_id text NOT NULL REFERENCES assets,external_id text NOT NULL,name text NOT NULL,payload jsonb NOT NULL,request_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,scope_id,source_asset_id,external_id));
CREATE TABLE automation_positions(bot_id text NOT NULL,version text NOT NULL,next_due_at timestamptz,event_cursor bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(bot_id,version),FOREIGN KEY(bot_id,version) REFERENCES asset_versions(asset_id,version));
CREATE TABLE automation_runs(bot_id text NOT NULL,version text NOT NULL,occurrence_key text NOT NULL,task_id text NOT NULL REFERENCES tasks,
 channel text NOT NULL,identity_principal_id text NOT NULL,published_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(bot_id,version,occurrence_key),FOREIGN KEY(bot_id,version) REFERENCES asset_versions(asset_id,version));
`};
