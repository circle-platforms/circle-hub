// Forward-only migrator (adapted from the earlier storage migrator). Applied migrations never change: each is checksummed,
// and an unknown applied version, a gap or a checksum mismatch refuses to start. To change the schema, append a migration.
// Two roles: the owner applies migrations; the runtime role gets only SELECT and INSERT on the history tables (and the
// column UPDATEs the mutable tables need), so the running Hub cannot alter, disable the triggers of, or delete history.
import type { Database, PgTransaction } from './db.ts';
import { sha256Hex } from './digest.ts';
import { MigrationError } from './errors.ts';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Arbitrary constant: the advisory lock that serializes migrators of one database. */
const MIGRATION_LOCK = 7_301_562_001;

const APPEND_ONLY = (table: string) => `
CREATE TRIGGER ${table}_append_only BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION hub_append_only();
CREATE TRIGGER ${table}_no_truncate BEFORE TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION hub_append_only();`;

const V1_RECORDS = `
CREATE FUNCTION hub_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'append-only table %: % rejected', TG_TABLE_NAME, TG_OP USING ERRCODE = 'HU001';
END
$fn$;

CREATE TABLE records (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id text NOT NULL UNIQUE CHECK (id ~ '^rcd_[0-9a-z]{26}$'),
  digest text NOT NULL UNIQUE CHECK (digest ~ '^[0-9a-f]{64}$'),
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z_]{0,39}$'),
  schema text NOT NULL CHECK (schema ~ '^[a-z][a-z0-9_-]*@[0-9]+$'),
  provenance text NOT NULL CHECK (provenance ~ '^[a-z][a-z_]{0,39}$'),
  created_at timestamptz NOT NULL,
  body text NOT NULL,
  size integer NOT NULL CHECK (size >= 0)
);
CREATE INDEX records_kind_seq ON records (kind, seq);
${APPEND_ONLY('records')}

CREATE TABLE record_index (
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  value text NOT NULL CHECK (octet_length(value) <= 1000),
  digest text NOT NULL REFERENCES records (digest),
  record_seq bigint NOT NULL,
  PRIMARY KEY (key, value, digest)
);
CREATE INDEX record_index_lookup ON record_index (key, value, record_seq);
${APPEND_ONLY('record_index')}

CREATE TABLE objects (
  sha256 text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size bigint NOT NULL CHECK (size >= 0),
  media_type text NOT NULL CHECK (length(media_type) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL
);
${APPEND_ONLY('objects')}

CREATE TABLE users (
  id text PRIMARY KEY CHECK (id ~ '^usr_[0-9a-z]{26}$'),
  name text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 100),
  role text NOT NULL CHECK (role ~ '^[a-z_]{1,40}$'),
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE user_history (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL REFERENCES users (id),
  name text NOT NULL,
  role text NOT NULL,
  disabled boolean NOT NULL,
  changed_by text REFERENCES users (id),
  changed_at timestamptz NOT NULL
);
CREATE INDEX user_history_user ON user_history (user_id, seq);
${APPEND_ONLY('user_history')}

CREATE TABLE tokens (
  id text PRIMARY KEY CHECK (id ~ '^tok_[0-9a-z]{26}$'),
  user_id text NOT NULL REFERENCES users (id),
  sha256 text NOT NULL UNIQUE CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  label text NOT NULL CHECK (length(label) <= 100),
  created_at timestamptz NOT NULL,
  created_by text REFERENCES users (id),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by text REFERENCES users (id)
);
CREATE INDEX tokens_user ON tokens (user_id);

CREATE TABLE pointers (
  name text PRIMARY KEY CHECK (name ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  target text NOT NULL CHECK (target ~ '^[0-9a-f]{64}$'),
  version bigint NOT NULL CHECK (version >= 1),
  moved_at timestamptz NOT NULL,
  action_digest text NOT NULL REFERENCES records (digest)
);

CREATE TABLE call_logs (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  digest text NOT NULL UNIQUE REFERENCES records (digest),
  at timestamptz NOT NULL,
  trace_id text NOT NULL CHECK (trace_id ~ '^[0-9a-f]{32}$'),
  span_id text NOT NULL CHECK (span_id ~ '^[0-9a-f]{16}$'),
  user_id text,
  session_id text,
  tool text NOT NULL,
  run_id text,
  args_digest text NOT NULL CHECK (args_digest ~ '^[0-9a-f]{64}$'),
  args_size bigint NOT NULL CHECK (args_size >= 0),
  args_preview text CHECK (octet_length(args_preview) <= 1024),
  call_result text NOT NULL,
  acceptance text,
  error_code text,
  duration_ms integer NOT NULL CHECK (duration_ms >= 0)
);
CREATE INDEX call_logs_user_seq ON call_logs (user_id, seq);
CREATE INDEX call_logs_run_seq ON call_logs (run_id, seq);
CREATE INDEX call_logs_at ON call_logs (at);
${APPEND_ONLY('call_logs')}

-- Real reasons behind neutral answers (D05 R[3]), for admins only. Outside the call_log record, so no digest a user sees covers them.
CREATE TABLE call_notes (
  digest text PRIMARY KEY REFERENCES call_logs (digest),
  note text NOT NULL CHECK (length(note) BETWEEN 1 AND 2000),
  at timestamptz NOT NULL
);
${APPEND_ONLY('call_notes')}
`;

const V2_LEASES = `
-- The lease table (D04 R[0]): one row per key, the fencing token monotonic per row. Expiry is decided by the
-- database clock; an expired or released row is taken over in place (UPDATE ... WHERE expires_at <= now() OR
-- released_at IS NOT NULL), never deleted, so the token never repeats for a key.
CREATE TABLE leases (
  key text PRIMARY KEY CHECK (key ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  lease_id text NOT NULL CHECK (lease_id ~ '^lse_[0-9a-z]{26}$'),
  run_id text NOT NULL CHECK (run_id ~ '^run_[0-9a-z]{26}$'),
  user_id text NOT NULL CHECK (user_id ~ '^usr_[0-9a-z]{26}$'),
  token bigint NOT NULL CHECK (token >= 1),
  acquired_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  released_at timestamptz
);
CREATE INDEX leases_prefix ON leases (key);
`;

const V3_RECORD_KEYS = `
CREATE TABLE record_keys (
  kind text NOT NULL,
  key text NOT NULL CHECK (octet_length(key) BETWEEN 1 AND 1000),
  digest text NOT NULL REFERENCES records(digest),
  PRIMARY KEY (kind, key)
);
${APPEND_ONLY('record_keys')}
`;

const V6_CALL_REASONS = `
-- Full private reasons stay outside the call record and its public digest; call_notes remains the bounded summary.
CREATE TABLE call_reasons (
  digest text NOT NULL REFERENCES call_logs (digest),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  note text NOT NULL CHECK (length(note) >= 1),
  at timestamptz NOT NULL,
  PRIMARY KEY (digest, ordinal)
);
${APPEND_ONLY('call_reasons')}
`;

