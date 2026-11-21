import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, writeFile, rename, rm } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord, parseCliOptions } from '../functions/text.ts';
import { chooseSiblings, neededShapes, planCommandLines, siblingNote, type SiblingPlan } from '../functions/sibling-reference.ts';
import { deviceReadNote, readableLines, readFileName, READ_LINES_PER_CASE, READS_DIRECTORY } from '../functions/device-read-lines.ts';
import { HISTORY_DIRECTORY } from '../functions/device-history.ts';
import { culprits, failed as failedRow, notDispatched, nothingPassed, nothingToRework, progress, reworkOpened, toStart, unjudged, volumeClosed, volumeOpened, volumePassed, volumesUsed } from '../functions/next-step.ts';

export type Stage = 'queued' | 'recomposing' | 'accepted' | 'writing' | 'auditing' | 'ready' | 'stopped' | 'excluded';
export interface CaseState {
  k: string; autoid: string; title: string;
  recompose: { index: string; item: string }; plan: { index: string; item: string };
  stage: Stage; attempts: { recompose: number; write: number };
  stopped?: string; review?: string[];
  device_passed?: boolean;
  record_accepted?: boolean; regated?: boolean;
  decision?: string;
  carry?: string;
  device_rounds?: number;
  prior?: Array<{ plans: string; returns: string; notes?: string }>;
  gave_up?: string;
  excluded?: string;
  action?: Action;
  pending?: string;
  ready_sha256?: string;
  audits?: number;
}
export interface PipelineState {
  schema: 'compile-pipeline@1'; width: number; max_attempts: number; model: string;
  recompose_run: string; plan_run: string; recompose_dir: string; plan_dir: string; records_dir: string;
  cases: CaseState[];
  open?: string;
  plan_history?: Array<{ run: string; dir: string }>;
  volume?: { n: number; result?: 'passed' | 'failed' };
  device_reads?: { booking: string; device: string; bed?: string; lines: Record<string, string>; asked: Record<string, number> };
}
export interface Action { label: string; subagent_type: string; description: string }
export interface Step {
  actions: Action[]; running: string[]; ready: string[]; stopped: Array<{ label: string; reason: string }>; queued: number; all_done: boolean; message: string;
  waiting?: Array<{ label: string; reason: string }>;
  excluded?: Array<{ label: string; reason: string }>;
}
export interface ToolRun { code: number; stdout: string; stderr: string }
export type RunTool = (skill: string, tool: string, args: string[], stdin?: string) => Promise<ToolRun>;

const RECOMPOSER = 'case-compile:compile-recomposer', WRITER = 'case-compile:compile-writer', AUDITOR = 'case-compile:compile-fidelity';
const NOTE_CHARS = 1500;
const label = (stage: 'recompose' | 'write' | 'audit', k: string) => `${stage === 'recompose' ? '重组' : stage === 'write' ? '编写' : '审计'} ${k}`;
const RUNNING: Stage[] = ['recomposing', 'writing', 'auditing'];
export const words = (run: ToolRun) => `${run.stderr.trim()}\n${run.stdout.trim()}`.trim().slice(0, NOTE_CHARS);

