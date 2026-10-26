// Admin inventory of runs already stored. It reads the run and validation-result indexes and derives
// status, terminal counts and the unknown count. It does not write, and it never returns submission
// bodies, quotes or credentials.
import { labelOf, PARTITION, type Layer, type StaticTerminal, type DynamicTerminal } from '../../contracts/generated/vocabulary.ts';
import type { ValidationResult } from '../../contracts/src/validation.ts';
import { partitionCountsOf } from '../../contracts/src/validation.ts';
import type { RunRecord } from '../../contracts/src/run.ts';
import type { Page, Principal, RecordStore, RecordsKit, StoredRecord } from '../records/api.ts';
import { listRunRecords, resultsOf } from '../runs/engine/store.ts';
import { CliError } from './errors.ts';

export const RUN_LIST_DEFAULT_LIMIT = 50;
export const RUN_LIST_MAX_LIMIT = 500;
export const RUN_LIST_STATES = ['受理', '未受理', '进行中'] as const;
export type RunListState = (typeof RUN_LIST_STATES)[number];

export interface RunListQuery {
  pack: string | null;
  user: string | null;
  state: RunListState | null;
  since: string | null;
  unknown: boolean;
  limit: number;
  cursor: string | null;
}

export interface RunListTerminal {
  requirement: string;
  counts: Array<{ terminal: string; count: number }>;
}

export interface RunListRow {
  run: string;
  pack: string;
  user: string;
  started_at: string;
  state: RunListState;
  terminals: RunListTerminal[];
  unknown: number;
}

export interface RunListPage {
  items: RunListRow[];
  next: string | null;
}

interface Cursor {
  reader: string;
  pack: string | null;
  user: string | null;
  state: RunListState | null;
  since: string | null;
  unknown: boolean;
  at: string;
  id: string;
}

function terminalLabel(layer: Layer, terminal: StaticTerminal | DynamicTerminal): string {
  return layer === 'static' ? labelOf('static_terminal', terminal as StaticTerminal) : labelOf('dynamic_terminal', terminal as DynamicTerminal);
}

/** Layer terminals of the newest accepted result, counted per requirement. Empty when that result has no partitions. */
export function terminalCounts(result: ValidationResult): RunListTerminal[] {
  const counts = new Map<string, Map<string, number>>();
  for (const part of PARTITION) {
    for (const item of result.partitions[part]) {
      for (const requirement of item.requirements) {
        for (const layer of requirement.layers) {
          const label = terminalLabel(layer.layer, layer.terminal);
          const byRequirement = counts.get(requirement.requirement) ?? new Map<string, number>();
          byRequirement.set(label, (byRequirement.get(label) ?? 0) + 1);
          counts.set(requirement.requirement, byRequirement);
        }
      }
    }
  }
  return [...counts.keys()].sort().map((requirement) => ({
    requirement,
    counts: [...(counts.get(requirement) ?? [])].map(([terminal, count]) => ({ terminal, count })).sort((a, b) => a.terminal < b.terminal ? -1 : a.terminal > b.terminal ? 1 : 0),
  }));
}

export function formatTerminals(row: RunListRow): string {
  if (row.terminals.length === 0) return '无';
  return row.terminals.map((requirement) => `${requirement.requirement} ${requirement.counts.map((count) => `${count.terminal} ${count.count}`).join('、')}`).join('，');
}

export function runListLines(page: RunListPage): string[] {
  if (page.items.length === 0) return ['没有符合筛选的运行'];
  const lines = page.items.map((row) => `运行 ${row.run}；包 ${row.pack}；发起 ${row.user}；开始 ${row.started_at}；验证 ${row.state}；终态 ${formatTerminals(row)}；未知 ${row.unknown}`);
  if (page.next !== null) lines.push(`下一页游标 ${page.next}`);
  return lines;
}

