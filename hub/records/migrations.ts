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
-- Keep this invoker function inlineable so caller predicates reach the records indexes.
CREATE OR REPLACE FUNCTION hub_read_records() RETURNS TABLE(seq pg_catalog.int8,id pg_catalog.text,digest pg_catalog.text,kind pg_catalog.text,schema pg_catalog.text,
 provenance pg_catalog.text,created_at pg_catalog.timestamptz,body pg_catalog.text,size pg_catalog.int4) LANGUAGE sql STABLE AS $fn$
 SELECT r.seq,r.id,r.digest,r.kind,r.schema,r.provenance,r.created_at,
 CASE WHEN h.artifact IS NOT NULL THEN h.body WHEN b.record IS NULL OR r.body<>b.marker OR p.data IS NULL THEN r.body
 ELSE pg_catalog.convert_from(p.data,'UTF8') END,r.size FROM public.records r
 LEFT JOIN public.personal_record_bindings b ON b.record=r.digest
 LEFT JOIN public.personal_payloads p ON (p.owner,p.epoch,p.sha256)=(b.owner,b.epoch,b.sha256)
 LEFT JOIN public.run_originals h ON h.artifact=r.digest
 WHERE h.artifact IS NOT NULL OR NOT EXISTS(SELECT 1 FROM public.personal_purges x WHERE (x.owner,x.epoch)=(b.owner,b.epoch))
$fn$;
`},
 {version:18,name:'personal_sync_mode',sql:`CREATE TABLE personal_sync_mode_operations(owner text NOT NULL REFERENCES users(id),epoch text NOT NULL,operation_id text NOT NULL,request text NOT NULL,result text NOT NULL,PRIMARY KEY(owner,epoch,operation_id));
CREATE TRIGGER personal_sync_mode_operations_append_only BEFORE UPDATE OR DELETE ON personal_sync_mode_operations FOR EACH ROW EXECUTE FUNCTION hub_append_only();
CREATE TRIGGER personal_sync_mode_operations_no_truncate BEFORE TRUNCATE ON personal_sync_mode_operations FOR EACH STATEMENT EXECUTE FUNCTION hub_append_only();
`},
 {version:19,name:'member_deletion',sql:`ALTER TABLE public.users ADD COLUMN deleted_at pg_catalog.timestamptz;
ALTER TABLE public.user_history ADD COLUMN deleted_at pg_catalog.timestamptz;
ALTER TABLE public.users DROP CONSTRAINT users_name_key;
CREATE UNIQUE INDEX users_live_name ON public.users(name) WHERE deleted_at IS NULL;
ALTER TABLE public.users ADD CONSTRAINT deleted_members_disabled CHECK(deleted_at IS NULL OR disabled);
CREATE TABLE public.member_deletion_intents (
 member pg_catalog.text PRIMARY KEY REFERENCES public.users(id),
 operation_id pg_catalog.text NOT NULL UNIQUE CHECK(operation_id ~ '^[0-9a-f-]{36}$'),by_user pg_catalog.text NOT NULL REFERENCES public.users(id),
 epoch pg_catalog.text NOT NULL,at pg_catalog.timestamptz NOT NULL,
 purge_manifest pg_catalog.text NOT NULL CHECK(purge_manifest ~ '^[0-9a-f]{64}$'),
 counts pg_catalog.jsonb NOT NULL
);
${APPEND_ONLY('member_deletion_intents')}
-- Only the real table-owner migration session can use this bounded conversion window.
CREATE FUNCTION public.hub_member_layout_conversion() RETURNS pg_catalog.bool LANGUAGE sql STABLE
 SET search_path=pg_catalog,public,pg_temp AS $fn$
 SELECT CURRENT_USER=pg_catalog.pg_get_userbyid(c.relowner)
 AND SESSION_USER=pg_catalog.pg_get_userbyid(c.relowner)
 AND pg_catalog.current_setting('role') IN ('none',pg_catalog.pg_get_userbyid(c.relowner))
 AND pg_catalog.current_setting('circle_hub.member_layout_conversion',true)='19'
 AND NOT EXISTS(SELECT 1 FROM public.schema_migrations WHERE version=19)
 FROM pg_catalog.pg_class c WHERE c.oid='public.records'::pg_catalog.regclass
$fn$;
REVOKE ALL ON FUNCTION public.hub_member_layout_conversion() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.hub_append_only() RETURNS pg_catalog.trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,public,pg_temp AS $fn$
BEGIN
 IF TG_TABLE_NAME='records' AND TG_OP='UPDATE' THEN
 IF public.hub_member_layout_conversion() AND OLD.kind='knowledge_source_attribution'
 AND (pg_catalog.to_jsonb(NEW)-'body')=(pg_catalog.to_jsonb(OLD)-'body')
 AND EXISTS(SELECT 1 FROM public.personal_record_bindings b JOIN public.personal_payloads p
 ON (p.owner,p.epoch,p.sha256)=(b.owner,b.epoch,b.sha256)
 WHERE b.record=OLD.digest AND b.marker=NEW.body
 AND pg_catalog.convert_from(p.data,'UTF8')=OLD.body
 AND (pg_catalog.replace(OLD.body,pg_catalog.chr(92)||'u0000',pg_catalog.chr(92)||'u0001')::pg_catalog.json)->>'space'=b.owner
 AND (pg_catalog.replace(OLD.body,pg_catalog.chr(92)||'u0000',pg_catalog.chr(92)||'u0001')::pg_catalog.json)->>'by'=b.owner
 AND b.sha256=pg_catalog.encode(pg_catalog.sha256(p.data),'hex') AND b.bytes=pg_catalog.octet_length(p.data)
 AND b.proof=public.hub_personal_proof(OLD.digest,b.sha256,b.owner,b.epoch,b.bytes,OLD.created_at,OLD.kind,OLD.provenance,OLD.schema)) THEN RETURN NEW;END IF;
 END IF;
 RAISE EXCEPTION 'append-only table %: % rejected',TG_TABLE_NAME,TG_OP USING ERRCODE='HU001';
END $fn$;
CREATE OR REPLACE FUNCTION hub_check_personal_binding() RETURNS pg_catalog.trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE r public.records%ROWTYPE; p pg_catalog.bytea; b pg_catalog.json; h pg_catalog.text;
BEGIN
 SELECT * INTO r FROM records WHERE digest=NEW.record;
 SELECT data INTO p FROM personal_payloads WHERE owner=NEW.owner AND epoch=NEW.epoch AND sha256=NEW.sha256;
 IF NOT (public.hub_member_layout_conversion() AND r.kind='knowledge_source_attribution') AND NOT EXISTS(SELECT 1 FROM public.personal_spaces WHERE owner=NEW.owner AND epoch=NEW.epoch AND mode='hub') THEN RAISE EXCEPTION 'inactive personal scope'; END IF;
 IF r.digest IS NULL OR p IS NULL OR r.body<>NEW.marker OR NEW.marker::jsonb<>jsonb_build_object('personal_payload',NEW.sha256,'owner',NEW.owner,'epoch',NEW.epoch,'record',NEW.record,'proof',NEW.proof)
 THEN RAISE EXCEPTION 'invalid personal capsule'; END IF;
 b:=replace(convert_from(p,'UTF8'),chr(92)||'u0000',chr(92)||'u0001')::pg_catalog.json;
 IF r.kind NOT IN ('knowledge_space_entry','knowledge_space_version','knowledge_space_source','knowledge_space_grant','memory_document','memory_version','memory_grant','source_artifact','knowledge_source_attribution')
 OR (r.kind<>'source_artifact' AND (b->>'space') IS DISTINCT FROM NEW.owner)
 OR (r.kind='source_artifact' AND ((b->'author'->>'user') IS DISTINCT FROM NEW.owner OR b->'origin'->'upload' IS NULL OR b->'visibility'->>'admins'<>'false'))
 THEN RAISE EXCEPTION 'not a personal payload'; END IF;
 IF r.kind='source_artifact' AND NOT EXISTS(
 SELECT 1 FROM public.hub_read_records() s JOIN public.personal_record_bindings q ON q.record=s.digest
 WHERE s.kind='knowledge_space_source' AND q.owner=NEW.owner AND q.epoch=NEW.epoch
 AND (replace(s.body,chr(92)||'u0000',chr(92)||'u0001')::pg_catalog.json)->>'space'=NEW.owner
 AND (replace(s.body,chr(92)||'u0000',chr(92)||'u0001')::pg_catalog.json)->>'artifact'=NEW.record) THEN RAISE EXCEPTION 'personal artifact has no owning knowledge source';END IF;
 IF r.kind='knowledge_source_attribution' AND b->>'by' IS DISTINCT FROM NEW.owner THEN RAISE EXCEPTION 'not the attributed uploader';END IF;
 IF b->'personal_scope' IS NOT NULL THEN
 IF (b->'personal_scope')::pg_catalog.jsonb<>jsonb_build_object('owner',NEW.owner,'epoch',NEW.epoch) THEN RAISE EXCEPTION 'personal artifact scope mismatch';END IF;
 END IF;
 h:=encode(sha256(convert_to('{"body":'||convert_from(p,'UTF8')||',"created_at":'||to_json(to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::pg_catalog.text||',"kind":'||to_json(r.kind)::pg_catalog.text||',"provenance":'||to_json(r.provenance)::pg_catalog.text||',"schema":'||to_json(r.schema)::pg_catalog.text||'}','UTF8')),'hex');
 IF h<>r.digest OR NEW.bytes<>octet_length(p) OR NEW.proof<>hub_personal_proof(r.digest,NEW.sha256,NEW.owner,NEW.epoch,NEW.bytes,r.created_at,r.kind,r.provenance,r.schema)
 THEN RAISE EXCEPTION 'personal capsule digest mismatch'; END IF;
 IF public.hub_member_layout_conversion() AND r.kind='knowledge_source_attribution' THEN INSERT INTO public.personal_legacy_ready VALUES(NEW.record) ON CONFLICT DO NOTHING;
 ELSE PERFORM public.hub_finish_personal_record(NEW.record);END IF;
 RETURN NULL;
END $fn$;
CREATE OR REPLACE FUNCTION hub_active_personal_insert() RETURNS pg_catalog.trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $fn$
BEGIN
 IF public.hub_member_layout_conversion() THEN RETURN NEW;END IF;
 IF EXISTS(SELECT 1 FROM public.users WHERE id=NEW.owner AND deleted_at IS NOT NULL) THEN RAISE EXCEPTION 'deleted member';END IF;
 PERFORM 1 FROM public.personal_spaces WHERE owner=NEW.owner AND epoch=NEW.epoch AND mode='hub' FOR SHARE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.personal_purges WHERE owner=NEW.owner AND epoch=NEW.epoch) THEN RAISE EXCEPTION 'inactive personal scope';END IF;
 IF TG_TABLE_NAME='personal_objects' THEN
 IF NOT EXISTS(SELECT 1 FROM public.personal_payloads WHERE owner=NEW.owner AND epoch=NEW.epoch AND sha256=NEW.sha256) THEN RAISE EXCEPTION 'personal object has no payload';END IF;
 END IF;
 RETURN NEW;
