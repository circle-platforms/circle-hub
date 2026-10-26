// Named compare-and-set pointers (the current knowledge roots). A move takes a per-name advisory lock, compares the current
// target with the expected one and, only when they agree, writes a move_root action record (B05 R[4]) and the new target in
// the same transaction. A refused move writes nothing. Each action carries the new version and the previous move's action,
// so every move is its own record, also when it repeats an earlier move in the same millisecond.
import { RunId, Versioned } from '../../contracts/src/common.ts';
import type { ActionBody, MoveInput, MoveResult, Page, PageQuery, PointerState, Pointers, RecordStore, StoredRecord, Transaction } from './api.ts';
import { RECORD_SCHEMAS } from './constants.ts';
import { iso } from './db.ts';
import type { Database, Row } from './db.ts';
import { isSha256 } from './digest.ts';
import { AccessError, IntegrityError } from './errors.ts';

const NAME = /^[a-z0-9][a-z0-9:._/-]{0,199}$/;
/** Namespace of the per-name advisory locks (two-key form: namespace, hashtext(name)). */
const POINTER_LOCK_SPACE = 730_156;

function stateOf(row: Row): PointerState {
  return { name: String(row.name), target: String(row.target), version: Number(row.version), moved_at: iso(row.moved_at), action: String(row.action_digest) };
}

export class PgPointers implements Pointers {
  readonly #db: Database;
  readonly #store: RecordStore;
  readonly #now: () => Date;

  constructor(db: Database, store: RecordStore, now: () => Date) {
    this.#db = db;
    this.#store = store;
    this.#now = now;
  }

  async get(name: string, tx?: Transaction): Promise<PointerState | null> {
    if (typeof name !== 'string' || !NAME.test(name)) return null;
    const row = (await this.#db.query('SELECT name, target, version, moved_at, action_digest FROM pointers WHERE name = $1', [name], tx)).rows[0];
    return row === undefined ? null : stateOf(row);
  }

  async list(prefix: string): Promise<PointerState[]> {
    if (typeof prefix !== 'string' || prefix.length === 0 || prefix.length > 200) throw new TypeError('a pointer prefix is 1 to 200 characters');
    const rows = (await this.#db.query('SELECT name, target, version, moved_at, action_digest FROM pointers WHERE name LIKE $1 ORDER BY name', [`${prefix.replace(/[%_\\]/g, (c) => `\\${c}`)}%`])).rows;
    return rows.map(stateOf);
  }

  async move(input: MoveInput, tx?: Transaction): Promise<MoveResult> {
    const name = input.name;
    if (typeof name !== 'string' || !NAME.test(name)) throw new TypeError(`pointer names must match ${NAME}`);
    if (input.expected !== null && !isSha256(input.expected)) throw new TypeError('expected must be a lowercase hex SHA-256 or null');
    if (!isSha256(input.next)) throw new TypeError('next must be a lowercase hex SHA-256');
    if(input.refresh!==undefined&&typeof input.refresh!=='boolean')throw new TypeError('refresh must be boolean');
    if(input.expected_action!==undefined&&input.expected_action!==null&&!isSha256(input.expected_action))throw new TypeError('expected_action must be a digest or null');
    if(input.next===input.expected){if(!input.refresh)throw new TypeError('next must differ from expected');if(typeof input.expected_action!=='string')throw new TypeError('same-target refresh requires expected_action');}
    const component = input.component ?? 'records.pointers@1';
    if (!Versioned.safeParse(component).success) throw new TypeError('component must be name@major (contracts Versioned)');
    const run = input.run ?? null;
    if (run !== null && !RunId.safeParse(run).success) throw new TypeError('run must be a run id');
    const note = input.note ?? null;
    if (note !== null && (typeof note !== 'string' || note.length > 500)) throw new TypeError('notes are at most 500 characters');
    return this.#db.transaction(async (t) => {
      const by = input.by ?? null;
      if (by !== null) {
        const user = (await this.#db.query('SELECT disabled FROM users WHERE id = $1', [by.id], t)).rows[0];
        if (user === undefined || user.disabled === true) throw new AccessError('操作人不是有效的 Hub 账号');
      }
      const startedAt = this.#now().toISOString();
      await this.#db.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [POINTER_LOCK_SPACE, name], t);
      const current = await this.get(name, t);
      if ((current?.target ?? null) !== input.expected) return { moved: false, current };
      if(input.expected_action!==undefined&&(current?.action??null)!==input.expected_action)return {moved:false,current};
      const endedAt = this.#now().toISOString();
      const body: ActionBody = {
        action: 'move_root',
        run,
        item: null,
        inputs: input.expected === null ? [input.next] : [input.expected, input.next],
        component,
        lease: null,
        started_at: startedAt,
        ended_at: endedAt,
        result: 'completed',
        error_code: null,
        acceptance: null,
        codes: [],
        detail: {
          pointer: name,
          expected: input.expected,
          next: input.next,
          version: (current?.version ?? 0) + 1,
          previous_action: current?.action ?? null,
          ...(input.refresh?{refresh:true}:{}),
          by: by?.id ?? null,
          note,
        },
      };
      const index = [
        { key: 'pointer.name', value: name },
        { key: 'action.kind', value: 'move_root' },
        ...(run === null ? [] : [{ key: 'action.run', value: run }]),
      ];
      const action = await this.#store.put<ActionBody>(
        { kind: 'action', schema: RECORD_SCHEMAS.action, provenance: 'observed', body, created_at: endedAt, index },
        t,
      );
      if (!action.created) throw new IntegrityError('移动当前根的动作与一条已有记录完全相同（动作链断了）', { detail: { pointer: name } });
      const row =
        current === null
          ? (
              await this.#db.query(
                'INSERT INTO pointers (name, target, version, moved_at, action_digest) VALUES ($1, $2, 1, $3, $4) RETURNING *',
                [name, input.next, endedAt, action.digest],
                t,
              )
            ).rows[0]
          : (
              await this.#db.query(
                'UPDATE pointers SET target = $2, version = version + 1, moved_at = $3, action_digest = $4 WHERE name = $1 AND target = $5 RETURNING *',
                [name, input.next, endedAt, action.digest, input.expected],
                t,
              )
            ).rows[0];
      if (row === undefined) throw new Error('pointer changed while its advisory lock was held');
      return { moved: true, pointer: stateOf(row), action };
    }, tx);
  }

  async history(name: string, query: PageQuery = {}): Promise<Page<StoredRecord<ActionBody>>> {
    if (typeof name !== 'string' || !NAME.test(name)) throw new TypeError(`pointer names must match ${NAME}`);
    return this.#store.find<ActionBody>({
      key: 'pointer.name',
      value: name,
      kind: 'action',
      limit: query.limit,
      cursor: query.cursor,
      newestFirst: query.newestFirst ?? true,
    });
  }
}
