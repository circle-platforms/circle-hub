import type {Migration} from '../../storage/src/index.ts';
export const toolRolesMigration:Migration={version:28,name:'Tool minimum roles replace professional permissions',sql:`
DROP TABLE professional_permissions;
ALTER TABLE tool_bindings ADD COLUMN minimum_role text NOT NULL DEFAULT 'viewer' REFERENCES role_presets;
ALTER TABLE tool_bindings ADD COLUMN approval boolean NOT NULL DEFAULT false;
ALTER TABLE tool_bindings ADD COLUMN annotations jsonb NOT NULL DEFAULT '{}';
`};