END $fn$;
CREATE FUNCTION public.hub_convert_member_attributions() RETURNS pg_catalog.void LANGUAGE plpgsql
 SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE r public.records%ROWTYPE;b pg_catalog.json;o pg_catalog.text;e pg_catalog.text;h pg_catalog.text;p pg_catalog.text;m pg_catalog.text;d pg_catalog.text;
BEGIN
 IF CURRENT_USER<>pg_catalog.pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class WHERE oid='public.records'::pg_catalog.regclass))
 OR EXISTS(SELECT 1 FROM public.schema_migrations WHERE version=19) THEN RAISE EXCEPTION 'migration owner only, once' USING ERRCODE='42501';END IF;
 PERFORM pg_catalog.set_config('circle_hub.member_layout_conversion','19',true);
 FOR r IN SELECT * FROM public.records WHERE kind='knowledge_source_attribution' AND NOT EXISTS(SELECT 1 FROM public.personal_record_bindings q WHERE q.record=records.digest) ORDER BY seq LOOP
 b:=pg_catalog.replace(r.body,pg_catalog.chr(92)||'u0000',pg_catalog.chr(92)||'u0001')::pg_catalog.json;o:=b->>'space';
 IF o IS DISTINCT FROM b->>'by' OR o !~ '^usr_[0-9a-z]{26}$' OR NOT EXISTS(SELECT 1 FROM public.users WHERE id=o) THEN RAISE EXCEPTION 'invalid personal attribution owner';END IF;
 d:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('{"body":'||r.body||',"created_at":'||pg_catalog.to_json(pg_catalog.to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::pg_catalog.text||',"kind":'||pg_catalog.to_json(r.kind)::pg_catalog.text||',"provenance":'||pg_catalog.to_json(r.provenance)::pg_catalog.text||',"schema":'||pg_catalog.to_json(r.schema)::pg_catalog.text||'}','UTF8')),'hex');
 IF d<>r.digest THEN RAISE EXCEPTION 'attribution digest mismatch before conversion';END IF;
 INSERT INTO public.personal_spaces(owner,epoch) VALUES(o,'00000000-0000-4000-8000-000000000001') ON CONFLICT DO NOTHING;
 SELECT q.epoch INTO e FROM public.personal_record_bindings q WHERE q.record=b->>'source' AND q.owner=o;
 IF e IS NULL THEN SELECT epoch INTO e FROM public.personal_spaces WHERE owner=o;END IF;
 h:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(r.body,'UTF8')),'hex');
 INSERT INTO public.personal_payloads VALUES(o,e,h,pg_catalog.convert_to(r.body,'UTF8')) ON CONFLICT DO NOTHING;
 p:=public.hub_personal_proof(r.digest,h,o,e,pg_catalog.octet_length(r.body),r.created_at,r.kind,r.provenance,r.schema);
 m:=pg_catalog.json_build_object('personal_payload',h,'owner',o,'epoch',e,'record',r.digest,'proof',p)::pg_catalog.text;
 INSERT INTO public.personal_record_bindings VALUES(r.digest,o,e,h,pg_catalog.octet_length(r.body),m,p);
 UPDATE public.records SET body=m WHERE digest=r.digest;
 END LOOP;
 SET CONSTRAINTS personal_binding_check IMMEDIATE;
 DELETE FROM public.personal_payloads p WHERE EXISTS(SELECT 1 FROM public.personal_purges x WHERE (x.owner,x.epoch)=(p.owner,p.epoch));
 PERFORM pg_catalog.set_config('circle_hub.member_layout_conversion','',true);
END $fn$;
REVOKE ALL ON FUNCTION public.hub_convert_member_attributions() FROM PUBLIC;
SELECT public.hub_convert_member_attributions();
CREATE FUNCTION public.hub_protect_deleted_member() RETURNS pg_catalog.trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,public,pg_temp AS $fn$
BEGIN
 IF OLD.deleted_at IS NOT NULL AND (NEW.deleted_at IS DISTINCT FROM OLD.deleted_at OR NOT NEW.disabled
 OR NEW.name IS DISTINCT FROM OLD.name OR NEW.role IS DISTINCT FROM OLD.role OR NEW.password_hash IS DISTINCT FROM OLD.password_hash
 OR NEW.password_revision IS DISTINCT FROM OLD.password_revision) THEN RAISE EXCEPTION 'permanent member tombstone' USING ERRCODE='HU001';END IF;
 RETURN NEW;
END $fn$;
CREATE TRIGGER users_tombstone BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.hub_protect_deleted_member();
CREATE FUNCTION public.hub_guard_member_scope() RETURNS pg_catalog.trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $fn$
BEGIN
 IF NEW.mode='hub' AND EXISTS(SELECT 1 FROM public.users WHERE id=NEW.owner AND deleted_at IS NOT NULL) THEN RAISE EXCEPTION 'deleted member';END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.hub_guard_member_scope() FROM PUBLIC;
CREATE TRIGGER personal_spaces_member BEFORE INSERT OR UPDATE ON public.personal_spaces FOR EACH ROW EXECUTE FUNCTION public.hub_guard_member_scope();
CREATE FUNCTION public.hub_begin_member_deletion(a pg_catalog.text,o pg_catalog.text,e pg_catalog.text,op pg_catalog.text,m pg_catalog.text,c pg_catalog.jsonb,t pg_catalog.timestamptz,revision pg_catalog.timestamptz)
 RETURNS pg_catalog.void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE u public.users%ROWTYPE;admin_set_lock CONSTANT pg_catalog.int8:=7301562002;k pg_catalog.text;
BEGIN
 IF pg_catalog.jsonb_typeof(c)<>'object' OR c - ARRAY['records','payloads','objects','attributions','archives','private_versions']::pg_catalog.text[]<>'{}'::pg_catalog.jsonb THEN RAISE EXCEPTION 'invalid deletion counts';END IF;
 FOREACH k IN ARRAY ARRAY['records','payloads','objects','attributions','archives','private_versions']::pg_catalog.text[] LOOP
 IF NOT c ? k OR pg_catalog.jsonb_typeof(c->k)<>'number' OR (c->>k) !~ '^(0|[1-9][0-9]*)$' OR (c->>k)::pg_catalog.int8>9007199254740991 THEN RAISE EXCEPTION 'invalid deletion counts';END IF;
 END LOOP;
 -- Same administrator-set lock as role changes and deactivation.
 PERFORM pg_catalog.pg_advisory_xact_lock(admin_set_lock);
 PERFORM 1 FROM public.users WHERE id=a AND role='admin' AND NOT disabled FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO u FROM public.users WHERE id=o FOR UPDATE;
 IF NOT FOUND OR u.deleted_at IS NOT NULL OR u.updated_at<>revision THEN RAISE EXCEPTION 'member state changed';END IF;
 IF u.role='admin' AND NOT u.disabled AND NOT EXISTS(SELECT 1 FROM public.users WHERE role='admin' AND NOT disabled AND id<>o) THEN RAISE EXCEPTION 'last active administrator';END IF;
 INSERT INTO public.personal_spaces(owner,epoch) VALUES(o,e) ON CONFLICT DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM public.personal_spaces WHERE owner=o AND epoch=e) THEN RAISE EXCEPTION 'epoch changed';END IF;
 IF EXISTS(SELECT 1 FROM public.personal_record_bindings b WHERE b.owner=o AND NOT EXISTS(SELECT 1 FROM public.personal_purges p WHERE (p.owner,p.epoch)=(b.owner,b.epoch)) AND NOT EXISTS(SELECT 1 FROM public.personal_legacy_ready x WHERE x.record=b.record)) THEN RAISE EXCEPTION 'personal transfer incomplete';END IF;
 IF EXISTS(SELECT 1 FROM public.records r JOIN public.record_index i ON i.digest=r.digest AND i.key='personal.pack.owner' WHERE r.kind='personal_pack_version' AND i.value=o AND NOT EXISTS(SELECT 1 FROM public.personal_record_bindings b WHERE b.record=r.digest)) THEN RAISE EXCEPTION 'personal pack transfer incomplete';END IF;
 IF EXISTS(SELECT 1 FROM public.records r JOIN public.record_index i ON i.digest=r.digest AND i.key IN ('artifact.author','artifact.reader') AND i.value=o
 CROSS JOIN LATERAL (SELECT pg_catalog.replace(r.body,pg_catalog.chr(92)||'u0000',pg_catalog.chr(92)||'u0001')::pg_catalog.jsonb AS b) x
 WHERE r.kind='source_artifact' AND NOT EXISTS(SELECT 1 FROM public.personal_record_bindings q WHERE q.record=r.digest)
 AND ((x.b->'origin'->'upload' IS NOT NULL AND x.b->'author'->>'user'=o) OR
 (x.b->'origin'->'read' IS NOT NULL AND x.b->'visibility'->>'admins'='false' AND x.b->'visibility'->'readers'=pg_catalog.jsonb_build_array(o)))) THEN RAISE EXCEPTION 'private original transfer incomplete';END IF;
 INSERT INTO public.member_deletion_intents VALUES(o,op,a,e,t,m,c);
 UPDATE public.users SET disabled=true,deleted_at=t,password_hash=NULL,password_must_change=false,password_revision=password_revision+1,updated_at=t WHERE id=o;
 UPDATE public.tokens SET revoked_at=t,revoked_by=a WHERE user_id=o AND revoked_at IS NULL;
 INSERT INTO public.user_history(user_id,name,role,disabled,changed_by,changed_at,deleted_at) VALUES(o,u.name,u.role,true,a,t,t);