export function spawnTool(skillsRoot: string): RunTool {
  return (skill, tool, args, stdin) => new Promise((done) => {
    const child = spawn(process.execPath, [join(skillsRoot, skill, 'tools', tool), ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; }); child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (error) => done({ code: 1, stdout, stderr: stderr + error.message }));
    child.on('close', (code) => done({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(stdin ?? '');
  });
}

export function startTool(skillsRoot: string): StartTool {
  return (skill, tool, args, stdin) => {
    const child = spawn(process.execPath, [join(skillsRoot, skill, 'tools', tool), ...args], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', () => undefined); child.stdin.on('error', () => undefined);
    child.stdin.end(stdin ?? '');
    child.unref();
  };
}

export function envelopeIn(text: string): Record<string, unknown> | null {
  const marker = text.lastIndexOf('供模型引用');
  if (marker < 0) return null;
  const start = text.indexOf('{', marker);
  if (start < 0) return null;
  const end = text.lastIndexOf('}');
  try { const value = JSON.parse(text.slice(start, end + 1)); return isRecord(value) ? value : null; } catch { return null; }
}

export function recordStatus(envelope: Record<string, unknown> | null, item: string): { satisfied: boolean; seen: string } {
  if (!envelope) return { satisfied: false, seen: 'Hub 的答复里没有机器可读部分' };
  if (envelope.acceptance !== 'accepted') {
    const errors = Array.isArray(envelope.errors) ? envelope.errors.filter(isRecord) : [];
    return { satisfied: false, seen: `整份提交没有被受理：${errors.map((e) => `${String(e.message ?? e.code)}${e.path ? `（${String(e.path)}）` : ''}${e.fix ? `；下一步：${String(e.fix)}` : ''}`).join('；') || '没有说明'}` };
  }
  const result = isRecord(envelope.result) ? envelope.result : {};
  const partitions = isRecord(result.partitions) ? result.partitions : {};
  for (const [partition, rows] of Object.entries(partitions)) {
    for (const row of Array.isArray(rows) ? rows.filter(isRecord) : []) {
      if (row.item !== item) continue;
      const requirement = (Array.isArray(row.requirements) ? row.requirements.filter(isRecord) : []).find((r) => r.requirement === 'record');
      if (requirement?.status === 'satisfied') return { satisfied: true, seen: 'record 要求项已满足' };
      const claims = Array.isArray(requirement?.claims) ? requirement.claims.filter(isRecord) : [];
      const said = claims.flatMap((c) => isRecord(c.statement) && typeof c.statement.text === 'string' && c.statement.verdict !== 'support' ? [c.statement.text] : []).slice(0, 8);
      return { satisfied: false, seen: `这一条在分区 ${partition}，record 要求项为 ${String(requirement?.status ?? '没有结论')}${said.length ? `：${said.join('；')}` : ''}` };
    }
  }
  return { satisfied: false, seen: '这一条不在 Hub 这次的结果里' };
}

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));
async function itemFiles(dir: string): Promise<Array<{ index: string; value: Record<string, unknown> }>> {
  const names = (await readdir(join(dir, 'items'))).filter((n) => n.endsWith('.json')).sort();
  const out = [];
  for (const name of names) { const value = await readJson(join(dir, 'items', name)); if (isRecord(value)) out.push({ index: name.slice(0, -5), value }); }
  return out;
}
const fieldsOf = (item: Record<string, unknown>) => (isRecord(item.fields) ? item.fields : {});
const autoidOf = (item: Record<string, unknown>) => { const f = fieldsOf(item); return typeof f.autoid === 'string' ? f.autoid : typeof f.case_id === 'string' ? f.case_id : ''; };
const nodeOf = (item: Record<string, unknown>) => {
  const f = fieldsOf(item), late = isRecord(f.recomposition_late) ? f.recomposition_late : {};
  if (typeof f.node === 'string') return f.node;
  if (typeof late.node === 'string') return late.node;
  if (isRecord(item.location) && typeof item.location.selector === 'string') return item.location.selector;
  const tail = typeof item.location === 'string' ? /\/(n\/[^/]+)$/.exec(item.location) : null;
  return tail ? tail[1]! : '';
};

export async function initState(recomposeDir: string, planDir: string, open: Record<string, unknown>, model: string, width = 6, maxAttempts = 5): Promise<PipelineState> {
  const recompose = await itemFiles(recomposeDir), plan = await itemFiles(planDir);
  if (typeof open.recompose_run !== 'string' || typeof open.plan_run !== 'string') throw new Error('open-compile.json 里没有 recompose_run 和 plan_run；先跑 open-compile.ts');
  const cases: CaseState[] = [];
  for (const [n, p] of plan.entries()) {
    const node = nodeOf(p.value);
    const r = recompose.find((row) => nodeOf(row.value) === node);
    if (!r) throw new Error(`脚本编写运行的条目 ${String(p.value.id)}（节点 ${node}）在重组运行里找不到同一节点；两个运行不是同一份脑图，重跑 open-compile.ts`);
    cases.push({ k: String(n).padStart(2, '0'), autoid: autoidOf(p.value) || autoidOf(r.value), title: String(fieldsOf(p.value).title ?? p.value.label ?? ''), recompose: { index: r.index, item: String(r.value.id) }, plan: { index: p.index, item: String(p.value.id) }, stage: 'queued', attempts: { recompose: 0, write: 0 } });
  }
  const reads = await deviceReadsOf(planDir, open);
  return { schema: 'compile-pipeline@1', width, max_attempts: maxAttempts, model, recompose_run: open.recompose_run, plan_run: open.plan_run, recompose_dir: recomposeDir, plan_dir: planDir, records_dir: 'records', cases, ...(reads ? { device_reads: reads } : {}) };
}
async function deviceReadsOf(planDir: string, open: Record<string, unknown>): Promise<PipelineState['device_reads']> {
  if (typeof open.booking !== 'string' || !open.booking) return undefined;
  try {
    const profile: unknown = JSON.parse(await readFile(join(planDir, 'sources', 'profile.json'), 'utf8'));
    const seat = isRecord(profile) && Array.isArray(profile.seats) ? profile.seats.find(isRecord) : undefined;
    if (!isRecord(profile) || !seat || typeof seat.device !== 'string' || !seat.device) return undefined;
    return { booking: open.booking, device: seat.device, ...(typeof profile.bed === 'string' && profile.bed ? { bed: profile.bed } : {}), lines: {}, asked: {} };
  } catch { return undefined; }
}

export type StartTool = (skill: string, tool: string, args: string[], stdin?: string) => void;
export interface Gates { run: RunTool; hub: string; plumb: string; token: string; plumbKey: string; start?: StartTool }

async function dispatchRecompose(state: PipelineState, c: CaseState, gates: Pick<Gates, 'run'>, note?: string): Promise<Action> {
  c.stage = 'recomposing'; c.attempts.recompose += 1; note = noteFor(c, note); delete c.pending;
  const brief = await gates.run('case-compile', 'task-brief.ts', ['--role', '用例重组', '--case', c.autoid, '--brief', join(state.recompose_dir, 'items', `${c.recompose.index}.json`), '--out', join(state.records_dir, `${c.recompose.index}.json`), '--task-file', join('tasks', 'recompose', `${c.k}-${c.attempts.recompose}.md`), '--run', state.recompose_dir, ...(note ? ['--note', note] : [])]);
  if (brief.code !== 0) throw new Error(`生成重组任务失败（${c.autoid}）：${words(brief)}`);
  return (c.action = { label: label('recompose', c.k), subagent_type: RECOMPOSER, description: brief.stdout.trim() });
}
async function dispatchWrite(state: PipelineState, c: CaseState, gates: Pick<Gates, 'run'> & Partial<Gates>, note?: string): Promise<Action> {
  const audits = join('cases', c.k, 'audit');
  if (existsSync(audits)) await rename(audits, join('cases', c.k, `audit-${c.attempts.write}-${Date.now()}`)).catch(() => undefined);
  c.stage = 'writing'; c.attempts.write += 1; note = noteFor(c, note); delete c.pending; c.audits = 0;
  note = [note, await siblingReference(state, c)].filter(Boolean).join('；') || undefined;
  note = [note, await deviceReadReference(state, c, gates).catch(() => undefined)].filter(Boolean).join('；') || undefined;
  const prior = c.prior ?? [];
  const history = prior.length ? ['--round', String(prior.length + 1), '--prior-plans', prior.map((p) => p.plans).join(','), '--prior-returns', prior.map((p) => p.returns).join(','), ...(prior.every((p) => p.notes) ? ['--prior-notes', prior.map((p) => p.notes!).join(',')] : [])] : [];
  const task = join('tasks', 'write', prior.length ? `${c.k}-r${prior.length + 1}-${c.attempts.write}.md` : `${c.k}-${c.attempts.write}.md`);
  const brief = await gates.run('case-compile', 'task-brief.ts', ['--role', '脚本编写', '--case', c.autoid, '--brief', join(state.plan_dir, 'briefs', `${c.plan.index}.md`), '--out', join('cases', c.k, 'plan', `${c.plan.index}.json`), '--task-file', task, '--run', state.plan_dir, ...history, ...(note ? ['--note', note] : [])]);
  if (brief.code !== 0) throw new Error(`生成编写任务失败（${c.autoid}）：${words(brief)}`);
  return (c.action = { label: label('write', c.k), subagent_type: WRITER, description: brief.stdout.trim() });
}
const READS_PER_COMPILE = 40, READ_WAIT_MS = 180_000, READ_MISSES_END = 3;
async function deviceReadReference(state: PipelineState, c: CaseState, gates: Pick<Gates, 'run'> & Partial<Gates>): Promise<string | undefined> {
  const reads = state.device_reads;
  if (!reads) return undefined;
  const brief = await readFile(join(state.plan_dir, 'briefs', `${c.plan.index}.md`), 'utf8').catch(() => null);
  if (brief === null) return undefined;
  const now = Date.now(), asked = reads.asked ?? (reads.asked = {});
  const overdue = Object.values(asked).filter((at) => now - at > READ_WAIT_MS).length;
  const none = overdue >= READ_MISSES_END && !Object.values(reads.lines).some((kept) => existsSync(kept));
  const have: Array<{ line: string; file: string; lines: number }> = [], coming: Array<{ line: string; file: string }> = [];
  for (const line of readableLines(brief, 12)) {
    if (have.length + coming.length >= READ_LINES_PER_CASE) break;
    const kept = reads.lines[line];
    if (kept === undefined) {
      if (none || !gates.start || !gates.hub || !gates.token || Object.keys(reads.lines).length >= READS_PER_COMPILE) continue;
      const target = join(READS_DIRECTORY, readFileName(line));
      await mkdir(READS_DIRECTORY, { recursive: true }); await rm(target, { force: true });
      gates.start('case-compile', 'device-read.ts', ['--hub', gates.hub, '--booking', reads.booking, '--device', reads.device, '--line', line, '--out', target, ...(reads.bed ? ['--bed', reads.bed] : [])], `${gates.token}\n`);
      reads.lines[line] = target; asked[line] = now; coming.push({ line, file: target });
      continue;
    }
    const text = await readFile(kept, 'utf8').catch(() => null);
    if (text !== null) have.push({ line, file: kept, lines: Math.max(0, text.replace(/\n$/, '').split('\n').length - 2) });
    else if (now - (asked[line] ?? 0) <= READ_WAIT_MS) coming.push({ line, file: kept });
  }
  return deviceReadNote(reads.device, have, coming);
}
async function siblingReference(state: PipelineState, c: CaseState): Promise<string | undefined> {
  const text = (path: string) => readFile(path, 'utf8').catch(() => null);
  const brief = await text(join(state.plan_dir, 'briefs', `${c.plan.index}.md`));
  if (brief === null) return undefined;
  let record: unknown = null;
  try { record = JSON.parse((await text(join(state.plan_dir, 'records', `${c.plan.index}.json`))) ?? 'null'); } catch { record = null; }
  const needed = neededShapes(brief, record);
  if (needed.size === 0) return undefined;
  const siblings: SiblingPlan[] = [];
  for (const other of state.cases) {
    if (other === c || other.stage !== 'ready') continue;
    const path = join('cases', other.k, 'plan', `${other.plan.index}.json`);
    try { siblings.push({ path, lines: planCommandLines(JSON.parse((await text(path)) ?? 'null')), devicePassed: other.device_passed === true }); } catch { }
  }
  return siblingNote(chooseSiblings(needed, siblings));
}
const noteFor = (c: CaseState, note?: string) => {
  const failed = note ?? (c.carry ? `停下前最后一次没有通过：${c.carry}` : '');
  delete c.carry;
  const decision = c.decision ? (/^(模型|使用者)决定[：:]/.test(c.decision) ? c.decision : `重做这一条的依据：${c.decision}`) : '';
  return [decision, failed].filter(Boolean).join('；').slice(0, 2 * NOTE_CHARS) || undefined;
};
function stop(c: CaseState, reason: string) { c.stage = 'stopped'; c.stopped = reason.slice(0, NOTE_CHARS); delete c.pending; }
export const unavailable = (run: ToolRun) => run.code !== 0 && /暂时不可用/.test(`${run.stderr}\n${run.stdout}`);
function wait(c: CaseState, reason: string): null { c.pending = reason.slice(0, NOTE_CHARS); return null; }
const sha256File = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');
const PLUMB_WAKE_SECONDS = 240;
async function plumbGate(g: Gates, tool: string, args: string[]): Promise<ToolRun> {
  const first = await g.run('case-compile', tool, args, `${g.plumbKey}\n`);
  if (!unavailable(first)) return first;
  await g.run('plumb', 'plumb.ts', ['wake', '--wait', '--timeout-sec', String(PLUMB_WAKE_SECONDS), '--base-url', g.plumb, '--key-stdin'], `${g.plumbKey}\n`);
  return g.run('case-compile', tool, args, `${g.plumbKey}\n`);
}

export async function hubAnswer(sent: ToolRun): Promise<Record<string, unknown> | null> {
  const named = /全文在 (.+?\.txt)/.exec(sent.stdout);
  if (named && existsSync(named[1]!)) { const whole = envelopeIn(await readFile(named[1]!, 'utf8')); if (whole) return whole; }
  return envelopeIn(sent.stdout);
}

export function onlyUnknown(run: ToolRun): boolean {
  for (const text of [run.stdout, run.stderr]) {
    const start = text.indexOf('{"ok"');
    if (start < 0) continue;
    try {
      const value = JSON.parse(text.slice(start, text.lastIndexOf('}') + 1));
      const problems = isRecord(value) && Array.isArray(value.problems) ? value.problems.filter(isRecord) : [];
      return problems.length > 0 && problems.every((p) => p.verdict === 'unknown');
    } catch { return false; }
  }
  return false;
}

async function latestAnswer(state: PipelineState): Promise<Record<string, unknown> | null> {
  const files: Array<{ path: string; at: number }> = [];
  for (const dir of [state.records_dir, submitDir(state)])
    for (const n of (await readdir(dir).catch(() => [] as string[])).filter((n) => /^answer-\d+-\d+\.txt$/.test(n))) files.push({ path: join(dir, n), at: Number(n.split('-')[1]) });
  files.sort((a, b) => b.at - a.at);
  for (const f of files) { const value = envelopeIn(await readFile(f.path, 'utf8')); if (value) return value; }
  return null;
}

const submitDir = (state: PipelineState) => `${state.records_dir.replace(/\/+$/, '')}-submit`;
const acceptedDir = (state: PipelineState) => `${state.records_dir.replace(/\/+$/, '')}-accepted`;
async function keepAccepted(state: PipelineState, c: CaseState): Promise<void> {
  const name = `${c.recompose.index}.json`, kept = join(acceptedDir(state), name);
  if (existsSync(kept)) return;
  const judged = existsSync(join(submitDir(state), name)) ? join(submitDir(state), name) : join(state.records_dir, name);
  if (!existsSync(judged)) return;
  await mkdir(acceptedDir(state), { recursive: true });
  await copyFile(judged, kept);
}
const recordAccepted = (c: CaseState) => c.record_accepted === true || c.stage === 'accepted' || c.stage === 'writing' || c.stage === 'ready' || (c.stage === 'stopped' && c.attempts.write > 0);
const toolFailure = (c: CaseState) => c.stage === 'stopped' && c.attempts.write === 0 && !c.regated && /Hub 的答复里没有机器可读部分|submit-records 没有交上去/.test(c.stopped ?? '');

async function submitCase(state: PipelineState, c: CaseState, g: Gates): Promise<ToolRun> {
  const dir = submitDir(state);
  await mkdir(dir, { recursive: true });
  for (const n of await readdir(dir)) if (n.endsWith('.json')) await rm(join(dir, n));
  const take = async (row: CaseState, accepted = false) => {
    const name = `${row.recompose.index}.json`, kept = join(acceptedDir(state), name);
    const from = accepted && existsSync(kept) ? kept : join(state.records_dir, name);
    if (existsSync(from)) await copyFile(from, join(dir, name));
  };
  for (const row of state.cases) if (row !== c && recordAccepted(row)) await take(row, true);
  for (const row of state.cases.filter(toolFailure)) {
    row.regated = true;
    const record = join(state.records_dir, `${row.recompose.index}.json`);
    if (!existsSync(record)) continue;
    const checked = await g.run('recompose', 'check-record.ts', ['--file', record, '--run', state.recompose_dir]);
    if (checked.code === 0 || onlyUnknown(checked)) await take(row);
  }
  await take(c);
  return g.run('recompose', 'submit-records.ts', ['--hub', g.hub, '--run', state.recompose_run, '--model', state.model, '--records', dir, '--partial', 'yes'], `${g.token}\n`);
}

async function promoteAccepted(state: PipelineState, envelope: Record<string, unknown> | null): Promise<void> {
  if (!envelope) return;
  for (const c of state.cases)
    if (c.stage === 'stopped' && c.attempts.write === 0 && existsSync(join(state.records_dir, `${c.recompose.index}.json`)) && recordStatus(envelope, c.recompose.item).satisfied) { c.stage = 'accepted'; c.record_accepted = true; delete c.stopped; await keepAccepted(state, c); }
}

async function recomposeEnded(state: PipelineState, c: CaseState, g: Gates, finished: boolean): Promise<Action | null> {
  const record = join(state.records_dir, `${c.recompose.index}.json`);
  const again = async (reason: string) => c.attempts.recompose >= state.max_attempts ? (stop(c, `用例重组 ${c.attempts.recompose} 次仍未通过：${reason}`), null) : dispatchRecompose(state, c, g, `上一次没有通过：${reason}`);
  if (!existsSync(record)) return finished ? again(`没有写出 ${record}`) : null;
  const checked = await g.run('recompose', 'check-record.ts', ['--file', record, '--run', state.recompose_dir]);
  if (checked.code !== 0 && !onlyUnknown(checked)) return again(`本地重组自检没有通过：${words(checked)}`);
  const sent = await submitCase(state, c, g);
  if (unavailable(sent)) return wait(c, `Hub 暂时收不到这一条的重组记录：${words(sent)}`);
  const answer = await hubAnswer(sent);
  if (!answer) return again(`submit-records 没有交上去：${words(sent) || '没有输出'}`);
  await promoteAccepted(state, answer);
  const status = recordStatus(answer, c.recompose.item);
  if (!status.satisfied) return again(`Hub 核对这一条没有通过：${status.seen}${checked.code !== 0 ? `；本地自检另有读不到的引用：${words(checked)}` : ''}`);
  c.record_accepted = true; delete c.pending;
  await keepAccepted(state, c);
  return toWriter(state, c, g);
}

async function toWriter(state: PipelineState, c: CaseState, g: Pick<Gates, 'run'> & Partial<Gates>): Promise<Action | null> {
  if (!existsSync(join(state.plan_dir, 'briefs', `${c.plan.index}.md`))) {
    c.stage = 'accepted';
    if (!g.hub || !g.token) return null;
    const refreshed = await g.run('case-compile', 'refresh-late.ts', ['--hub', g.hub, '--run', state.plan_run, '--dir', state.plan_dir], `${g.token}\n`);
    if (unavailable(refreshed)) return wait(c, `Hub 暂时取不到这一条的重组结果：${words(refreshed)}`);
    if (refreshed.code !== 0 || !existsSync(join(state.plan_dir, 'briefs', `${c.plan.index}.md`))) { stop(c, `重组已被 Hub 受理，但脚本编写运行刷新不到这一条：${words(refreshed) || '没有写出编写简报'}`); return null; }
  }
  return dispatchWrite(state, c, g);
}

async function writeEnded(state: PipelineState, c: CaseState, g: Gates, finished: boolean): Promise<Action | null> {
  const plans = join('cases', c.k, 'plan'), plan = join(plans, `${c.plan.index}.json`), audits = join('cases', c.k, 'audit');
  const again = async (reason: string) => c.attempts.write >= state.max_attempts ? (stop(c, `脚本编写 ${c.attempts.write} 次仍未通过：${reason}`), null) : dispatchWrite(state, c, g, `上一次没有通过：${reason}`);
  if (!existsSync(plan)) return finished ? again(`没有写出 ${plan}`) : null;
  const checked = await g.run('case-compile', 'check-plan.ts', ['--file', plan, '--run', state.plan_dir]);
  if (checked.code !== 0) return again(`计划自检没有通过：${words(checked)}`);
  const verified = await plumbGate(g, 'cmd-verify-plumb.ts', ['--plans', plans, '--run', state.plan_dir, '--base-url', g.plumb, '--key-stdin']);
  if (unavailable(verified)) return wait(c, `命令核验暂时做不了：${words(verified)}`);
  if (verified.code !== 0) return again(`命令核验没有通过：${words(verified)}`);
  await mkdir(audits, { recursive: true });
  const audited = await plumbGate(g, 'fidelity-plumb.ts', ['--run', state.plan_dir, '--plans', plans, '--briefs', audits, '--base-url', g.plumb, '--key-stdin']);
  if (unavailable(audited)) return wait(c, `场景保真审计暂时做不了：${words(audited)}`);
  if (audited.code !== 0) {
    if ((await pendingBriefs(audits)).length) return dispatchAudit(state, c, g);
    if (/^参数无效/.test(words(audited))) return again(`场景保真审计做不了：${words(audited)}`);
    stop(c, `场景保真审计没有做完（Plumb）：${words(audited)}`); return null;
  }
  return auditApplied(state, c, g, false);
}

async function pendingBriefs(audits: string): Promise<string[]> {
  const names = await readdir(audits).catch(() => [] as string[]);
  return names.filter((n) => n.endsWith('.brief.json') && !names.includes(n.replace(/\.brief\.json$/, '.verdict.json'))).sort();
}

async function dispatchAudit(state: PipelineState, c: CaseState, g: Pick<Gates, 'run'>): Promise<Action> {
  const audits = join('cases', c.k, 'audit'), brief = (await pendingBriefs(audits))[0]!;
  c.stage = 'auditing'; c.audits = (c.audits ?? 0) + 1; delete c.pending;
  const task = join('tasks', 'audit', `${c.k}-${c.attempts.write}-${c.audits}.md`);
  const made = await g.run('case-compile', 'task-brief.ts', ['--role', '保真核对', '--case', `${c.plan.index}.json`, '--brief', join(audits, brief), '--out', join(audits, brief.replace(/\.brief\.json$/, '.verdict.json')), '--task-file', task]);
  if (made.code !== 0) throw new Error(`生成保真盲审任务失败（${c.autoid}）：${words(made)}`);
  return (c.action = { label: label('audit', c.k), subagent_type: AUDITOR, description: made.stdout.trim() });
}

async function reviewZoneVerdicts(audits: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of (await readdir(audits).catch(() => [] as string[])).filter((n) => n.endsWith('.verdict.json')).sort()) {
    let value: unknown;
    try { value = JSON.parse(await readFile(join(audits, name), 'utf8')); } catch { continue; }
    const failing = (isRecord(value) && Array.isArray(value.steps) ? value.steps.filter(isRecord) : []).filter((row) => row.verdict !== 'preserved');
    if (failing.length && failing.every((row) => isRecord(row.model_judgment) && isRecord(row.model_judgment.gate) && row.model_judgment.gate.action === 'review')) out.push(name);
  }
  return out;
}

