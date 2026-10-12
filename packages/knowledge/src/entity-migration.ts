import type {Migration} from '../../storage/src/index.ts';

export const entityMigration:Migration={version:10,name:'Versioned object vocabulary observations and access filtered relations',sql:`
CREATE TABLE object_type_packages(tenant_id text NOT NULL,package_id text NOT NULL,version text NOT NULL,
 sha256 text NOT NULL,definition jsonb NOT NULL,registered_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,package_id,version));
CREATE TABLE entities(entity_id text PRIMARY KEY,tenant_id text NOT NULL,scope_id text NOT NULL,
 source_system text NOT NULL,source_type text NOT NULL,external_id text NOT NULL,current_revision_id text,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,scope_id,source_system,source_type,external_id));
CREATE TABLE entity_observations(entity_revision_id text PRIMARY KEY,entity_id text NOT NULL REFERENCES entities,
 observation_key text NOT NULL,request_hash text NOT NULL,type_package_id text NOT NULL,type_package_version text NOT NULL,type_id text NOT NULL,
 source_revision text NOT NULL,source_revision_id text NOT NULL REFERENCES sources,attributes jsonb NOT NULL,
 source_readers jsonb NOT NULL,platform_readers jsonb NOT NULL,observer_id text NOT NULL,origin text NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(entity_id,observation_key));
ALTER TABLE entities ADD FOREIGN KEY(current_revision_id) REFERENCES entity_observations DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX entities_partition ON entities(tenant_id,scope_id,entity_id);
CREATE INDEX entity_observations_source ON entity_observations(source_revision_id);
CREATE TABLE entity_relations(relation_id text PRIMARY KEY,tenant_id text NOT NULL,scope_id text NOT NULL,type text NOT NULL,
 from_entity_id text NOT NULL REFERENCES entities,to_entity_id text NOT NULL REFERENCES entities,
 source_system text NOT NULL,source_type text NOT NULL,external_id text NOT NULL,current_revision_id text,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,scope_id,source_system,source_type,external_id));
CREATE TABLE relation_observations(relation_revision_id text PRIMARY KEY,relation_id text NOT NULL REFERENCES entity_relations,
 observation_key text NOT NULL,request_hash text NOT NULL,source_revision text NOT NULL,source_revision_id text NOT NULL REFERENCES sources,
 source_readers jsonb NOT NULL,platform_readers jsonb NOT NULL,observer_id text NOT NULL,observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(relation_id,observation_key));
ALTER TABLE entity_relations ADD FOREIGN KEY(current_revision_id) REFERENCES relation_observations DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX entity_relations_from ON entity_relations(from_entity_id);
CREATE INDEX entity_relations_to ON entity_relations(to_entity_id);
CREATE INDEX relation_observations_source ON relation_observations(source_revision_id);
`};