const V7_STANDARD_AUTHORIZATION = `
-- MCP standard authorization (decision 78): the clients that registered themselves (RFC 7591), the invitation codes that
-- tell the authorization page which account is connecting (only their SHA-256 is kept), and the client a token went to.
CREATE TABLE oauth_clients (
  id text PRIMARY KEY CHECK (id ~ '^cli_[0-9a-z]{26}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  redirect_uris text[] NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 10),
  created_at timestamptz NOT NULL
);
CREATE INDEX oauth_clients_created ON oauth_clients (created_at);

CREATE TABLE invitations (
  id text PRIMARY KEY CHECK (id ~ '^inv_[0-9a-z]{26}$'),
  user_id text NOT NULL REFERENCES users (id),
  sha256 text NOT NULL UNIQUE CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  created_by text NOT NULL REFERENCES users (id),
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  used_at timestamptz,
  used_by_client text REFERENCES oauth_clients (id),
  CHECK ((used_at IS NULL) = (used_by_client IS NULL))
);
CREATE INDEX invitations_user ON invitations (user_id);

ALTER TABLE tokens ADD COLUMN client_id text REFERENCES oauth_clients (id);
`;

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  { version: 1, name: 'records', sql: V1_RECORDS },
  { version: 2, name: 'leases', sql: V2_LEASES },
  { version: 3, name: 'record_keys', sql: V3_RECORD_KEYS },
  { version: 4, name: 'unbounded_leases', sql: 'ALTER TABLE leases ALTER COLUMN expires_at DROP NOT NULL;' },
  { version: 5, name: 'lease_registrations', sql: `CREATE TABLE lease_registrations (
    prefix text PRIMARY KEY CHECK (right(prefix, 1) = '/'),
    owner text NOT NULL,
    registered_at timestamptz NOT NULL
  );` },
  { version: 6, name: 'call_reasons', sql: V6_CALL_REASONS },
  { version: 7, name: 'standard_authorization', sql: V7_STANDARD_AUTHORIZATION },
  { version: 8, name: 'console_passwords', sql: `ALTER TABLE users
    ADD COLUMN password_hash text,
    ADD COLUMN password_must_change boolean NOT NULL DEFAULT false,
    ADD COLUMN password_revision integer NOT NULL DEFAULT 0;
  ALTER TABLE tokens ADD COLUMN console_session boolean NOT NULL DEFAULT false,
    ADD COLUMN expires_at timestamptz;
  ALTER TABLE user_history ADD COLUMN password_changed boolean NOT NULL DEFAULT false;` },
  { version: 9, name: 'knowledge_space_search', sql: `CREATE TABLE knowledge_space_search (
    version text NOT NULL REFERENCES records(digest),
    space text NOT NULL,
    path text NOT NULL,
    entry text NOT NULL,
    record text NOT NULL REFERENCES records(digest),
    tokens text[] NOT NULL,
    PRIMARY KEY(version,path,entry)
  );
  CREATE INDEX knowledge_space_search_tokens ON knowledge_space_search USING GIN(tokens);
  CREATE INDEX knowledge_space_search_space ON knowledge_space_search(space,version);
  CREATE TABLE knowledge_space_search_ready (
    version text NOT NULL REFERENCES records(digest), path text NOT NULL, row_count integer NOT NULL, PRIMARY KEY(version,path)
  );` },
  { version: 10, name: 'knowledge_search_documents', sql: `CREATE TABLE knowledge_space_search_documents (
    record text PRIMARY KEY REFERENCES records(digest), tokens text[] NOT NULL,
    token_bytes bigint NOT NULL CHECK(token_bytes>=0)
  );
  INSERT INTO knowledge_space_search_documents(record,tokens,token_bytes)
    SELECT DISTINCT ON (record) record,tokens,64+COALESCE((SELECT sum(octet_length(token)+4) FROM unnest(tokens) token),0)
    FROM knowledge_space_search ORDER BY record;
  CREATE INDEX knowledge_space_search_documents_tokens ON knowledge_space_search_documents USING GIN(tokens);
  ALTER TABLE knowledge_space_search DROP COLUMN tokens;
  ALTER TABLE knowledge_space_search ADD CONSTRAINT knowledge_space_search_document
    FOREIGN KEY(record) REFERENCES knowledge_space_search_documents(record);
  CREATE INDEX knowledge_space_search_document_space ON knowledge_space_search(space,record);` },
  { version:11,name:'knowledge_search_version_totals',sql:`ALTER TABLE knowledge_space_search ADD COLUMN quota_space text;
  UPDATE knowledge_space_search s SET quota_space=CASE WHEN r.kind='knowledge_space_version' THEN s.space
    ELSE 'product:'||array_to_string((string_to_array(s.path,'/'))[1:4],'/') END FROM records r WHERE r.digest=s.version;
  ALTER TABLE knowledge_space_search ALTER COLUMN quota_space SET NOT NULL;
  CREATE TABLE knowledge_space_search_totals (
    quota_space text NOT NULL, version text NOT NULL REFERENCES records(digest),
    token_bytes bigint NOT NULL CHECK(token_bytes>=0), PRIMARY KEY(quota_space,version)
  );
  INSERT INTO knowledge_space_search_totals(quota_space,version,token_bytes)
    SELECT s.quota_space,s.version,sum(d.token_bytes) FROM knowledge_space_search s
    JOIN knowledge_space_search_documents d ON d.record=s.record GROUP BY s.quota_space,s.version;` },
  {version:12,name:'memory_heads_and_usage',sql:`CREATE TABLE memory_heads (
    document text PRIMARY KEY REFERENCES records(digest), space text NOT NULL,
    version text NOT NULL REFERENCES records(digest), path text NOT NULL, state text NOT NULL,
    bytes bigint NOT NULL CHECK(bytes>=0)
  );
  CREATE INDEX memory_heads_space ON memory_heads(space,document);
  CREATE TABLE memory_space_usage (
    space text PRIMARY KEY, active_bytes bigint NOT NULL CHECK(active_bytes>=0),
    history_bytes bigint NOT NULL CHECK(history_bytes>=0)
  );`},
  {version:13,name:'memory_context_limits',sql:`ALTER TABLE memory_heads
    ADD COLUMN context_bytes bigint NOT NULL DEFAULT 0 CHECK(context_bytes>=0);
  ALTER TABLE memory_space_usage
    ADD COLUMN active_documents bigint NOT NULL DEFAULT 0 CHECK(active_documents>=0);
  UPDATE memory_heads h SET context_bytes=h.bytes
    -- JSONB cannot decode NUL; this accounting-only view substitutes an equal-width control character.
    +octet_length(replace(r.body,chr(92)||'u0000',chr(92)||'u0001')::jsonb->>'title')
    +octet_length(replace(r.body,chr(92)||'u0000',chr(92)||'u0001')::jsonb->>'path')
    FROM records r WHERE r.digest=h.version;
  UPDATE memory_space_usage SET active_bytes=0,active_documents=0;
  INSERT INTO memory_space_usage(space,active_bytes,history_bytes,active_documents)
    SELECT space,coalesce(sum(context_bytes) FILTER(WHERE state='enabled'),0),0,
      count(*) FILTER(WHERE state='enabled') FROM memory_heads GROUP BY space
    ON CONFLICT(space) DO UPDATE SET active_bytes=EXCLUDED.active_bytes,
      active_documents=EXCLUDED.active_documents;`},
  {version:14,name:'personal_payloads',sql:`CREATE TABLE personal_spaces (
 owner text PRIMARY KEY REFERENCES users(id), epoch text NOT NULL,
 mode text NOT NULL DEFAULT 'hub' CHECK(mode IN ('hub','local'))
);
CREATE TABLE personal_payloads (
 owner text NOT NULL REFERENCES users(id), epoch text NOT NULL,
 sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'), data bytea NOT NULL,
 PRIMARY KEY(owner,epoch,sha256), CHECK(encode(sha256(data),'hex')=sha256)
);
CREATE TRIGGER personal_payloads_immutable BEFORE UPDATE ON personal_payloads
 FOR EACH ROW EXECUTE FUNCTION hub_append_only();
CREATE TABLE personal_record_bindings (
 record text PRIMARY KEY, owner text NOT NULL REFERENCES users(id), epoch text NOT NULL,
 sha256 text NOT NULL, bytes bigint NOT NULL, marker text NOT NULL, proof text NOT NULL
);
CREATE TRIGGER personal_record_bindings_append_only BEFORE UPDATE OR DELETE ON personal_record_bindings
 FOR EACH ROW EXECUTE FUNCTION hub_append_only();
CREATE TRIGGER personal_record_bindings_no_truncate BEFORE TRUNCATE ON personal_record_bindings
 FOR EACH STATEMENT EXECUTE FUNCTION hub_append_only();
CREATE TABLE personal_objects (
 owner text NOT NULL REFERENCES users(id), epoch text NOT NULL, sha256 text NOT NULL,
 PRIMARY KEY(owner,epoch,sha256)
);
CREATE TRIGGER personal_objects_append_only BEFORE UPDATE OR DELETE ON personal_objects
 FOR EACH ROW EXECUTE FUNCTION hub_append_only();
CREATE TRIGGER personal_objects_no_truncate BEFORE TRUNCATE ON personal_objects
 FOR EACH STATEMENT EXECUTE FUNCTION hub_append_only();
CREATE TABLE personal_purges (
 owner text NOT NULL REFERENCES users(id), epoch text NOT NULL, at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner,epoch)
);
CREATE TRIGGER personal_purges_append_only BEFORE UPDATE OR DELETE ON personal_purges
 FOR EACH ROW EXECUTE FUNCTION hub_append_only();
CREATE TRIGGER personal_purges_no_truncate BEFORE TRUNCATE ON personal_purges
 FOR EACH STATEMENT EXECUTE FUNCTION hub_append_only();

-- A deterministic capsule binds the old logical digest, body digest and immutable metadata.
CREATE FUNCTION hub_personal_proof(d text,h text,o text,e text,n bigint,t timestamptz,k text,p text,s text)
 RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $fn$
 SELECT encode(sha256(convert_to(d||':'||h||':'||o||':'||e||':'||n::text||':'||
 to_char(t AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')||':'||k||':'||p||':'||s,'UTF8')),'hex')
$fn$;
CREATE OR REPLACE FUNCTION hub_append_only() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $fn$
BEGIN
 IF TG_TABLE_NAME='records' AND TG_OP='UPDATE' THEN
 IF current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID))
 AND current_setting('circle_hub.personal_layout_conversion',true)='14'
 AND NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=14)
 AND (to_jsonb(NEW)-'body')=(to_jsonb(OLD)-'body')
 AND EXISTS(SELECT 1 FROM personal_record_bindings b JOIN personal_payloads p
 ON (p.owner,p.epoch,p.sha256)=(b.owner,b.epoch,b.sha256)
 WHERE b.record=OLD.digest AND b.marker=NEW.body AND convert_from(p.data,'UTF8')=OLD.body
 AND b.sha256=encode(sha256(p.data),'hex') AND b.bytes=octet_length(p.data)
 AND ((OLD.kind IN ('knowledge_space_entry','knowledge_space_version','knowledge_space_source','knowledge_space_grant','memory_document','memory_version','memory_grant')
 AND (replace(OLD.body,chr(92)||'u0000',chr(92)||'u0001')::json)->>'space'=b.owner)
 OR (OLD.kind='source_artifact'
 AND (replace(OLD.body,chr(92)||'u0000',chr(92)||'u0001')::json)->'author'->>'user'=b.owner
 AND (replace(OLD.body,chr(92)||'u0000',chr(92)||'u0001')::json)->'visibility'->>'admins'='false'
 AND (replace(OLD.body,chr(92)||'u0000',chr(92)||'u0001')::json)->'origin'->'upload' IS NOT NULL))
 AND b.proof=hub_personal_proof(OLD.digest,b.sha256,b.owner,b.epoch,b.bytes,
 OLD.created_at,OLD.kind,OLD.provenance,OLD.schema)) THEN RETURN NEW; END IF;
 END IF;
 RAISE EXCEPTION 'append-only table %: % rejected',TG_TABLE_NAME,TG_OP USING ERRCODE='HU001';
END $fn$;
-- Exact storage references, not arbitrary mentions in prose, grounds or generator inputs.
CREATE TABLE object_holds (
 record text NOT NULL REFERENCES records(digest),sha256 text NOT NULL,artifact boolean NOT NULL,members boolean NOT NULL,
 PRIMARY KEY(record,sha256,artifact,members)
);
CREATE INDEX object_holds_target ON object_holds(artifact,sha256,record);
CREATE INDEX object_holds_members ON object_holds(members) WHERE members;
CREATE TRIGGER object_holds_append_only BEFORE UPDATE OR DELETE ON object_holds FOR EACH ROW EXECUTE FUNCTION hub_append_only();
CREATE TRIGGER object_holds_no_truncate BEFORE TRUNCATE ON object_holds FOR EACH STATEMENT EXECUTE FUNCTION hub_append_only();
CREATE FUNCTION hub_object_refs(k text,b text) RETURNS TABLE(sha256 text,artifact boolean,members boolean)
 LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE d jsonb;op text[]:='{}';ap text[]:='{}';path text;v jsonb;
BEGIN
 CASE k
 WHEN 'source_artifact' THEN op:=ARRAY['$.sha256'];
 WHEN 'authorization' THEN op:=ARRAY['$.bound'];
 WHEN 'pack_version' THEN op:=ARRAY['$.digest','$.manifest.files[*].sha256'];
 WHEN 'personal_pack_version' THEN op:=ARRAY['$.digest','$.manifest.files[*].sha256'];ap:=ARRAY['$.files.*'];
 WHEN 'knowledge_space_version' THEN op:=ARRAY['$.tree'];
 WHEN 'tree_root' THEN op:=ARRAY['$.sources[*].sha256','$.rows[*].sha256'];ap:=ARRAY['$.sources[*].artifact','$.rows[*].artifact'];
 WHEN 'submission' THEN op:=ARRAY['$.received.object'];
 WHEN 'run' THEN op:=ARRAY['$.policy','$.executors'];ap:=ARRAY['$.sources[*].artifact','$.sources[*].meta_artifact'];
 WHEN 'claim' THEN op:=ARRAY['$.statement.data.feeding.object'];ap:=ARRAY['$.statement.data.feeding.source.artifact'];
 WHEN 'action' THEN op:=ARRAY['$.detail.output.sha256','$.detail.sha256','$.detail.lists[*].externals',
 '$.detail.binding.executor_digest','$.detail.binding.executor_source_digest','$.detail.admin_release_sha256',
 '$.detail.operation_definition_sha256','$.detail.source_definition_sha256','$.detail.reading_definition_sha256'];
 ELSE RETURN;
 END CASE;
 d:=replace(b,chr(92)||'u0000',chr(92)||'u0001')::jsonb;
 FOREACH path IN ARRAY op LOOP
 IF path='$.detail.sha256' AND COALESCE(d->>'component','') NOT IN ('hub.feeding@2','knowledge.sync@1') THEN CONTINUE;END IF;
 FOR v IN SELECT jsonb_path_query(d,path::jsonpath) LOOP
 sha256:=v#>>'{}';IF sha256 ~ '^[0-9a-f]{64}$' THEN artifact:=false;members:=k='run' AND path='$.executors';RETURN NEXT;END IF;
 END LOOP;
 END LOOP;
 FOREACH path IN ARRAY ap LOOP
 FOR v IN SELECT jsonb_path_query(d,path::jsonpath) LOOP
 sha256:=v#>>'{}';IF sha256 ~ '^[0-9a-f]{64}$' THEN artifact:=true;members:=false;RETURN NEXT;END IF;
 END LOOP;
 END LOOP;
END $fn$;
CREATE FUNCTION hub_track_object_holds() RETURNS pg_catalog.trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE r public.records%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='records' THEN r:=NEW;
 ELSIF NEW.key='knowledge.feeding.object' THEN SELECT * INTO r FROM public.records WHERE digest=NEW.digest;
 ELSE RETURN NULL;END IF;
 IF r.kind='claim' AND NOT EXISTS(SELECT 1 FROM public.record_index i WHERE i.digest=r.digest AND i.key='knowledge.feeding.object') THEN RETURN NULL;END IF;
 INSERT INTO public.object_holds SELECT DISTINCT r.digest,x.* FROM public.hub_object_refs(r.kind,r.body) x ON CONFLICT DO NOTHING;
 RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION hub_track_object_holds() FROM PUBLIC;
INSERT INTO object_holds SELECT DISTINCT r.digest,x.* FROM records r CROSS JOIN LATERAL hub_object_refs(r.kind,r.body) x
 WHERE r.kind NOT IN ('source_artifact','knowledge_space_version') AND (r.kind<>'claim' OR EXISTS(SELECT 1 FROM record_index i WHERE i.digest=r.digest AND i.key='knowledge.feeding.object'));
CREATE TRIGGER records_object_holds AFTER INSERT ON records FOR EACH ROW EXECUTE FUNCTION hub_track_object_holds();
CREATE TRIGGER record_index_object_holds AFTER INSERT ON record_index FOR EACH ROW EXECUTE FUNCTION hub_track_object_holds();

CREATE FUNCTION hub_personal_migrate_inline() RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE r records%ROWTYPE; b json; o text; h text; e text:='00000000-0000-4000-8000-000000000001'; proof text; marker text; original_digest text;
BEGIN
 IF current_user<>pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='records'::regclass))
 OR EXISTS(SELECT 1 FROM schema_migrations WHERE version=14) THEN
 RAISE EXCEPTION 'migration owner only, once' USING ERRCODE='42501'; END IF;
 PERFORM set_config('circle_hub.personal_layout_conversion','14',true);
 FOR r IN SELECT * FROM records WHERE kind IN
 ('knowledge_space_entry','knowledge_space_version','knowledge_space_source','knowledge_space_grant',
 'memory_document','memory_version','memory_grant','source_artifact') ORDER BY seq LOOP
 b:=replace(r.body,chr(92)||'u0000',chr(92)||'u0001')::json; o:=b->>'space';
 IF r.kind='source_artifact' THEN
 SELECT (replace(x.body,chr(92)||'u0000',chr(92)||'u0001')::json)->>'space' INTO o FROM (SELECT x0.kind,COALESCE(convert_from(p.data,'UTF8'),x0.body) AS body FROM records x0 LEFT JOIN personal_record_bindings pb ON pb.record=x0.digest LEFT JOIN personal_payloads p ON (p.owner,p.epoch,p.sha256)=(pb.owner,pb.epoch,pb.sha256)) x
 WHERE x.kind='knowledge_space_source' AND (replace(x.body,chr(92)||'u0000',chr(92)||'u0001')::json)->>'artifact'=r.digest
 AND (replace(x.body,chr(92)||'u0000',chr(92)||'u0001')::json)->>'space' = b->'author'->>'user' LIMIT 1;
 END IF;
 IF r.kind='source_artifact' AND EXISTS(SELECT 1 FROM object_holds h WHERE h.artifact AND h.sha256=r.digest) THEN CONTINUE;END IF;
 IF r.kind='source_artifact' AND (b->'origin'->'upload' IS NULL OR b->'visibility'->>'admins'<>'false' OR b->'author'->>'user' IS DISTINCT FROM o) THEN CONTINUE; END IF;
 IF o IS NULL OR o !~ '^usr_[0-9a-z]{26}$' THEN CONTINUE; END IF;
 original_digest:=encode(sha256(convert_to('{"body":'||r.body||',"created_at":'||
 to_json(to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text||
 ',"kind":'||to_json(r.kind)::text||',"provenance":'||to_json(r.provenance)::text||
 ',"schema":'||to_json(r.schema)::text||'}','UTF8')),'hex');
 IF original_digest<>r.digest THEN RAISE EXCEPTION 'personal record digest mismatch before conversion'; END IF;
 INSERT INTO personal_spaces(owner,epoch) VALUES(o,e) ON CONFLICT DO NOTHING;
 h:=encode(sha256(convert_to(r.body,'UTF8')),'hex');
 INSERT INTO personal_payloads VALUES(o,e,h,convert_to(r.body,'UTF8')) ON CONFLICT DO NOTHING;
 proof:=hub_personal_proof(r.digest,h,o,e,octet_length(r.body),r.created_at,r.kind,r.provenance,r.schema);
 marker:=json_build_object('personal_payload',h,'owner',o,'epoch',e,'record',r.digest,'proof',proof)::text;
 INSERT INTO personal_record_bindings VALUES(r.digest,o,e,h,octet_length(r.body),marker,proof);
 UPDATE records SET body=marker WHERE digest=r.digest;
 IF NOT EXISTS(SELECT 1 FROM records x JOIN personal_record_bindings q ON q.record=x.digest
 JOIN personal_payloads p ON (p.owner,p.epoch,p.sha256)=(q.owner,q.epoch,q.sha256)
 WHERE x.digest=original_digest AND x.body=q.marker AND convert_from(p.data,'UTF8')=r.body)
 THEN RAISE EXCEPTION 'personal record changed during conversion'; END IF;
 END LOOP;
 PERFORM set_config('circle_hub.personal_layout_conversion','',true);
END $fn$;
REVOKE ALL ON FUNCTION hub_personal_migrate_inline() FROM PUBLIC;
SELECT hub_personal_migrate_inline();
INSERT INTO object_holds SELECT DISTINCT r.digest,x.* FROM records r CROSS JOIN LATERAL hub_object_refs(r.kind,r.body) x
 WHERE r.kind IN ('source_artifact','knowledge_space_version') AND NOT EXISTS(SELECT 1 FROM personal_record_bindings b WHERE b.record=r.digest);
CREATE TABLE personal_legacy_candidates(record text PRIMARY KEY REFERENCES records(digest));
INSERT INTO personal_legacy_candidates SELECT record FROM personal_record_bindings;
CREATE TRIGGER personal_legacy_candidates_append_only BEFORE UPDATE OR DELETE ON personal_legacy_candidates FOR EACH ROW EXECUTE FUNCTION hub_append_only();
CREATE TRIGGER personal_legacy_candidates_no_truncate BEFORE TRUNCATE ON personal_legacy_candidates FOR EACH STATEMENT EXECUTE FUNCTION hub_append_only();

CREATE FUNCTION hub_read_records() RETURNS TABLE(seq bigint,id text,digest text,kind text,schema text,
 provenance text,created_at timestamptz,body text,size integer) LANGUAGE sql STABLE AS $fn$
 SELECT r.seq,r.id,r.digest,r.kind,r.schema,r.provenance,r.created_at,
 CASE WHEN b.record IS NULL OR r.body<>b.marker OR p.data IS NULL THEN r.body
 ELSE convert_from(p.data,'UTF8') END,r.size FROM public.records r
 LEFT JOIN public.personal_record_bindings b ON b.record=r.digest
 LEFT JOIN public.personal_payloads p ON (p.owner,p.epoch,p.sha256)=(b.owner,b.epoch,b.sha256)
 WHERE NOT EXISTS(SELECT 1 FROM public.personal_purges x WHERE (x.owner,x.epoch)=(b.owner,b.epoch))
$fn$;
CREATE FUNCTION hub_purge_personal(o pg_catalog.text,e pg_catalog.text) RETURNS pg_catalog.void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $fn$
BEGIN
 PERFORM 1 FROM public.personal_spaces WHERE owner=o AND epoch=e FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'unavailable' USING ERRCODE='P0002'; END IF;
 IF EXISTS(SELECT 1 FROM public.personal_record_bindings b WHERE b.owner=o AND b.epoch=e AND NOT EXISTS(SELECT 1 FROM public.personal_legacy_ready d WHERE d.record=b.record))
 OR EXISTS(SELECT 1 FROM public.personal_objects x JOIN public.personal_legacy_retire q ON q.sha256=x.sha256 WHERE x.owner=o AND x.epoch=e AND NOT EXISTS(SELECT 1 FROM public.personal_legacy_retired d WHERE d.sha256=q.sha256)) THEN
 RAISE EXCEPTION 'legacy personal object materialization incomplete'; END IF;
 INSERT INTO public.personal_purges(owner,epoch) VALUES(o,e) ON CONFLICT DO NOTHING;
 DELETE FROM public.personal_payloads WHERE owner=o AND epoch=e;
 UPDATE public.personal_spaces SET mode='local' WHERE owner=o AND epoch=e;
 DELETE FROM public.knowledge_space_search WHERE space=o;
 DELETE FROM public.knowledge_space_search_ready WHERE version IN
 (SELECT record FROM public.personal_record_bindings WHERE owner=o AND epoch=e);
 DELETE FROM public.knowledge_space_search_totals WHERE quota_space=o;
 DELETE FROM public.knowledge_space_search_documents d WHERE record IN
 (SELECT record FROM public.personal_record_bindings WHERE owner=o AND epoch=e)
 AND NOT EXISTS(SELECT 1 FROM public.knowledge_space_search s WHERE s.record=d.record);
 DELETE FROM public.memory_heads WHERE space=o;
 DELETE FROM public.memory_space_usage WHERE space=o;
END $fn$;
REVOKE ALL ON FUNCTION hub_purge_personal(text,text) FROM PUBLIC;
CREATE TABLE personal_legacy_ready (record text PRIMARY KEY REFERENCES records(digest));
CREATE TRIGGER personal_legacy_ready_append_only BEFORE UPDATE OR DELETE ON personal_legacy_ready FOR EACH ROW EXECUTE FUNCTION hub_append_only();
CREATE TRIGGER personal_legacy_ready_no_truncate BEFORE TRUNCATE ON personal_legacy_ready FOR EACH STATEMENT EXECUTE FUNCTION hub_append_only();
-- A runtime INSERT cannot shadow a team record or manufacture a cleared capsule.
CREATE FUNCTION hub_check_personal_binding() RETURNS pg_catalog.trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE r public.records%ROWTYPE; p pg_catalog.bytea; b pg_catalog.json; h pg_catalog.text;
BEGIN
 SELECT * INTO r FROM records WHERE digest=NEW.record;
 SELECT data INTO p FROM personal_payloads WHERE owner=NEW.owner AND epoch=NEW.epoch AND sha256=NEW.sha256;
 IF NOT EXISTS(SELECT 1 FROM personal_spaces WHERE owner=NEW.owner AND epoch=NEW.epoch AND mode='hub') THEN RAISE EXCEPTION 'inactive personal scope'; END IF;
 IF r.digest IS NULL OR p IS NULL OR r.body<>NEW.marker OR NEW.marker::jsonb<>jsonb_build_object('personal_payload',NEW.sha256,'owner',NEW.owner,'epoch',NEW.epoch,'record',NEW.record,'proof',NEW.proof)
 THEN RAISE EXCEPTION 'invalid personal capsule'; END IF;
 b:=replace(convert_from(p,'UTF8'),chr(92)||'u0000',chr(92)||'u0001')::json;
 IF r.kind NOT IN ('knowledge_space_entry','knowledge_space_version','knowledge_space_source','knowledge_space_grant','memory_document','memory_version','memory_grant','source_artifact')
 OR (r.kind<>'source_artifact' AND (b->>'space') IS DISTINCT FROM NEW.owner)
 OR (r.kind='source_artifact' AND ((b->'author'->>'user') IS DISTINCT FROM NEW.owner OR b->'origin'->'upload' IS NULL OR b->'visibility'->>'admins'<>'false'))
 THEN RAISE EXCEPTION 'not a personal payload'; END IF;
 IF r.kind='source_artifact' AND NOT EXISTS(
 SELECT 1 FROM public.hub_read_records() s JOIN public.personal_record_bindings q ON q.record=s.digest
 WHERE s.kind='knowledge_space_source' AND q.owner=NEW.owner AND q.epoch=NEW.epoch
 AND (replace(s.body,chr(92)||'u0000',chr(92)||'u0001')::json)->>'space'=NEW.owner
 AND (replace(s.body,chr(92)||'u0000',chr(92)||'u0001')::json)->>'artifact'=NEW.record) THEN RAISE EXCEPTION 'personal artifact has no owning knowledge source';END IF;
 IF b->'personal_scope' IS NOT NULL THEN
 IF (b->'personal_scope')::jsonb<>jsonb_build_object('owner',NEW.owner,'epoch',NEW.epoch) THEN RAISE EXCEPTION 'personal artifact scope mismatch';END IF;
 END IF;
 h:=encode(sha256(convert_to('{"body":'||convert_from(p,'UTF8')||',"created_at":'||to_json(to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text||',"kind":'||to_json(r.kind)::text||',"provenance":'||to_json(r.provenance)::text||',"schema":'||to_json(r.schema)::text||'}','UTF8')),'hex');
 IF h<>r.digest OR NEW.bytes<>octet_length(p) OR NEW.proof<>hub_personal_proof(r.digest,NEW.sha256,NEW.owner,NEW.epoch,NEW.bytes,r.created_at,r.kind,r.provenance,r.schema)
 THEN RAISE EXCEPTION 'personal capsule digest mismatch'; END IF;
 PERFORM public.hub_finish_personal_record(NEW.record);
 RETURN NULL;
END $fn$;
CREATE CONSTRAINT TRIGGER personal_binding_check AFTER INSERT ON personal_record_bindings
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hub_check_personal_binding();
CREATE TABLE personal_legacy_retire (sha256 text PRIMARY KEY);
CREATE TRIGGER personal_legacy_retire_append_only BEFORE UPDATE OR DELETE ON personal_legacy_retire FOR EACH ROW EXECUTE FUNCTION hub_append_only();
CREATE TRIGGER personal_legacy_retire_no_truncate BEFORE TRUNCATE ON personal_legacy_retire FOR EACH STATEMENT EXECUTE FUNCTION hub_append_only();
CREATE TABLE personal_legacy_retired (sha256 text PRIMARY KEY REFERENCES personal_legacy_retire(sha256));
CREATE TRIGGER personal_legacy_retired_append_only BEFORE UPDATE OR DELETE ON personal_legacy_retired FOR EACH ROW EXECUTE FUNCTION hub_append_only();
CREATE TRIGGER personal_legacy_retired_no_truncate BEFORE TRUNCATE ON personal_legacy_retired FOR EACH STATEMENT EXECUTE FUNCTION hub_append_only();
-- Runtime can only record completion after the scoped bytes actually exist.
CREATE FUNCTION hub_personal_tree_children(o text,e text,h text) RETURNS SETOF text LANGUAGE plpgsql
 SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE data bytea;
BEGIN
 SELECT p.data INTO data FROM public.personal_payloads p WHERE p.owner=o AND p.epoch=e AND p.sha256=h;
 IF FOUND THEN RETURN QUERY SELECT child->>'digest' FROM json_array_elements(COALESCE(replace(convert_from(data,'UTF8'),chr(92)||'u0000',chr(92)||'u0001')::json->'children','[]'::json)) child;END IF;
END $fn$;
REVOKE ALL ON FUNCTION hub_personal_tree_children(text,text,text) FROM PUBLIC;
CREATE FUNCTION hub_finish_personal_record(d pg_catalog.text) RETURNS pg_catalog.void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE x pg_catalog.record;b pg_catalog.json;missing pg_catalog.bool;hashes pg_catalog.text[];
BEGIN
 SELECT r.kind,r.body AS stored_marker,q.*,p.data INTO x FROM public.records r JOIN public.personal_record_bindings q ON q.record=r.digest
 JOIN public.personal_payloads p ON (p.owner,p.epoch,p.sha256)=(q.owner,q.epoch,q.sha256) WHERE r.digest=d;
 IF NOT FOUND THEN RAISE EXCEPTION 'personal record transfer incomplete';END IF;
 IF x.stored_marker<>x.marker OR x.marker::jsonb<>jsonb_build_object('personal_payload',x.sha256,'owner',x.owner,'epoch',x.epoch,'record',d,'proof',x.proof)
 THEN RAISE EXCEPTION 'invalid personal capsule';END IF;
 b:=replace(convert_from(x.data,'UTF8'),chr(92)||'u0000',chr(92)||'u0001')::json;
 PERFORM 1 FROM public.personal_spaces s WHERE s.owner=x.owner AND s.epoch=x.epoch AND s.mode='hub' FOR SHARE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.personal_purges p WHERE p.owner=x.owner AND p.epoch=x.epoch) THEN RAISE EXCEPTION 'inactive personal scope';END IF;
 IF x.kind='source_artifact' THEN
 IF NOT EXISTS(SELECT 1 FROM public.personal_objects o JOIN public.personal_payloads p ON (p.owner,p.epoch,p.sha256)=(o.owner,o.epoch,o.sha256)
 WHERE o.owner=x.owner AND o.epoch=x.epoch AND o.sha256=b->>'sha256' AND octet_length(p.data)=(b->>'size')::bigint) THEN RAISE EXCEPTION 'personal original transfer incomplete';END IF;
 hashes:=ARRAY[b->>'sha256'];
 ELSIF x.kind='knowledge_space_version' AND b->>'tree' IS NOT NULL THEN
 WITH RECURSIVE wanted(h,n) AS (SELECT b->>'tree',0 UNION
 SELECT child,w.n+1 FROM wanted w CROSS JOIN LATERAL public.hub_personal_tree_children(x.owner,x.epoch,w.h) child WHERE w.n<65),bounded AS(SELECT * FROM wanted LIMIT 10001)
 SELECT array_agg(DISTINCT w.h),bool_or(p.sha256 IS NULL OR o.sha256 IS NULL OR w.n>64) OR count(*)>10000 INTO hashes,missing FROM bounded w LEFT JOIN public.personal_payloads p ON p.owner=x.owner AND p.epoch=x.epoch AND p.sha256=w.h
 LEFT JOIN public.personal_objects o ON o.owner=x.owner AND o.epoch=x.epoch AND o.sha256=w.h;
 IF missing THEN RAISE EXCEPTION 'personal tree transfer incomplete';END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM public.personal_legacy_candidates WHERE record=d) THEN
 INSERT INTO public.personal_legacy_retire(sha256) SELECT unnest(hashes) ON CONFLICT DO NOTHING;
 END IF;
 INSERT INTO public.personal_legacy_ready(record) VALUES(d) ON CONFLICT DO NOTHING;
END $fn$;
REVOKE ALL ON FUNCTION hub_finish_personal_record(text) FROM PUBLIC;
CREATE FUNCTION hub_finish_personal_retirement(h pg_catalog.text) RETURNS pg_catalog.void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $fn$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.personal_legacy_retire WHERE sha256=h)
 OR EXISTS(SELECT 1 FROM public.personal_record_bindings b WHERE NOT EXISTS(SELECT 1 FROM public.personal_legacy_ready r WHERE r.record=b.record)
 AND NOT EXISTS(SELECT 1 FROM public.personal_purges p WHERE p.owner=b.owner AND p.epoch=b.epoch))
 OR NOT EXISTS(SELECT 1 FROM public.personal_objects o JOIN public.personal_payloads p ON (p.owner,p.epoch,p.sha256)=(o.owner,o.epoch,o.sha256) WHERE o.sha256=h)
 THEN RAISE EXCEPTION 'personal retirement transfer incomplete';END IF;
 -- Filesystem removal and directory durability are checked by the application before calling this function.
 INSERT INTO public.personal_legacy_retired(sha256) VALUES(h) ON CONFLICT DO NOTHING;
END $fn$;
REVOKE ALL ON FUNCTION hub_finish_personal_retirement(text) FROM PUBLIC;
CREATE FUNCTION hub_active_personal_insert() RETURNS pg_catalog.trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $fn$
BEGIN
 PERFORM 1 FROM public.personal_spaces WHERE owner=NEW.owner AND epoch=NEW.epoch AND mode='hub' FOR SHARE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.personal_purges WHERE owner=NEW.owner AND epoch=NEW.epoch) THEN RAISE EXCEPTION 'inactive personal scope';END IF;
 IF TG_TABLE_NAME='personal_objects' THEN
 IF NOT EXISTS(SELECT 1 FROM public.personal_payloads WHERE owner=NEW.owner AND epoch=NEW.epoch AND sha256=NEW.sha256) THEN RAISE EXCEPTION 'personal object has no payload';END IF;
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION hub_active_personal_insert() FROM PUBLIC;
CREATE TRIGGER personal_payloads_active BEFORE INSERT ON personal_payloads FOR EACH ROW EXECUTE FUNCTION hub_active_personal_insert();
CREATE TRIGGER personal_objects_active BEFORE INSERT ON personal_objects FOR EACH ROW EXECUTE FUNCTION hub_active_personal_insert();
CREATE INDEX personal_record_bindings_scope ON personal_record_bindings(owner,epoch,record);
CREATE FUNCTION hub_resume_personal(o pg_catalog.text,e pg_catalog.text,n pg_catalog.text) RETURNS pg_catalog.void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $fn$
BEGIN
 PERFORM 1 FROM public.personal_spaces WHERE owner=o AND epoch=e AND mode='local' FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.personal_purges WHERE owner=o AND epoch=e)
 OR n=e OR n !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 OR EXISTS(SELECT 1 FROM public.personal_purges WHERE owner=o AND epoch=n)
 OR EXISTS(SELECT 1 FROM public.personal_record_bindings WHERE owner=o AND epoch=n) THEN RAISE EXCEPTION 'unavailable' USING ERRCODE='P0002';END IF;
 UPDATE public.personal_spaces SET epoch=n,mode='hub' WHERE owner=o AND epoch=e;
END $fn$;
REVOKE ALL ON FUNCTION hub_resume_personal(text,text,text) FROM PUBLIC;

`},
  {version:15,name:'personal_sync_transport',sql:`CREATE TABLE personal_sync_heads (
 owner text NOT NULL REFERENCES users(id),epoch text NOT NULL,snapshot text,last_synced_at timestamptz,
 PRIMARY KEY(owner,epoch)
);
CREATE TABLE personal_sync_identities (
 owner text NOT NULL REFERENCES users(id),epoch text NOT NULL,kind text NOT NULL,identity text NOT NULL,item_id uuid NOT NULL,
 PRIMARY KEY(owner,epoch,kind,identity)
);
CREATE TABLE personal_sync_clients (
 owner text NOT NULL REFERENCES users(id),epoch text NOT NULL,client_id uuid NOT NULL,name_payload text NOT NULL,
 PRIMARY KEY(owner,epoch,client_id)
);
CREATE TABLE personal_sync_sessions (
 id uuid PRIMARY KEY,owner text NOT NULL REFERENCES users(id),epoch text NOT NULL,client_id uuid NOT NULL,
 snapshot text NOT NULL,state_version text NOT NULL,expires_at timestamptz NOT NULL,
 FOREIGN KEY(owner,epoch,client_id) REFERENCES personal_sync_clients(owner,epoch,client_id)
);
CREATE INDEX personal_sync_sessions_scope ON personal_sync_sessions(owner,epoch,expires_at);
CREATE TABLE personal_sync_objects (
 owner text NOT NULL REFERENCES users(id),epoch text NOT NULL,id text NOT NULL,kind text NOT NULL,bytes integer NOT NULL CHECK(bytes>0),charge_bytes integer NOT NULL CHECK(charge_bytes>0 AND charge_bytes<=bytes),
 PRIMARY KEY(owner,epoch,id)
);
CREATE TRIGGER personal_sync_objects_immutable BEFORE UPDATE ON personal_sync_objects FOR EACH ROW EXECUTE FUNCTION hub_append_only();
CREATE TABLE personal_sync_edges (
 owner text NOT NULL REFERENCES users(id),epoch text NOT NULL,parent text NOT NULL,child text NOT NULL,
 PRIMARY KEY(owner,epoch,parent,child)
);
CREATE TABLE personal_sync_session_objects (
 session_id uuid NOT NULL REFERENCES personal_sync_sessions(id),object_id text NOT NULL,frozen boolean NOT NULL DEFAULT false,
 PRIMARY KEY(session_id,object_id)
);
CREATE INDEX personal_sync_session_objects_object ON personal_sync_session_objects(object_id,session_id);
CREATE TABLE personal_sync_retained (
 owner text NOT NULL REFERENCES users(id),epoch text NOT NULL,object_id text NOT NULL,
 PRIMARY KEY(owner,epoch,object_id)
);
CREATE TABLE personal_sync_operations (
 owner text NOT NULL REFERENCES users(id),epoch text NOT NULL,operation_id text NOT NULL,request text NOT NULL,receipt text NOT NULL,
 PRIMARY KEY(owner,epoch,operation_id)
);
CREATE TABLE personal_sync_aborts (
 session_id uuid PRIMARY KEY REFERENCES personal_sync_sessions(id),at timestamptz NOT NULL
);
CREATE FUNCTION hub_collect_personal_sync(o pg_catalog.text,e pg_catalog.text,t pg_catalog.timestamptz) RETURNS pg_catalog.int4 LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE removed pg_catalog.text[];total pg_catalog.int4;
BEGIN
 -- Only unretained transport objects with no live session may be collected; ordinary personal objects stay intact.
 WITH RECURSIVE roots(id) AS (
 SELECT snapshot FROM public.personal_sync_heads WHERE owner=o AND epoch=e AND snapshot IS NOT NULL UNION
 SELECT object_id FROM public.personal_sync_retained WHERE owner=o AND epoch=e),
 protected(id) AS (SELECT id FROM roots UNION SELECT x.child FROM public.personal_sync_edges x JOIN protected p ON x.parent=p.id WHERE x.owner=o AND x.epoch=e),
 gone AS (
 DELETE FROM public.personal_sync_objects x WHERE x.owner=o AND x.epoch=e
 AND NOT EXISTS(SELECT 1 FROM protected p WHERE p.id=x.id)
 AND NOT EXISTS(SELECT 1 FROM public.personal_sync_session_objects r JOIN public.personal_sync_sessions s ON s.id=r.session_id
 WHERE r.object_id=x.id AND s.owner=o AND s.epoch=e AND s.expires_at>t
 AND NOT EXISTS(SELECT 1 FROM public.personal_sync_aborts a WHERE a.session_id=s.id)) RETURNING id)
 SELECT array_agg(id),count(*)::integer INTO removed,total FROM gone;
 DELETE FROM public.personal_payloads p WHERE p.owner=o AND p.epoch=e AND p.sha256=ANY(removed)
 AND NOT EXISTS(SELECT 1 FROM public.personal_record_bindings b WHERE (b.owner,b.epoch,b.sha256)=(p.owner,p.epoch,p.sha256))
 AND NOT EXISTS(SELECT 1 FROM public.personal_objects x WHERE (x.owner,x.epoch,x.sha256)=(p.owner,p.epoch,p.sha256))
 AND NOT EXISTS(SELECT 1 FROM public.personal_sync_clients c WHERE (c.owner,c.epoch,c.name_payload)=(p.owner,p.epoch,p.sha256));
 RETURN total;
END $fn$;
REVOKE ALL ON FUNCTION hub_collect_personal_sync(text,text,timestamptz) FROM PUBLIC;

CREATE TRIGGER personal_sync_identities_append_only BEFORE UPDATE OR DELETE ON personal_sync_identities FOR EACH ROW EXECUTE FUNCTION hub_append_only();
CREATE TRIGGER personal_sync_identities_no_truncate BEFORE TRUNCATE ON personal_sync_identities FOR EACH STATEMENT EXECUTE FUNCTION hub_append_only();

CREATE TRIGGER personal_sync_clients_append_only BEFORE UPDATE OR DELETE ON personal_sync_clients FOR EACH ROW EXECUTE FUNCTION hub_append_only();
CREATE TRIGGER personal_sync_clients_no_truncate BEFORE TRUNCATE ON personal_sync_clients FOR EACH STATEMENT EXECUTE FUNCTION hub_append_only();

CREATE TRIGGER personal_sync_sessions_append_only BEFORE UPDATE OR DELETE ON personal_sync_sessions FOR EACH ROW EXECUTE FUNCTION hub_append_only();
CREATE TRIGGER personal_sync_sessions_no_truncate BEFORE TRUNCATE ON personal_sync_sessions FOR EACH STATEMENT EXECUTE FUNCTION hub_append_only();

CREATE TRIGGER personal_sync_edges_append_only BEFORE UPDATE OR DELETE ON personal_sync_edges FOR EACH ROW EXECUTE FUNCTION hub_append_only();
CREATE TRIGGER personal_sync_edges_no_truncate BEFORE TRUNCATE ON personal_sync_edges FOR EACH STATEMENT EXECUTE FUNCTION hub_append_only();

CREATE TRIGGER personal_sync_session_objects_append_only BEFORE UPDATE OR DELETE ON personal_sync_session_objects FOR EACH ROW EXECUTE FUNCTION hub_append_only();
CREATE TRIGGER personal_sync_session_objects_no_truncate BEFORE TRUNCATE ON personal_sync_session_objects FOR EACH STATEMENT EXECUTE FUNCTION hub_append_only();

CREATE TRIGGER personal_sync_retained_append_only BEFORE UPDATE OR DELETE ON personal_sync_retained FOR EACH ROW EXECUTE FUNCTION hub_append_only();
CREATE TRIGGER personal_sync_retained_no_truncate BEFORE TRUNCATE ON personal_sync_retained FOR EACH STATEMENT EXECUTE FUNCTION hub_append_only();

CREATE TRIGGER personal_sync_operations_append_only BEFORE UPDATE OR DELETE ON personal_sync_operations FOR EACH ROW EXECUTE FUNCTION hub_append_only();
CREATE TRIGGER personal_sync_operations_no_truncate BEFORE TRUNCATE ON personal_sync_operations FOR EACH STATEMENT EXECUTE FUNCTION hub_append_only();

CREATE TRIGGER personal_sync_aborts_append_only BEFORE UPDATE OR DELETE ON personal_sync_aborts FOR EACH ROW EXECUTE FUNCTION hub_append_only();
CREATE TRIGGER personal_sync_aborts_no_truncate BEFORE TRUNCATE ON personal_sync_aborts FOR EACH STATEMENT EXECUTE FUNCTION hub_append_only();
`},
 {version:16,name:'personal_sync_commit',sql:`ALTER TABLE personal_sync_heads ADD COLUMN native_state text, ADD COLUMN memory_projection text, ADD COLUMN conflicts integer NOT NULL DEFAULT 0;
CREATE FUNCTION hub_lock_personal_scope(o pg_catalog.text) RETURNS TABLE(epoch pg_catalog.text,mode pg_catalog.text) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fn$ SELECT p.epoch,p.mode FROM public.personal_spaces p WHERE p.owner=o FOR SHARE $fn$;
REVOKE ALL ON FUNCTION hub_lock_personal_scope(pg_catalog.text) FROM PUBLIC;
CREATE FUNCTION hub_replace_personal_memory(o pg_catalog.text,e pg_catalog.text,h pg_catalog.jsonb) RETURNS pg_catalog.void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE x pg_catalog.jsonb;b pg_catalog.jsonb;d pg_catalog.text;v pg_catalog.text;history pg_catalog.int8;
BEGIN
 PERFORM 1 FROM public.personal_spaces WHERE owner=o AND epoch=e AND mode='hub' FOR SHARE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.personal_purges WHERE owner=o AND epoch=e) THEN RAISE EXCEPTION 'inactive personal scope';END IF;
 IF jsonb_typeof(h)<>'array' OR jsonb_array_length(h)>10000 THEN RAISE EXCEPTION 'invalid memory projection';END IF;
 FOR x IN SELECT jsonb_array_elements(h) LOOP
 d:=x->>'document';v:=x->>'version';
 SELECT replace(r.body,chr(92)||'u0000',chr(92)||'u0001')::jsonb INTO b FROM public.hub_read_records() r JOIN public.personal_record_bindings p ON p.record=r.digest WHERE p.owner=o AND p.epoch=e AND r.digest=v AND r.kind='memory_version';
 IF b IS NULL OR b->>'space'<>o OR b->>'document'<>d OR NOT EXISTS(SELECT 1 FROM public.personal_record_bindings p JOIN public.records r ON r.digest=p.record WHERE p.owner=o AND p.epoch=e AND p.record=d AND r.kind='memory_document') THEN RAISE EXCEPTION 'invalid memory projection';END IF;
 END LOOP;
 DELETE FROM public.memory_heads WHERE space=o;
 FOR x IN SELECT jsonb_array_elements(h) LOOP
 SELECT replace(r.body,chr(92)||'u0000',chr(92)||'u0001')::jsonb INTO b FROM public.hub_read_records() r WHERE digest=x->>'version';
 INSERT INTO public.memory_heads(document,space,version,path,state,bytes,context_bytes) VALUES(x->>'document',o,x->>'version',b->>'path',b->>'state',(b->>'bytes')::bigint,octet_length(b->>'title')+octet_length(b->>'path')+(b->>'bytes')::bigint);
 END LOOP;
 SELECT COALESCE(sum(r.size),0) INTO history FROM public.records r JOIN public.personal_record_bindings b ON b.record=r.digest WHERE b.owner=o AND b.epoch=e AND r.kind IN ('memory_document','memory_version');
 INSERT INTO public.memory_space_usage(space,active_bytes,history_bytes,active_documents)
 SELECT o,COALESCE(sum(context_bytes) FILTER(WHERE state='enabled'),0),history,count(*) FILTER(WHERE state='enabled') FROM public.memory_heads WHERE space=o
 ON CONFLICT(space) DO UPDATE SET active_bytes=EXCLUDED.active_bytes,history_bytes=EXCLUDED.history_bytes,active_documents=EXCLUDED.active_documents;
END $fn$;
REVOKE ALL ON FUNCTION hub_replace_personal_memory(text,text,jsonb) FROM PUBLIC;

CREATE TABLE personal_sync_bindings(owner text NOT NULL REFERENCES users(id),epoch text NOT NULL,kind text NOT NULL,item_id uuid NOT NULL,object_id text NOT NULL,native text NOT NULL,locator text NOT NULL,PRIMARY KEY(owner,epoch,kind,object_id,native,locator));
CREATE INDEX personal_sync_bindings_native ON personal_sync_bindings(owner,epoch,kind,native,locator);
CREATE TABLE personal_sync_notes(owner text NOT NULL REFERENCES users(id),epoch text NOT NULL,kind text NOT NULL,id text NOT NULL,payload text NOT NULL,bytes integer NOT NULL CHECK(bytes>=0),PRIMARY KEY(owner,epoch,kind,id));
CREATE TABLE personal_sync_native_credits(owner text NOT NULL REFERENCES users(id),epoch text NOT NULL,event text NOT NULL,bytes bigint NOT NULL CHECK(bytes>=0),PRIMARY KEY(owner,epoch,event));
CREATE TABLE personal_sync_exports(owner text NOT NULL REFERENCES users(id),epoch text NOT NULL,object_id text NOT NULL,PRIMARY KEY(owner,epoch,object_id));
CREATE TABLE personal_sync_memory_reservations(owner text NOT NULL REFERENCES users(id),epoch text NOT NULL,bytes bigint NOT NULL CHECK(bytes>=0),documents integer NOT NULL CHECK(documents>=0),PRIMARY KEY(owner,epoch));
CREATE TRIGGER personal_sync_bindings_append_only BEFORE UPDATE OR DELETE ON personal_sync_bindings FOR EACH ROW EXECUTE FUNCTION hub_append_only();
CREATE TRIGGER personal_sync_bindings_no_truncate BEFORE TRUNCATE ON personal_sync_bindings FOR EACH STATEMENT EXECUTE FUNCTION hub_append_only();
CREATE TRIGGER personal_sync_notes_append_only BEFORE UPDATE OR DELETE ON personal_sync_notes FOR EACH ROW EXECUTE FUNCTION hub_append_only();
CREATE TRIGGER personal_sync_notes_no_truncate BEFORE TRUNCATE ON personal_sync_notes FOR EACH STATEMENT EXECUTE FUNCTION hub_append_only();
CREATE TRIGGER personal_sync_native_credits_append_only BEFORE UPDATE OR DELETE ON personal_sync_native_credits FOR EACH ROW EXECUTE FUNCTION hub_append_only();
CREATE TRIGGER personal_sync_native_credits_no_truncate BEFORE TRUNCATE ON personal_sync_native_credits FOR EACH STATEMENT EXECUTE FUNCTION hub_append_only();
CREATE TRIGGER personal_sync_exports_append_only BEFORE UPDATE OR DELETE ON personal_sync_exports FOR EACH ROW EXECUTE FUNCTION hub_append_only();
CREATE TRIGGER personal_sync_exports_no_truncate BEFORE TRUNCATE ON personal_sync_exports FOR EACH STATEMENT EXECUTE FUNCTION hub_append_only();
`},
 {version:17,name:'run_originals',sql:`CREATE TABLE run_originals (
 artifact pg_catalog.text PRIMARY KEY REFERENCES records(digest),
 held_by pg_catalog.text NOT NULL REFERENCES records(digest),
 sha256 pg_catalog.text NOT NULL,body pg_catalog.text NOT NULL,data pg_catalog.bytea NOT NULL,
 CHECK(pg_catalog.encode(pg_catalog.sha256(data),'hex')=sha256)
);
CREATE INDEX run_originals_sha256 ON run_originals(sha256);
CREATE TRIGGER run_originals_append_only BEFORE UPDATE OR DELETE ON run_originals FOR EACH ROW EXECUTE FUNCTION hub_append_only();
CREATE TRIGGER run_originals_no_truncate BEFORE TRUNCATE ON run_originals FOR EACH STATEMENT EXECUTE FUNCTION hub_append_only();
CREATE FUNCTION hub_keep_run_originals(r pg_catalog.text,must_exist pg_catalog.bool) RETURNS pg_catalog.void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE b pg_catalog.record;body pg_catalog.text;original pg_catalog.jsonb;raw pg_catalog.bytea;
BEGIN
 FOR b IN SELECT DISTINCT p.* FROM public.object_holds h JOIN public.personal_record_bindings p ON p.record=h.sha256
 JOIN public.records c ON c.digest=p.record JOIN public.records v ON v.digest=h.record
 WHERE h.record=r AND h.artifact AND c.kind='source_artifact' AND v.kind='run' ORDER BY p.owner,p.epoch,p.record LOOP
 IF EXISTS(SELECT 1 FROM public.run_originals WHERE artifact=b.record) THEN CONTINUE;END IF;
 PERFORM 1 FROM public.personal_spaces s WHERE s.owner=b.owner AND s.epoch=b.epoch AND s.mode='hub' FOR SHARE;
 IF NOT FOUND THEN IF must_exist THEN RAISE EXCEPTION 'run original scope is unavailable';ELSE CONTINUE;END IF;END IF;
 SELECT pg_catalog.convert_from(p.data,'UTF8') INTO body FROM public.personal_payloads p
 WHERE (p.owner,p.epoch,p.sha256)=(b.owner,b.epoch,b.sha256)
 AND NOT EXISTS(SELECT 1 FROM public.personal_purges x WHERE (x.owner,x.epoch)=(b.owner,b.epoch));
 IF body IS NULL THEN IF must_exist THEN RAISE EXCEPTION 'run original is unavailable';ELSE CONTINUE;END IF;END IF;
 original:=pg_catalog.replace(body,pg_catalog.chr(92)||'u0000',pg_catalog.chr(92)||'u0001')::pg_catalog.jsonb;
 IF original->'origin'->'upload' IS NULL THEN CONTINUE;END IF;
 SELECT p.data INTO raw FROM public.personal_objects o JOIN public.personal_payloads p ON (p.owner,p.epoch,p.sha256)=(o.owner,o.epoch,o.sha256)
 WHERE (o.owner,o.epoch,o.sha256)=(b.owner,b.epoch,original->>'sha256');
 IF raw IS NULL THEN RAISE EXCEPTION 'run original bytes are unavailable';END IF;
 INSERT INTO public.run_originals VALUES(b.record,r,original->>'sha256',body,raw) ON CONFLICT DO NOTHING;
 END LOOP;
END $fn$;
REVOKE ALL ON FUNCTION hub_keep_run_originals(pg_catalog.text,pg_catalog.bool) FROM PUBLIC;
CREATE FUNCTION hub_keep_inserted_run_originals() RETURNS pg_catalog.trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $fn$
BEGIN PERFORM public.hub_keep_run_originals(NEW.digest,true);RETURN NULL;END $fn$;
REVOKE ALL ON FUNCTION hub_keep_inserted_run_originals() FROM PUBLIC;
CREATE TRIGGER records_run_originals AFTER INSERT ON records FOR EACH ROW WHEN(NEW.kind='run') EXECUTE FUNCTION hub_keep_inserted_run_originals();
SELECT public.hub_keep_run_originals(r.digest,false) FROM public.records r WHERE r.kind='run'
 AND EXISTS(SELECT 1 FROM public.object_holds h JOIN public.personal_record_bindings b ON b.record=h.sha256 WHERE h.record=r.digest AND h.artifact);
CREATE OR REPLACE FUNCTION hub_read_records() RETURNS TABLE(seq pg_catalog.int8,id pg_catalog.text,digest pg_catalog.text,kind pg_catalog.text,schema pg_catalog.text,
 provenance pg_catalog.text,created_at pg_catalog.timestamptz,body pg_catalog.text,size pg_catalog.int4) LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $fn$
 SELECT r.seq,r.id,r.digest,r.kind,r.schema,r.provenance,r.created_at,
 CASE WHEN h.artifact IS NOT NULL THEN h.body WHEN b.record IS NULL OR r.body<>b.marker OR p.data IS NULL THEN r.body
 ELSE pg_catalog.convert_from(p.data,'UTF8') END,r.size FROM public.records r
 LEFT JOIN public.personal_record_bindings b ON b.record=r.digest
 LEFT JOIN public.personal_payloads p ON (p.owner,p.epoch,p.sha256)=(b.owner,b.epoch,b.sha256)
 LEFT JOIN public.run_originals h ON h.artifact=r.digest
 WHERE h.artifact IS NOT NULL OR NOT EXISTS(SELECT 1 FROM public.personal_purges x WHERE (x.owner,x.epoch)=(b.owner,b.epoch))
$fn$;
`},
]);