export function auditRefusal(applied: ToolRun): string {
  try {
    const value = JSON.parse(applied.stdout.slice(applied.stdout.indexOf('{'), applied.stdout.lastIndexOf('}') + 1));
    if (!isRecord(value) || value.ready !== false) return '';
    const attention = Array.isArray(value.attention) ? value.attention.filter(isRecord) : [];
    return attention.map((row) => String(row.message ?? '')).filter(Boolean).join('；') || '核对结果没有并入';
  } catch { return ''; }
}

async function auditApplied(state: PipelineState, c: CaseState, g: Pick<Gates, 'run'> & Partial<Gates>, afterAudit: boolean): Promise<Action | null> {
  const plans = join('cases', c.k, 'plan'), plan = join(plans, `${c.plan.index}.json`), audits = join('cases', c.k, 'audit');
  const again = async (reason: string) => c.attempts.write >= state.max_attempts ? (stop(c, `脚本编写 ${c.attempts.write} 次仍未通过：${reason}`), null) : dispatchWrite(state, c, g, `上一次没有通过：${reason}`);
  if ((await pendingBriefs(audits)).length) {
    if (!afterAudit) return dispatchAudit(state, c, g);
    if ((c.audits ?? 0) >= state.max_attempts) { stop(c, `保真盲审 ${c.audits} 次都没有写出判断`); return null; }
    return dispatchAudit(state, c, g);
  }
  const applied = await g.run('case-compile', 'fidelity-apply.ts', ['--run', state.plan_dir, '--plans', plans, '--briefs', audits]);
  if (applied.code !== 0) return again(`场景保真审计没有通过：${words(applied)}`);
  const refused = auditRefusal(applied);
  if (refused) {
    const unsure = await reviewZoneVerdicts(audits);
    if (unsure.length && (c.audits ?? 0) < state.max_attempts) {
      for (const name of unsure) await rename(join(audits, name), join(audits, name.replace(/\.verdict\.json$/, '.plumb-review.json')));
      (c.review ??= []).push(`场景保真：第 ${c.attempts.write} 版计划里有 Plumb 拿不准、标为“待人工复核”的步骤；本次无人值守，改由独立盲审给出结论（Plumb 的原判断保存在 ${join(audits, unsure[0]!.replace(/\.verdict\.json$/, '.plumb-review.json'))}）`);
      return dispatchAudit(state, c, g);
    }
  }
  if (refused) return again(`场景保真审计没有通过：${refused}。落实作者前置状态句的每条前置命令都要带 precondition_source（手册逐字引文）并挂在那条作者步骤上，保真核对才按有来源的前置豁免`);
  const final = await g.run('case-compile', 'check-plan.ts', ['--file', plan, '--run', state.plan_dir]);
  if (final.code !== 0) return again(`合入审计结论后计划自检没有通过：${words(final)}`);
  const kept = join('cases', c.k, 'ready', `${c.plan.index}.json`);
  await mkdir(join('cases', c.k, 'ready'), { recursive: true });
  await copyFile(plan, kept);
  c.ready_sha256 = await sha256File(kept);
  c.stage = 'ready'; delete c.pending;
  return null;
}