END $fn$;
REVOKE ALL ON FUNCTION public.hub_begin_member_deletion(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.jsonb,pg_catalog.timestamptz,pg_catalog.timestamptz) FROM PUBLIC;
CREATE FUNCTION public.hub_finish_member_deletion(o pg_catalog.text,op pg_catalog.text) RETURNS pg_catalog.void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE e pg_catalog.text;
BEGIN
 SELECT epoch INTO e FROM public.member_deletion_intents WHERE member=o AND operation_id=op;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.users WHERE id=o AND disabled AND deleted_at IS NOT NULL) THEN RAISE EXCEPTION 'unavailable';END IF;
 -- The same purge function and all of its durable-retirement guards remain authoritative.
 PERFORM public.hub_purge_personal(o,e);
END $fn$;
REVOKE ALL ON FUNCTION public.hub_finish_member_deletion(pg_catalog.text,pg_catalog.text) FROM PUBLIC;
`},
 {version:20,name:'account_payload_holders',sql:`ALTER TABLE public.personal_spaces ADD COLUMN account_epoch pg_catalog.text;
CREATE TABLE public.run_pack_records(record pg_catalog.text PRIMARY KEY REFERENCES public.records(digest),held_by pg_catalog.text NOT NULL REFERENCES public.records(digest),owner pg_catalog.text NOT NULL REFERENCES public.users(id),digest pg_catalog.text NOT NULL,body pg_catalog.text NOT NULL);
CREATE TABLE public.held_object_targets(sha256 pg_catalog.text NOT NULL,held_by pg_catalog.text NOT NULL REFERENCES public.records(digest),owner pg_catalog.text NOT NULL,epoch pg_catalog.text NOT NULL,PRIMARY KEY(sha256,held_by));
CREATE TABLE public.held_objects(sha256 pg_catalog.text PRIMARY KEY REFERENCES public.objects(sha256),held_by pg_catalog.text NOT NULL REFERENCES public.records(digest),data pg_catalog.bytea NOT NULL,CHECK(pg_catalog.encode(pg_catalog.sha256(data),'hex')=sha256));
CREATE TABLE public.original_targets(artifact pg_catalog.text NOT NULL REFERENCES public.records(digest),held_by pg_catalog.text NOT NULL REFERENCES public.records(digest),owner pg_catalog.text NOT NULL,epoch pg_catalog.text NOT NULL,sha256 pg_catalog.text NOT NULL,body pg_catalog.text NOT NULL,PRIMARY KEY(artifact));
${APPEND_ONLY('run_pack_records')}
${APPEND_ONLY('held_object_targets')}
${APPEND_ONLY('held_objects')}
${APPEND_ONLY('original_targets')}
CREATE INDEX held_object_targets_owner ON public.held_object_targets(owner,epoch);
CREATE INDEX original_targets_owner ON public.original_targets(owner,epoch);
CREATE INDEX run_pack_records_scope ON public.run_pack_records(owner,digest);

CREATE FUNCTION public.hub_account_layout_conversion() RETURNS pg_catalog.bool LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $fn$
 SELECT CURRENT_USER=pg_catalog.pg_get_userbyid(c.relowner) AND SESSION_USER=pg_catalog.pg_get_userbyid(c.relowner)
 AND pg_catalog.current_setting('role') IN ('none',pg_catalog.pg_get_userbyid(c.relowner))
 AND pg_catalog.current_setting('circle_hub.account_layout_conversion',true)='20'
 AND NOT EXISTS(SELECT 1 FROM public.schema_migrations WHERE version=20)
 FROM pg_catalog.pg_class c WHERE c.oid='public.records'::pg_catalog.regclass
$fn$;
REVOKE ALL ON FUNCTION public.hub_account_layout_conversion() FROM PUBLIC;
CREATE FUNCTION public.hub_capture_owner(b pg_catalog.jsonb) RETURNS pg_catalog.text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $fn$
 SELECT CASE WHEN b->'origin'->'upload' IS NOT NULL AND b->'visibility'->>'admins'='false' THEN b->'author'->>'user'
 WHEN b->'origin'->'read' IS NOT NULL AND b->'visibility'->>'admins'='false' AND pg_catalog.jsonb_array_length(b->'visibility'->'readers')=1 THEN b->'visibility'->'readers'->>0 ELSE NULL END
$fn$;
CREATE FUNCTION public.hub_account_scope(o pg_catalog.text,n pg_catalog.text) RETURNS pg_catalog.text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE e pg_catalog.text;s public.personal_spaces%ROWTYPE;
BEGIN
 PERFORM 1 FROM public.users WHERE id=o AND NOT disabled AND deleted_at IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'unavailable' USING ERRCODE='P0002';END IF;
 INSERT INTO public.personal_spaces(owner,epoch) VALUES(o,'00000000-0000-4000-8000-000000000001') ON CONFLICT DO NOTHING;
 SELECT * INTO s FROM public.personal_spaces WHERE owner=o FOR UPDATE;
 IF s.account_epoch IS NOT NULL THEN RETURN s.account_epoch;END IF;
 IF n=s.epoch OR n !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' OR EXISTS(SELECT 1 FROM public.personal_purges WHERE owner=o AND epoch=n) THEN RAISE EXCEPTION 'invalid account scope';END IF;
 UPDATE public.personal_spaces SET account_epoch=n WHERE owner=o;RETURN n;
END $fn$;
REVOKE ALL ON FUNCTION public.hub_account_scope(pg_catalog.text,pg_catalog.text) FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.hub_append_only() RETURNS pg_catalog.trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $fn$
BEGIN
 IF TG_TABLE_NAME='record_index' AND TG_OP='DELETE' THEN
 IF OLD.key='artifact.object' AND CURRENT_USER=pg_catalog.pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class WHERE oid='public.record_index'::pg_catalog.regclass)) AND EXISTS(SELECT 1 FROM public.personal_record_bindings b JOIN public.personal_purges p ON (p.owner,p.epoch)=(b.owner,b.epoch) WHERE b.record=OLD.digest) THEN RETURN OLD;END IF;
 IF OLD.key IN ('personal.pack.id','personal.pack.grant','personal.pack.retired')
 AND CURRENT_USER=pg_catalog.pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class WHERE oid='public.record_index'::pg_catalog.regclass))
 AND EXISTS(SELECT 1 FROM public.personal_record_bindings b JOIN public.personal_purges p ON (p.owner,p.epoch)=(b.owner,b.epoch)
 JOIN public.member_deletion_intents d ON d.member=b.owner JOIN public.users u ON u.id=d.member AND u.deleted_at IS NOT NULL WHERE b.record=OLD.digest) THEN RETURN OLD;END IF;
 END IF;
 IF TG_TABLE_NAME='records' AND TG_OP='UPDATE' THEN
 IF public.hub_account_layout_conversion() AND (pg_catalog.to_jsonb(NEW)-'body')=(pg_catalog.to_jsonb(OLD)-'body')
 AND EXISTS(SELECT 1 FROM public.personal_record_bindings b JOIN public.personal_payloads p ON (p.owner,p.epoch,p.sha256)=(b.owner,b.epoch,b.sha256)
 WHERE b.record=OLD.digest AND b.marker=NEW.body AND pg_catalog.convert_from(p.data,'UTF8')=OLD.body
 AND b.sha256=pg_catalog.encode(pg_catalog.sha256(p.data),'hex') AND b.bytes=pg_catalog.octet_length(p.data)
 AND ((OLD.kind IN ('personal_pack_version','personal_pack_grant','personal_pack_retirement','personal_pack_transfer') AND (pg_catalog.replace(OLD.body,pg_catalog.chr(92)||'u0000',pg_catalog.chr(92)||'u0001')::pg_catalog.jsonb)->>'space'=b.owner)
 OR (OLD.kind='source_artifact' AND public.hub_capture_owner(pg_catalog.replace(OLD.body,pg_catalog.chr(92)||'u0000',pg_catalog.chr(92)||'u0001')::pg_catalog.jsonb)=b.owner))
 AND b.proof=public.hub_personal_proof(OLD.digest,b.sha256,b.owner,b.epoch,b.bytes,OLD.created_at,OLD.kind,OLD.provenance,OLD.schema)) THEN RETURN NEW;END IF;
 END IF;
 RAISE EXCEPTION 'append-only table %: % rejected',TG_TABLE_NAME,TG_OP USING ERRCODE='HU001';
