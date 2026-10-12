import type {Migration} from '../../storage/src/index.ts';
export const oauthMigration:Migration={version:21,name:'Private owned OAuth grant flow receipts',sql:`
CREATE TABLE oauth_flows(flow_id text PRIMARY KEY,tenant_id text NOT NULL,scope_id text NOT NULL,owner_id text NOT NULL,
 connector_asset_id text NOT NULL,connector_version text NOT NULL,profile_ref text NOT NULL,profile_digest text NOT NULL,
 grant_type text NOT NULL,request_hash text NOT NULL,idempotency_key text NOT NULL,secret_key text NOT NULL,
 state text NOT NULL DEFAULT 'creating',metadata jsonb NOT NULL DEFAULT '{}',interval_seconds integer NOT NULL DEFAULT 5,
 expires_at timestamptz,next_poll_at timestamptz,credential_asset_id text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,scope_id,owner_id,idempotency_key));
`};
