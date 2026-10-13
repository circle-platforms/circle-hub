import type {Migration} from '../../storage/src/index.ts';
export const changeSetDependenciesMigration:Migration={version:25,name:'Grouped changes dependencies and superseded requests',sql:`
ALTER TABLE change_sets ADD COLUMN blocked_reasons jsonb NOT NULL DEFAULT '[]';
ALTER TABLE change_sets ADD COLUMN superseded_by text REFERENCES change_sets;
CREATE INDEX change_sets_items ON change_sets USING gin(items);
ALTER TABLE skill_packages ALTER COLUMN approval_task_id DROP NOT NULL;
ALTER TABLE skill_packages ADD COLUMN change_set_id text REFERENCES change_sets;
ALTER TABLE skill_packages ADD COLUMN check_result jsonb NOT NULL DEFAULT '{"undeclaredTools":[],"missingTools":[]}';
CREATE TABLE change_set_dependency_wakeups(id bigserial PRIMARY KEY,tenant_id text NOT NULL,scope_id text NOT NULL,processed_at timestamptz);
CREATE INDEX change_set_dependency_pending ON change_set_dependency_wakeups(id) WHERE processed_at IS NULL;
`};