END $fn$;
CREATE OR REPLACE FUNCTION hub_active_personal_insert() RETURNS pg_catalog.trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $fn$
BEGIN
 IF public.hub_account_layout_conversion() THEN RETURN NEW;END IF;
 PERFORM 1 FROM public.personal_spaces s JOIN public.users u ON u.id=s.owner WHERE s.owner=NEW.owner
 AND ((s.epoch=NEW.epoch AND s.mode='hub') OR s.account_epoch=NEW.epoch) AND u.deleted_at IS NULL FOR SHARE OF s;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.personal_purges WHERE owner=NEW.owner AND epoch=NEW.epoch) THEN RAISE EXCEPTION 'inactive personal scope';END IF;
 IF TG_TABLE_NAME='personal_objects' AND NOT EXISTS(SELECT 1 FROM public.personal_payloads WHERE owner=NEW.owner AND epoch=NEW.epoch AND sha256=NEW.sha256) THEN RAISE EXCEPTION 'personal object has no payload';END IF;
 RETURN NEW;
END $fn$;
CREATE OR REPLACE FUNCTION hub_check_personal_binding() RETURNS pg_catalog.trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE r public.records%ROWTYPE; p pg_catalog.bytea; b pg_catalog.json; h pg_catalog.text;
BEGIN
 SELECT * INTO r FROM records WHERE digest=NEW.record;
 SELECT data INTO p FROM personal_payloads WHERE owner=NEW.owner AND epoch=NEW.epoch AND sha256=NEW.sha256;
 IF NOT EXISTS(SELECT 1 FROM public.personal_spaces WHERE owner=NEW.owner AND ((epoch=NEW.epoch AND mode='hub') OR account_epoch=NEW.epoch)) THEN RAISE EXCEPTION 'inactive personal scope'; END IF;
 IF r.digest IS NULL OR p IS NULL OR r.body<>NEW.marker OR NEW.marker::jsonb<>jsonb_build_object('personal_payload',NEW.sha256,'owner',NEW.owner,'epoch',NEW.epoch,'record',NEW.record,'proof',NEW.proof)
 THEN RAISE EXCEPTION 'invalid personal capsule'; END IF;
 b:=replace(convert_from(p,'UTF8'),chr(92)||'u0000',chr(92)||'u0001')::pg_catalog.json;
 IF (r.kind IN ('knowledge_space_entry','knowledge_space_version','knowledge_space_source','knowledge_space_grant','memory_document','memory_version','memory_grant','knowledge_source_attribution','personal_pack_version','personal_pack_grant','personal_pack_retirement','personal_pack_transfer') AND b->>'space'=NEW.owner)
 OR (r.kind='source_artifact' AND public.hub_capture_owner(b::pg_catalog.jsonb)=NEW.owner) THEN NULL;
 ELSE RAISE EXCEPTION 'not a personal payload';END IF;
 IF r.kind='knowledge_source_attribution' AND b->>'by' IS DISTINCT FROM NEW.owner THEN RAISE EXCEPTION 'not the attributed uploader';END IF;
 IF r.kind IN ('personal_pack_version','personal_pack_grant','personal_pack_retirement','personal_pack_transfer') AND NOT EXISTS(SELECT 1 FROM public.personal_spaces WHERE owner=NEW.owner AND account_epoch=NEW.epoch) THEN RAISE EXCEPTION 'private install scope mismatch';END IF;
 IF r.kind='source_artifact' AND NOT EXISTS(SELECT 1 FROM public.personal_spaces WHERE owner=NEW.owner AND account_epoch=NEW.epoch)
 AND NOT EXISTS(SELECT 1 FROM public.hub_read_records() s JOIN public.personal_record_bindings q ON q.record=s.digest
 WHERE s.kind='knowledge_space_source' AND q.owner=NEW.owner AND q.epoch=NEW.epoch AND (pg_catalog.replace(s.body,pg_catalog.chr(92)||'u0000',pg_catalog.chr(92)||'u0001')::pg_catalog.jsonb)->>'artifact'=NEW.record) THEN RAISE EXCEPTION 'personal artifact has no owning knowledge source';END IF;
 IF b->'personal_scope' IS NOT NULL THEN
 IF (b->'personal_scope')::pg_catalog.jsonb<>jsonb_build_object('owner',NEW.owner,'epoch',NEW.epoch) THEN RAISE EXCEPTION 'personal artifact scope mismatch';END IF;
 END IF;
 h:=encode(sha256(convert_to('{"body":'||convert_from(p,'UTF8')||',"created_at":'||to_json(to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::pg_catalog.text||',"kind":'||to_json(r.kind)::pg_catalog.text||',"provenance":'||to_json(r.provenance)::pg_catalog.text||',"schema":'||to_json(r.schema)::pg_catalog.text||'}','UTF8')),'hex');
 IF h<>r.digest OR NEW.bytes<>octet_length(p) OR NEW.proof<>hub_personal_proof(r.digest,NEW.sha256,NEW.owner,NEW.epoch,NEW.bytes,r.created_at,r.kind,r.provenance,r.schema)
 THEN RAISE EXCEPTION 'personal capsule digest mismatch'; END IF;
 PERFORM public.hub_finish_personal_record(NEW.record);
 RETURN NULL;
END $fn$;
CREATE OR REPLACE FUNCTION hub_finish_personal_record(d pg_catalog.text) RETURNS pg_catalog.void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE x pg_catalog.record;b pg_catalog.json;missing pg_catalog.bool;hashes pg_catalog.text[];
BEGIN
 SELECT r.kind,r.body AS stored_marker,q.*,p.data INTO x FROM public.records r JOIN public.personal_record_bindings q ON q.record=r.digest
 JOIN public.personal_payloads p ON (p.owner,p.epoch,p.sha256)=(q.owner,q.epoch,q.sha256) WHERE r.digest=d;
 IF NOT FOUND THEN RAISE EXCEPTION 'personal record transfer incomplete';END IF;
 IF x.stored_marker<>x.marker OR x.marker::jsonb<>jsonb_build_object('personal_payload',x.sha256,'owner',x.owner,'epoch',x.epoch,'record',d,'proof',x.proof)
 THEN RAISE EXCEPTION 'invalid personal capsule';END IF;
 b:=replace(convert_from(x.data,'UTF8'),chr(92)||'u0000',chr(92)||'u0001')::pg_catalog.json;
 PERFORM 1 FROM public.personal_spaces s WHERE s.owner=x.owner AND ((s.epoch=x.epoch AND s.mode='hub') OR s.account_epoch=x.epoch) FOR SHARE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.personal_purges p WHERE p.owner=x.owner AND p.epoch=x.epoch) THEN RAISE EXCEPTION 'inactive personal scope';END IF;
 IF x.kind='source_artifact' THEN
 IF NOT EXISTS(SELECT 1 FROM public.personal_objects o JOIN public.personal_payloads p ON (p.owner,p.epoch,p.sha256)=(o.owner,o.epoch,o.sha256)
 WHERE o.owner=x.owner AND o.epoch=x.epoch AND o.sha256=b->>'sha256' AND octet_length(p.data)=(b->>'size')::pg_catalog.int8) THEN RAISE EXCEPTION 'personal original transfer incomplete';END IF;
 hashes:=ARRAY[b->>'sha256'];
 ELSIF x.kind='personal_pack_version' THEN
 SELECT pg_catalog.array_agg(DISTINCT h) INTO hashes FROM (SELECT b->>'digest' AS h UNION ALL SELECT f->>'sha256' FROM pg_catalog.json_array_elements(b->'manifest'->'files') f) q;
 IF EXISTS(SELECT 1 FROM pg_catalog.unnest(hashes) h LEFT JOIN public.personal_objects o ON o.owner=x.owner AND o.epoch=x.epoch AND o.sha256=h LEFT JOIN public.personal_payloads p ON (p.owner,p.epoch,p.sha256)=(o.owner,o.epoch,o.sha256) WHERE p.data IS NULL) THEN RAISE EXCEPTION 'private pack transfer incomplete';END IF;
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
CREATE FUNCTION public.hub_convert_account_payloads() RETURNS pg_catalog.void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE r public.records%ROWTYPE;b pg_catalog.jsonb;o pg_catalog.text;e pg_catalog.text;h pg_catalog.text;p pg_catalog.text;m pg_catalog.text;d pg_catalog.text;
BEGIN
 IF CURRENT_USER<>pg_catalog.pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class WHERE oid='public.records'::pg_catalog.regclass)) OR EXISTS(SELECT 1 FROM public.schema_migrations WHERE version=20) THEN RAISE EXCEPTION 'migration owner only, once' USING ERRCODE='42501';END IF;
 PERFORM pg_catalog.set_config('circle_hub.account_layout_conversion','20',true);
 FOR r IN SELECT * FROM public.records WHERE kind IN ('source_artifact','personal_pack_version','personal_pack_grant','personal_pack_retirement','personal_pack_transfer') AND NOT EXISTS(SELECT 1 FROM public.personal_record_bindings q WHERE q.record=records.digest) ORDER BY seq LOOP
 b:=pg_catalog.replace(r.body,pg_catalog.chr(92)||'u0000',pg_catalog.chr(92)||'u0001')::pg_catalog.jsonb;
 o:=CASE WHEN r.kind='source_artifact' THEN public.hub_capture_owner(b) ELSE b->>'space' END;
 IF o IS NULL OR NOT EXISTS(SELECT 1 FROM public.users WHERE id=o) THEN CONTINUE;END IF;
 IF r.kind='source_artifact' AND b->'personal_scope' IS NOT NULL THEN RAISE EXCEPTION 'scoped original has no binding';END IF;
 IF EXISTS(SELECT 1 FROM public.users WHERE id=o AND deleted_at IS NOT NULL) THEN RAISE EXCEPTION 'unprepared private data belongs to a deleted member';END IF;
 d:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('{"body":'||r.body||',"created_at":'||pg_catalog.to_json(pg_catalog.to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::pg_catalog.text||',"kind":'||pg_catalog.to_json(r.kind)::pg_catalog.text||',"provenance":'||pg_catalog.to_json(r.provenance)::pg_catalog.text||',"schema":'||pg_catalog.to_json(r.schema)::pg_catalog.text||'}','UTF8')),'hex');
 IF d<>r.digest THEN RAISE EXCEPTION 'account record digest mismatch before conversion';END IF;
 INSERT INTO public.personal_spaces(owner,epoch) VALUES(o,'00000000-0000-4000-8000-000000000001') ON CONFLICT DO NOTHING;
 UPDATE public.personal_spaces SET account_epoch=pg_catalog.gen_random_uuid()::pg_catalog.text WHERE owner=o AND account_epoch IS NULL;
 SELECT account_epoch INTO e FROM public.personal_spaces WHERE owner=o;
 h:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(r.body,'UTF8')),'hex');
 INSERT INTO public.personal_payloads VALUES(o,e,h,pg_catalog.convert_to(r.body,'UTF8')) ON CONFLICT DO NOTHING;
 p:=public.hub_personal_proof(r.digest,h,o,e,pg_catalog.octet_length(r.body),r.created_at,r.kind,r.provenance,r.schema);
 m:=pg_catalog.json_build_object('personal_payload',h,'owner',o,'epoch',e,'record',r.digest,'proof',p)::pg_catalog.text;
 INSERT INTO public.personal_record_bindings VALUES(r.digest,o,e,h,pg_catalog.octet_length(r.body),m,p);
 UPDATE public.records SET body=m WHERE digest=r.digest;
 INSERT INTO public.personal_legacy_candidates VALUES(r.digest) ON CONFLICT DO NOTHING;
 END LOOP;
 PERFORM pg_catalog.set_config('circle_hub.account_layout_conversion','',true);