/** Tables and what the runtime role may do with them; nothing else (no DELETE, no TRUNCATE, no DDL, not the owner). */
export const RUNTIME_GRANTS: Readonly<Record<string, string>> = Object.freeze({
  personal_sync_heads:'SELECT, INSERT, UPDATE (snapshot,last_synced_at,native_state,memory_projection,conflicts)',
  personal_sync_bindings:'SELECT, INSERT',
  personal_sync_notes:'SELECT, INSERT',
  personal_sync_native_credits:'SELECT, INSERT',
  personal_sync_exports:'SELECT, INSERT',
  personal_sync_memory_reservations:'SELECT, INSERT, UPDATE (bytes,documents)',
  personal_sync_identities:'SELECT, INSERT',
  personal_sync_clients:'SELECT, INSERT',
  personal_sync_sessions:'SELECT, INSERT',
  personal_sync_objects:'SELECT, INSERT',
  personal_sync_edges:'SELECT, INSERT',
  personal_sync_session_objects:'SELECT, INSERT',
  personal_sync_retained:'SELECT, INSERT',
  personal_sync_operations:'SELECT, INSERT',
  personal_sync_aborts:'SELECT, INSERT',
  run_originals:'SELECT',
  object_holds:'SELECT',
  personal_spaces:'SELECT, INSERT',
  personal_payloads:'SELECT, INSERT',
  personal_record_bindings:'SELECT, INSERT',
  personal_objects:'SELECT, INSERT',
  personal_purges:'SELECT',
  personal_legacy_ready:'SELECT',
  personal_legacy_candidates:'SELECT',
  personal_legacy_retire:'SELECT',
  personal_legacy_retired:'SELECT',
  memory_heads:'SELECT, INSERT, UPDATE (version,path,state,bytes,context_bytes)',
  memory_space_usage:'SELECT, INSERT, UPDATE (active_bytes,history_bytes,active_documents)',
  knowledge_space_search: 'SELECT, INSERT',
  knowledge_space_search_documents: 'SELECT, INSERT',
  knowledge_space_search_ready: 'SELECT, INSERT',
  knowledge_space_search_totals:'SELECT, INSERT, UPDATE (token_bytes)',
  schema_migrations: 'SELECT',
  records: 'SELECT, INSERT',
  record_index: 'SELECT, INSERT',
  record_keys: 'SELECT, INSERT',
  objects: 'SELECT, INSERT',
  user_history: 'SELECT, INSERT',
  call_logs: 'SELECT, INSERT',
  call_notes: 'SELECT, INSERT',
  call_reasons: 'SELECT, INSERT',
  users: 'SELECT, INSERT, UPDATE (role, disabled, updated_at, password_hash, password_must_change, password_revision)',
  tokens: 'SELECT, INSERT, UPDATE (last_used_at, revoked_at, revoked_by)',
  oauth_clients: 'SELECT, INSERT, DELETE',
  invitations: 'SELECT, INSERT, UPDATE (used_at, used_by_client)',
  pointers: 'SELECT, INSERT, UPDATE (target, version, moved_at, action_digest)',
  lease_registrations: 'SELECT, INSERT, UPDATE, DELETE',
  leases: 'SELECT, INSERT, UPDATE (lease_id, run_id, user_id, token, acquired_at, expires_at, released_at)',
});