async function retryWaiting(state: PipelineState, current: CaseState | null, g: Gates, actions: Action[]): Promise<void> {
  let tried = 0;
  for (const row of state.cases) {
    if (row === current || !row.pending || tried >= 2 || !RUNNING.includes(row.stage)) continue;
    tried++;
    const action = await advanceGate(state, row, g, false);
    if (action) actions.push(action);
  }
}

async function fill(state: PipelineState, g: Pick<Gates, 'run'> & Partial<Gates>, actions: Action[], failed?: (c: CaseState, error: unknown) => void): Promise<void> {
  const running = () => state.cases.filter((c) => RUNNING.includes(c.stage)).length;
  for (const c of state.cases) {
    if (running() >= state.width) break;
    if (c.stage !== 'accepted') continue;
    let action: Action | null = null;
    try { action = await toWriter(state, c, g); } catch (error) { if (!failed) throw error; failed(c, error); }
    if (action) actions.push(action);
  }
  for (const c of state.cases) {
    if (running() >= state.width) break;
    if (c.stage === 'queued') actions.push(await dispatchRecompose(state, c, g));
  }
}

export function summary(state: PipelineState, actions: Action[]): Step {
  const running = state.cases.filter((c) => RUNNING.includes(c.stage)).map((c) => label(c.stage === 'recomposing' ? 'recompose' : c.stage === 'writing' ? 'write' : 'audit', c.k));
  const ready = state.cases.filter((c) => c.stage === 'ready').map((c) => c.k);
  const stopped = state.cases.filter((c) => c.stage === 'stopped').map((c) => ({ label: `${c.k} ${c.autoid}`, reason: c.stopped ?? '' }));
  const queued = state.cases.filter((c) => c.stage === 'queued' || c.stage === 'accepted').length;
  const excluded = state.cases.filter((c) => c.stage === 'excluded').map((c) => ({ label: `${c.k} ${c.autoid}`, reason: c.excluded ?? '' }));
  const allDone = !running.length && !queued && !actions.length;
  const waiting = state.cases.filter((c) => c.pending && c.stage !== 'stopped' && c.stage !== 'ready').map((c) => ({ label: c.stage === 'accepted' ? c.k : label(c.stage === 'recomposing' ? 'recompose' : c.stage === 'writing' ? 'write' : 'audit', c.k), reason: c.pending! }));
  const message = progress({ cases: state.cases.length, toStart: actions.length, running: running.length, queued, ready: ready.length, stopped: stopped.length, excluded: excluded.length, waiting: waiting.map((w) => w.label), allDone, ...(state.open ? { open: state.open } : {}) });
  return { actions, running, ready, stopped, queued, all_done: allDone, message, ...(waiting.length ? { waiting } : {}), ...(excluded.length ? { excluded } : {}) };
}

