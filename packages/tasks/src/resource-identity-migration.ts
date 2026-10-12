import type { Migration } from '../../storage/src/index.ts';
export const resourceIdentityMigration: Migration = { version: 22, name: 'Resource clients and audience bound short lived tokens', sql: `
ALTER TABLE policies ADD COLUMN username text;
CREATE TABLE service_clients(
  client_id text PRIMARY KEY,principal_id text NOT NULL REFERENCES policies(principal_id),tenant_id text NOT NULL,scope_id text NOT NULL,
  resource_asset_id text NOT NULL REFERENCES assets(asset_id),name text NOT NULL,scopes jsonb NOT NULL,resource_scopes jsonb NOT NULL,
  secret_salt text NOT NULL,secret_digest text NOT NULL,secret_version integer NOT NULL DEFAULT 1,revoked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE resource_access_tokens(
  digest text PRIMARY KEY,client_id text NOT NULL REFERENCES service_clients(client_id),secret_version integer NOT NULL,
  subject_id text NOT NULL REFERENCES policies(principal_id),tenant_id text NOT NULL,scope_id text NOT NULL,scopes jsonb NOT NULL,
  expires_at timestamptz NOT NULL,operation_id text REFERENCES operations(operation_id),fencing_token bigint,permission text,
  secret_key text,secret_binding text,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX resource_access_token_operation ON resource_access_tokens(operation_id,fencing_token,expires_at DESC);
` };
