import type {Migration} from '../../storage/src/index.ts';
export const registryPageMigration:Migration={version:39,name:'Track approval updates for faceted registry ordering',sql:`
ALTER TABLE approvals ADD COLUMN updated_at timestamptz NOT NULL DEFAULT clock_timestamp();
UPDATE approvals SET updated_at=created_at;
CREATE TRIGGER approval_registry_touch BEFORE UPDATE ON approvals FOR EACH ROW EXECUTE FUNCTION registry_touch();
CREATE INDEX approvals_registry_update ON approvals(updated_at,approval_id);
`};
