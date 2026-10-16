import type {Migration} from '../../storage/src/index.ts';
export const teamMigration:Migration={version:46,name:'Teams, team approval roles and shared reader checks',sql:`
CREATE TABLE teams(
  team_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  scope_id text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,scope_id,name)
);
CREATE TABLE team_members(
  team_id text NOT NULL REFERENCES teams,
  principal_id text NOT NULL REFERENCES policies,
  tenant_id text NOT NULL,
  PRIMARY KEY(team_id,principal_id)
);
CREATE INDEX team_members_principal ON team_members(tenant_id,principal_id);
CREATE TABLE team_approval_roles(
  team_id text NOT NULL REFERENCES teams,
  tenant_id text NOT NULL,
  scope_id text NOT NULL,
  role text NOT NULL REFERENCES approval_role_names,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(team_id,scope_id,role)
);
CREATE FUNCTION reader_visible(readers jsonb, principal text, tenant text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(readers ? principal, false)
    OR COALESCE(readers ? '*', false)
    OR EXISTS (
      SELECT 1 FROM team_members m
      WHERE m.tenant_id = tenant AND m.principal_id = principal AND readers ? m.team_id
    );
$$;
`};
