import type {Migration} from '../../storage/src/index.ts';
export const enterpriseGovernanceMigration:Migration={version:45,name:'Enterprise governance approval roles, requests and OIDC subjects',sql:`
CREATE TABLE approval_role_names(role text PRIMARY KEY CHECK(role IN ('manager','security','dpo','legal','finance','hr','it')));
INSERT INTO approval_role_names(role) VALUES ('manager'),('security'),('dpo'),('legal'),('finance'),('hr'),('it');
CREATE TABLE principal_approval_roles(
  principal_id text NOT NULL REFERENCES policies,
  tenant_id text NOT NULL,
  scope_id text NOT NULL,
  role text NOT NULL REFERENCES approval_role_names,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(principal_id,scope_id,role)
);
CREATE TABLE governance_requests(
  request_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  scope_id text NOT NULL,
  principal_id text NOT NULL,
  task_id text NOT NULL,
  title text NOT NULL,
  summary text NOT NULL,
  content jsonb NOT NULL,
  policy jsonb NOT NULL,
  status text NOT NULL CHECK(status IN ('open','approved','declined')),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  record_id text,
  snapshot_id text,
  decline_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,scope_id,principal_id,idempotency_key)
);
CREATE TABLE governance_decisions(
  request_id text NOT NULL REFERENCES governance_requests,
  principal_id text NOT NULL,
  role text NOT NULL,
  approve boolean NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(request_id,principal_id)
);
CREATE TABLE oidc_transactions(
  state_hash text PRIMARY KEY,
  nonce text NOT NULL,
  redirect_uri text NOT NULL,
  expires_at timestamptz NOT NULL
);
ALTER TABLE policies ADD COLUMN oidc_sub text;
CREATE UNIQUE INDEX policies_oidc_sub ON policies(tenant_id,oidc_sub) WHERE oidc_sub IS NOT NULL;
`};
