import { PRIOR_DEVICE_HISTORY_DISCLAIMER, type CompileBriefV1 } from './authoring-brief.ts';
import { LEADING_PROMPT, LOG_STAMP } from './delivery.ts';
import { isRecord } from './text.ts';

export const DEVICE_HISTORY_SCHEMA = 'device-history@1';
export const HISTORY_DIRECTORY = 'history';
export const HISTORY_FILE = 'history.json';
export const HISTORY_FETCHING_FILE = 'fetching.json';
export const HISTORY_PENDING_REASON = '下载这个运行时已在后台向 Hub 取历次上机验证，生成这份任务时还没有取完。';
export const HISTORY_MAX_RUNS = 6;
export const HISTORY_BUDGET_MS = 240_000;
export const HISTORY_MAX_ENTRIES = 6;
export const HISTORY_REFUSALS_SHOWN = 3;
export const HISTORY_COMMAND_CHARS = 80;
export const HISTORY_REPLY_CHARS = 120;
export const HISTORY_TOKEN_CHARS = 40;
export const HISTORY_PASSED_COMMANDS_SHOWN = 40;

export interface HistoryJob { job: string; plan_run: string | null; ended_at: string | null; outcome: string; rows: Array<{ item: string; dynamic_terminal: string }> | null }
export interface HistoryRun { run: string; started_at: string | null; build: string | null; jobs: HistoryJob[] }
export interface HubHistory { schema: 'run-history@1'; run: string; subjects: string[]; limit: number | null; complete: boolean; runs: HistoryRun[] }
export interface HistoryReturn { run: string; dir: string | null; reason?: string }
export interface DeviceHistoryFile {
  schema: typeof DEVICE_HISTORY_SCHEMA;
  run: string;
  fetched_at: string;
  status: 'fetched' | 'unavailable';
  reason?: string;
  answer: HubHistory | null;
  returns: HistoryReturn[];
  elapsed_ms: number;
  pending?: { shared: string };
}

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

export function parseHubHistory(value: unknown, run: string): HubHistory | null {
  if (!isRecord(value) || value.schema !== 'run-history@1' || value.run !== run || !Array.isArray(value.runs)) return null;
  const runs: HistoryRun[] = [];
  for (const row of value.runs) {
    if (!isRecord(row) || typeof row.run !== 'string' || !/^run_[0-9a-hjkmnp-tv-z]{26}$/.test(row.run) || !Array.isArray(row.jobs)) return null;
    const jobs: HistoryJob[] = [];
    for (const job of row.jobs) {
      if (!isRecord(job) || typeof job.job !== 'string' || !/^[0-9a-f]{64}$/.test(job.job) || typeof job.outcome !== 'string') return null;
      if (job.rows !== null && (!Array.isArray(job.rows) || job.rows.some((r) => !isRecord(r) || typeof r.item !== 'string' || typeof r.dynamic_terminal !== 'string'))) return null;
      jobs.push({ job: job.job, plan_run: text(job.plan_run), ended_at: text(job.ended_at), outcome: job.outcome, rows: job.rows === null ? null : (job.rows as Array<Record<string, unknown>>).map((r) => ({ item: String(r.item), dynamic_terminal: String(r.dynamic_terminal) })) });
    }
    runs.push({ run: row.run, started_at: text(row.started_at), build: text(row.build), jobs });
  }
  return { schema: 'run-history@1', run, subjects: Array.isArray(value.subjects) ? value.subjects.filter((s): s is string => typeof s === 'string') : [], limit: typeof value.limit === 'number' ? value.limit : null, complete: value.complete !== false, runs };
}

export function parseDeviceHistory(value: unknown): DeviceHistoryFile | null {
  if (!isRecord(value) || value.schema !== DEVICE_HISTORY_SCHEMA || typeof value.run !== 'string' || (value.status !== 'fetched' && value.status !== 'unavailable')) return null;
  const answer = value.answer === null || value.answer === undefined ? null : parseHubHistory(value.answer, isRecord(value.answer) && typeof value.answer.run === 'string' ? value.answer.run : '');
  if (value.status === 'fetched' && answer === null) return null;
  const returns: HistoryReturn[] = (Array.isArray(value.returns) ? value.returns : []).filter(isRecord).filter((row) => typeof row.run === 'string').map((row) => ({ run: String(row.run), dir: text(row.dir), ...(text(row.reason) ? { reason: String(row.reason) } : {}) }));
  return { schema: DEVICE_HISTORY_SCHEMA, run: value.run, fetched_at: text(value.fetched_at) ?? '', status: value.status, ...(text(value.reason) ? { reason: String(value.reason) } : {}), answer, returns, elapsed_ms: typeof value.elapsed_ms === 'number' ? value.elapsed_ms : 0, ...(isRecord(value.pending) && text(value.pending.shared) ? { pending: { shared: String(value.pending.shared) } } : {}) };
}

export function sessionCommandCount(session: string): number {
  let count = 0;
  for (const line of session.replace(/\r/g, '').split('\n')) {
    const typed = LEADING_PROMPT.exec(line);
    if (!typed) continue;
    const echoed = line.slice(typed[1].length), control = echoed.search(/[\u0000-\u001f\u007f]/);
    if ((control < 0 ? echoed : echoed.slice(0, control)).trim()) count++;
  }
  return count;
}