async function saveState(path: string, state: PipelineState) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}

function advanceGate(state: PipelineState, c: CaseState, g: Gates, finished: boolean): Promise<Action | null> {
  if (c.stage === 'recomposing') return recomposeEnded(state, c, g, finished);
  if (c.stage === 'writing') return writeEnded(state, c, g, finished);
  return auditApplied(state, c, g, true);
}

export async function next(state: PipelineState, finished: string, g: Gates): Promise<Step> {
  const match = /^(重组|编写|审计) (\d+)$/.exec(finished.trim());
  if (!match) throw new Error(`--finished 写这个工具派发时给的标签，形如“重组 03”“编写 03”或“审计 03”（看到 ${finished.slice(0, 40)}）`);
  const c = state.cases.find((row) => row.k === match[2]);
  const expected: Stage = match[1] === '重组' ? 'recomposing' : match[1] === '编写' ? 'writing' : 'auditing';
  if (!c || c.stage !== expected) throw new Error(`标签 ${finished} 对不上：${c ? `这一条现在是 ${c.stage}` : '没有这一条'}；用 pipeline.ts status 看各条现在在哪一步`);
  const actions: Action[] = [];
  const action = await advanceGate(state, c, g, true);
  if (action) actions.push(action);
  await retryWaiting(state, c, g, actions);
  await promoteAccepted(state, await latestAnswer(state));
  await fill(state, g, actions);
  return summary(state, actions);
}

const labelOf = (c: CaseState) => label(c.stage === 'recomposing' ? 'recompose' : c.stage === 'writing' ? 'write' : 'audit', c.k);

export async function resume(state: PipelineState, g: Gates): Promise<Step> {
  const fresh: Action[] = [];
  await retryWaiting(state, null, g, fresh);
  await promoteAccepted(state, await latestAnswer(state));
  await fill(state, g, fresh);
  const running = state.cases.filter((c) => RUNNING.includes(c.stage) && !c.pending);
  const lost = running.filter((c) => c.action?.label !== labelOf(c));
  if (lost.length) throw new Error(`这份状态没有记下 ${lost.map(labelOf).join('、')} 派出的任务：不能接着派，从 init 重新开始`);
  return summary(state, running.map((c) => c.action!));
}

export function forLead(step: Step): Omit<Step, 'actions'> & { to_start: string[] } {
  const { actions, message, ...rest } = step;
  return { ...rest, to_start: actions.map((a) => a.label), message: actions.length ? `${message}。${toStart(actions.length)}` : message };
}