END $fn$;
REVOKE ALL ON FUNCTION public.hub_convert_account_payloads() FROM PUBLIC;
-- The owner conversion performs its own exact proof check. Runtime binding validation stays enabled afterwards.
ALTER TABLE public.personal_record_bindings DISABLE TRIGGER personal_binding_check;
SELECT public.hub_convert_account_payloads();
ALTER TABLE public.personal_record_bindings ENABLE TRIGGER personal_binding_check;
CREATE FUNCTION public.hub_restore_legacy_object(d pg_catalog.text,h pg_catalog.text,raw pg_catalog.bytea) RETURNS pg_catalog.void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE x pg_catalog.record;b pg_catalog.jsonb;
BEGIN
 SELECT r.kind,q.owner,q.epoch,pg_catalog.convert_from(p.data,'UTF8') AS body INTO x FROM public.records r JOIN public.personal_legacy_candidates c ON c.record=r.digest
 JOIN public.personal_record_bindings q ON q.record=r.digest JOIN public.personal_payloads p ON (p.owner,p.epoch,p.sha256)=(q.owner,q.epoch,q.sha256) WHERE r.digest=d AND NOT EXISTS(SELECT 1 FROM public.personal_legacy_ready a WHERE a.record=d);
 IF NOT FOUND THEN RAISE EXCEPTION 'not an unfinished legacy transfer';END IF;
 b:=pg_catalog.replace(x.body,pg_catalog.chr(92)||'u0000',pg_catalog.chr(92)||'u0001')::pg_catalog.jsonb;
 IF NOT ((x.kind='source_artifact' AND b->>'sha256'=h AND (b->>'size')::pg_catalog.int8=pg_catalog.octet_length(raw)) OR (x.kind='personal_pack_version' AND (b->>'digest'=h OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(b->'manifest'->'files') f WHERE f->>'sha256'=h AND (f->>'size')::pg_catalog.int8=pg_catalog.octet_length(raw))))) THEN RAISE EXCEPTION 'not a declared legacy object';END IF;
 IF pg_catalog.encode(pg_catalog.sha256(raw),'hex')<>h OR NOT EXISTS(SELECT 1 FROM public.objects WHERE sha256=h AND size=pg_catalog.octet_length(raw)) THEN RAISE EXCEPTION 'legacy object mismatch';END IF;
 INSERT INTO public.personal_payloads VALUES(x.owner,x.epoch,h,raw) ON CONFLICT DO NOTHING;
 INSERT INTO public.personal_objects VALUES(x.owner,x.epoch,h) ON CONFLICT DO NOTHING;
END $fn$;
REVOKE ALL ON FUNCTION public.hub_restore_legacy_object(pg_catalog.text,pg_catalog.text,pg_catalog.bytea) FROM PUBLIC;
CREATE FUNCTION public.hub_keep_capture(holder pg_catalog.text,a pg_catalog.text,required pg_catalog.bool) RETURNS pg_catalog.void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE q pg_catalog.record;b pg_catalog.jsonb;raw pg_catalog.bytea;
BEGIN
 IF EXISTS(SELECT 1 FROM public.run_originals WHERE artifact=a) THEN RETURN;END IF;
 SELECT r.body,p.owner,p.epoch INTO q FROM public.hub_read_records() r JOIN public.personal_record_bindings p ON p.record=r.digest WHERE r.digest=a AND r.kind='source_artifact';
 IF NOT FOUND THEN RETURN;END IF;
 b:=pg_catalog.replace(q.body,pg_catalog.chr(92)||'u0000',pg_catalog.chr(92)||'u0001')::pg_catalog.jsonb;
 INSERT INTO public.original_targets VALUES(a,holder,q.owner,q.epoch,b->>'sha256',q.body) ON CONFLICT DO NOTHING;
 SELECT p.data INTO raw FROM public.personal_objects o JOIN public.personal_payloads p ON (p.owner,p.epoch,p.sha256)=(o.owner,o.epoch,o.sha256) WHERE (o.owner,o.epoch,o.sha256)=(q.owner,q.epoch,b->>'sha256');
 IF raw IS NULL THEN IF required THEN RAISE EXCEPTION 'independent original bytes unavailable';ELSE RETURN;END IF;END IF;
 INSERT INTO public.run_originals VALUES(a,holder,b->>'sha256',q.body,raw) ON CONFLICT DO NOTHING;
END $fn$;
REVOKE ALL ON FUNCTION public.hub_keep_capture(pg_catalog.text,pg_catalog.text,pg_catalog.bool) FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.hub_keep_run_originals(r pg_catalog.text,must_exist pg_catalog.bool) RETURNS pg_catalog.void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE a pg_catalog.text;
BEGIN
 FOR a IN SELECT h.sha256 FROM public.object_holds h JOIN public.records v ON v.digest=h.record AND v.kind='run' WHERE h.record=r AND h.artifact LOOP PERFORM public.hub_keep_capture(r,a,must_exist);END LOOP;
END $fn$;
CREATE FUNCTION public.hub_keep_team_original() RETURNS pg_catalog.trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE b pg_catalog.jsonb;
BEGIN
 b:=pg_catalog.replace(NEW.body,pg_catalog.chr(92)||'u0000',pg_catalog.chr(92)||'u0001')::pg_catalog.jsonb;
 IF b->>'space'='team' THEN PERFORM public.hub_keep_capture(NEW.digest,b->>'artifact',true);END IF;RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION public.hub_keep_team_original() FROM PUBLIC;
