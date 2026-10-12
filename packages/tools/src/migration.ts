import type {Migration} from '../../storage/src/index.ts';
export const toolMigration:Migration={version:13,name:'Tenant unique version pinned tool bindings and private worker injections',sql:`
CREATE TABLE tool_bindings(tenant_id text NOT NULL,name text NOT NULL,asset_id text NOT NULL,version text NOT NULL,package_id text NOT NULL,suffix text NOT NULL,
 PRIMARY KEY(tenant_id,name),FOREIGN KEY(asset_id,version) REFERENCES asset_versions(asset_id,version));
CREATE TABLE tool_injections(operation_id text PRIMARY KEY REFERENCES operations,secret_key text NOT NULL,binding text NOT NULL);
`};