export async function retry(state: PipelineState, which: string, decision: string, g: Pick<Gates, 'run'> & Partial<Gates>): Promise<Step> {
  const c = state.cases.find((row) => row.k === which.trim() || row.autoid === which.trim());
  if (!c) throw new Error(`--case 写 status 里的序号或 autoid（看到 ${which.slice(0, 40)}）`);
  if (c.stage === 'excluded') throw new Error(`${c.k} 不在交付卷里（${c.excluded ?? '没有通过上机'}），不再重写；它照实进报告`);
  if (c.stage !== 'stopped' && c.stage !== 'ready') throw new Error(`${c.k} 现在是 ${c.stage}，子代理还在做；只有停下的和已就绪的条目能 retry`);
  if (!decision.trim()) throw new Error('--note 写对这一条的决定或 Hub 退回它的原话');
  if (c.stage === 'ready') {
    c.decision = decision.trim().slice(0, NOTE_CHARS); c.stage = 'accepted'; c.attempts.write = 0; delete c.ready_sha256; delete c.pending;
    const again: Action[] = [];
    await fill(state, g, again);
    return summary(state, again);
  }
  const atAudit = (c.stopped ?? '').startsWith('场景保真审计没有做完') && existsSync(join('cases', c.k, 'plan', `${c.plan.index}.json`));
  c.decision = decision.trim().slice(0, NOTE_CHARS); c.carry = c.stopped; delete c.stopped; c.regated = false;
  const actions: Action[] = [];
  if (atAudit) {
    const action = await auditApplied(state, c, g, false);
    if (action) actions.push(action);
    await fill(state, g, actions);
    return summary(state, actions);
  }
  if (c.attempts.write === 0 && !c.record_accepted) { c.stage = 'queued'; c.attempts.recompose = 0; } else { c.stage = 'accepted'; c.attempts.write = 0; }
  await fill(state, g, actions);
  return summary(state, actions);
}

const MAX_DEVICE_ROUNDS = 3;
const MAX_VOLUMES = 2;
export interface Reworked extends Step { round: number; carried: string[]; reworked: string[]; gave_up: Array<{ label: string; reason: string }> }

async function deviceRows(returnsDir: string): Promise<Map<string, Record<string, unknown>>> {
  let index: unknown;
  try { index = JSON.parse(await readFile(join(returnsDir, 'index.json'), 'utf8')); } catch { throw new Error(`--returns ${returnsDir} 里没有 index.json；写 download-returns.ts 存回传的那个目录`); }
  const jobs = isRecord(index) && Array.isArray(index.jobs) ? index.jobs.filter(isRecord) : [];
  const ran = jobs.filter((job) => Array.isArray(job.rows) && job.rows.length).at(-1);
  if (!ran) {
    const last = jobs.at(-1);
    const why = last && Array.isArray(last.missing_facts) ? last.missing_facts.filter(isRecord).map((f) => String(f.fact ?? '')).filter(Boolean).join('；') : '';
    throw new Error(`${returnsDir} 里没有一轮上机的结果：${notDispatched(why.slice(0, 400))}`);
  }
  return new Map((ran.rows as unknown[]).filter(isRecord).map((row) => [String(row.item), row]));
}

type Carried = Map<string, { autoid?: string; file?: string; sha256?: string }>;

async function newPlanRun(state: PipelineState, open: Record<string, unknown>, base: string, exclude: string[], what: string, g: Gates): Promise<{ target: string; planDir: string; openFile: string }> {
  const planDir = join(base, 'plan-run'), openFile = join(base, 'open-compile.json');
  const opened = await g.run('case-compile', 'open-compile.ts', ['--hub', g.hub, '--plumb', g.plumb, '--subject', String(open.subject), '--product', String(open.product), '--build', String(open.build), '--booking', String(open.booking), ...(exclude.length ? ['--exclude', exclude.join(',')] : []), '--recompose-run', String(open.recompose_run), '--recompose-record', String(open.recompose_record), '--out', openFile], `${g.token}\n${g.plumbKey}\n`);
  if (opened.code !== 0 || !existsSync(openFile)) throw new Error(`${what}没有开成：${words(opened) || '没有输出'}`);
  const target = String(((await readJson(openFile)) as Record<string, unknown>).plan_run ?? '');
  if (!target || target === state.plan_run) throw new Error(`open-compile.ts 没有给出新的脚本编写运行（看到 ${target || '空'}）`);
  const history = join(dirname(state.plan_history?.[0]?.dir ?? state.plan_dir), HISTORY_DIRECTORY);
  const got = await g.run('case-compile', 'download-run.ts', ['--hub', g.hub, '--run', target, '--out', planDir, '--history-reuse', history], `${g.token}\n`);
  if (got.code !== 0 || !existsSync(join(planDir, 'run.json'))) throw new Error(`${what} ${target} 没有下载下来：${words(got) || '没有输出'}`);
  return { target, planDir, openFile };
}

async function carryPlans(state: PipelineState, base: string, planDir: string, which: string[], g: Pick<Gates, 'run'>): Promise<Carried> {
  const carry = await g.run('case-compile', 'carry-plans.ts', ['--source', state.plan_dir, '--target', planDir, '--plans', join(base, 'carried'), '--source-plans', join(base, 'source-plans'), ...which]);
  if (carry.code !== 0) throw new Error(`结转没有做成：${words(carry)}`);
  const manifest = JSON.parse(carry.stdout.slice(carry.stdout.indexOf('{'))) as { carried?: Array<{ autoid?: string; file?: string; sha256?: string }> };
  return new Map((manifest.carried ?? []).map((row) => [String(row.autoid), row]));
}

function switchRun(state: PipelineState, target: string, planDir: string, openFile: string): void {
  (state.plan_history ??= []).push({ run: state.plan_run, dir: state.plan_dir });
  state.plan_run = target; state.plan_dir = planDir; state.open = openFile;
}

async function takeCarried(state: PipelineState, cases: CaseState[], carriedBy: Carried, g: Gates, actions: Action[]): Promise<{ carried: string[]; regated: number }> {
  const carried: string[] = [], regate: CaseState[] = [];
  for (const c of cases) {
    const row = carriedBy.get(c.autoid);
    if (row?.file && row.sha256) {
      const kept = join('cases', c.k, 'ready', `${c.plan.index}.json`);
      await copyFile(row.file, kept); await copyFile(row.file, join('cases', c.k, 'plan', `${c.plan.index}.json`));
      c.ready_sha256 = await sha256File(kept); carried.push(c.k);
    } else regate.push(c);
  }
  for (const c of regate) { c.stage = 'writing'; delete c.ready_sha256; const action = await writeEnded(state, c, g, true); if (action) actions.push(action); }
  return { carried, regated: regate.length };
}

const exclude = (c: CaseState, why: string) => { c.stage = 'excluded'; c.excluded = why; delete c.pending; };

async function openVolume(state: PipelineState, open: Record<string, unknown>, inPlay: CaseState[], out: CaseState[], why: (c: CaseState) => string, g: Gates, done: (message: string) => Reworked): Promise<Reworked> {
  const members = inPlay.filter((c) => !out.includes(c));
  if (!members.length) { for (const c of out) exclude(c, why(c)); return done(nothingPassed(state.cases.length)); }
  const n = (state.volume?.n ?? 0) + 1, base = `deliver-${n}`;
  if (existsSync(base)) throw new Error(`${base} 已经存在：第 ${n} 次交付卷已经开过，照 pipeline.ts status 的 message 接着做`);
  const excluded = [...state.cases.filter((c) => c.stage === 'excluded'), ...out].map((c) => c.autoid);
  await mkdir(base, { recursive: true });
  let opened: { target: string; planDir: string; openFile: string }, carriedBy: Carried;
  try {
    opened = await newPlanRun(state, open, base, excluded, '交付卷的脚本编写运行', g);
    await mkdir(join(base, 'source-plans'), { recursive: true });
    for (const c of members) await copyFile(join('cases', c.k, 'ready', `${c.plan.index}.json`), join(base, 'source-plans', `${c.plan.index}.json`));
    carriedBy = await carryPlans(state, base, opened.planDir, ['--exclude', excluded.join(',')], g);
  } catch (error) {
    await rm(base, { recursive: true, force: true });
    throw error;
  }
  switchRun(state, opened.target, opened.planDir, opened.openFile);
  state.volume = { n };
  for (const c of out) exclude(c, why(c));
  const actions: Action[] = [];
  const { carried, regated } = await takeCarried(state, members, carriedBy, g, actions);
  const step = summary(state, actions);
  return { ...step, message: volumeOpened({ n, run: opened.target, open: opened.openFile, out: out.map((c) => c.k), carried: carried.length, regated, status: step.message }), round: n, carried, reworked: [], gave_up: out.filter((c) => c.gave_up).map((c) => ({ label: `${c.k} ${c.autoid}`, reason: c.gave_up! })) };
}