const ROLE = /^[a-z_][a-z0-9_]{0,62}$/;

export function migrationChecksum(migration: Migration): string {
  return sha256Hex(migration.sql);
}

function checkList(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1 || !/^[a-z][a-z0-9_]{0,62}$/.test(migration.name) || migration.sql.trim() === '') {
      throw new TypeError(`migration list must be versions 1..n in order with names; problem at index ${index}`);
    }
  });
}

/**
 * Gives `role` exactly RUNTIME_GRANTS (after revoking everything else it had on these tables). Run as the owner, after
 * migrate(); repeatable. The runtime role must not own the tables: an owner can always disable triggers.
 */
export async function grantRuntime(db: Database, role: string, tx?: PgTransaction): Promise<void> {
  if (typeof role !== 'string' || !ROLE.test(role)) throw new TypeError('runtime role names are lowercase letters, digits and underscores');
  await db.transaction(async (t) => {
    const owner = (await db.query<{ owns: boolean }>(`SELECT pg_get_userbyid(relowner) = $1 AS owns FROM pg_class WHERE relname = 'records' AND relkind = 'r'`, [role], t)).rows[0];
    if (owner === undefined) throw new MigrationError('还没有应用迁移，不能授权运行角色');
    if (owner.owns) throw new MigrationError(`运行角色 ${role} 拥有这些表，能关掉只追加的触发器；请让另一个角色执行迁移`);
    const temporary=(await db.query<{allowed:boolean}>("SELECT pg_catalog.has_database_privilege($1,pg_catalog.current_database(),'TEMPORARY') AS allowed",[role],t)).rows[0];
    if(temporary?.allowed)throw new MigrationError(`运行角色 ${role} 有创建临时对象的权限；请先收回该权限，再授权运行角色`);
    await db.query(`GRANT EXECUTE ON FUNCTION hub_purge_personal(text,text),hub_resume_personal(text,text,text) TO "${role}"`, [], t);
    await db.query(`GRANT EXECUTE ON FUNCTION hub_collect_personal_sync(text,text,timestamptz),hub_replace_personal_memory(text,text,jsonb),hub_lock_personal_scope(text) TO "${role}"`, [], t);
    await db.query(`GRANT EXECUTE ON FUNCTION hub_finish_personal_record(text),hub_finish_personal_retirement(text) TO "${role}"`, [], t);
    for (const [table, privileges] of Object.entries(RUNTIME_GRANTS)) {
      await db.query(`REVOKE ALL ON TABLE ${table} FROM "${role}"`, [], t);
      await db.query(`GRANT ${privileges} ON TABLE ${table} TO "${role}"`, [], t);
    }
  }, tx);
}