CREATE TRIGGER records_team_original AFTER INSERT ON public.records FOR EACH ROW WHEN(NEW.kind='knowledge_space_source') EXECUTE FUNCTION public.hub_keep_team_original();
CREATE FUNCTION public.hub_keep_frozen_packs(r pg_catalog.text,required pg_catalog.bool) RETURNS pg_catalog.void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE run_body pg_catalog.jsonb;wanted pg_catalog.record;v pg_catalog.record;h pg_catalog.text;file pg_catalog.record;raw pg_catalog.bytea;
BEGIN
 SELECT pg_catalog.replace(body,pg_catalog.chr(92)||'u0000',pg_catalog.chr(92)||'u0001')::pg_catalog.jsonb INTO run_body FROM public.records WHERE digest=r AND kind='run';IF NOT FOUND THEN RETURN;END IF;
 FOR wanted IN SELECT run_body->>'pack_space' AS owner,run_body->>'pack_digest' AS digest UNION SELECT skill->>'space',skill->>'digest' FROM pg_catalog.jsonb_array_elements(COALESCE(run_body->'skills','[]'::pg_catalog.jsonb)) skill LOOP
 IF wanted.owner IS NULL OR wanted.owner='team' THEN CONTINUE;END IF;
 IF required AND NOT EXISTS(SELECT 1 FROM public.users WHERE id=wanted.owner AND NOT disabled AND deleted_at IS NULL) THEN RAISE EXCEPTION 'private package owner unavailable';END IF;
 SELECT x.digest AS record,x.body,p.epoch INTO v FROM public.hub_read_records() x JOIN public.record_index i ON i.digest=x.digest AND i.key='personal.pack.digest' AND i.value=wanted.owner||'/'||wanted.digest JOIN public.personal_record_bindings p ON p.record=x.digest AND p.owner=wanted.owner WHERE x.kind='personal_pack_version' LIMIT 1;
 IF NOT FOUND THEN IF required THEN RAISE EXCEPTION 'frozen private package unavailable';ELSE CONTINUE;END IF;END IF;
 INSERT INTO public.run_pack_records VALUES(v.record,r,wanted.owner,wanted.digest,v.body) ON CONFLICT DO NOTHING;
 FOR h IN SELECT wanted.digest UNION SELECT f->>'sha256' FROM pg_catalog.jsonb_array_elements(pg_catalog.replace(v.body,pg_catalog.chr(92)||'u0000',pg_catalog.chr(92)||'u0001')::pg_catalog.jsonb->'manifest'->'files') f LOOP
 INSERT INTO public.held_object_targets VALUES(h,r,wanted.owner,v.epoch) ON CONFLICT DO NOTHING;
 SELECT p.data INTO raw FROM public.personal_objects o JOIN public.personal_payloads p ON (p.owner,p.epoch,p.sha256)=(o.owner,o.epoch,o.sha256) WHERE (o.owner,o.epoch,o.sha256)=(wanted.owner,v.epoch,h);
 IF raw IS NULL THEN IF required THEN RAISE EXCEPTION 'frozen package bytes unavailable';ELSE CONTINUE;END IF;END IF;
 INSERT INTO public.held_objects VALUES(h,r,raw) ON CONFLICT DO NOTHING;
 END LOOP;
 FOR file IN SELECT value AS artifact FROM pg_catalog.jsonb_each_text(COALESCE(pg_catalog.replace(v.body,pg_catalog.chr(92)||'u0000',pg_catalog.chr(92)||'u0001')::pg_catalog.jsonb->'files','{}'::pg_catalog.jsonb)) LOOP PERFORM public.hub_keep_capture(r,file.artifact,required);END LOOP;
 END LOOP;
END $fn$;
REVOKE ALL ON FUNCTION public.hub_keep_frozen_packs(pg_catalog.text,pg_catalog.bool) FROM PUBLIC;
CREATE FUNCTION public.hub_freeze_private_run() RETURNS pg_catalog.trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fn$
BEGIN PERFORM public.hub_keep_frozen_packs(NEW.digest,true);RETURN NULL;END $fn$;
REVOKE ALL ON FUNCTION public.hub_freeze_private_run() FROM PUBLIC;
CREATE TRIGGER records_private_run AFTER INSERT ON public.records FOR EACH ROW WHEN(NEW.kind='run') EXECUTE FUNCTION public.hub_freeze_private_run();
DO $backfill$
DECLARE r pg_catalog.record;b pg_catalog.jsonb;
BEGIN
 FOR r IN SELECT digest FROM public.records WHERE kind='run' LOOP PERFORM public.hub_keep_run_originals(r.digest,false);PERFORM public.hub_keep_frozen_packs(r.digest,false);END LOOP;
 FOR r IN SELECT digest,body FROM public.hub_read_records() WHERE kind='knowledge_space_source' LOOP b:=pg_catalog.replace(r.body,pg_catalog.chr(92)||'u0000',pg_catalog.chr(92)||'u0001')::pg_catalog.jsonb;IF b->>'space'='team' THEN PERFORM public.hub_keep_capture(r.digest,b->>'artifact',false);END IF;END LOOP;
END $backfill$;
CREATE FUNCTION public.hub_finish_independent_objects(target_owner pg_catalog.text DEFAULT NULL) RETURNS pg_catalog.void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fn$
BEGIN
 INSERT INTO public.held_objects SELECT t.sha256,t.held_by,p.data FROM public.held_object_targets t JOIN public.personal_objects o ON (o.owner,o.epoch,o.sha256)=(t.owner,t.epoch,t.sha256) JOIN public.personal_payloads p ON (p.owner,p.epoch,p.sha256)=(o.owner,o.epoch,o.sha256) WHERE (target_owner IS NULL OR t.owner=target_owner) AND NOT EXISTS(SELECT 1 FROM public.held_objects h WHERE h.sha256=t.sha256) ON CONFLICT DO NOTHING;
 INSERT INTO public.run_originals SELECT t.artifact,t.held_by,t.sha256,t.body,p.data FROM public.original_targets t JOIN public.personal_objects o ON (o.owner,o.epoch,o.sha256)=(t.owner,t.epoch,t.sha256) JOIN public.personal_payloads p ON (p.owner,p.epoch,p.sha256)=(o.owner,o.epoch,o.sha256) WHERE (target_owner IS NULL OR t.owner=target_owner) AND NOT EXISTS(SELECT 1 FROM public.run_originals h WHERE h.artifact=t.artifact) ON CONFLICT DO NOTHING;
 IF EXISTS(SELECT 1 FROM public.held_object_targets t WHERE (target_owner IS NULL OR t.owner=target_owner) AND NOT EXISTS(SELECT 1 FROM public.held_objects h WHERE h.sha256=t.sha256)) OR EXISTS(SELECT 1 FROM public.original_targets t WHERE (target_owner IS NULL OR t.owner=target_owner) AND NOT EXISTS(SELECT 1 FROM public.run_originals h WHERE h.artifact=t.artifact)) THEN RAISE EXCEPTION 'independent original transfer incomplete';END IF;
END $fn$;
REVOKE ALL ON FUNCTION public.hub_finish_independent_objects(pg_catalog.text) FROM PUBLIC;
-- Keep this invoker SQL function inlineable: digest predicates must reach records indexes.
CREATE OR REPLACE FUNCTION public.hub_read_records() RETURNS TABLE(seq pg_catalog.int8,id pg_catalog.text,digest pg_catalog.text,kind pg_catalog.text,schema pg_catalog.text,provenance pg_catalog.text,created_at pg_catalog.timestamptz,body pg_catalog.text,size pg_catalog.int4) LANGUAGE sql STABLE AS $fn$
 SELECT r.seq,r.id,r.digest,r.kind,r.schema,r.provenance,r.created_at,COALESCE(h.body,k.body,CASE WHEN b.record IS NULL OR r.body<>b.marker OR p.data IS NULL THEN r.body ELSE pg_catalog.convert_from(p.data,'UTF8') END),r.size
 FROM public.records r LEFT JOIN public.personal_record_bindings b ON b.record=r.digest LEFT JOIN public.personal_payloads p ON (p.owner,p.epoch,p.sha256)=(b.owner,b.epoch,b.sha256)
 LEFT JOIN public.run_originals h ON h.artifact=r.digest LEFT JOIN public.run_pack_records k ON k.record=r.digest
 WHERE h.artifact IS NOT NULL OR k.record IS NOT NULL OR NOT EXISTS(SELECT 1 FROM public.personal_purges x WHERE (x.owner,x.epoch)=(b.owner,b.epoch))
$fn$;
CREATE FUNCTION public.hub_clear_personal_payloads(o pg_catalog.text,e pg_catalog.text) RETURNS pg_catalog.void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fn$
BEGIN
 IF EXISTS(SELECT 1 FROM public.personal_record_bindings b WHERE b.owner=o AND b.epoch=e AND NOT EXISTS(SELECT 1 FROM public.personal_legacy_ready d WHERE d.record=b.record))
 OR EXISTS(SELECT 1 FROM public.personal_objects x JOIN public.personal_legacy_retire q ON q.sha256=x.sha256 WHERE x.owner=o AND x.epoch=e AND NOT EXISTS(SELECT 1 FROM public.personal_legacy_retired d WHERE d.sha256=q.sha256)) THEN
 RAISE EXCEPTION 'legacy personal object materialization incomplete'; END IF;
 INSERT INTO public.personal_purges(owner,epoch) VALUES(o,e) ON CONFLICT DO NOTHING;
 DELETE FROM public.personal_payloads WHERE owner=o AND epoch=e;
 DELETE FROM public.record_index i USING public.personal_record_bindings b WHERE i.digest=b.record AND b.owner=o AND b.epoch=e AND i.key='artifact.object';
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
REVOKE ALL ON FUNCTION public.hub_clear_personal_payloads(pg_catalog.text,pg_catalog.text) FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.hub_purge_personal(o pg_catalog.text,e pg_catalog.text) RETURNS pg_catalog.void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fn$
BEGIN
 PERFORM 1 FROM public.personal_spaces WHERE owner=o AND epoch=e FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'unavailable' USING ERRCODE='P0002';END IF;
 PERFORM public.hub_finish_independent_objects(o);PERFORM public.hub_clear_personal_payloads(o,e);UPDATE public.personal_spaces SET mode='local' WHERE owner=o AND epoch=e;
