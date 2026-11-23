// New-database baseline; subsequent schema changes append checksummed migrations.
import type { Database, PgTransaction } from './db.ts';
import { sha256Hex } from './digest.ts';
import { MigrationError } from './errors.ts';

export interface Migration { version: number; name: string; sql: string }
const MIGRATION_LOCK = 7_301_562_001;

const BASELINE = String.raw`
SET LOCAL check_function_bodies = false;

CREATE FUNCTION public.hub_account_scope(o text, n text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $_$
DECLARE e pg_catalog.text;s public.personal_spaces%ROWTYPE;
BEGIN
 PERFORM 1 FROM public.users WHERE id=o AND NOT disabled AND deleted_at IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'unavailable' USING ERRCODE='P0002';END IF;
 INSERT INTO public.personal_spaces(owner,epoch) VALUES(o,'00000000-0000-4000-8000-000000000001') ON CONFLICT DO NOTHING;
 SELECT * INTO s FROM public.personal_spaces WHERE owner=o FOR UPDATE;
 IF s.account_epoch IS NOT NULL THEN RETURN s.account_epoch;END IF;
 IF n=s.epoch OR n !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' OR EXISTS(SELECT 1 FROM public.personal_purges WHERE owner=o AND epoch=n) THEN RAISE EXCEPTION 'invalid account scope';END IF;
 UPDATE public.personal_spaces SET account_epoch=n WHERE owner=o;RETURN n;
END $_$;

CREATE FUNCTION public.hub_active_cache_insert() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN PERFORM 1 FROM public.users WHERE id=NEW.owner AND NOT disabled AND deleted_at IS NULL FOR SHARE;IF NOT FOUND THEN RAISE EXCEPTION 'inactive personal scope';END IF;RETURN NEW;END $$;

CREATE FUNCTION public.hub_active_personal_insert() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
 PERFORM 1 FROM public.personal_spaces s JOIN public.users u ON u.id=s.owner WHERE s.owner=NEW.owner
 AND ((s.epoch=NEW.epoch AND s.mode='hub') OR s.account_epoch=NEW.epoch) AND u.deleted_at IS NULL FOR SHARE OF s;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.personal_purges WHERE owner=NEW.owner AND epoch=NEW.epoch) THEN RAISE EXCEPTION 'inactive personal scope';END IF;
 IF TG_TABLE_NAME='personal_objects' AND NOT EXISTS(SELECT 1 FROM public.personal_payloads WHERE owner=NEW.owner AND epoch=NEW.epoch AND sha256=NEW.sha256) THEN RAISE EXCEPTION 'personal object has no payload';END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION public.hub_append_only() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
 IF TG_TABLE_NAME='record_index' AND TG_OP='DELETE' THEN
 IF OLD.key='artifact.object' AND CURRENT_USER=pg_catalog.pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class WHERE oid='public.record_index'::pg_catalog.regclass)) AND EXISTS(SELECT 1 FROM public.personal_record_bindings b JOIN public.personal_purges p ON (p.owner,p.epoch)=(b.owner,b.epoch) WHERE b.record=OLD.digest) THEN RETURN OLD;END IF;
 IF OLD.key IN ('personal.pack.id','personal.pack.grant','personal.pack.retired')
 AND CURRENT_USER=pg_catalog.pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class WHERE oid='public.record_index'::pg_catalog.regclass))
 AND EXISTS(SELECT 1 FROM public.personal_record_bindings b JOIN public.personal_purges p ON (p.owner,p.epoch)=(b.owner,b.epoch)
 JOIN public.member_deletion_intents d ON d.member=b.owner JOIN public.users u ON u.id=d.member AND u.deleted_at IS NOT NULL WHERE b.record=OLD.digest) THEN RETURN OLD;END IF;
 END IF;
 RAISE EXCEPTION 'append-only table %: % rejected',TG_TABLE_NAME,TG_OP USING ERRCODE='HU001';
END $$;

CREATE FUNCTION public.hub_begin_member_deletion(a text, o text, e text, op text, m text, c jsonb, t timestamp with time zone, revision timestamp with time zone) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $_$
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
 IF EXISTS(SELECT 1 FROM public.records r JOIN public.record_index i ON i.digest=r.digest AND i.key='personal.pack.owner' WHERE r.kind='personal_pack_version' AND i.value=o AND NOT EXISTS(SELECT 1 FROM public.personal_record_bindings b WHERE b.record=r.digest)) THEN RAISE EXCEPTION 'personal pack transfer incomplete';END IF;
 IF EXISTS(SELECT 1 FROM public.records r JOIN public.record_index i ON i.digest=r.digest AND i.key IN ('artifact.author','artifact.reader') AND i.value=o
 CROSS JOIN LATERAL (SELECT pg_catalog.replace(r.body,pg_catalog.chr(92)||'u0000',pg_catalog.chr(92)||'u0001')::pg_catalog.jsonb AS b) x
 WHERE r.kind='source_artifact' AND NOT EXISTS(SELECT 1 FROM public.personal_record_bindings q WHERE q.record=r.digest)
 AND public.hub_capture_owner(x.b)=o) THEN RAISE EXCEPTION 'private original transfer incomplete';END IF;
 PERFORM public.hub_check_member_holders(o);
 PERFORM 1 FROM public.hub_member_deletion_snapshot(o) s WHERE s.purge_manifest=m AND s.counts=c;
 IF NOT FOUND THEN RAISE EXCEPTION 'deletion manifest or counts changed';END IF;
 INSERT INTO public.member_deletion_intents VALUES(o,op,a,e,t,m,c);
 UPDATE public.users SET disabled=true,deleted_at=t,password_hash=NULL,password_must_change=false,password_revision=password_revision+1,updated_at=t WHERE id=o;
 UPDATE public.tokens SET revoked_at=t,revoked_by=a WHERE user_id=o AND revoked_at IS NULL;
 INSERT INTO public.user_history(user_id,name,role,disabled,changed_by,changed_at,deleted_at) VALUES(o,u.name,u.role,true,a,t,t);
END $_$;

CREATE FUNCTION public.hub_capture_owner(b jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
 SELECT CASE WHEN b->'origin'->'upload' IS NOT NULL AND b->'visibility'->>'admins'='false' THEN b->'author'->>'user'
 WHEN b->'origin'->'read' IS NOT NULL AND b->'visibility'->>'admins'='false' AND pg_catalog.jsonb_array_length(b->'visibility'->'readers')=1 THEN b->'visibility'->'readers'->>0 ELSE NULL END
$$;

CREATE FUNCTION public.hub_check_member_holders(o text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.records r
 CROSS JOIN LATERAL (SELECT pg_catalog.replace(r.body,pg_catalog.chr(92)||'u0000',pg_catalog.chr(92)||'u0001')::pg_catalog.jsonb AS body) b
 CROSS JOIN LATERAL (SELECT b.body->>'pack_space' AS owner,b.body->>'pack_digest' AS digest UNION ALL SELECT skill->>'space',skill->>'digest' FROM pg_catalog.jsonb_array_elements(CASE WHEN pg_catalog.jsonb_typeof(b.body->'skills')='array' THEN b.body->'skills' ELSE '[]'::pg_catalog.jsonb END) skill) wanted
 WHERE r.kind='run' AND wanted.owner=o AND NOT EXISTS(SELECT 1 FROM public.run_pack_records h WHERE h.owner=wanted.owner AND h.digest=wanted.digest)) THEN RAISE EXCEPTION 'frozen private version cannot be verified';END IF;
END $$;

CREATE FUNCTION public.hub_check_personal_binding() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
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
END $$;

CREATE FUNCTION public.hub_clear_personal_payloads(o text, e text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
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
END $$;

CREATE FUNCTION public.hub_collect_personal_sync(o text, e text, t timestamp with time zone) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
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
END $$;

CREATE FUNCTION public.hub_finish_independent_objects(target_owner text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
 INSERT INTO public.held_objects SELECT t.sha256,t.held_by,p.data FROM public.held_object_targets t JOIN public.personal_objects o ON (o.owner,o.epoch,o.sha256)=(t.owner,t.epoch,t.sha256) JOIN public.personal_payloads p ON (p.owner,p.epoch,p.sha256)=(o.owner,o.epoch,o.sha256) WHERE (target_owner IS NULL OR t.owner=target_owner) AND NOT EXISTS(SELECT 1 FROM public.held_objects h WHERE h.sha256=t.sha256) ON CONFLICT DO NOTHING;
 INSERT INTO public.run_originals SELECT t.artifact,t.held_by,t.sha256,t.body,p.data FROM public.original_targets t JOIN public.personal_objects o ON (o.owner,o.epoch,o.sha256)=(t.owner,t.epoch,t.sha256) JOIN public.personal_payloads p ON (p.owner,p.epoch,p.sha256)=(o.owner,o.epoch,o.sha256) WHERE (target_owner IS NULL OR t.owner=target_owner) AND NOT EXISTS(SELECT 1 FROM public.run_originals h WHERE h.artifact=t.artifact) AND NOT EXISTS(SELECT 1 FROM public.run_original_purges x WHERE x.artifact=t.artifact) ON CONFLICT DO NOTHING;
 IF EXISTS(SELECT 1 FROM public.held_object_targets t WHERE (target_owner IS NULL OR t.owner=target_owner) AND NOT EXISTS(SELECT 1 FROM public.held_objects h WHERE h.sha256=t.sha256)) OR EXISTS(SELECT 1 FROM public.original_targets t WHERE (target_owner IS NULL OR t.owner=target_owner) AND NOT EXISTS(SELECT 1 FROM public.run_originals h WHERE h.artifact=t.artifact) AND NOT EXISTS(SELECT 1 FROM public.run_original_purges x WHERE x.artifact=t.artifact)) THEN RAISE EXCEPTION 'independent original transfer incomplete';END IF;
END $$;

CREATE FUNCTION public.hub_finish_member_deletion(o text, op text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
DECLARE e pg_catalog.text;a pg_catalog.text;
BEGIN
 SELECT epoch INTO e FROM public.member_deletion_intents WHERE member=o AND operation_id=op;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.users WHERE id=o AND disabled AND deleted_at IS NOT NULL) THEN RAISE EXCEPTION 'unavailable';END IF;
 PERFORM public.hub_purge_personal(o,e);SELECT account_epoch INTO a FROM public.personal_spaces WHERE owner=o;
 IF a IS NOT NULL THEN PERFORM public.hub_clear_personal_payloads(o,a);END IF;
 IF EXISTS(SELECT 1 FROM public.personal_payloads WHERE owner=o) THEN RAISE EXCEPTION 'personal payloads remain';END IF;
 DELETE FROM public.record_index i USING public.personal_record_bindings b WHERE i.digest=b.record AND b.owner=o AND i.key IN ('personal.pack.id','personal.pack.grant','personal.pack.retired');
END $$;

CREATE FUNCTION public.hub_finish_personal_record(d text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
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
END $$;

CREATE FUNCTION public.hub_freeze_private_run() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN PERFORM public.hub_keep_frozen_packs(NEW.digest,true);RETURN NULL;END $$;

CREATE FUNCTION public.hub_freeze_run_uploads() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN PERFORM public.hub_freeze_upload_declarations(NEW.digest);RETURN NULL;END $$;

CREATE FUNCTION public.hub_freeze_upload_declarations(r text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $_$
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
 -- Narrow by the capture hash before decoding any logical source body, including during the backfill.
 IF EXISTS(WITH candidates AS MATERIALIZED (
  SELECT a.body FROM public.record_index i JOIN public.hub_read_records() a ON a.digest=i.digest
  WHERE i.key='knowledge.space.source_hash' AND i.value=b->>'sha256' AND a.kind='knowledge_space_source' AND a.seq<=run_seq
 ) SELECT 1 FROM candidates a WHERE (pg_catalog.replace(a.body,pg_catalog.chr(92)||'u0000',pg_catalog.chr(92)||'u0001')::pg_catalog.jsonb)->>'space'<>'team' AND (pg_catalog.replace(a.body,pg_catalog.chr(92)||'u0000',pg_catalog.chr(92)||'u0001')::pg_catalog.jsonb)->>'artifact'=capture.digest) THEN CONTINUE;END IF;
 INSERT INTO public.run_upload_declarations VALUES(r,capture.digest,u) ON CONFLICT DO NOTHING;
 END LOOP;
END $_$;

CREATE FUNCTION public.hub_guard_member_scope() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
 IF NEW.mode='hub' AND EXISTS(SELECT 1 FROM public.users WHERE id=NEW.owner AND deleted_at IS NOT NULL) THEN RAISE EXCEPTION 'deleted member';END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION public.hub_guard_run_originals() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
 IF TG_OP='DELETE' AND CURRENT_USER=pg_catalog.pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class WHERE oid='public.run_originals'::pg_catalog.regclass))
 AND EXISTS(SELECT 1 FROM public.run_original_purges p WHERE p.artifact=OLD.artifact AND p.held_by=OLD.held_by) THEN RETURN OLD;END IF;
 RAISE EXCEPTION 'append-only table %: % rejected',TG_TABLE_NAME,TG_OP USING ERRCODE='HU001';
END $$;

CREATE FUNCTION public.hub_keep_capture(holder text, a text, required boolean) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
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
END $$;

CREATE FUNCTION public.hub_keep_frozen_packs(r text, required boolean) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
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
END $$;

CREATE FUNCTION public.hub_keep_inserted_run_originals() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN PERFORM public.hub_keep_run_originals(NEW.digest,true);RETURN NULL;END $$;

CREATE FUNCTION public.hub_keep_run_originals(r text, must_exist boolean) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
DECLARE a pg_catalog.text;
BEGIN
 FOR a IN SELECT h.sha256 FROM public.object_holds h JOIN public.records v ON v.digest=h.record AND v.kind='run' WHERE h.record=r AND h.artifact LOOP PERFORM public.hub_keep_capture(r,a,must_exist);END LOOP;
END $$;

CREATE FUNCTION public.hub_keep_storage_original() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
 IF NEW.artifact AND NOT EXISTS(SELECT 1 FROM public.personal_record_bindings b WHERE b.record=NEW.record) THEN PERFORM public.hub_keep_capture(NEW.record,NEW.sha256,true);END IF;RETURN NULL;
END $$;

CREATE FUNCTION public.hub_keep_team_original() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
DECLARE b pg_catalog.jsonb;
BEGIN
 b:=pg_catalog.replace(NEW.body,pg_catalog.chr(92)||'u0000',pg_catalog.chr(92)||'u0001')::pg_catalog.jsonb;
 IF b->>'space'='team' THEN PERFORM public.hub_keep_capture(NEW.digest,b->>'artifact',true);END IF;RETURN NULL;
END $$;

CREATE FUNCTION public.hub_lock_personal_scope(o text) RETURNS TABLE(epoch text, mode text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$ SELECT p.epoch,p.mode FROM public.personal_spaces p WHERE p.owner=o FOR SHARE $$;

CREATE FUNCTION public.hub_member_deletion_snapshot(o text) RETURNS TABLE(purge_manifest text, counts jsonb)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
 WITH r AS (SELECT b.record,r.kind FROM public.personal_record_bindings b JOIN public.records r ON r.digest=b.record WHERE b.owner=o AND NOT EXISTS(SELECT 1 FROM public.personal_purges p WHERE (p.owner,p.epoch)=(b.owner,b.epoch))),
 p AS (SELECT epoch,sha256 FROM public.personal_payloads WHERE owner=o),
 b AS (SELECT epoch,sha256 FROM public.personal_objects b WHERE owner=o AND NOT EXISTS(SELECT 1 FROM public.personal_purges p WHERE (p.owner,p.epoch)=(b.owner,b.epoch))),
 c AS (SELECT digest FROM public.personal_cache_installs WHERE owner=o),
 manifest AS (SELECT '{"caches":['||COALESCE((SELECT pg_catalog.string_agg(pg_catalog.to_json(digest)::pg_catalog.text,',' ORDER BY digest) FROM c),'')||'],"objects":['||COALESCE((SELECT pg_catalog.string_agg('{"epoch":'||pg_catalog.to_json(epoch)::pg_catalog.text||',"sha256":'||pg_catalog.to_json(sha256)::pg_catalog.text||'}',',' ORDER BY epoch,sha256) FROM b),'')||'],"payloads":['||COALESCE((SELECT pg_catalog.string_agg('{"epoch":'||pg_catalog.to_json(epoch)::pg_catalog.text||',"sha256":'||pg_catalog.to_json(sha256)::pg_catalog.text||'}',',' ORDER BY epoch,sha256) FROM p),'')||'],"records":['||COALESCE((SELECT pg_catalog.string_agg(pg_catalog.to_json(record)::pg_catalog.text,',' ORDER BY record) FROM r),'')||']}' AS text)
 SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(manifest.text,'UTF8')),'hex'),
 pg_catalog.jsonb_build_object('records',(SELECT pg_catalog.count(*) FROM r),'payloads',(SELECT pg_catalog.count(*) FROM p),'objects',(SELECT pg_catalog.count(*) FROM b),'attributions',(SELECT pg_catalog.count(*) FROM r WHERE kind='knowledge_source_attribution'),'archives',(SELECT pg_catalog.count(*) FROM r WHERE kind='knowledge_space_source'),'private_versions',(SELECT pg_catalog.count(*) FROM r WHERE kind='personal_pack_version')) FROM manifest
$$;

CREATE FUNCTION public.hub_object_refs(k text, b text) RETURNS TABLE(sha256 text, artifact boolean, members boolean)
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $_$
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
END $_$;

CREATE FUNCTION public.hub_personal_proof(d text, h text, o text, e text, n bigint, t timestamp with time zone, k text, p text, s text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
 SELECT encode(sha256(convert_to(d||':'||h||':'||o||':'||e||':'||n::text||':'||
 to_char(t AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')||':'||k||':'||p||':'||s,'UTF8')),'hex')
$$;

CREATE FUNCTION public.hub_personal_tree_children(o text, e text, h text) RETURNS SETOF text
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
DECLARE data bytea;
BEGIN
 SELECT p.data INTO data FROM public.personal_payloads p WHERE p.owner=o AND p.epoch=e AND p.sha256=h;
 IF FOUND THEN RETURN QUERY SELECT child->>'digest' FROM json_array_elements(COALESCE(replace(convert_from(data,'UTF8'),chr(92)||'u0000',chr(92)||'u0001')::json->'children','[]'::json)) child;END IF;
END $$;

CREATE FUNCTION public.hub_protect_deleted_member() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
 IF OLD.deleted_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'permanent member tombstone' USING ERRCODE='HU001';END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION public.hub_protect_token_revocation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
 IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by) THEN RAISE EXCEPTION 'permanent token revocation' USING ERRCODE='HU001';END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION public.hub_purge_personal(o text, e text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
 PERFORM 1 FROM public.personal_spaces WHERE owner=o AND epoch=e FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'unavailable' USING ERRCODE='P0002';END IF;
 INSERT INTO public.run_original_purges(artifact,held_by,owner,epoch,sha256,at) SELECT c.artifact,c.held_by,o,e,c.sha256,pg_catalog.now() FROM public.hub_run_citations(o,e) c ON CONFLICT DO NOTHING;
 DELETE FROM public.run_originals h USING public.run_original_purges p WHERE p.artifact=h.artifact AND p.held_by=h.held_by AND p.owner=o AND p.epoch=e;
 PERFORM public.hub_finish_independent_objects(o);PERFORM public.hub_clear_personal_payloads(o,e);UPDATE public.personal_spaces SET mode='local' WHERE owner=o AND epoch=e;
END $$;

CREATE FUNCTION public.hub_read_records() RETURNS TABLE(seq bigint, id text, digest text, kind text, schema text, provenance text, created_at timestamp with time zone, body text, size integer)
    LANGUAGE sql STABLE
    AS $$
 SELECT r.seq,r.id,r.digest,r.kind,r.schema,r.provenance,r.created_at,COALESCE(h.body,k.body,CASE WHEN b.record IS NULL OR r.body<>b.marker OR p.data IS NULL THEN r.body ELSE pg_catalog.convert_from(p.data,'UTF8') END),r.size
 FROM public.records r LEFT JOIN public.personal_record_bindings b ON b.record=r.digest LEFT JOIN public.personal_payloads p ON (p.owner,p.epoch,p.sha256)=(b.owner,b.epoch,b.sha256)
 LEFT JOIN public.run_originals h ON h.artifact=r.digest LEFT JOIN public.run_pack_records k ON k.record=r.digest
 WHERE h.artifact IS NOT NULL OR k.record IS NOT NULL OR NOT EXISTS(SELECT 1 FROM public.personal_purges x WHERE (x.owner,x.epoch)=(b.owner,b.epoch))
$$;

CREATE FUNCTION public.hub_replace_personal_memory(o text, e text, h jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
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
END $$;

CREATE FUNCTION public.hub_resume_personal(o text, e text, n text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $_$
BEGIN
 PERFORM 1 FROM public.personal_spaces WHERE owner=o AND epoch=e AND mode='local' FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.personal_purges WHERE owner=o AND epoch=e)
 OR n=e OR n !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 OR EXISTS(SELECT 1 FROM public.personal_purges WHERE owner=o AND epoch=n)
 OR EXISTS(SELECT 1 FROM public.personal_record_bindings WHERE owner=o AND epoch=n) THEN RAISE EXCEPTION 'unavailable' USING ERRCODE='P0002';END IF;
 UPDATE public.personal_spaces SET epoch=n,mode='hub' WHERE owner=o AND epoch=e;
END $_$;

CREATE FUNCTION public.hub_run_citations(o text, e text) RETURNS TABLE(artifact text, held_by text, sha256 text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
 SELECT t.artifact,t.held_by,t.sha256 FROM public.original_targets t JOIN public.records v ON v.digest=t.held_by AND v.kind<>'knowledge_space_source'
 WHERE t.owner=o AND t.epoch=e AND NOT EXISTS(SELECT 1 FROM public.run_original_purges p WHERE p.artifact=t.artifact)
$$;

CREATE FUNCTION public.hub_track_object_holds() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
DECLARE r public.records%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='records' THEN r:=NEW;
 ELSIF NEW.key='knowledge.feeding.object' THEN SELECT * INTO r FROM public.records WHERE digest=NEW.digest;
 ELSE RETURN NULL;END IF;
 IF r.kind='claim' AND NOT EXISTS(SELECT 1 FROM public.record_index i WHERE i.digest=r.digest AND i.key='knowledge.feeding.object') THEN RETURN NULL;END IF;
 INSERT INTO public.object_holds SELECT DISTINCT r.digest,x.* FROM public.hub_object_refs(r.kind,r.body) x ON CONFLICT DO NOTHING;
 RETURN NULL;
END $$;

CREATE TABLE public.call_logs (
    seq bigint NOT NULL,
    digest text NOT NULL,
    at timestamp with time zone NOT NULL,
    trace_id text NOT NULL,
    span_id text NOT NULL,
    user_id text,
    session_id text,
    tool text NOT NULL,
    run_id text,
    args_digest text NOT NULL,
    args_size bigint NOT NULL,
    args_preview text,
    call_result text NOT NULL,
    acceptance text,
    error_code text,
    duration_ms integer NOT NULL,
    CONSTRAINT call_logs_args_digest_check CHECK ((args_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT call_logs_args_preview_check CHECK ((octet_length(args_preview) <= 1024)),
    CONSTRAINT call_logs_args_size_check CHECK ((args_size >= 0)),
    CONSTRAINT call_logs_duration_ms_check CHECK ((duration_ms >= 0)),
    CONSTRAINT call_logs_span_id_check CHECK ((span_id ~ '^[0-9a-f]{16}$'::text)),
    CONSTRAINT call_logs_trace_id_check CHECK ((trace_id ~ '^[0-9a-f]{32}$'::text))
);

ALTER TABLE public.call_logs ALTER COLUMN seq ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.call_logs_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.call_notes (
    digest text NOT NULL,
    note text NOT NULL,
    at timestamp with time zone NOT NULL,
    CONSTRAINT call_notes_note_check CHECK (((length(note) >= 1) AND (length(note) <= 2000)))
);

CREATE TABLE public.call_reasons (
    digest text NOT NULL,
    ordinal integer NOT NULL,
    note text NOT NULL,
    at timestamp with time zone NOT NULL,
    CONSTRAINT call_reasons_note_check CHECK ((length(note) >= 1)),
    CONSTRAINT call_reasons_ordinal_check CHECK ((ordinal >= 0))
);

CREATE TABLE public.held_object_targets (
    sha256 text NOT NULL,
    held_by text NOT NULL,
    owner text NOT NULL,
    epoch text NOT NULL
);

CREATE TABLE public.held_objects (
    sha256 text NOT NULL,
    held_by text NOT NULL,
    data bytea NOT NULL,
    CONSTRAINT held_objects_check CHECK ((encode(sha256(data), 'hex'::text) = sha256))
);

CREATE TABLE public.invitations (
    id text NOT NULL,
    user_id text NOT NULL,
    sha256 text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    created_by text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    used_by_client text,
    CONSTRAINT invitations_check CHECK ((expires_at > created_at)),
    CONSTRAINT invitations_check1 CHECK (((used_at IS NULL) = (used_by_client IS NULL))),
    CONSTRAINT invitations_id_check CHECK ((id ~ '^inv_[0-9a-z]{26}$'::text)),
    CONSTRAINT invitations_sha256_check CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text))
);

CREATE TABLE public.knowledge_space_search (
    version text NOT NULL,
    space text NOT NULL,
    path text NOT NULL,
    entry text NOT NULL,
    record text NOT NULL,
    quota_space text NOT NULL
);

CREATE TABLE public.knowledge_space_search_documents (
    record text NOT NULL,
    tokens text[] NOT NULL,
    token_bytes bigint NOT NULL,
    CONSTRAINT knowledge_space_search_documents_token_bytes_check CHECK ((token_bytes >= 0))
);

CREATE TABLE public.knowledge_space_search_ready (
    version text NOT NULL,
    path text NOT NULL,
    row_count integer NOT NULL
);

CREATE TABLE public.knowledge_space_search_totals (
    quota_space text NOT NULL,
    version text NOT NULL,
    token_bytes bigint NOT NULL,
    refused_space_bytes bigint,
    refused_entry_bytes bigint,
    CONSTRAINT knowledge_space_search_totals_refused_entry_bytes_check CHECK ((refused_entry_bytes > 0)),
    CONSTRAINT knowledge_space_search_totals_refused_space_bytes_check CHECK ((refused_space_bytes > 0)),
    CONSTRAINT knowledge_space_search_totals_token_bytes_check CHECK ((token_bytes >= 0))
);

CREATE TABLE public.lease_registrations (
    prefix text NOT NULL,
    owner text NOT NULL,
    registered_at timestamp with time zone NOT NULL,
    CONSTRAINT lease_registrations_prefix_check CHECK (("right"(prefix, 1) = '/'::text))
);

CREATE TABLE public.leases (
    key text NOT NULL,
    lease_id text NOT NULL,
    run_id text NOT NULL,
    user_id text NOT NULL,
    token bigint NOT NULL,
    acquired_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone,
    released_at timestamp with time zone,
    CONSTRAINT leases_key_check CHECK ((key ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'::text)),
    CONSTRAINT leases_lease_id_check CHECK ((lease_id ~ '^lse_[0-9a-z]{26}$'::text)),
    CONSTRAINT leases_run_id_check CHECK ((run_id ~ '^run_[0-9a-z]{26}$'::text)),
    CONSTRAINT leases_token_check CHECK ((token >= 1)),
    CONSTRAINT leases_user_id_check CHECK ((user_id ~ '^usr_[0-9a-z]{26}$'::text))
);

CREATE TABLE public.member_deletion_intents (
    member text NOT NULL,
    operation_id text NOT NULL,
    by_user text NOT NULL,
    epoch text NOT NULL,
    at timestamp with time zone NOT NULL,
    purge_manifest text NOT NULL,
    counts jsonb NOT NULL,
    CONSTRAINT member_deletion_intents_operation_id_check CHECK ((operation_id ~ '^[0-9a-f-]{36}$'::text)),
    CONSTRAINT member_deletion_intents_purge_manifest_check CHECK ((purge_manifest ~ '^[0-9a-f]{64}$'::text))
);

CREATE TABLE public.memory_heads (
    document text NOT NULL,
    space text NOT NULL,
    version text NOT NULL,
    path text NOT NULL,
    state text NOT NULL,
    bytes bigint NOT NULL,
    context_bytes bigint DEFAULT 0 NOT NULL,
    CONSTRAINT memory_heads_bytes_check CHECK ((bytes >= 0)),
    CONSTRAINT memory_heads_context_bytes_check CHECK ((context_bytes >= 0))
);

CREATE TABLE public.memory_space_usage (
    space text NOT NULL,
    active_bytes bigint NOT NULL,
    history_bytes bigint NOT NULL,
    active_documents bigint DEFAULT 0 NOT NULL,
    CONSTRAINT memory_space_usage_active_bytes_check CHECK ((active_bytes >= 0)),
    CONSTRAINT memory_space_usage_active_documents_check CHECK ((active_documents >= 0)),
    CONSTRAINT memory_space_usage_history_bytes_check CHECK ((history_bytes >= 0))
);

CREATE TABLE public.oauth_clients (
    id text NOT NULL,
    name text NOT NULL,
    redirect_uris text[] NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT oauth_clients_id_check CHECK ((id ~ '^cli_[0-9a-z]{26}$'::text)),
    CONSTRAINT oauth_clients_name_check CHECK (((length(name) >= 1) AND (length(name) <= 100))),
    CONSTRAINT oauth_clients_redirect_uris_check CHECK (((cardinality(redirect_uris) >= 1) AND (cardinality(redirect_uris) <= 10)))
);

CREATE TABLE public.object_holds (
    record text NOT NULL,
    sha256 text NOT NULL,
    artifact boolean NOT NULL,
    members boolean NOT NULL
);

CREATE TABLE public.objects (
    sha256 text NOT NULL,
    size bigint NOT NULL,
    media_type text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT objects_media_type_check CHECK (((length(media_type) >= 1) AND (length(media_type) <= 200))),
    CONSTRAINT objects_sha256_check CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT objects_size_check CHECK ((size >= 0))
);

CREATE TABLE public.original_targets (
    artifact text NOT NULL,
    held_by text NOT NULL,
    owner text NOT NULL,
    epoch text NOT NULL,
    sha256 text NOT NULL,
    body text NOT NULL
);

CREATE TABLE public.personal_cache_installs (
    owner text NOT NULL,
    digest text NOT NULL,
    CONSTRAINT personal_cache_installs_digest_check CHECK ((digest ~ '^[0-9a-f]{64}$'::text))
);

CREATE TABLE public.personal_objects (
    owner text NOT NULL,
    epoch text NOT NULL,
    sha256 text NOT NULL
);

CREATE TABLE public.personal_payloads (
    owner text NOT NULL,
    epoch text NOT NULL,
    sha256 text NOT NULL,
    data bytea NOT NULL,
    CONSTRAINT personal_payloads_check CHECK ((encode(sha256(data), 'hex'::text) = sha256)),
    CONSTRAINT personal_payloads_sha256_check CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text))
);

CREATE TABLE public.personal_purges (
    owner text NOT NULL,
    epoch text NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.personal_record_bindings (
    record text NOT NULL,
    owner text NOT NULL,
    epoch text NOT NULL,
    sha256 text NOT NULL,
    bytes bigint NOT NULL,
    marker text NOT NULL,
    proof text NOT NULL
);

CREATE TABLE public.personal_spaces (
    owner text NOT NULL,
    epoch text NOT NULL,
    mode text DEFAULT 'hub'::text NOT NULL,
    account_epoch text,
    CONSTRAINT personal_spaces_mode_check CHECK ((mode = ANY (ARRAY['hub'::text, 'local'::text])))
);

CREATE TABLE public.personal_sync_aborts (
    session_id uuid NOT NULL,
    at timestamp with time zone NOT NULL
);

CREATE TABLE public.personal_sync_bindings (
    owner text NOT NULL,
    epoch text NOT NULL,
    kind text NOT NULL,
    item_id uuid NOT NULL,
    object_id text NOT NULL,
    native text NOT NULL,
    locator text NOT NULL
);

CREATE TABLE public.personal_sync_clients (
    owner text NOT NULL,
    epoch text NOT NULL,
    client_id uuid NOT NULL,
    name_payload text NOT NULL
);

CREATE TABLE public.personal_sync_edges (
    owner text NOT NULL,
    epoch text NOT NULL,
    parent text NOT NULL,
    child text NOT NULL
);

CREATE TABLE public.personal_sync_exports (
    owner text NOT NULL,
    epoch text NOT NULL,
    object_id text NOT NULL
);

CREATE TABLE public.personal_sync_heads (
    owner text NOT NULL,
    epoch text NOT NULL,
    snapshot text,
    last_synced_at timestamp with time zone,
    native_state text,
    memory_projection text,
    conflicts integer DEFAULT 0 NOT NULL
);

CREATE TABLE public.personal_sync_identities (
    owner text NOT NULL,
    epoch text NOT NULL,
    kind text NOT NULL,
    identity text NOT NULL,
    item_id uuid NOT NULL
);

CREATE TABLE public.personal_sync_memory_reservations (
    owner text NOT NULL,
    epoch text NOT NULL,
    bytes bigint NOT NULL,
    documents integer NOT NULL,
    CONSTRAINT personal_sync_memory_reservations_bytes_check CHECK ((bytes >= 0)),
    CONSTRAINT personal_sync_memory_reservations_documents_check CHECK ((documents >= 0))
);

CREATE TABLE public.personal_sync_mode_operations (
    owner text NOT NULL,
    epoch text NOT NULL,
    operation_id text NOT NULL,
    request text NOT NULL,
    result text NOT NULL
);

CREATE TABLE public.personal_sync_native_credits (
    owner text NOT NULL,
    epoch text NOT NULL,
    event text NOT NULL,
    bytes bigint NOT NULL,
    CONSTRAINT personal_sync_native_credits_bytes_check CHECK ((bytes >= 0))
);

CREATE TABLE public.personal_sync_notes (
    owner text NOT NULL,
    epoch text NOT NULL,
    kind text NOT NULL,
    id text NOT NULL,
    payload text NOT NULL,
    bytes integer NOT NULL,
    CONSTRAINT personal_sync_notes_bytes_check CHECK ((bytes >= 0))
);

CREATE TABLE public.personal_sync_objects (
    owner text NOT NULL,
    epoch text NOT NULL,
    id text NOT NULL,
    kind text NOT NULL,
    bytes integer NOT NULL,
    charge_bytes integer NOT NULL,
    CONSTRAINT personal_sync_objects_bytes_check CHECK ((bytes > 0)),
    CONSTRAINT personal_sync_objects_check CHECK (((charge_bytes > 0) AND (charge_bytes <= bytes)))
);

CREATE TABLE public.personal_sync_operations (
    owner text NOT NULL,
    epoch text NOT NULL,
    operation_id text NOT NULL,
    request text NOT NULL,
    receipt text NOT NULL
);

CREATE TABLE public.personal_sync_retained (
    owner text NOT NULL,
    epoch text NOT NULL,
    object_id text NOT NULL
);

CREATE TABLE public.personal_sync_session_objects (
    session_id uuid NOT NULL,
    object_id text NOT NULL,
    frozen boolean DEFAULT false NOT NULL
);

CREATE TABLE public.personal_sync_sessions (
    id uuid NOT NULL,
    owner text NOT NULL,
    epoch text NOT NULL,
    client_id uuid NOT NULL,
    snapshot text NOT NULL,
    state_version text NOT NULL,
    expires_at timestamp with time zone NOT NULL
);

CREATE TABLE public.pointers (
    name text NOT NULL,
    target text NOT NULL,
    version bigint NOT NULL,
    moved_at timestamp with time zone NOT NULL,
    action_digest text NOT NULL,
    CONSTRAINT pointers_name_check CHECK ((name ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'::text)),
    CONSTRAINT pointers_target_check CHECK ((target ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT pointers_version_check CHECK ((version >= 1))
);

CREATE TABLE public.process_events (
    seq bigint NOT NULL,
    at timestamp with time zone NOT NULL,
    kind text NOT NULL,
    boot text,
    pid integer,
    release text,
    node_version text,
    heap_limit_bytes bigint,
    uptime_ms bigint,
    last_seen_at timestamp with time zone,
    requests jsonb,
    requests_omitted integer DEFAULT 0 NOT NULL,
    reports jsonb,
    CONSTRAINT process_events_kind_check CHECK ((kind ~ '^[a-z][a-z_]{0,39}$'::text))
);

ALTER TABLE public.process_events ALTER COLUMN seq ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.process_events_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.record_index (
    key text NOT NULL,
    value text NOT NULL,
    digest text NOT NULL,
    record_seq bigint NOT NULL,
    CONSTRAINT record_index_key_check CHECK ((key ~ '^[a-z][a-z0-9_.-]{0,99}$'::text)),
    CONSTRAINT record_index_value_check CHECK ((octet_length(value) <= 1000))
);

CREATE TABLE public.record_keys (
    kind text NOT NULL,
    key text NOT NULL,
    digest text NOT NULL,
    CONSTRAINT record_keys_key_check CHECK (((octet_length(key) >= 1) AND (octet_length(key) <= 1000)))
);

CREATE TABLE public.records (
    seq bigint NOT NULL,
    id text NOT NULL,
    digest text NOT NULL,
    kind text NOT NULL,
    schema text NOT NULL,
    provenance text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    body text NOT NULL,
    size integer NOT NULL,
    CONSTRAINT records_digest_check CHECK ((digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT records_id_check CHECK ((id ~ '^rcd_[0-9a-z]{26}$'::text)),
    CONSTRAINT records_kind_check CHECK ((kind ~ '^[a-z][a-z_]{0,39}$'::text)),
    CONSTRAINT records_provenance_check CHECK ((provenance ~ '^[a-z][a-z_]{0,39}$'::text)),
    CONSTRAINT records_schema_check CHECK ((schema ~ '^[a-z][a-z0-9_-]*@[0-9]+$'::text)),
    CONSTRAINT records_size_check CHECK ((size >= 0))
);

ALTER TABLE public.records ALTER COLUMN seq ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.records_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.resource_samples (
    seq bigint NOT NULL,
    sampled_at timestamp with time zone NOT NULL,
    boot text NOT NULL,
    interval_ms integer,
    process_cpu_ratio double precision,
    event_loop_utilization double precision,
    event_loop_delay_p50_ms double precision,
    event_loop_delay_p99_ms double precision,
    event_loop_delay_max_ms double precision,
    heap_used_bytes bigint,
    heap_limit_bytes bigint,
    rss_bytes bigint,
    external_bytes bigint,
    array_buffers_bytes bigint,
    gc_pause_ms double precision,
    sandbox_running integer,
    sandbox_limit integer,
    sandbox_waiting integer,
    sandbox_timeouts bigint,
    sandbox_queue_full bigint,
    pool_limit integer,
    pool_total integer,
    pool_idle integer,
    pool_waiting integer,
    pool_connection_failures bigint,
    pg_active_connections integer,
    pg_cache_hit_ratio double precision,
    pg_waiting_locks integer,
    pg_deadlocks bigint,
    data_free_bytes bigint,
    io_wait_ratio double precision,
    mcp_sessions integer,
    mcp_sessions_by_client jsonb,
    console_streams integer,
    requests_in_flight integer,
    failed_reads text[] DEFAULT '{}'::text[] NOT NULL,
    dropped_samples integer DEFAULT 0 NOT NULL
);

ALTER TABLE public.resource_samples ALTER COLUMN seq ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.resource_samples_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.run_original_purges (
    artifact text NOT NULL,
    held_by text NOT NULL,
    owner text NOT NULL,
    epoch text NOT NULL,
    sha256 text NOT NULL,
    at timestamp with time zone NOT NULL,
    CONSTRAINT run_original_purges_sha256_check CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text))
);

CREATE TABLE public.run_originals (
    artifact text NOT NULL,
    held_by text NOT NULL,
    sha256 text NOT NULL,
    body text NOT NULL,
    data bytea NOT NULL,
    CONSTRAINT run_originals_check CHECK ((encode(sha256(data), 'hex'::text) = sha256))
);

CREATE TABLE public.run_pack_records (
    record text NOT NULL,
    held_by text NOT NULL,
    owner text NOT NULL,
    digest text NOT NULL,
    body text NOT NULL
);

CREATE TABLE public.run_upload_declarations (
    run_record text NOT NULL,
    artifact text NOT NULL,
    uploader text NOT NULL
);

CREATE TABLE public.tokens (
    id text NOT NULL,
    user_id text NOT NULL,
    sha256 text NOT NULL,
    label text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    created_by text,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    revoked_by text,
    client_id text,
    console_session boolean DEFAULT false NOT NULL,
    expires_at timestamp with time zone,
    CONSTRAINT tokens_id_check CHECK ((id ~ '^tok_[0-9a-z]{26}$'::text)),
    CONSTRAINT tokens_label_check CHECK ((length(label) <= 100)),
    CONSTRAINT tokens_sha256_check CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text))
);

CREATE TABLE public.trace_spans (
    trace_id text NOT NULL,
    span_id text NOT NULL,
    parent_span_id text,
    is_root boolean NOT NULL,
    name text NOT NULL,
    type text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone NOT NULL,
    level text NOT NULL,
    status_message text,
    origin text NOT NULL,
    user_id text,
    session_id text,
    run_id text,
    client_name text,
    client_version text,
    release text,
    environment text,
    usage jsonb NOT NULL,
    client_platform text,
    CONSTRAINT trace_spans_parent_span_id_check CHECK ((parent_span_id ~ '^[0-9a-f]{16}$'::text)),
    CONSTRAINT trace_spans_span_id_check CHECK ((span_id ~ '^[0-9a-f]{16}$'::text)),
    CONSTRAINT trace_spans_status_message_check CHECK ((char_length(status_message) <= 1000)),
    CONSTRAINT trace_spans_trace_id_check CHECK ((trace_id ~ '^[0-9a-f]{32}$'::text))
);

CREATE TABLE public.user_history (
    seq bigint NOT NULL,
    user_id text NOT NULL,
    name text NOT NULL,
    role text NOT NULL,
    disabled boolean NOT NULL,
    changed_by text,
    changed_at timestamp with time zone NOT NULL,
    password_changed boolean DEFAULT false NOT NULL,
    deleted_at timestamp with time zone
);

ALTER TABLE public.user_history ALTER COLUMN seq ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.user_history_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.users (
    id text NOT NULL,
    name text NOT NULL,
    role text NOT NULL,
    disabled boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    password_hash text,
    password_must_change boolean DEFAULT false NOT NULL,
    password_revision integer DEFAULT 0 NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT deleted_members_disabled CHECK (((deleted_at IS NULL) OR disabled)),
    CONSTRAINT users_id_check CHECK ((id ~ '^usr_[0-9a-z]{26}$'::text)),
    CONSTRAINT users_name_check CHECK (((length(name) >= 1) AND (length(name) <= 100))),
    CONSTRAINT users_role_check CHECK ((role ~ '^[a-z_]{1,40}$'::text))
);

ALTER TABLE ONLY public.call_logs
    ADD CONSTRAINT call_logs_digest_key UNIQUE (digest);

ALTER TABLE ONLY public.call_logs
    ADD CONSTRAINT call_logs_pkey PRIMARY KEY (seq);

ALTER TABLE ONLY public.call_notes
    ADD CONSTRAINT call_notes_pkey PRIMARY KEY (digest);

ALTER TABLE ONLY public.call_reasons
    ADD CONSTRAINT call_reasons_pkey PRIMARY KEY (digest, ordinal);

ALTER TABLE ONLY public.held_object_targets
    ADD CONSTRAINT held_object_targets_pkey PRIMARY KEY (sha256, held_by);

ALTER TABLE ONLY public.held_objects
    ADD CONSTRAINT held_objects_pkey PRIMARY KEY (sha256);

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_sha256_key UNIQUE (sha256);

ALTER TABLE ONLY public.knowledge_space_search_documents
    ADD CONSTRAINT knowledge_space_search_documents_pkey PRIMARY KEY (record);

ALTER TABLE ONLY public.knowledge_space_search
    ADD CONSTRAINT knowledge_space_search_pkey PRIMARY KEY (version, path, entry);

ALTER TABLE ONLY public.knowledge_space_search_ready
    ADD CONSTRAINT knowledge_space_search_ready_pkey PRIMARY KEY (version, path);

ALTER TABLE ONLY public.knowledge_space_search_totals
    ADD CONSTRAINT knowledge_space_search_totals_pkey PRIMARY KEY (quota_space, version);

ALTER TABLE ONLY public.lease_registrations
    ADD CONSTRAINT lease_registrations_pkey PRIMARY KEY (prefix);

ALTER TABLE ONLY public.leases
    ADD CONSTRAINT leases_pkey PRIMARY KEY (key);

ALTER TABLE ONLY public.member_deletion_intents
    ADD CONSTRAINT member_deletion_intents_operation_id_key UNIQUE (operation_id);

ALTER TABLE ONLY public.member_deletion_intents
    ADD CONSTRAINT member_deletion_intents_pkey PRIMARY KEY (member);

ALTER TABLE ONLY public.memory_heads
    ADD CONSTRAINT memory_heads_pkey PRIMARY KEY (document);

ALTER TABLE ONLY public.memory_space_usage
    ADD CONSTRAINT memory_space_usage_pkey PRIMARY KEY (space);

ALTER TABLE ONLY public.oauth_clients
    ADD CONSTRAINT oauth_clients_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.object_holds
    ADD CONSTRAINT object_holds_pkey PRIMARY KEY (record, sha256, artifact, members);

ALTER TABLE ONLY public.objects
    ADD CONSTRAINT objects_pkey PRIMARY KEY (sha256);

ALTER TABLE ONLY public.original_targets
    ADD CONSTRAINT original_targets_pkey PRIMARY KEY (artifact);

ALTER TABLE ONLY public.personal_cache_installs
    ADD CONSTRAINT personal_cache_installs_pkey PRIMARY KEY (owner, digest);

ALTER TABLE ONLY public.personal_objects
    ADD CONSTRAINT personal_objects_pkey PRIMARY KEY (owner, epoch, sha256);

ALTER TABLE ONLY public.personal_payloads
    ADD CONSTRAINT personal_payloads_pkey PRIMARY KEY (owner, epoch, sha256);

ALTER TABLE ONLY public.personal_purges
    ADD CONSTRAINT personal_purges_pkey PRIMARY KEY (owner, epoch);

ALTER TABLE ONLY public.personal_record_bindings
    ADD CONSTRAINT personal_record_bindings_pkey PRIMARY KEY (record);

ALTER TABLE ONLY public.personal_spaces
    ADD CONSTRAINT personal_spaces_pkey PRIMARY KEY (owner);

ALTER TABLE ONLY public.personal_sync_aborts
    ADD CONSTRAINT personal_sync_aborts_pkey PRIMARY KEY (session_id);

ALTER TABLE ONLY public.personal_sync_bindings
    ADD CONSTRAINT personal_sync_bindings_pkey PRIMARY KEY (owner, epoch, kind, object_id, native, locator);

ALTER TABLE ONLY public.personal_sync_clients
    ADD CONSTRAINT personal_sync_clients_pkey PRIMARY KEY (owner, epoch, client_id);

ALTER TABLE ONLY public.personal_sync_edges
    ADD CONSTRAINT personal_sync_edges_pkey PRIMARY KEY (owner, epoch, parent, child);

ALTER TABLE ONLY public.personal_sync_exports
    ADD CONSTRAINT personal_sync_exports_pkey PRIMARY KEY (owner, epoch, object_id);

ALTER TABLE ONLY public.personal_sync_heads
    ADD CONSTRAINT personal_sync_heads_pkey PRIMARY KEY (owner, epoch);

ALTER TABLE ONLY public.personal_sync_identities
    ADD CONSTRAINT personal_sync_identities_pkey PRIMARY KEY (owner, epoch, kind, identity);

ALTER TABLE ONLY public.personal_sync_memory_reservations
    ADD CONSTRAINT personal_sync_memory_reservations_pkey PRIMARY KEY (owner, epoch);

ALTER TABLE ONLY public.personal_sync_mode_operations
    ADD CONSTRAINT personal_sync_mode_operations_pkey PRIMARY KEY (owner, epoch, operation_id);

ALTER TABLE ONLY public.personal_sync_native_credits
    ADD CONSTRAINT personal_sync_native_credits_pkey PRIMARY KEY (owner, epoch, event);

ALTER TABLE ONLY public.personal_sync_notes
    ADD CONSTRAINT personal_sync_notes_pkey PRIMARY KEY (owner, epoch, kind, id);

ALTER TABLE ONLY public.personal_sync_objects
    ADD CONSTRAINT personal_sync_objects_pkey PRIMARY KEY (owner, epoch, id);

ALTER TABLE ONLY public.personal_sync_operations
    ADD CONSTRAINT personal_sync_operations_pkey PRIMARY KEY (owner, epoch, operation_id);

ALTER TABLE ONLY public.personal_sync_retained
    ADD CONSTRAINT personal_sync_retained_pkey PRIMARY KEY (owner, epoch, object_id);

ALTER TABLE ONLY public.personal_sync_session_objects
    ADD CONSTRAINT personal_sync_session_objects_pkey PRIMARY KEY (session_id, object_id);

ALTER TABLE ONLY public.personal_sync_sessions
    ADD CONSTRAINT personal_sync_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pointers
    ADD CONSTRAINT pointers_pkey PRIMARY KEY (name);

ALTER TABLE ONLY public.process_events
    ADD CONSTRAINT process_events_pkey PRIMARY KEY (seq);

ALTER TABLE ONLY public.record_index
    ADD CONSTRAINT record_index_pkey PRIMARY KEY (key, value, digest);

ALTER TABLE ONLY public.record_keys
    ADD CONSTRAINT record_keys_pkey PRIMARY KEY (kind, key);

ALTER TABLE ONLY public.records
    ADD CONSTRAINT records_digest_key UNIQUE (digest);

ALTER TABLE ONLY public.records
    ADD CONSTRAINT records_id_key UNIQUE (id);

ALTER TABLE ONLY public.records
    ADD CONSTRAINT records_pkey PRIMARY KEY (seq);

ALTER TABLE ONLY public.resource_samples
    ADD CONSTRAINT resource_samples_pkey PRIMARY KEY (seq);

ALTER TABLE ONLY public.run_original_purges
    ADD CONSTRAINT run_original_purges_pkey PRIMARY KEY (artifact);

ALTER TABLE ONLY public.run_originals
    ADD CONSTRAINT run_originals_pkey PRIMARY KEY (artifact);

ALTER TABLE ONLY public.run_pack_records
    ADD CONSTRAINT run_pack_records_pkey PRIMARY KEY (record);

ALTER TABLE ONLY public.run_upload_declarations
    ADD CONSTRAINT run_upload_declarations_pkey PRIMARY KEY (run_record, artifact);

ALTER TABLE ONLY public.tokens
    ADD CONSTRAINT tokens_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.tokens
    ADD CONSTRAINT tokens_sha256_key UNIQUE (sha256);

ALTER TABLE ONLY public.trace_spans
    ADD CONSTRAINT trace_spans_pkey PRIMARY KEY (trace_id, span_id);

ALTER TABLE ONLY public.user_history
    ADD CONSTRAINT user_history_pkey PRIMARY KEY (seq);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

CREATE INDEX call_logs_at ON public.call_logs USING btree (at);

CREATE INDEX call_logs_run_seq ON public.call_logs USING btree (run_id, seq);

CREATE INDEX call_logs_user_seq ON public.call_logs USING btree (user_id, seq);

CREATE INDEX held_object_targets_owner ON public.held_object_targets USING btree (owner, epoch);

CREATE INDEX invitations_user ON public.invitations USING btree (user_id);

CREATE INDEX knowledge_space_search_document_space ON public.knowledge_space_search USING btree (space, record);

CREATE INDEX knowledge_space_search_documents_tokens ON public.knowledge_space_search_documents USING gin (tokens);

CREATE INDEX knowledge_space_search_space ON public.knowledge_space_search USING btree (space, version);

CREATE INDEX leases_prefix ON public.leases USING btree (key);

CREATE INDEX memory_heads_space ON public.memory_heads USING btree (space, document);

CREATE INDEX oauth_clients_created ON public.oauth_clients USING btree (created_at);

CREATE INDEX object_holds_members ON public.object_holds USING btree (members) WHERE members;

CREATE INDEX object_holds_target ON public.object_holds USING btree (artifact, sha256, record);

CREATE INDEX original_targets_owner ON public.original_targets USING btree (owner, epoch);

CREATE INDEX personal_record_bindings_scope ON public.personal_record_bindings USING btree (owner, epoch, record);

CREATE INDEX personal_sync_bindings_native ON public.personal_sync_bindings USING btree (owner, epoch, kind, native, locator);

CREATE INDEX personal_sync_session_objects_object ON public.personal_sync_session_objects USING btree (object_id, session_id);

CREATE INDEX personal_sync_sessions_scope ON public.personal_sync_sessions USING btree (owner, epoch, expires_at);

CREATE INDEX process_events_at ON public.process_events USING btree (at);

CREATE UNIQUE INDEX process_events_end ON public.process_events USING btree (boot) WHERE (kind <> 'start'::text);

CREATE UNIQUE INDEX process_events_start ON public.process_events USING btree (boot) WHERE (kind = 'start'::text);

CREATE INDEX record_index_digest ON public.record_index USING btree (digest);

CREATE INDEX record_index_lookup ON public.record_index USING btree (key, value, record_seq);

CREATE INDEX records_kind_seq ON public.records USING btree (kind, seq);

CREATE INDEX resource_samples_boot ON public.resource_samples USING btree (boot, sampled_at);

CREATE INDEX resource_samples_sampled_at ON public.resource_samples USING btree (sampled_at);

CREATE INDEX run_original_purges_owner ON public.run_original_purges USING btree (owner, epoch);

CREATE INDEX run_originals_sha256 ON public.run_originals USING btree (sha256);

CREATE INDEX run_pack_records_scope ON public.run_pack_records USING btree (owner, digest);

CREATE INDEX tokens_user ON public.tokens USING btree (user_id);

CREATE INDEX trace_spans_mcp_releases ON public.trace_spans USING btree (release, started_at DESC) WHERE (is_root AND (origin = 'mcp'::text));

CREATE INDEX trace_spans_root_names ON public.trace_spans USING btree (name, started_at DESC) WHERE is_root;

CREATE INDEX trace_spans_root_users ON public.trace_spans USING btree (user_id, started_at DESC) WHERE is_root;

CREATE INDEX trace_spans_roots ON public.trace_spans USING btree (started_at DESC) WHERE is_root;

CREATE INDEX trace_spans_started ON public.trace_spans USING btree (started_at);

CREATE INDEX user_history_user ON public.user_history USING btree (user_id, seq);

CREATE UNIQUE INDEX users_live_name ON public.users USING btree (name) WHERE (deleted_at IS NULL);

CREATE TRIGGER call_logs_append_only BEFORE DELETE OR UPDATE ON public.call_logs FOR EACH ROW EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER call_logs_no_truncate BEFORE TRUNCATE ON public.call_logs FOR EACH STATEMENT EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER call_notes_append_only BEFORE DELETE OR UPDATE ON public.call_notes FOR EACH ROW EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER call_notes_no_truncate BEFORE TRUNCATE ON public.call_notes FOR EACH STATEMENT EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER call_reasons_append_only BEFORE DELETE OR UPDATE ON public.call_reasons FOR EACH ROW EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER call_reasons_no_truncate BEFORE TRUNCATE ON public.call_reasons FOR EACH STATEMENT EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER held_object_targets_append_only BEFORE DELETE OR UPDATE ON public.held_object_targets FOR EACH ROW EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER held_object_targets_no_truncate BEFORE TRUNCATE ON public.held_object_targets FOR EACH STATEMENT EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER held_objects_append_only BEFORE DELETE OR UPDATE ON public.held_objects FOR EACH ROW EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER held_objects_no_truncate BEFORE TRUNCATE ON public.held_objects FOR EACH STATEMENT EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER member_deletion_intents_append_only BEFORE DELETE OR UPDATE ON public.member_deletion_intents FOR EACH ROW EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER member_deletion_intents_no_truncate BEFORE TRUNCATE ON public.member_deletion_intents FOR EACH STATEMENT EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER object_holds_append_only BEFORE DELETE OR UPDATE ON public.object_holds FOR EACH ROW EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER object_holds_no_truncate BEFORE TRUNCATE ON public.object_holds FOR EACH STATEMENT EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER object_holds_original AFTER INSERT ON public.object_holds FOR EACH ROW EXECUTE FUNCTION public.hub_keep_storage_original();

CREATE TRIGGER objects_append_only BEFORE DELETE OR UPDATE ON public.objects FOR EACH ROW EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER objects_no_truncate BEFORE TRUNCATE ON public.objects FOR EACH STATEMENT EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER original_targets_append_only BEFORE DELETE OR UPDATE ON public.original_targets FOR EACH ROW EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER original_targets_no_truncate BEFORE TRUNCATE ON public.original_targets FOR EACH STATEMENT EXECUTE FUNCTION public.hub_append_only();

CREATE CONSTRAINT TRIGGER personal_binding_check AFTER INSERT ON public.personal_record_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.hub_check_personal_binding();

CREATE TRIGGER personal_cache_active BEFORE INSERT ON public.personal_cache_installs FOR EACH ROW EXECUTE FUNCTION public.hub_active_cache_insert();

CREATE TRIGGER personal_cache_installs_append_only BEFORE DELETE OR UPDATE ON public.personal_cache_installs FOR EACH ROW EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER personal_cache_installs_no_truncate BEFORE TRUNCATE ON public.personal_cache_installs FOR EACH STATEMENT EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER personal_objects_active BEFORE INSERT ON public.personal_objects FOR EACH ROW EXECUTE FUNCTION public.hub_active_personal_insert();

CREATE TRIGGER personal_objects_append_only BEFORE DELETE OR UPDATE ON public.personal_objects FOR EACH ROW EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER personal_objects_no_truncate BEFORE TRUNCATE ON public.personal_objects FOR EACH STATEMENT EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER personal_payloads_active BEFORE INSERT ON public.personal_payloads FOR EACH ROW EXECUTE FUNCTION public.hub_active_personal_insert();

CREATE TRIGGER personal_payloads_immutable BEFORE UPDATE ON public.personal_payloads FOR EACH ROW EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER personal_purges_append_only BEFORE DELETE OR UPDATE ON public.personal_purges FOR EACH ROW EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER personal_purges_no_truncate BEFORE TRUNCATE ON public.personal_purges FOR EACH STATEMENT EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER personal_record_bindings_append_only BEFORE DELETE OR UPDATE ON public.personal_record_bindings FOR EACH ROW EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER personal_record_bindings_no_truncate BEFORE TRUNCATE ON public.personal_record_bindings FOR EACH STATEMENT EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER personal_spaces_member BEFORE INSERT OR UPDATE ON public.personal_spaces FOR EACH ROW EXECUTE FUNCTION public.hub_guard_member_scope();

CREATE TRIGGER personal_sync_aborts_append_only BEFORE DELETE OR UPDATE ON public.personal_sync_aborts FOR EACH ROW EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER personal_sync_aborts_no_truncate BEFORE TRUNCATE ON public.personal_sync_aborts FOR EACH STATEMENT EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER personal_sync_bindings_append_only BEFORE DELETE OR UPDATE ON public.personal_sync_bindings FOR EACH ROW EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER personal_sync_bindings_no_truncate BEFORE TRUNCATE ON public.personal_sync_bindings FOR EACH STATEMENT EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER personal_sync_clients_append_only BEFORE DELETE OR UPDATE ON public.personal_sync_clients FOR EACH ROW EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER personal_sync_clients_no_truncate BEFORE TRUNCATE ON public.personal_sync_clients FOR EACH STATEMENT EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER personal_sync_edges_append_only BEFORE DELETE OR UPDATE ON public.personal_sync_edges FOR EACH ROW EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER personal_sync_edges_no_truncate BEFORE TRUNCATE ON public.personal_sync_edges FOR EACH STATEMENT EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER personal_sync_exports_append_only BEFORE DELETE OR UPDATE ON public.personal_sync_exports FOR EACH ROW EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER personal_sync_exports_no_truncate BEFORE TRUNCATE ON public.personal_sync_exports FOR EACH STATEMENT EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER personal_sync_identities_append_only BEFORE DELETE OR UPDATE ON public.personal_sync_identities FOR EACH ROW EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER personal_sync_identities_no_truncate BEFORE TRUNCATE ON public.personal_sync_identities FOR EACH STATEMENT EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER personal_sync_mode_operations_append_only BEFORE DELETE OR UPDATE ON public.personal_sync_mode_operations FOR EACH ROW EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER personal_sync_mode_operations_no_truncate BEFORE TRUNCATE ON public.personal_sync_mode_operations FOR EACH STATEMENT EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER personal_sync_native_credits_append_only BEFORE DELETE OR UPDATE ON public.personal_sync_native_credits FOR EACH ROW EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER personal_sync_native_credits_no_truncate BEFORE TRUNCATE ON public.personal_sync_native_credits FOR EACH STATEMENT EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER personal_sync_notes_append_only BEFORE DELETE OR UPDATE ON public.personal_sync_notes FOR EACH ROW EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER personal_sync_notes_no_truncate BEFORE TRUNCATE ON public.personal_sync_notes FOR EACH STATEMENT EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER personal_sync_objects_immutable BEFORE UPDATE ON public.personal_sync_objects FOR EACH ROW EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER personal_sync_operations_append_only BEFORE DELETE OR UPDATE ON public.personal_sync_operations FOR EACH ROW EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER personal_sync_operations_no_truncate BEFORE TRUNCATE ON public.personal_sync_operations FOR EACH STATEMENT EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER personal_sync_retained_append_only BEFORE DELETE OR UPDATE ON public.personal_sync_retained FOR EACH ROW EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER personal_sync_retained_no_truncate BEFORE TRUNCATE ON public.personal_sync_retained FOR EACH STATEMENT EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER personal_sync_session_objects_append_only BEFORE DELETE OR UPDATE ON public.personal_sync_session_objects FOR EACH ROW EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER personal_sync_session_objects_no_truncate BEFORE TRUNCATE ON public.personal_sync_session_objects FOR EACH STATEMENT EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER personal_sync_sessions_append_only BEFORE DELETE OR UPDATE ON public.personal_sync_sessions FOR EACH ROW EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER personal_sync_sessions_no_truncate BEFORE TRUNCATE ON public.personal_sync_sessions FOR EACH STATEMENT EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER record_index_append_only BEFORE DELETE OR UPDATE ON public.record_index FOR EACH ROW EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER record_index_no_truncate BEFORE TRUNCATE ON public.record_index FOR EACH STATEMENT EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER record_index_object_holds AFTER INSERT ON public.record_index FOR EACH ROW EXECUTE FUNCTION public.hub_track_object_holds();

CREATE TRIGGER record_keys_append_only BEFORE DELETE OR UPDATE ON public.record_keys FOR EACH ROW EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER record_keys_no_truncate BEFORE TRUNCATE ON public.record_keys FOR EACH STATEMENT EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER records_append_only BEFORE DELETE OR UPDATE ON public.records FOR EACH ROW EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER records_frozen_uploads AFTER INSERT ON public.records FOR EACH ROW WHEN ((new.kind = 'run'::text)) EXECUTE FUNCTION public.hub_freeze_run_uploads();

CREATE TRIGGER records_no_truncate BEFORE TRUNCATE ON public.records FOR EACH STATEMENT EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER records_object_holds AFTER INSERT ON public.records FOR EACH ROW EXECUTE FUNCTION public.hub_track_object_holds();

CREATE TRIGGER records_private_run AFTER INSERT ON public.records FOR EACH ROW WHEN ((new.kind = 'run'::text)) EXECUTE FUNCTION public.hub_freeze_private_run();

CREATE TRIGGER records_run_originals AFTER INSERT ON public.records FOR EACH ROW WHEN ((new.kind = 'run'::text)) EXECUTE FUNCTION public.hub_keep_inserted_run_originals();

CREATE TRIGGER records_team_original AFTER INSERT ON public.records FOR EACH ROW WHEN ((new.kind = 'knowledge_space_source'::text)) EXECUTE FUNCTION public.hub_keep_team_original();

CREATE TRIGGER run_original_purges_append_only BEFORE DELETE OR UPDATE ON public.run_original_purges FOR EACH ROW EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER run_original_purges_no_truncate BEFORE TRUNCATE ON public.run_original_purges FOR EACH STATEMENT EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER run_originals_append_only BEFORE DELETE OR UPDATE ON public.run_originals FOR EACH ROW EXECUTE FUNCTION public.hub_guard_run_originals();

CREATE TRIGGER run_originals_no_truncate BEFORE TRUNCATE ON public.run_originals FOR EACH STATEMENT EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER run_pack_records_append_only BEFORE DELETE OR UPDATE ON public.run_pack_records FOR EACH ROW EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER run_pack_records_no_truncate BEFORE TRUNCATE ON public.run_pack_records FOR EACH STATEMENT EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER run_upload_declarations_append_only BEFORE DELETE OR UPDATE ON public.run_upload_declarations FOR EACH ROW EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER run_upload_declarations_no_truncate BEFORE TRUNCATE ON public.run_upload_declarations FOR EACH STATEMENT EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER tokens_revocation BEFORE UPDATE ON public.tokens FOR EACH ROW EXECUTE FUNCTION public.hub_protect_token_revocation();

CREATE TRIGGER user_history_append_only BEFORE DELETE OR UPDATE ON public.user_history FOR EACH ROW EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER user_history_no_truncate BEFORE TRUNCATE ON public.user_history FOR EACH STATEMENT EXECUTE FUNCTION public.hub_append_only();

CREATE TRIGGER users_tombstone BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.hub_protect_deleted_member();

ALTER TABLE ONLY public.call_logs
    ADD CONSTRAINT call_logs_digest_fkey FOREIGN KEY (digest) REFERENCES public.records(digest);

ALTER TABLE ONLY public.call_notes
    ADD CONSTRAINT call_notes_digest_fkey FOREIGN KEY (digest) REFERENCES public.call_logs(digest);

ALTER TABLE ONLY public.call_reasons
    ADD CONSTRAINT call_reasons_digest_fkey FOREIGN KEY (digest) REFERENCES public.call_logs(digest);

ALTER TABLE ONLY public.held_object_targets
    ADD CONSTRAINT held_object_targets_held_by_fkey FOREIGN KEY (held_by) REFERENCES public.records(digest);

ALTER TABLE ONLY public.held_objects
    ADD CONSTRAINT held_objects_held_by_fkey FOREIGN KEY (held_by) REFERENCES public.records(digest);

ALTER TABLE ONLY public.held_objects
    ADD CONSTRAINT held_objects_sha256_fkey FOREIGN KEY (sha256) REFERENCES public.objects(sha256);

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_used_by_client_fkey FOREIGN KEY (used_by_client) REFERENCES public.oauth_clients(id);

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.knowledge_space_search
    ADD CONSTRAINT knowledge_space_search_document FOREIGN KEY (record) REFERENCES public.knowledge_space_search_documents(record);

ALTER TABLE ONLY public.knowledge_space_search_documents
    ADD CONSTRAINT knowledge_space_search_documents_record_fkey FOREIGN KEY (record) REFERENCES public.records(digest);

ALTER TABLE ONLY public.knowledge_space_search_ready
    ADD CONSTRAINT knowledge_space_search_ready_version_fkey FOREIGN KEY (version) REFERENCES public.records(digest);

ALTER TABLE ONLY public.knowledge_space_search
    ADD CONSTRAINT knowledge_space_search_record_fkey FOREIGN KEY (record) REFERENCES public.records(digest);

ALTER TABLE ONLY public.knowledge_space_search_totals
    ADD CONSTRAINT knowledge_space_search_totals_version_fkey FOREIGN KEY (version) REFERENCES public.records(digest);

ALTER TABLE ONLY public.knowledge_space_search
    ADD CONSTRAINT knowledge_space_search_version_fkey FOREIGN KEY (version) REFERENCES public.records(digest);

ALTER TABLE ONLY public.member_deletion_intents
    ADD CONSTRAINT member_deletion_intents_by_user_fkey FOREIGN KEY (by_user) REFERENCES public.users(id);

ALTER TABLE ONLY public.member_deletion_intents
    ADD CONSTRAINT member_deletion_intents_member_fkey FOREIGN KEY (member) REFERENCES public.users(id);

ALTER TABLE ONLY public.memory_heads
    ADD CONSTRAINT memory_heads_document_fkey FOREIGN KEY (document) REFERENCES public.records(digest);

ALTER TABLE ONLY public.memory_heads
    ADD CONSTRAINT memory_heads_version_fkey FOREIGN KEY (version) REFERENCES public.records(digest);

ALTER TABLE ONLY public.object_holds
    ADD CONSTRAINT object_holds_record_fkey FOREIGN KEY (record) REFERENCES public.records(digest);

ALTER TABLE ONLY public.original_targets
    ADD CONSTRAINT original_targets_artifact_fkey FOREIGN KEY (artifact) REFERENCES public.records(digest);

ALTER TABLE ONLY public.original_targets
    ADD CONSTRAINT original_targets_held_by_fkey FOREIGN KEY (held_by) REFERENCES public.records(digest);

ALTER TABLE ONLY public.personal_cache_installs
    ADD CONSTRAINT personal_cache_installs_owner_fkey FOREIGN KEY (owner) REFERENCES public.users(id);

ALTER TABLE ONLY public.personal_objects
    ADD CONSTRAINT personal_objects_owner_fkey FOREIGN KEY (owner) REFERENCES public.users(id);

ALTER TABLE ONLY public.personal_payloads
    ADD CONSTRAINT personal_payloads_owner_fkey FOREIGN KEY (owner) REFERENCES public.users(id);

ALTER TABLE ONLY public.personal_purges
    ADD CONSTRAINT personal_purges_owner_fkey FOREIGN KEY (owner) REFERENCES public.users(id);

ALTER TABLE ONLY public.personal_record_bindings
    ADD CONSTRAINT personal_record_bindings_owner_fkey FOREIGN KEY (owner) REFERENCES public.users(id);

ALTER TABLE ONLY public.personal_spaces
    ADD CONSTRAINT personal_spaces_owner_fkey FOREIGN KEY (owner) REFERENCES public.users(id);

ALTER TABLE ONLY public.personal_sync_aborts
    ADD CONSTRAINT personal_sync_aborts_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.personal_sync_sessions(id);

ALTER TABLE ONLY public.personal_sync_bindings
    ADD CONSTRAINT personal_sync_bindings_owner_fkey FOREIGN KEY (owner) REFERENCES public.users(id);

ALTER TABLE ONLY public.personal_sync_clients
    ADD CONSTRAINT personal_sync_clients_owner_fkey FOREIGN KEY (owner) REFERENCES public.users(id);

ALTER TABLE ONLY public.personal_sync_edges
    ADD CONSTRAINT personal_sync_edges_owner_fkey FOREIGN KEY (owner) REFERENCES public.users(id);

ALTER TABLE ONLY public.personal_sync_exports
    ADD CONSTRAINT personal_sync_exports_owner_fkey FOREIGN KEY (owner) REFERENCES public.users(id);

ALTER TABLE ONLY public.personal_sync_heads
    ADD CONSTRAINT personal_sync_heads_owner_fkey FOREIGN KEY (owner) REFERENCES public.users(id);

ALTER TABLE ONLY public.personal_sync_identities
    ADD CONSTRAINT personal_sync_identities_owner_fkey FOREIGN KEY (owner) REFERENCES public.users(id);

ALTER TABLE ONLY public.personal_sync_memory_reservations
    ADD CONSTRAINT personal_sync_memory_reservations_owner_fkey FOREIGN KEY (owner) REFERENCES public.users(id);

ALTER TABLE ONLY public.personal_sync_mode_operations
    ADD CONSTRAINT personal_sync_mode_operations_owner_fkey FOREIGN KEY (owner) REFERENCES public.users(id);

ALTER TABLE ONLY public.personal_sync_native_credits
    ADD CONSTRAINT personal_sync_native_credits_owner_fkey FOREIGN KEY (owner) REFERENCES public.users(id);

ALTER TABLE ONLY public.personal_sync_notes
    ADD CONSTRAINT personal_sync_notes_owner_fkey FOREIGN KEY (owner) REFERENCES public.users(id);

ALTER TABLE ONLY public.personal_sync_objects
    ADD CONSTRAINT personal_sync_objects_owner_fkey FOREIGN KEY (owner) REFERENCES public.users(id);

ALTER TABLE ONLY public.personal_sync_operations
    ADD CONSTRAINT personal_sync_operations_owner_fkey FOREIGN KEY (owner) REFERENCES public.users(id);

ALTER TABLE ONLY public.personal_sync_retained
    ADD CONSTRAINT personal_sync_retained_owner_fkey FOREIGN KEY (owner) REFERENCES public.users(id);

ALTER TABLE ONLY public.personal_sync_session_objects
    ADD CONSTRAINT personal_sync_session_objects_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.personal_sync_sessions(id);

ALTER TABLE ONLY public.personal_sync_sessions
    ADD CONSTRAINT personal_sync_sessions_owner_epoch_client_id_fkey FOREIGN KEY (owner, epoch, client_id) REFERENCES public.personal_sync_clients(owner, epoch, client_id);

ALTER TABLE ONLY public.personal_sync_sessions
    ADD CONSTRAINT personal_sync_sessions_owner_fkey FOREIGN KEY (owner) REFERENCES public.users(id);

ALTER TABLE ONLY public.pointers
    ADD CONSTRAINT pointers_action_digest_fkey FOREIGN KEY (action_digest) REFERENCES public.records(digest);

ALTER TABLE ONLY public.record_index
    ADD CONSTRAINT record_index_digest_fkey FOREIGN KEY (digest) REFERENCES public.records(digest);

ALTER TABLE ONLY public.record_keys
    ADD CONSTRAINT record_keys_digest_fkey FOREIGN KEY (digest) REFERENCES public.records(digest);

ALTER TABLE ONLY public.run_original_purges
    ADD CONSTRAINT run_original_purges_artifact_fkey FOREIGN KEY (artifact) REFERENCES public.records(digest);

ALTER TABLE ONLY public.run_original_purges
    ADD CONSTRAINT run_original_purges_held_by_fkey FOREIGN KEY (held_by) REFERENCES public.records(digest);

ALTER TABLE ONLY public.run_original_purges
    ADD CONSTRAINT run_original_purges_owner_fkey FOREIGN KEY (owner) REFERENCES public.users(id);

ALTER TABLE ONLY public.run_originals
    ADD CONSTRAINT run_originals_artifact_fkey FOREIGN KEY (artifact) REFERENCES public.records(digest);

ALTER TABLE ONLY public.run_originals
    ADD CONSTRAINT run_originals_held_by_fkey FOREIGN KEY (held_by) REFERENCES public.records(digest);

ALTER TABLE ONLY public.run_pack_records
    ADD CONSTRAINT run_pack_records_held_by_fkey FOREIGN KEY (held_by) REFERENCES public.records(digest);

ALTER TABLE ONLY public.run_pack_records
    ADD CONSTRAINT run_pack_records_owner_fkey FOREIGN KEY (owner) REFERENCES public.users(id);

ALTER TABLE ONLY public.run_pack_records
    ADD CONSTRAINT run_pack_records_record_fkey FOREIGN KEY (record) REFERENCES public.records(digest);

ALTER TABLE ONLY public.run_upload_declarations
    ADD CONSTRAINT run_upload_declarations_artifact_fkey FOREIGN KEY (artifact) REFERENCES public.records(digest);

ALTER TABLE ONLY public.run_upload_declarations
    ADD CONSTRAINT run_upload_declarations_run_record_fkey FOREIGN KEY (run_record) REFERENCES public.records(digest);

ALTER TABLE ONLY public.run_upload_declarations
    ADD CONSTRAINT run_upload_declarations_uploader_fkey FOREIGN KEY (uploader) REFERENCES public.users(id);

ALTER TABLE ONLY public.tokens
    ADD CONSTRAINT tokens_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.oauth_clients(id);

ALTER TABLE ONLY public.tokens
    ADD CONSTRAINT tokens_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.tokens
    ADD CONSTRAINT tokens_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.tokens
    ADD CONSTRAINT tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.user_history
    ADD CONSTRAINT user_history_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.user_history
    ADD CONSTRAINT user_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

REVOKE ALL ON FUNCTION public.hub_account_scope(o text, n text) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.hub_active_cache_insert() FROM PUBLIC;

REVOKE ALL ON FUNCTION public.hub_active_personal_insert() FROM PUBLIC;

REVOKE ALL ON FUNCTION public.hub_begin_member_deletion(a text, o text, e text, op text, m text, c jsonb, t timestamp with time zone, revision timestamp with time zone) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.hub_check_member_holders(o text) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.hub_clear_personal_payloads(o text, e text) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.hub_collect_personal_sync(o text, e text, t timestamp with time zone) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.hub_finish_independent_objects(target_owner text) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.hub_finish_member_deletion(o text, op text) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.hub_finish_personal_record(d text) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.hub_freeze_private_run() FROM PUBLIC;

REVOKE ALL ON FUNCTION public.hub_freeze_run_uploads() FROM PUBLIC;

REVOKE ALL ON FUNCTION public.hub_freeze_upload_declarations(r text) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.hub_guard_member_scope() FROM PUBLIC;

REVOKE ALL ON FUNCTION public.hub_guard_run_originals() FROM PUBLIC;

REVOKE ALL ON FUNCTION public.hub_keep_capture(holder text, a text, required boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.hub_keep_frozen_packs(r text, required boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.hub_keep_inserted_run_originals() FROM PUBLIC;

REVOKE ALL ON FUNCTION public.hub_keep_run_originals(r text, must_exist boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.hub_keep_storage_original() FROM PUBLIC;

REVOKE ALL ON FUNCTION public.hub_keep_team_original() FROM PUBLIC;

REVOKE ALL ON FUNCTION public.hub_lock_personal_scope(o text) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.hub_member_deletion_snapshot(o text) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.hub_personal_tree_children(o text, e text, h text) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.hub_purge_personal(o text, e text) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.hub_replace_personal_memory(o text, e text, h jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.hub_resume_personal(o text, e text, n text) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.hub_run_citations(o text, e text) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.hub_track_object_holds() FROM PUBLIC;

SET LOCAL check_function_bodies = true;
CREATE TABLE teams (
  id text PRIMARY KEY CHECK (id ~ '^tm_[0-7][0-9a-hjkmnp-tv-z]{25}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL,
  created_by text NOT NULL REFERENCES users(id),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX teams_live_name ON teams(name) WHERE deleted_at IS NULL;
CREATE TABLE team_members (
  team_id text NOT NULL REFERENCES teams(id),
  user_id text NOT NULL REFERENCES users(id),
  added_at timestamptz NOT NULL,
  added_by text NOT NULL REFERENCES users(id),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_members_user ON team_members(user_id, team_id);

`;

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  { version: 1, name: 'baseline', sql: BASELINE },
  { version: 2, name: 'external_member_identities', sql: `CREATE TABLE public.external_member_identities (
   issuer text NOT NULL CHECK (length(issuer) BETWEEN 1 AND 256),
   subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 256),
   owner text NOT NULL REFERENCES public.users(id),
   bound_at timestamptz NOT NULL DEFAULT now(),
   PRIMARY KEY (issuer,subject), UNIQUE (issuer,owner)
 );` },
]);