/** For a process that does not migrate (the runtime role): refuses to start unless exactly this program's migrations are applied. */
export async function verifyMigrations(db: Database, migrations: readonly Migration[] = MIGRATIONS): Promise<void> {
  checkList(migrations);
  const privilege=(await db.query<{runtime:boolean;temporary:boolean}>("SELECT pg_catalog.pg_get_userbyid(c.relowner)<>current_user AS runtime,pg_catalog.has_database_privilege(current_user,pg_catalog.current_database(),'TEMPORARY') AS temporary FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('public.records')")).rows[0];
  if(privilege?.runtime&&privilege.temporary)throw new MigrationError('运行角色有创建临时对象的权限；请先收回该权限，拒绝启动');
  const exists = (await db.query<{ t: string | null }>("SELECT to_regclass('schema_migrations')::text AS t")).rows[0];
  const applied =
    exists?.t === null || exists === undefined ? [] : (await db.query<{ version: number; name: string; sha256: string }>('SELECT version, name, sha256 FROM schema_migrations ORDER BY version')).rows;
  const unknown = applied.filter((row) => !migrations.some((migration) => migration.version === row.version));
  if (unknown.length > 0) {
    throw new MigrationError(`数据库里有本程序不认识的迁移（版本 ${unknown.map((row) => row.version).join('、')}），可能来自更新的 Hub；拒绝启动`, {
      detail: { versions: unknown.map((row) => row.version) },
    });
  }
  for (const migration of migrations) {
    const row = applied.find((candidate) => candidate.version === migration.version);
    if (row === undefined) {
      throw new MigrationError(`迁移 ${migration.version}（${migration.name}）还没有应用；请先由拥有表的角色执行迁移，拒绝启动`, { detail: { version: migration.version } });
    }
    if (row.sha256 !== migrationChecksum(migration) || row.name !== migration.name) {
      throw new MigrationError(`已应用的迁移 ${migration.version}（${row.name}）的校验和与本程序不符；已应用的迁移不能修改，拒绝启动`, {
        detail: { version: migration.version },
      });
    }
  }
}