END $fn$;
CREATE OR REPLACE FUNCTION public.hub_begin_member_deletion(a pg_catalog.text,o pg_catalog.text,e pg_catalog.text,op pg_catalog.text,m pg_catalog.text,c pg_catalog.jsonb,t pg_catalog.timestamptz,revision pg_catalog.timestamptz)
 RETURNS pg_catalog.void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE u public.users%ROWTYPE;admin_set_lock CONSTANT pg_catalog.int8:=7301562002;k pg_catalog.text;
BEGIN
 IF pg_catalog.jsonb_typeof(c)<>'object' OR c - ARRAY['records','payloads','objects','attributions','archives','private_versions']::pg_catalog.text[]<>'{}'::pg_catalog.jsonb THEN RAISE EXCEPTION 'invalid deletion counts';END IF;
 FOREACH k IN ARRAY ARRAY['records','payloads','objects','attributions','archives','private_versions']::pg_catalog.text[] LOOP
 IF NOT c ? k OR pg_catalog.jsonb_typeof(c->k)<>'number' OR (c->>k) !~ '^(0|[1-9][0-9]*)$' OR (c->>k)::pg_catalog.int8>9007199254740991 THEN RAISE EXCEPTION 'invalid deletion counts';END IF;
 END LOOP;
 -- Same administrator-set lock as role changes and deactivation.
 PERFORM pg_catalog.pg_advisory_xact_lock(admin_set_lock);
 PERFORM 1 FROM public.users WHERE id=a AND role='admin' AND NOT disabled FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO u FROM public.users WHERE id=o FOR UPDATE;
 IF NOT FOUND OR u.deleted_at IS NOT NULL OR u.updated_at<>revision THEN RAISE EXCEPTION 'member state changed';END IF;
 IF u.role='admin' AND NOT u.disabled AND NOT EXISTS(SELECT 1 FROM public.users WHERE role='admin' AND NOT disabled AND id<>o) THEN RAISE EXCEPTION 'last active administrator';END IF;
 INSERT INTO public.personal_spaces(owner,epoch) VALUES(o,e) ON CONFLICT DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM public.personal_spaces WHERE owner=o AND epoch=e) THEN RAISE EXCEPTION 'epoch changed';END IF;
 IF EXISTS(SELECT 1 FROM public.personal_record_bindings b WHERE b.owner=o AND NOT EXISTS(SELECT 1 FROM public.personal_purges p WHERE (p.owner,p.epoch)=(b.owner,b.epoch)) AND NOT EXISTS(SELECT 1 FROM public.personal_legacy_ready x WHERE x.record=b.record)) THEN RAISE EXCEPTION 'personal transfer incomplete';END IF;
 IF EXISTS(SELECT 1 FROM public.records r JOIN public.record_index i ON i.digest=r.digest AND i.key='personal.pack.owner' WHERE r.kind='personal_pack_version' AND i.value=o AND NOT EXISTS(SELECT 1 FROM public.personal_record_bindings b WHERE b.record=r.digest)) THEN RAISE EXCEPTION 'personal pack transfer incomplete';END IF;
 IF EXISTS(SELECT 1 FROM public.records r JOIN public.record_index i ON i.digest=r.digest AND i.key IN ('artifact.author','artifact.reader') AND i.value=o
 CROSS JOIN LATERAL (SELECT pg_catalog.replace(r.body,pg_catalog.chr(92)||'u0000',pg_catalog.chr(92)||'u0001')::pg_catalog.jsonb AS b) x
 WHERE r.kind='source_artifact' AND NOT EXISTS(SELECT 1 FROM public.personal_record_bindings q WHERE q.record=r.digest)
 AND public.hub_capture_owner(x.b)=o) THEN RAISE EXCEPTION 'private original transfer incomplete';END IF;
 INSERT INTO public.member_deletion_intents VALUES(o,op,a,e,t,m,c);
 UPDATE public.users SET disabled=true,deleted_at=t,password_hash=NULL,password_must_change=false,password_revision=password_revision+1,updated_at=t WHERE id=o;
 UPDATE public.tokens SET revoked_at=t,revoked_by=a WHERE user_id=o AND revoked_at IS NULL;
 INSERT INTO public.user_history(user_id,name,role,disabled,changed_by,changed_at,deleted_at) VALUES(o,u.name,u.role,true,a,t,t);
END $fn$;
CREATE OR REPLACE FUNCTION public.hub_finish_member_deletion(o pg_catalog.text,op pg_catalog.text) RETURNS pg_catalog.void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE e pg_catalog.text;a pg_catalog.text;
BEGIN
 SELECT epoch INTO e FROM public.member_deletion_intents WHERE member=o AND operation_id=op;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.users WHERE id=o AND disabled AND deleted_at IS NOT NULL) THEN RAISE EXCEPTION 'unavailable';END IF;
 PERFORM public.hub_purge_personal(o,e);SELECT account_epoch INTO a FROM public.personal_spaces WHERE owner=o;
 IF a IS NOT NULL THEN PERFORM public.hub_clear_personal_payloads(o,a);END IF;
 IF EXISTS(SELECT 1 FROM public.personal_payloads WHERE owner=o) THEN RAISE EXCEPTION 'personal payloads remain';END IF;
 DELETE FROM public.record_index i USING public.personal_record_bindings b WHERE i.digest=b.record AND b.owner=o AND i.key IN ('personal.pack.id','personal.pack.grant','personal.pack.retired');
END $fn$;
`},
 {version:21,name:'private_storage_holders',sql:`CREATE TABLE public.personal_cache_installs(owner pg_catalog.text NOT NULL REFERENCES public.users(id),digest pg_catalog.text NOT NULL CHECK(digest ~ '^[0-9a-f]{64}$'),PRIMARY KEY(owner,digest));
${APPEND_ONLY('personal_cache_installs')}
CREATE FUNCTION public.hub_active_cache_insert() RETURNS pg_catalog.trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fn$
BEGIN PERFORM 1 FROM public.users WHERE id=NEW.owner AND NOT disabled AND deleted_at IS NULL FOR SHARE;IF NOT FOUND THEN RAISE EXCEPTION 'inactive personal scope';END IF;RETURN NEW;END $fn$;
REVOKE ALL ON FUNCTION public.hub_active_cache_insert() FROM PUBLIC;
CREATE TRIGGER personal_cache_active BEFORE INSERT ON public.personal_cache_installs FOR EACH ROW EXECUTE FUNCTION public.hub_active_cache_insert();
CREATE TABLE public.run_upload_declarations(run_record pg_catalog.text NOT NULL REFERENCES public.records(digest),artifact pg_catalog.text NOT NULL REFERENCES public.records(digest),uploader pg_catalog.text NOT NULL REFERENCES public.users(id),PRIMARY KEY(run_record,artifact));
${APPEND_ONLY('run_upload_declarations')}
CREATE FUNCTION public.hub_freeze_upload_declarations(r pg_catalog.text) RETURNS pg_catalog.void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE run_body pg_catalog.jsonb;run_seq pg_catalog.int8;binding pg_catalog.jsonb;capture pg_catalog.record;b pg_catalog.jsonb;u pg_catalog.text;
BEGIN
 SELECT seq,pg_catalog.replace(body,pg_catalog.chr(92)||'u0000',pg_catalog.chr(92)||'u0001')::pg_catalog.jsonb INTO run_seq,run_body FROM public.records WHERE digest=r AND kind='run';IF NOT FOUND THEN RETURN;END IF;
 u:=COALESCE(run_body->>'runner',run_body->>'configurer');
 FOR binding IN SELECT value FROM pg_catalog.jsonb_array_elements(COALESCE(run_body->'sources','[]'::pg_catalog.jsonb)) LOOP
 IF binding->'upload_declaration' IS NULL OR u IS NULL OR NOT EXISTS(SELECT 1 FROM public.users WHERE id=u) OR binding->'upload_declaration'->>'by' IS DISTINCT FROM u OR binding->>'slot' IS NULL THEN CONTINUE;END IF;
 SELECT x.* INTO capture FROM public.hub_read_records() x WHERE x.digest=binding->>'artifact' AND x.kind='source_artifact' AND x.schema='source_artifact@1' AND x.provenance='declared';IF NOT FOUND THEN CONTINUE;END IF;
 b:=pg_catalog.replace(capture.body,pg_catalog.chr(92)||'u0000',pg_catalog.chr(92)||'u0001')::pg_catalog.jsonb;
 IF b->'author'->>'user' IS DISTINCT FROM u OR b->>'provenance_type'<>'declared' OR b->'origin'->'upload' IS NULL OR b->'personal_scope' IS NOT NULL OR pg_catalog.substring(binding->>'reference','^src:([0-9a-f]{64})(?:/|$)') IS DISTINCT FROM b->>'sha256' THEN CONTINUE;END IF;
 IF EXISTS(SELECT 1 FROM public.personal_record_bindings p JOIN public.personal_spaces q ON q.owner=p.owner WHERE p.record=capture.digest AND p.epoch IS DISTINCT FROM q.account_epoch) THEN CONTINUE;END IF;
 IF EXISTS(SELECT 1 FROM public.hub_read_records() a WHERE a.kind='knowledge_space_source' AND a.seq<=run_seq AND (pg_catalog.replace(a.body,pg_catalog.chr(92)||'u0000',pg_catalog.chr(92)||'u0001')::pg_catalog.jsonb)->>'space'<>'team' AND (pg_catalog.replace(a.body,pg_catalog.chr(92)||'u0000',pg_catalog.chr(92)||'u0001')::pg_catalog.jsonb)->>'artifact'=capture.digest) THEN CONTINUE;END IF;
 INSERT INTO public.run_upload_declarations VALUES(r,capture.digest,u) ON CONFLICT DO NOTHING;
 END LOOP;
