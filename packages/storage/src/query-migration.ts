import type {Migration} from './index.ts';
export const queryMigration:Migration={version:32,name:'Record registry update times for stable faceted pages',sql:`
ALTER TABLE asset_versions ADD COLUMN updated_at timestamptz NOT NULL DEFAULT clock_timestamp();
UPDATE asset_versions SET updated_at=created_at;
ALTER TABLE skill_packages ADD COLUMN updated_at timestamptz NOT NULL DEFAULT clock_timestamp();
UPDATE skill_packages SET updated_at=created_at;
ALTER TABLE service_clients ADD COLUMN updated_at timestamptz NOT NULL DEFAULT clock_timestamp();
UPDATE service_clients SET updated_at=created_at;
CREATE FUNCTION registry_touch() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.updated_at=clock_timestamp();RETURN NEW;END$$;
CREATE TRIGGER asset_version_touch BEFORE UPDATE ON asset_versions FOR EACH ROW EXECUTE FUNCTION registry_touch();
CREATE TRIGGER skill_package_touch BEFORE UPDATE ON skill_packages FOR EACH ROW EXECUTE FUNCTION registry_touch();
CREATE TRIGGER service_client_touch BEFORE UPDATE ON service_clients FOR EACH ROW EXECUTE FUNCTION registry_touch();
CREATE INDEX tasks_query_update ON tasks(tenant_id,scope_id,updated_at,task_id);
CREATE INDEX asset_version_query_update ON asset_versions(updated_at,asset_id);
`};
