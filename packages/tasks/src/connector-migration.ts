import type {Migration} from '../../storage/src/index.ts';
export const connectorMigration:Migration={version:9,name:'Scoped connector bindings cursor rules and external event admission',sql:`
ALTER TABLE tasks ADD COLUMN context jsonb NOT NULL DEFAULT '{}';
ALTER TABLE tasks ADD COLUMN internal boolean NOT NULL DEFAULT false;
CREATE TABLE connectors(tenant_id text NOT NULL,scope_id text NOT NULL,connector_id text NOT NULL,manifest jsonb NOT NULL,
 enabled boolean NOT NULL DEFAULT true,PRIMARY KEY(tenant_id,scope_id,connector_id));
CREATE TABLE rules(rule_id text PRIMARY KEY,tenant_id text NOT NULL,scope_id text NOT NULL,owner_id text NOT NULL REFERENCES policies,
 service_principal_id text NOT NULL REFERENCES policies,capability_pack_id text NOT NULL,bindings jsonb NOT NULL,options jsonb NOT NULL,
 cursor bigint NOT NULL DEFAULT 0,poll_round bigint NOT NULL DEFAULT 0,poll_task_id text,poll_operation_id text,
 interval_ms integer NOT NULL,next_poll_at timestamptz NOT NULL DEFAULT now(),enabled boolean NOT NULL DEFAULT true);
CREATE TABLE connector_events(rule_id text NOT NULL REFERENCES rules,connector_id text NOT NULL,external_event_id text NOT NULL,
 payload jsonb NOT NULL,sha256 text NOT NULL,task_id text NOT NULL REFERENCES tasks,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(rule_id,connector_id,external_event_id));
`};