function encode(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decode(token: string, query: RunListQuery, reader: string): Cursor {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw new CliError('游标无法识别', '去掉 --cursor，从第一页重新列出');
  }
  if (value === null || typeof value !== 'object') throw new CliError('游标无法识别', '去掉 --cursor，从第一页重新列出');
  const cursor = value as Partial<Cursor>;
  const same = cursor.reader === reader
    && cursor.pack === query.pack
    && cursor.user === query.user
    && cursor.state === query.state
    && cursor.since === query.since
    && cursor.unknown === query.unknown
    && typeof cursor.at === 'string'
    && typeof cursor.id === 'string';
  if (!same) throw new CliError('游标与这次筛选不一致', '去掉 --cursor，从第一页重新列出');
  return cursor as Cursor;
}

function newer(a: RunRecord, b: RunRecord): number {
  if (a.started_at !== b.started_at) return a.started_at < b.started_at ? 1 : -1;
  return a.run < b.run ? 1 : a.run > b.run ? -1 : 0;
}

function afterCursor(row: RunRecord, cursor: Cursor): boolean {
  return row.started_at < cursor.at || (row.started_at === cursor.at && row.run < cursor.id);
}

async function everyRun(store: RecordStore, filter: { user?: string; pack?: string }): Promise<RunRecord[]> {
  const rows: RunRecord[] = [];
  let cursor: string | null = null;
  do {
    const page: Page<StoredRecord<RunRecord>> = await listRunRecords(store, filter, { limit: 200, cursor });
    rows.push(...page.items.map((record) => record.body));
    cursor = page.next;
  } while (cursor !== null);
  return rows;
}

/**
 * One row from records already stored. Status is the newest validation result (受理, 未受理, or 进行中 when
 * there is none). Terminal counts and the unknown count come from the newest accepted result; a run with no
 * accepted result reports 无 and 0. System-delivery results are not the verification state.
 */
async function summarize(store: RecordStore, run: RunRecord, names: Map<string, string>): Promise<RunListRow> {
  const results = (await resultsOf(store, run.run)).filter((record) => record.body.system_input === undefined);
  results.sort((a, b) => a.created_at === b.created_at ? (a.digest < b.digest ? 1 : -1) : a.created_at < b.created_at ? 1 : -1);
  const newest = results[0] ?? null;
  const accepted = results.find((record) => record.body.acceptance === 'accepted') ?? null;
  const state: RunListState = newest === null ? '进行中' : newest.body.acceptance === 'accepted' ? '受理' : '未受理';
  const unknown = accepted === null ? 0 : partitionCountsOf(accepted.body.partitions).unknown;
  return {
    run: run.run,
    pack: run.pack,
    user: run.runner === undefined ? '未声明' : names.get(run.runner) ?? run.runner,
    started_at: run.started_at,
    state,
    terminals: accepted === null ? [] : terminalCounts(accepted.body),
    unknown,
  };
}

/** Runs an administrator can inventory. The caller has already checked the role. */
export async function listRunInventory(kit: RecordsKit, admin: Principal, query: RunListQuery): Promise<RunListPage> {
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > RUN_LIST_MAX_LIMIT) {
    throw new CliError(`--limit 要 1 到 ${RUN_LIST_MAX_LIMIT} 的整数`);
  }
  const cursor = query.cursor === null ? null : decode(query.cursor, query, admin.id);
  const names = new Map((await kit.principals.list()).map((user) => [user.id, user.name]));
  const filter = { ...(query.user === null ? {} : { user: query.user }), ...(query.pack === null ? {} : { pack: query.pack }) };
  const since = query.since === null ? null : Date.parse(query.since);
  const runs = (await everyRun(kit.store, filter))
    .filter((run) => since === null || Date.parse(run.started_at) >= since)
    .filter((run) => cursor === null || afterCursor(run, cursor))
    .sort(newer);
  const matched: RunListRow[] = [];
  for (const run of runs) {
    const row = await summarize(kit.store, run, names);
    if (query.state !== null && row.state !== query.state) continue;
    if (query.unknown && row.unknown < 1) continue;
    matched.push(row);
    if (matched.length > query.limit) break;
  }
  const items = matched.slice(0, query.limit);
  const last = items.at(-1);
  const next = matched.length > query.limit && last !== undefined
    ? encode({ reader: admin.id, pack: query.pack, user: query.user, state: query.state, since: query.since, unknown: query.unknown, at: last.started_at, id: last.run })
    : null;
  return { items, next };
}