export async function rework(state: PipelineState, open: Record<string, unknown>, returnsDir: string, notesDir: string | undefined, g: Gates): Promise<Reworked> {
  const inPlay = state.cases.filter((c) => c.stage !== 'excluded');
  const unfinished = inPlay.filter((c) => c.stage !== 'ready');
  if (unfinished.length) throw new Error(`还有 ${unfinished.length} 条不是就绪（${unfinished.map((c) => c.k).join('、')}）；返工在一轮上机回来之后做`);
  if (state.volume?.result) throw new Error(volumeClosed(state.volume.result === 'passed', state.volume.result === 'passed' ? state.cases.length - inPlay.length : state.cases.length));
  if (open.plan_run !== state.plan_run) throw new Error(`--open 写这一轮用的 open-compile 文件（它的脚本编写运行应是 ${state.plan_run}）；新的那个由本工具开`);
  for (const field of ['subject', 'product', 'build', 'booking', 'recompose_run', 'recompose_record']) if (typeof open[field] !== 'string' || !open[field]) throw new Error(`--open 不是 open-compile.ts 写的文件（缺 ${field}）`);
  const rows = await deviceRows(returnsDir);
  const blamed = culprits(rows.values());
  const failed: CaseState[] = [];
  for (const c of inPlay) {
    const row = rows.get(c.autoid);
    if (!row) throw new Error(`${returnsDir} 的这一轮上机里没有条目 ${c.autoid}；写这次合并运行的回传目录`);
    if (!state.volume && (!unjudged(row) || blamed.has(c.autoid))) c.device_rounds = (c.device_rounds ?? 0) + 1;
    c.device_passed = row.verdict === 'pass';
    if (failedRow(row, blamed)) failed.push(c);
  }
  const round = Math.max(1, ...state.cases.map((c) => c.device_rounds ?? 0)) + 1;
  const gaveUp = failed.filter((c) => (c.device_rounds ?? 0) >= MAX_DEVICE_ROUNDS);
  for (const c of gaveUp) c.gave_up = `上机 ${c.device_rounds} 轮仍未通过（最后一轮判定 ${String(rows.get(c.autoid)!.verdict)}）`;
  const done = (message: string): Reworked => ({ ...summary(state, []), message, round, carried: [], reworked: [], gave_up: gaveUp.map((c) => ({ label: `${c.k} ${c.autoid}`, reason: c.gave_up! })) });
  const verdictOf = (c: CaseState) => String(rows.get(c.autoid)!.verdict);
  if (state.volume) {
    const notPassed = inPlay.filter((c) => verdictOf(c) !== 'pass');
    if (!notPassed.length) { state.volume.result = 'passed'; return done(volumePassed(inPlay.length, state.cases.length - inPlay.length)); }
    if (state.volume.n >= MAX_VOLUMES) { state.volume.result = 'failed'; return done(volumesUsed(state.volume.n, notPassed.map((c) => c.k), state.cases.length)); }
    const out = failed.length ? failed : notPassed, verified = state.volume.n;
    return openVolume(state, open, inPlay, out, (c) => `交付卷第 ${verified} 次上机没有通过（判定 ${verdictOf(c)}）`, g, done);
  }
  if (!failed.length) return done(nothingToRework(inPlay.length, inPlay.filter((c) => verdictOf(c) !== 'pass').length));
  if (gaveUp.length) return openVolume(state, open, inPlay, failed, (c) => c.gave_up ?? `上机第 ${c.device_rounds} 轮没有通过（判定 ${verdictOf(c)}），同一轮已有条目用完 ${MAX_DEVICE_ROUNDS} 轮，不再开返工轮`, g, done);
  const base = `rework-${round}`, priorPlans = join(base, 'prior-plans');
  if (existsSync(base)) throw new Error(`${base} 已经存在：第 ${round} 轮返工已经开过，照 pipeline.ts status 的 message 接着做`);
  await mkdir(base, { recursive: true });
  const noticed = new Map<CaseState, string[]>();
  let opened: { target: string; planDir: string; openFile: string }, carriedBy: Carried;
  try {
    opened = await newPlanRun(state, open, base, [], '新的脚本编写运行', g);
    await mkdir(join(base, 'source-plans'), { recursive: true }); await mkdir(priorPlans, { recursive: true });
    for (const c of inPlay) {
      const kept = join('cases', c.k, 'ready', `${c.plan.index}.json`);
      await copyFile(kept, join(base, 'source-plans', `${c.plan.index}.json`));
      if (failed.includes(c)) await writeFile(join(priorPlans, `${c.plan.index}.json`), JSON.stringify({ ...((await readJson(kept)) as Record<string, unknown>), plan_run: state.plan_run }, null, 1) + '\n');
    }
    for (const c of failed) {
      const ran = await g.run('case-compile', 'check-plan.ts', ['--file', join('cases', c.k, 'plan', `${c.plan.index}.json`), '--run', state.plan_dir]).catch(() => null);
      try { const said: unknown = JSON.parse(ran?.stdout.trim().split('\n').pop() ?? 'null'); if (isRecord(said) && Array.isArray(said.advice)) noticed.set(c, said.advice.filter((line): line is string => typeof line === 'string').slice(0, 4)); } catch { }
    }
    carriedBy = await carryPlans(state, base, opened.planDir, ['--rework', failed.map((c) => c.autoid).join(',')], g);
  } catch (error) { await rm(base, { recursive: true, force: true }); throw error; }
  switchRun(state, opened.target, opened.planDir, opened.openFile);
  for (const c of failed) {
    const notes = notesDir && existsSync(join(notesDir, `${c.plan.index}.json`)) ? notesDir : undefined;
    (c.prior ??= []).push({ plans: priorPlans, returns: returnsDir, ...(notes ? { notes } : {}) });
    c.stage = 'accepted'; c.attempts.write = 0; delete c.ready_sha256; delete c.pending;
    const facts = noticed.get(c) ?? [];
    c.carry = `上机第 ${c.device_rounds} 轮没有通过（判定 ${String(rows.get(c.autoid)!.verdict)}）；这一轮跑的计划、设备回传和失败分析见任务文件${facts.length ? `。这份计划自检时看到的事实：${facts.join('；')}` : ''}`.slice(0, NOTE_CHARS);
  }
  const actions: Action[] = [];
  const { carried } = await takeCarried(state, inPlay.filter((c) => !failed.includes(c)), carriedBy, g, actions);
  await fill(state, g, actions, (c, error) => stop(c, `第 ${round} 轮的编写任务没有生成：${error instanceof Error ? error.message : String(error)}`));
  const step = summary(state, actions);
  return { ...step, message: reworkOpened({ round, run: opened.target, open: opened.openFile, carried: carried.length, reworked: failed.length, status: step.message }), round, carried, reworked: failed.map((c) => c.k), gave_up: [] };
}