/** Applies pending migrations in one transaction under an advisory lock. Returns the versions applied by this call. */
export async function migrate(db: Database, migrations: readonly Migration[] = MIGRATIONS): Promise<number[]> {
  checkList(migrations);
  return db.transaction(async (tx) => {
    await db.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK], tx);
    // Only the journal bootstrap is conditional; everything else is versioned and checksummed.
    await db.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version integer PRIMARY KEY, name text NOT NULL, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
      [],
      tx,
    );
    const applied = (await db.query<{ version: number; name: string; sha256: string }>('SELECT version, name, sha256 FROM schema_migrations ORDER BY version', [], tx)).rows;
    const unknown = applied.filter((row) => !migrations.some((migration) => migration.version === row.version));
    if (unknown.length > 0) {
      throw new MigrationError(
        `数据库里有本程序不认识的迁移（版本 ${unknown.map((row) => row.version).join('、')}），可能来自更新的 Hub；拒绝启动`,
        { detail: { versions: unknown.map((row) => row.version) } },
      );
    }
    const highest = applied.reduce((max, row) => Math.max(max, row.version), 0);
    const done: number[] = [];
    for (const migration of migrations) {
      const old = applied.find((row) => row.version === migration.version);
      const checksum = migrationChecksum(migration);
      if (old !== undefined) {
        if (old.sha256 !== checksum || old.name !== migration.name) {
          throw new MigrationError(`已应用的迁移 ${migration.version}（${old.name}）的校验和与本程序不符；已应用的迁移不能修改，拒绝启动`, {
            detail: { version: migration.version },
          });
        }
        continue;
      }
      if (migration.version < highest) {
        throw new MigrationError(`迁移 ${migration.version} 没有应用，但更高的版本已经应用；只能向前迁移，拒绝启动`, {
          detail: { version: migration.version },
        });
      }
      await db.query(migration.sql, [], tx);
      await db.query('INSERT INTO schema_migrations (version, name, sha256) VALUES ($1, $2, $3)', [migration.version, migration.name, checksum], tx);
      done.push(migration.version);
    }
    return done;
  });
}
