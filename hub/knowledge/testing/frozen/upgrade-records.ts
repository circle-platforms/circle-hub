// The frozen records of the upgrade test: what the Hub before the operation lease binding wrote for one
// knowledge-contribution run, as table rows plus object bytes. generate-upgrade-records.ts writes tests/fixtures/frozen/upgrade-records.json by
// running the old tree's code; the test restores it into a fresh database migrated by the current code and replays there.
import type { ObjectStore } from '../../../records/api.ts';
import type { Database } from '../../../records/db.ts';

export const UPGRADE_CALL = { traceId: '4bf92f3577b34da6a3ce929d0e0e4736', sessionId: 'operation-upgrade-replay' };
export const UPGRADE_ECHO = '合成旧回显：状态正常\n';
export const UPGRADE_BUILD = {
  name: 'Rel_ACME_1_2_15', family: 'ACME', line: '1.2', base: 'Rel_ACME_1_2_15', platform: null,
  built_at: '2026-01-02T10:00:00.000Z', released_at: '2026-01-03T10:00:00.000Z', sources: { tree: 'site:tree:Rel_ACME_1_2_15' }, root: null,
};

export interface RecordsDump {
  /** Rows of every table except the migration journal, by table in creation order (foreign keys point backwards). */
  tables: { name: string; rows: Record<string, unknown>[] }[];
  objects: { sha256: string; media_type: string; base64: string }[];
}

async function tables(db: Database): Promise<string[]> {
  const rows = (await db.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema() AND c.relkind = 'r' AND c.relname <> 'schema_migrations' ORDER BY c.oid`,
  )).rows;
  return rows.map((row) => row.name);
}

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;

export async function dumpRecords(db: Database, objects: ObjectStore): Promise<RecordsDump> {
  const out: RecordsDump = { tables: [], objects: [] };
  for (const name of await tables(db)) {
    const rows = (await db.query<{ row: Record<string, unknown> }>(`SELECT to_jsonb(t) AS row FROM ${quoted(name)} t ORDER BY to_jsonb(t)::text`)).rows.map((r) => r.row);
    if (rows[0] !== undefined && 'seq' in rows[0]) rows.sort((a, b) => Number(a.seq) - Number(b.seq));
    out.tables.push({ name, rows });
  }
  for (const row of out.tables.find((table) => table.name === 'objects')?.rows ?? []) {
    const sha256 = String(row.sha256);
    const bytes = await objects.get(sha256);
    if (bytes === null) throw new Error(`object ${sha256} is registered but has no bytes`);
    out.objects.push({ sha256, media_type: String(row.media_type), base64: Buffer.from(bytes).toString('base64') });
  }
  return out;
}

/** Writes the dump into an empty, migrated database and its object store, keeping sequence numbers and timestamps. */
export async function restoreRecords(db: Database, objects: ObjectStore, dump: RecordsDump): Promise<void> {
  const present = new Set(await tables(db));
  await db.transaction(async (tx) => {
    for (const table of dump.tables) {
      if (!present.has(table.name)) throw new Error(`the current schema has no table ${table.name}`);
      const existing = (await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${quoted(table.name)}`, [], tx)).rows[0]!;
      if (Number(existing.n) !== 0) throw new Error(`table ${table.name} is not empty before the restore`);
      if (table.rows.length === 0) continue;
      await db.query(
        `INSERT INTO ${quoted(table.name)} OVERRIDING SYSTEM VALUE SELECT * FROM jsonb_populate_recordset(NULL::${quoted(table.name)}, $1::jsonb)`,
        [JSON.stringify(table.rows)],
        tx,
      );
      const identity = (await db.query<{ column: string }>(
        `SELECT attname AS column FROM pg_attribute WHERE attrelid = $1::regclass AND attidentity <> '' AND NOT attisdropped`,
        [quoted(table.name)],
        tx,
      )).rows;
      for (const { column } of identity) {
        await db.query(`SELECT setval(pg_get_serial_sequence($1, $2), (SELECT max(${quoted(column)}) FROM ${quoted(table.name)}))`, [quoted(table.name), column], tx);
      }
    }
  });
  for (const object of dump.objects) {
    const info = await objects.put(Buffer.from(object.base64, 'base64'), object.media_type);
    if (info.sha256 !== object.sha256) throw new Error(`object ${object.sha256} restored with a different digest`);
  }
}