export interface StepCommand { step: number; by: string; mode: string | null; command: string }
export function stepCommands(log: string): StepCommand[] {
  const found: StepCommand[] = [];
  let open: number | null = null;
  for (const raw of log.replace(/\r/g, '').split('\n')) {
    const line = raw.replace(LOG_STAMP, '');
    const mark = /^#{4,}\s+step\s*(\d+)\s*:/.exec(line);
    if (mark) { open = Number(mark[1]); continue; }
    if (/^#{4,}\s+(?:begin|end) case:/.test(line)) { open = null; continue; }
    if (open === null) continue;
    const device = /^(\S+) - sends command in (\S+): (.*)$/.exec(line);
    const host = device ? null : /^(\S+) executes command: (.*)$/.exec(line);
    if (device) found.push({ step: open, by: device[1]!, mode: device[2]!, command: device[3]!.trim() });
    else if (host) found.push({ step: open, by: host[1]!, mode: null, command: host[2]!.trim() });
    if (device || host) open = null;
  }
  return found;
}

const cut = (value: string, chars: number): string => { const points = [...value]; return points.length <= chars ? value : `${points.slice(0, chars).join('')}…`; };

export interface LocalCaseReturn {
  job: string; plan_run: string | null; verdict: string;
  log: string | null; sessions: string[];
  device_commands: number | null;
  execution_refused: Array<{ command: string; reply: string[] }>;
  syntax_rejected: Array<{ command: string; token?: string }>;
  step_commands?: StepCommand[];
}
export type PriorDeviceHistory = CompileBriefV1['prior_device_history'];
export type PriorDeviceEntry = PriorDeviceHistory['entries'][number];

const empty = (status: PriorDeviceHistory['status'], reason?: string): PriorDeviceHistory => ({ status, ...(reason ? { unavailable_reason: reason } : {}), disclaimer: PRIOR_DEVICE_HISTORY_DISCLAIMER, match_key: 'autoid', max_entries: HISTORY_MAX_ENTRIES, entries: [] });

export const unavailableHistory = (reason: string): PriorDeviceHistory => empty('unavailable_from_hub', reason);

export function priorDeviceHistory(file: DeviceHistoryFile | null, autoid: string, local: (run: string) => { rows: LocalCaseReturn[]; missing?: string }, absentReason: string): PriorDeviceHistory {
  if (file === null) return empty('unavailable_from_hub', absentReason);
  if (file.status !== 'fetched' || file.answer === null) return empty('unavailable_from_hub', file.reason ?? absentReason);
  const entries: Array<PriorDeviceEntry & { order: string }> = [];
  for (const run of file.answer.runs) {
    const held = local(run.run);
    for (const job of run.jobs) {
      const said = job.rows?.find((row) => row.item === autoid);
      const here = held.rows.find((row) => row.job === job.job);
      if (!said && !here) continue;
      const refused = here?.execution_refused ?? [], rejected = here?.syntax_rejected ?? [];
      entries.push({
        verification_run: run.run, plan_run: here?.plan_run ?? job.plan_run, build: run.build, ended_at: job.ended_at,
        verdict: here?.verdict ?? said!.dynamic_terminal,
        log: here?.log ?? null, sessions: here?.sessions ?? [], device_commands: here?.device_commands ?? null,
        execution_refused: { total: refused.length, shown: refused.slice(0, HISTORY_REFUSALS_SHOWN).map((row) => ({ command: cut(row.command, HISTORY_COMMAND_CHARS), reply: cut(row.reply.join(' / '), HISTORY_REPLY_CHARS) })) },
        syntax_rejected: { total: rejected.length, shown: rejected.slice(0, HISTORY_REFUSALS_SHOWN).map((row) => ({ command: cut(row.command, HISTORY_COMMAND_CHARS), ...(row.token ? { token: cut(row.token, HISTORY_TOKEN_CHARS) } : {}) })) },
        ...(here ? {} : { files_missing: held.missing ?? '这次上机的设备输出没有下载到本地' }),
        ...(here?.step_commands?.length ? { passed_commands: { total: here.step_commands.length, shown: here.step_commands.slice(0, HISTORY_PASSED_COMMANDS_SHOWN).map((row) => `${row.by}${row.mode ? `（${row.mode}）` : ''}：${cut(row.command, HISTORY_COMMAND_CHARS)}`) } } : {}),
        order: job.ended_at ?? run.started_at ?? '',
      });
    }
  }
  if (!entries.length) return empty('none_found');
  entries.sort((a, b) => (a.order < b.order ? 1 : a.order > b.order ? -1 : 0));
  const passed = entries.findIndex((entry) => entry.verdict === 'pass');
  const ordered = passed > 0 ? [entries[passed], ...entries.slice(0, passed), ...entries.slice(passed + 1)] : entries;
  return { ...empty('available'), entries: ordered.slice(0, HISTORY_MAX_ENTRIES).map(({ order: _order, ...entry }, at) => { if (at > 0) delete entry.passed_commands; return entry; }) };
}
