import type {Migration} from '../../storage/src/index.ts';
export const workerCapabilityMigration:Migration={version:41,name:'Negotiate worker operation capabilities and persist granted requirements',sql:`
ALTER TABLE workers ADD COLUMN capabilities jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(capabilities)='array');
ALTER TABLE operations ADD COLUMN required_worker_capability text CHECK(required_worker_capability IS NULL OR required_worker_capability ~ '^[a-z][a-z0-9._-]{0,149}$');
`};
