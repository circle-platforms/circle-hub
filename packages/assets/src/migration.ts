import type {Migration} from '../../storage/src/index.ts';
export const assetMigration:Migration={version:11,name:'Scoped versioned asset registry and write only credential references',sql:`
CREATE TABLE assets(asset_id text PRIMARY KEY,tenant_id text NOT NULL,scope_id text NOT NULL,kind text NOT NULL,
 owner_principal_id text NOT NULL REFERENCES policies,current_version text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE asset_versions(asset_id text NOT NULL REFERENCES assets,version text NOT NULL,sha256 text NOT NULL,name text NOT NULL,
 declaration jsonb NOT NULL,configuration jsonb NOT NULL,readers jsonb NOT NULL,lifecycle text NOT NULL DEFAULT 'draft',
 approved_by text,approved_digest text,health jsonb NOT NULL DEFAULT '{"checkedAt":null,"result":"unknown","reason":"not-checked"}',
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(asset_id,version));
CREATE TABLE personal_credentials(asset_id text NOT NULL,version text NOT NULL,connector_asset_id text NOT NULL REFERENCES assets,
 secret_key text NOT NULL,PRIMARY KEY(asset_id,version),FOREIGN KEY(asset_id,version) REFERENCES asset_versions);
CREATE INDEX assets_partition ON assets(tenant_id,scope_id,asset_id);
`};