export async function collect(state: PipelineState, out: string): Promise<{ copied: number; stopped: Array<{ autoid: string; reason: string }>; not_done: string[]; reviewed?: Array<{ autoid: string; notes: string[] }>; excluded?: Array<{ autoid: string; reason: string }> }> {
  const notDone = state.cases.filter((c) => c.stage !== 'ready' && c.stage !== 'stopped' && c.stage !== 'excluded').map((c) => c.k);
  if (notDone.length) throw new Error(`还有 ${notDone.length} 条没走完流水线（${notDone.join('、')}）；等它们结束再收拢`);
  await mkdir(out, { recursive: true });
  let copied = 0;
  for (const c of state.cases.filter((row) => row.stage === 'ready')) {
    const kept = join('cases', c.k, 'ready', `${c.plan.index}.json`), from = existsSync(kept) ? kept : join('cases', c.k, 'plan', `${c.plan.index}.json`);
    if (c.ready_sha256 && (await sha256File(from)) !== c.ready_sha256) throw new Error(`${c.k} 就绪时留下的计划 ${from} 被改过（摘要对不上）；用 pipeline.ts retry --case ${c.k} 重新过关口`);
    await copyFile(from, join(out, `${c.plan.index}.json`), 1 ); copied++;
  }
  const reviewed = state.cases.filter((c) => c.stage !== 'excluded' && c.review?.length).map((c) => ({ autoid: c.autoid, notes: c.review! }));
  const excluded = state.cases.filter((c) => c.stage === 'excluded').map((c) => ({ autoid: c.autoid, reason: c.excluded ?? '' }));
  return { copied, stopped: state.cases.filter((c) => c.stage === 'stopped').map((c) => ({ autoid: c.autoid, reason: c.stopped ?? '' })), not_done: [], ...(reviewed.length ? { reviewed } : {}), ...(excluded.length ? { excluded } : {}) };
}

async function readStdinLines(): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

export async function main(argv: string[], readStdin = readStdinLines, run?: RunTool, skillsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')): Promise<number> {
  const [command, ...rest] = argv;
  const tools = run ?? spawnTool(skillsRoot);
  const starts = run ? undefined : startTool(skillsRoot);
  try {
    if (command === 'init') {
      const a = parseCliOptions(rest, { 'recompose-run': true, 'plan-run': true, open: true, model: true, state: true, width: false }, 'pipeline.ts init --recompose-run <目录> --plan-run <目录> --open open-compile.json --model <模型> --state <新文件>') as Record<string, string>;
      if (existsSync(a.state)) throw new Error(`--state ${a.state} 已经存在，不覆盖；用 pipeline.ts status 查看进度`);
      const width = a.width === undefined ? 6 : Number(a.width);
      if (!Number.isInteger(width) || width < 1 || width > 20) throw new Error('--width 写 1 到 20 的整数');
      const state = await initState(a['recompose-run'], a['plan-run'], (await readJson(a.open)) as Record<string, unknown>, a.model, width);
      state.open = a.open;
      const actions: Action[] = [];
      await fill(state, { run: tools }, actions);
      await saveState(a.state, state);
      process.stdout.write(JSON.stringify(forLead(summary(state, actions))) + '\n');
      return 0;
    }
    if (command === 'resume') {
      const a = parseCliOptions(rest, { state: true, hub: true, plumb: true, pause: false }, 'pipeline.ts resume --state <文件> --hub <MCP地址> --plumb <Plumb地址> [--pause <秒>]') as Record<string, string>;
      const pause = a.pause === undefined ? 0 : Number(a.pause);
      if (!Number.isInteger(pause) || pause < 0 || pause > 300) throw new Error('--pause 写 0 到 300 的整数（先等这么多秒再看）');
      const [token, plumbKey] = await readStdin();
      if (!token || !plumbKey) throw new Error("标准输入要两行：第一行 %HUB_TOKEN%，第二行 %PLUMB_API_KEY%");
      if (pause) await new Promise((done) => setTimeout(done, pause * 1000));
      const state = (await readJson(a.state)) as PipelineState;
      const step = await resume(state, { run: tools, hub: a.hub, plumb: a.plumb, token, plumbKey, start: starts });
      await saveState(a.state, state);
      process.stdout.write(JSON.stringify(step) + '\n');
      return 0;
    }
    if (command === 'next') {
      const a = parseCliOptions(rest, { state: true, finished: true, hub: true, plumb: true }, "pipeline.ts next --state <文件> --finished '<标签>' --hub <MCP地址> --plumb <Plumb地址>") as Record<string, string>;
      const [token, plumbKey] = await readStdin();
      if (!token || !plumbKey) throw new Error("标准输入要两行：第一行 %HUB_TOKEN%，第二行 %PLUMB_API_KEY%");
      const state = (await readJson(a.state)) as PipelineState;
      const step = await next(state, a.finished, { run: tools, hub: a.hub, plumb: a.plumb, token, plumbKey, start: starts });
      await saveState(a.state, state);
      process.stdout.write(JSON.stringify(step) + '\n');
      return 0;
    }
    if (command === 'status') {
      const a = parseCliOptions(rest, { state: true }, 'pipeline.ts status --state <文件>') as Record<string, string>;
      process.stdout.write(JSON.stringify(summary((await readJson(a.state)) as PipelineState, [])) + '\n');
      return 0;
    }
    if (command === 'collect') {
      const a = parseCliOptions(rest, { state: true, out: true }, 'pipeline.ts collect --state <文件> --out <计划目录>') as Record<string, string>;
      process.stdout.write(JSON.stringify(await collect((await readJson(a.state)) as PipelineState, a.out)) + '\n');
      return 0;
    }
    if (command === 'retry') {
      const a = parseCliOptions(rest, { state: true, case: true, note: true }, "pipeline.ts retry --state <文件> --case <序号> --note '<决定或退回的原话>'") as Record<string, string>;
      const state = (await readJson(a.state)) as PipelineState;
      const step = await retry(state, a.case, a.note, { run: tools });
      await saveState(a.state, state);
      process.stdout.write(JSON.stringify(forLead(step)) + '\n');
      return 0;
    }
    if (command === 'rework') {
      const a = parseCliOptions(rest, { state: true, open: true, returns: true, notes: false, hub: true, plumb: true }, "pipeline.ts rework --state <文件> --open <这一轮的 open-compile 文件> --returns <上机回传目录> [--notes <失败分析目录>] --hub <MCP地址> --plumb <Plumb地址>") as Record<string, string>;
      const [token, plumbKey] = await readStdin();
      if (!token || !plumbKey) throw new Error("标准输入要两行：第一行 %HUB_TOKEN%，第二行 %PLUMB_API_KEY%");
      const state = (await readJson(a.state)) as PipelineState;
      const step = await rework(state, (await readJson(a.open)) as Record<string, unknown>, a.returns, a.notes, { run: tools, hub: a.hub, plumb: a.plumb, token, plumbKey, start: starts });
      await saveState(a.state, state);
      process.stdout.write(JSON.stringify(forLead(step)) + '\n');
      return 0;
    }
    throw new Error('子命令只有 init、resume、next、status、collect、retry、rework');
  } catch (error) {
    process.stdout.write(`流水线工具没有完成：${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