END $fn$;
REVOKE ALL ON FUNCTION public.hub_freeze_upload_declarations(pg_catalog.text) FROM PUBLIC;
CREATE FUNCTION public.hub_freeze_run_uploads() RETURNS pg_catalog.trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fn$
BEGIN PERFORM public.hub_freeze_upload_declarations(NEW.digest);RETURN NULL;END $fn$;
REVOKE ALL ON FUNCTION public.hub_freeze_run_uploads() FROM PUBLIC;
CREATE TRIGGER records_frozen_uploads AFTER INSERT ON public.records FOR EACH ROW WHEN(NEW.kind='run') EXECUTE FUNCTION public.hub_freeze_run_uploads();
DO $backfill$ DECLARE r pg_catalog.record;BEGIN FOR r IN SELECT digest FROM public.records WHERE kind='run' LOOP PERFORM public.hub_freeze_upload_declarations(r.digest);END LOOP;END $backfill$;
-- The reviewed storage graph owns exact captures independently; textual mentions do not.
CREATE FUNCTION public.hub_keep_storage_original() RETURNS pg_catalog.trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fn$
BEGIN
 IF NEW.artifact AND NOT EXISTS(SELECT 1 FROM public.personal_record_bindings b WHERE b.record=NEW.record) THEN PERFORM public.hub_keep_capture(NEW.record,NEW.sha256,true);END IF;RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION public.hub_keep_storage_original() FROM PUBLIC;
CREATE TRIGGER object_holds_original AFTER INSERT ON public.object_holds FOR EACH ROW EXECUTE FUNCTION public.hub_keep_storage_original();
DO $holders$ DECLARE h pg_catalog.record;BEGIN FOR h IN SELECT a.record,a.sha256 FROM public.object_holds a WHERE a.artifact AND NOT EXISTS(SELECT 1 FROM public.personal_record_bindings b WHERE b.record=a.record) LOOP PERFORM public.hub_keep_capture(h.record,h.sha256,false);END LOOP;END $holders$;

`},
 {version:22,name:'member_deletion_holders',sql:`CREATE FUNCTION public.hub_check_member_holders(o pg_catalog.text) RETURNS pg_catalog.void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fn$
BEGIN
 IF EXISTS(SELECT 1 FROM public.records r
 CROSS JOIN LATERAL (SELECT pg_catalog.replace(r.body,pg_catalog.chr(92)||'u0000',pg_catalog.chr(92)||'u0001')::pg_catalog.jsonb AS body) b
 CROSS JOIN LATERAL (SELECT b.body->>'pack_space' AS owner,b.body->>'pack_digest' AS digest UNION ALL SELECT skill->>'space',skill->>'digest' FROM pg_catalog.jsonb_array_elements(CASE WHEN pg_catalog.jsonb_typeof(b.body->'skills')='array' THEN b.body->'skills' ELSE '[]'::pg_catalog.jsonb END) skill) wanted
 WHERE r.kind='run' AND wanted.owner=o AND NOT EXISTS(SELECT 1 FROM public.run_pack_records h WHERE h.owner=wanted.owner AND h.digest=wanted.digest)) THEN RAISE EXCEPTION 'frozen private version cannot be verified';END IF;
END $fn$;
REVOKE ALL ON FUNCTION public.hub_check_member_holders(pg_catalog.text) FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.hub_begin_member_deletion(a pg_catalog.text,o pg_catalog.text,e pg_catalog.text,op pg_catalog.text,m pg_catalog.text,c pg_catalog.jsonb,t pg_catalog.timestamptz,revision pg_catalog.timestamptz)
 RETURNS pg_catalog.void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE u public.users%ROWTYPE;admin_set_lock CONSTANT pg_catalog.int8:=7301562002;k pg_catalog.text;
BEGIN
 IF pg_catalog.jsonb_typeof(c)<>'object' OR c - ARRAY['records','payloads','objects','attributions','archives','private_versions']::pg_catalog.text[]<>'{}'::pg_catalog.jsonb THEN RAISE EXCEPTION 'invalid deletion counts';END IF;
 FOREACH k IN ARRAY ARRAY['records','payloads','objects','attributions','archives','private_versions']::pg_catalog.text[] LOOP
 IF NOT c ? k OR pg_catalog.jsonb_typeof(c->k)<>'number' OR (c->>k) !~ '^(0|[1-9][0-9]*)$' OR (c->>k)::pg_catalog.int8>9007199254740991 THEN RAISE EXCEPTION 'invalid deletion counts';END IF;
 END LOOP;
 -- Same administrator-set lock as role changes and deactivation.
 PERFORM pg_catalog.pg_advisory_xact_lock(admin_set_lock);
 PERFORM 1 FROM public.users WHERE id=a AND role='admin' AND NOT disabled FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO u FROM public.users WHERE id=o FOR UPDATE;
 IF NOT FOUND OR u.deleted_at IS NOT NULL OR u.updated_at<>revision THEN RAISE EXCEPTION 'member state changed';END IF;
 IF u.role='admin' AND NOT u.disabled AND NOT EXISTS(SELECT 1 FROM public.users WHERE role='admin' AND NOT disabled AND id<>o) THEN RAISE EXCEPTION 'last active administrator';END IF;
 INSERT INTO public.personal_spaces(owner,epoch) VALUES(o,e) ON CONFLICT DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM public.personal_spaces WHERE owner=o AND epoch=e) THEN RAISE EXCEPTION 'epoch changed';END IF;
 IF EXISTS(SELECT 1 FROM public.personal_record_bindings b WHERE b.owner=o AND NOT EXISTS(SELECT 1 FROM public.personal_purges p WHERE (p.owner,p.epoch)=(b.owner,b.epoch)) AND NOT EXISTS(SELECT 1 FROM public.personal_legacy_ready x WHERE x.record=b.record)) THEN RAISE EXCEPTION 'personal transfer incomplete';END IF;
 IF EXISTS(SELECT 1 FROM public.records r JOIN public.record_index i ON i.digest=r.digest AND i.key='personal.pack.owner' WHERE r.kind='personal_pack_version' AND i.value=o AND NOT EXISTS(SELECT 1 FROM public.personal_record_bindings b WHERE b.record=r.digest)) THEN RAISE EXCEPTION 'personal pack transfer incomplete';END IF;
 IF EXISTS(SELECT 1 FROM public.records r JOIN public.record_index i ON i.digest=r.digest AND i.key IN ('artifact.author','artifact.reader') AND i.value=o
 CROSS JOIN LATERAL (SELECT pg_catalog.replace(r.body,pg_catalog.chr(92)||'u0000',pg_catalog.chr(92)||'u0001')::pg_catalog.jsonb AS b) x
 WHERE r.kind='source_artifact' AND NOT EXISTS(SELECT 1 FROM public.personal_record_bindings q WHERE q.record=r.digest)
 AND public.hub_capture_owner(x.b)=o) THEN RAISE EXCEPTION 'private original transfer incomplete';END IF;
 PERFORM public.hub_check_member_holders(o);
 INSERT INTO public.member_deletion_intents VALUES(o,op,a,e,t,m,c);
 UPDATE public.users SET disabled=true,deleted_at=t,password_hash=NULL,password_must_change=false,password_revision=password_revision+1,updated_at=t WHERE id=o;
 UPDATE public.tokens SET revoked_at=t,revoked_by=a WHERE user_id=o AND revoked_at IS NULL;
 INSERT INTO public.user_history(user_id,name,role,disabled,changed_by,changed_at,deleted_at) VALUES(o,u.name,u.role,true,a,t,t);
END $fn$;
`},
]);

/** Tables and what the runtime role may do with them; nothing else (no DELETE, no TRUNCATE, no DDL, not the owner). */
export const RUNTIME_GRANTS: Readonly<Record<string, string>> = Object.freeze({
  member_deletion_intents:'SELECT',run_upload_declarations:'SELECT',personal_cache_installs:'SELECT, INSERT',
  run_pack_records:'SELECT',held_object_targets:'SELECT',held_objects:'SELECT',original_targets:'SELECT',
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
  personal_sync_mode_operations:'SELECT, INSERT',
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
    await db.query(`GRANT EXECUTE ON FUNCTION hub_begin_member_deletion(text,text,text,text,text,jsonb,timestamptz,timestamptz),hub_finish_member_deletion(text,text),hub_member_layout_conversion() TO "${role}"`, [], t);
    await db.query(`GRANT EXECUTE ON FUNCTION hub_account_scope(text,text),hub_restore_legacy_object(text,text,bytea),hub_finish_independent_objects(text),hub_account_layout_conversion() TO "${role}"`, [], t);
    await db.query(`GRANT EXECUTE ON FUNCTION hub_check_member_holders(text) TO "${role}"`, [], t);
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