/** Tables and what the runtime role may do with them; nothing else (DELETE only on what is not history, no TRUNCATE, no DDL, not the owner). */
export const RUNTIME_GRANTS: Readonly<Record<string, string>> = Object.freeze({
  external_member_identities: "SELECT, INSERT",
  trace_spans: "SELECT, INSERT, DELETE",
  resource_samples: "SELECT, INSERT, DELETE",
  process_events: "SELECT, INSERT, DELETE",
  member_deletion_intents: "SELECT",
  run_upload_declarations: "SELECT",
  personal_cache_installs: "SELECT, INSERT",
  run_pack_records: "SELECT",
  held_object_targets: "SELECT",
  held_objects: "SELECT",
  original_targets: "SELECT",
  personal_sync_heads: "SELECT, INSERT, UPDATE (snapshot,last_synced_at,native_state,memory_projection,conflicts)",
  personal_sync_bindings: "SELECT, INSERT",
  personal_sync_notes: "SELECT, INSERT",
  personal_sync_native_credits: "SELECT, INSERT",
  personal_sync_exports: "SELECT, INSERT",
  personal_sync_memory_reservations: "SELECT, INSERT, UPDATE (bytes,documents)",
  personal_sync_identities: "SELECT, INSERT",
  personal_sync_clients: "SELECT, INSERT",
  personal_sync_sessions: "SELECT, INSERT",
  personal_sync_objects: "SELECT, INSERT",
  personal_sync_edges: "SELECT, INSERT",
  personal_sync_session_objects: "SELECT, INSERT",
  personal_sync_retained: "SELECT, INSERT",
  personal_sync_operations: "SELECT, INSERT",
  personal_sync_aborts: "SELECT, INSERT",
  personal_sync_mode_operations: "SELECT, INSERT",
  run_originals: "SELECT",
  run_original_purges: "SELECT",
  object_holds: "SELECT",
  personal_spaces: "SELECT, INSERT",
  personal_payloads: "SELECT, INSERT",
  personal_record_bindings: "SELECT, INSERT",
  personal_objects: "SELECT, INSERT",
  personal_purges: "SELECT",
  memory_heads: "SELECT, INSERT, UPDATE (version,path,state,bytes,context_bytes)",
  memory_space_usage: "SELECT, INSERT, UPDATE (active_bytes,history_bytes,active_documents)",
  knowledge_space_search: "SELECT, INSERT",
  knowledge_space_search_documents: "SELECT, INSERT",
  knowledge_space_search_ready: "SELECT, INSERT",
  knowledge_space_search_totals: "SELECT, INSERT, UPDATE (token_bytes,refused_space_bytes,refused_entry_bytes)",
  schema_migrations: "SELECT",
  records: "SELECT, INSERT",
  record_index: "SELECT, INSERT",
  record_keys: "SELECT, INSERT",
  objects: "SELECT, INSERT",
  user_history: "SELECT, INSERT",
  call_logs: "SELECT, INSERT",
  call_notes: "SELECT, INSERT",
  call_reasons: "SELECT, INSERT",
  users: "SELECT, INSERT, UPDATE (name, role, disabled, updated_at, password_hash, password_must_change, password_revision)",
  tokens: "SELECT, INSERT, UPDATE (last_used_at, revoked_at, revoked_by)",
  oauth_clients: "SELECT, INSERT, DELETE",
  invitations: "SELECT, INSERT, UPDATE (used_at, used_by_client)",
  pointers: "SELECT, INSERT, UPDATE (target, version, moved_at, action_digest)",
  lease_registrations: "SELECT, INSERT, UPDATE, DELETE",
  leases: "SELECT, INSERT, UPDATE (lease_id, run_id, user_id, token, acquired_at, expires_at, released_at)",
  teams: "SELECT, INSERT, UPDATE",
  team_members: "SELECT, INSERT, DELETE",

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
    await db.query(`GRANT EXECUTE ON FUNCTION hub_finish_personal_record(text) TO "${role}"`, [], t);
    await db.query(`GRANT EXECUTE ON FUNCTION hub_begin_member_deletion(text,text,text,text,text,jsonb,timestamptz,timestamptz),hub_finish_member_deletion(text,text) TO "${role}"`, [], t);
    await db.query(`GRANT EXECUTE ON FUNCTION hub_account_scope(text,text),hub_finish_independent_objects(text) TO "${role}"`, [], t);
    await db.query(`GRANT EXECUTE ON FUNCTION hub_check_member_holders(text) TO "${role}"`, [], t);
    await db.query(`GRANT EXECUTE ON FUNCTION hub_run_citations(text,text) TO "${role}"`, [], t);
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
