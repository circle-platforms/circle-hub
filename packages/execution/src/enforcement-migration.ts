import type {Migration} from '../../storage/src/index.ts';
export const enforcementMigration:Migration={version:26,name:'Pinned execution changes and repairable run errors',sql:`
ALTER TABLE tasks ADD COLUMN waiting_reason text;
ALTER TABLE operations ADD COLUMN authorization_asset_id text REFERENCES assets;
ALTER TABLE operations ADD COLUMN approval_consumed boolean NOT NULL DEFAULT false;
CREATE TABLE execution_submissions(asset_id text NOT NULL,version text NOT NULL,task_id text NOT NULL REFERENCES tasks,input_revision_id text NOT NULL,action_digest text NOT NULL,consumed_operation_id text UNIQUE REFERENCES operations DEFERRABLE INITIALLY DEFERRED,PRIMARY KEY(asset_id,version),FOREIGN KEY(asset_id,version) REFERENCES asset_versions);
CREATE UNIQUE INDEX operation_approval_once ON operations(approval_id) WHERE approval_id IS NOT NULL AND approval_consumed;
`};
