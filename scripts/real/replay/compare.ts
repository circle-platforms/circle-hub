import { availableParallelism } from 'node:os';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, keyOf, ReplayError, requireFact, sha, type Bundle } from './types.ts';
import { inspectBundle, privateDirectory, safeFile, writePrivate } from './bundle.ts';
import { runReplay } from './run.ts';
import { fromMirror, GuardSandbox, runGuard, safeName, validGuardFile, type GuardFile } from './guard.ts';

export interface GuardCase {
  session: string;
  call: string;
  /** The JSON the hook gets on standard input, as Circle builds it. `tool_input` is the recorded arguments, or those with `variables` applied. */
  input: Record<string, unknown>;
  /** The guard entry, a name in the case's files. */
  entry: string;
  /** The file the candidate replaces; the entry when absent. */
  replace?: string;
  /** false: the case runs its files as they are even when a candidate is given (another guard decided it, so there is nothing to replace). */
  candidate?: boolean;
  /** The files of this case, or the name of a shared set in `sets` (exactly one of the two). */
  files?: Record<string, GuardFile>;
  set?: string;
  /** What the history recorded for this call. `evidence` says how well: `record` is the recorded denial, `log` a hooks log line bound by order. */
  baseline: {
    decision: 'allow' | 'deny' | 'ask' | 'none';
    reason: string;
    evidence?: string;
  };
  provenance: 'scripted' | 'operator';
}
export interface GuardContextInput {
  schema: 'circle-replay-guard-context@1';
  /** Plain variables Circle expanded in tool arguments before the hook saw them (`%NAME%` becomes the value). */
  variables?: Record<string, string>;
  /** An absolute directory prefix of the recorded session. The guard runs where that prefix is replaced by a private one of equal length. */
  mirror?: string;
  sets?: Record<string, Record<string, GuardFile>>;
  cases: GuardCase[];
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
/** Circle's variable expansion: `%NAME%` for each declared name, the longest names first. Secrets are not expanded for hooks and are not handled here. */
export function expandVariables(value: unknown, variables: Record<string, string>): unknown {
  const names = Object.keys(variables).filter(name => variables[name].length > 0).sort((a, b) => b.length - a.length);
  if (!names.length)
    return value;
  const pattern = new RegExp(`%(${names.join('|')})%`, 'g');
  const walk = (item: unknown): unknown => typeof item === 'string' ? item.replace(pattern, (_whole, name: string) => variables[name]) : Array.isArray(item) ? item.map(walk) : isRecord(item) ? Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, walk(entry)])) : item;
  return walk(value);
}
export function validateGuardContext(value: GuardContextInput, b: Bundle): void {
  requireFact(value.schema === 'circle-replay-guard-context@1' && Array.isArray(value.cases), '守卫上下文格式无效');
  const sets = value.sets ?? {};
  requireFact(isRecord(sets) && Object.values(sets).every(files => isRecord(files) && Object.entries(files).every(([name, file]) => safeName(name) && validGuardFile(file))), '守卫文件集合无效');
  const variables = value.variables ?? {};
  requireFact(isRecord(variables) && Object.entries(variables).every(([name, text]) => /^[A-Z][A-Z0-9_]*$/.test(name) && typeof text === 'string'), '守卫上下文变量无效');
  requireFact(value.mirror === undefined || (typeof value.mirror === 'string' && value.mirror.startsWith('/')), '守卫上下文镜像前缀无效');
  const seen = new Set<string>();
  for (const c of value.cases) {
    const key = keyOf(c.session, c.call);
    const p = b.pairs.get(key);
    requireFact(p && !seen.has(key), '守卫上下文缺少唯一来源调用');
    seen.add(key);
    requireFact(c.provenance === 'scripted' || c.provenance === 'operator', '守卫上下文缺少来源声明');
    requireFact(isRecord(c.input) && c.input.tool_name === p.call.name, '守卫上下文改变了模型工具参数');
    // The hook saw the recorded arguments or those after variable expansion; nothing else may stand in for what the model wrote.
    requireFact([p.call.args, expandVariables(p.call.args, variables)].some(args => canonical(args) === canonical(c.input.tool_input)), '守卫上下文改变了模型工具参数');
    requireFact(c.input.session_id === undefined || c.input.session_id === c.session, '守卫上下文的会话与来源调用不符');
    requireFact((c.files === undefined) !== (c.set === undefined), '守卫上下文必须给出 files 或 set 之一');
    const files = c.set !== undefined ? sets[c.set] : c.files;
    requireFact(isRecord(files) && safeName(c.entry) && Object.hasOwn(files, c.entry) && Object.hasOwn(files, c.replace ?? c.entry), '守卫上下文入口或候选替换文件缺失');
    if (c.set === undefined)
      requireFact(Object.entries(files).every(([name, file]) => safeName(name) && validGuardFile(file)), '守卫文件路径或内容无效');
    requireFact(['allow', 'deny', 'ask', 'none'].includes(c.baseline?.decision) && typeof c.baseline.reason === 'string', '守卫基线决定无效');
    if (p.denied)
      requireFact(c.baseline.decision === 'deny' && c.baseline.reason === p.denied.reason, '守卫基线与拒绝记录不符');
  }
}

export interface CompareOptions {
  bundle: string;
  app: string;
  /** The candidate guard file. Without it the context's own files run as recorded: the baseline check. */
  guard?: string;
  out: string;
  timeoutMs?: number;
  guardTimeoutMs?: number;
  /** Judge every call instead of stopping at the first difference or the first call that cannot be judged. */
  survey?: boolean;
  /** A short real directory for the equal-length mirror prefix (default: /tmp). */
  mirrorBase?: string;
}
export interface CallRecord {
  index: number;
  session: string;
  call: string;
  tool: string;
  /** `candidate`: the candidate's file ran. `reference`: the case's own files ran (no candidate, or a case the candidate does not apply to). */
  role: 'candidate' | 'reference';
  evidence: string;
  expectedDecision: string;
  outcome: 'match' | 'mismatch' | 'unknown';
  /** Why the call could not be judged. */
  cause?: string;
  actualDecision?: string;
  /** The guard crashed or printed no JSON; Circle denies the call then. */
  failed?: boolean;
  expectedReasonSha256: string;
  actualReasonSha256?: string;
  inputSha256: string;
  /** Paths the guard tried to read that its sandbox does not hold. */
  outsideReads: number;
  outsideReadsSha256?: string;
}
export interface CompareReport {
  exit: number;
  status: string;
  mode: 'candidate' | 'baseline';
  survey: boolean;
  /** Guard runs that gave a decision which could be set against the recorded one. */
  compared: number;
  /** Guard runs started. */
  attempted: number;
  matched: number;
  mismatched: number;
  unknown: number;
  /** Matches whose guard also tried to read outside its sandbox. */
  matchedWithOutsideReads: number;
  roles: Record<string, Record<string, number>>;
  evidence: Record<string, Record<string, number>>;
  candidateSha256?: string;
  contextSha256?: string;
  callsSha256?: string;
  firstDifference?: unknown;
  firstUnknown?: unknown;
}
const tally = (into: Record<string, Record<string, number>>, key: string, outcome: string) => {
  const row = (into[key] ??= { match: 0, mismatch: 0, unknown: 0 });
  row[outcome]++;
};
export async function compareReplay(options: CompareOptions): Promise<CompareReport> {
  const b = inspectBundle(options.bundle);
  const out = privateDirectory(options.out, [b.directory, b.source.home, ...b.source.workspaces, options.app]);
  const baseline = await runReplay({ bundle: options.bundle, app: options.app, out: join(out, 'baseline'), timeoutMs: options.timeoutMs });
  const survey = options.survey === true;
  const report: CompareReport = { exit: baseline.exit, status: baseline.status, mode: options.guard ? 'candidate' : 'baseline', survey, compared: 0, attempted: 0, matched: 0, mismatched: 0, unknown: 0, matchedWithOutsideReads: 0, roles: {}, evidence: {} };
  if (baseline.firstDifference)
    report.firstDifference = baseline.firstDifference;
  if (baseline.exit === 0) {
    const records: CallRecord[] = [];
    const sandboxes = new Map<string, GuardSandbox>();
    try {
      if (!b.source.indexHashes['guard-contexts.json'])
        throw new ReplayError('缺少历史守卫状态与明确的候选输入映射', 2);
      const candidateBytes = options.guard ? readFileSync(options.guard) : undefined;
      if (candidateBytes) {
        report.candidateSha256 = sha(candidateBytes);
        writePrivate(out, 'candidate-source.bin', candidateBytes);
      }
      const contextBytes = safeFile(b.directory, 'guard-contexts.json');
      report.contextSha256 = sha(contextBytes);
      const context = JSON.parse(contextBytes.toString()) as GuardContextInput;
      validateGuardContext(context, b);
      const cases = new Map(context.cases.map(c => [keyOf(c.session, c.call), c]));
      // Only calls the Harness put to the hook are judged: a call refused before that (invalid arguments) has no decision in the history.
      const order = (baseline.coverage.hookOrder ?? baseline.coverage.invocationOrder) as { session: string; call: string }[];
      if (!order.length)
        throw new ReplayError('没有任何调用交给过守卫，无法比较', 2);
      const timeout = options.guardTimeoutMs ?? 10000;
      const sandboxFor = (c: GuardCase, candidate: boolean) => {
        const name = c.replace ?? c.entry;
        const key = c.set !== undefined ? JSON.stringify([c.set, name, candidate]) : undefined;
        const known = key === undefined ? undefined : sandboxes.get(key);
        if (known)
          return { sandbox: known, shared: true };
        const sandbox = new GuardSandbox({ files: c.set !== undefined ? context.sets![c.set] : c.files!, replace: candidate && candidateBytes ? { name, bytes: candidateBytes } : undefined, mirror: context.mirror ? { from: context.mirror, base: options.mirrorBase } : undefined });
        if (key !== undefined)
          sandboxes.set(key, sandbox);
        return { sandbox, shared: key !== undefined };
      };
      const evaluate = async (index: number): Promise<CallRecord> => {
        const { session, call } = order[index];
        const c = cases.get(keyOf(session, call));
        const base = { index, session, call, tool: b.pairs.get(keyOf(session, call))!.call.name };
        if (!c)
          return { ...base, role: 'reference', evidence: 'none', expectedDecision: 'unknown', outcome: 'unknown', cause: 'no-context', expectedReasonSha256: sha(''), inputSha256: '', outsideReads: 0 };
        const candidate = candidateBytes !== undefined && c.candidate !== false;
        const record: CallRecord = { ...base, role: candidate ? 'candidate' : 'reference', evidence: c.baseline.evidence ?? 'unspecified', expectedDecision: c.baseline.decision, outcome: 'unknown', expectedReasonSha256: sha(c.baseline.reason), inputSha256: sha(canonical(c.input)), outsideReads: 0 };
        const evidence = join(out, `guard-${index}`);
        mkdirSync(evidence, { mode: 0o700 });
        const { sandbox, shared } = sandboxFor(c, candidate);
        try {
          const run = await runGuard(sandbox, c.entry, sandbox.input(c.input), timeout, evidence);
          const reason = sandbox.mirror ? fromMirror(run.reason, sandbox.mirror) : run.reason;
          record.actualDecision = run.decision;
          record.actualReasonSha256 = sha(reason);
          record.failed = run.failed;
          record.outsideReads = run.outsideReads.length;
          if (run.outsideReads.length)
            record.outsideReadsSha256 = sha(canonical(run.outsideReads));
          const same = run.decision === c.baseline.decision && reason === c.baseline.reason;
          // A difference found after the guard tried to read what the context lacks says nothing about the guard.
          record.outcome = same ? 'match' : run.outsideReads.length ? 'unknown' : 'mismatch';
          if (!same && run.outsideReads.length)
            record.cause = 'outside-read';
        }
        catch (error) {
          if (!(error instanceof ReplayError) || error.exit !== 2)
            throw error;
          record.cause = String(error.detail.cause ?? 'guard-unavailable');
        }
        finally {
          if (!shared)
            sandbox.dispose();
        }
        return record;
      };
      if (survey) {
        const slotted: CallRecord[] = [];
        const stopped: { error?: unknown } = {};
        let next = 0;
        await Promise.all(Array.from({ length: Math.max(1, Math.min(8, availableParallelism() - 2)) }, async () => {
          while (!stopped.error && next < order.length) {
            const index = next++;
            try { slotted[index] = await evaluate(index); }
            catch (error) { stopped.error ??= error; }
          }
        }));
        records.push(...slotted.filter(Boolean));
        if (stopped.error)
          throw stopped.error;
      }
      else
        for (let index = 0; index < order.length; index++) {
          records.push(await evaluate(index));
          if (records[index].outcome !== 'match')
            break;
        }
    }
    catch (error) {
      const e = error instanceof ReplayError ? error : new ReplayError('候选守卫比较异常', 1);
      report.exit = e.exit;
      report.status = e.exit === 2 ? 'unavailable' : 'different';
      report.firstDifference = { fact: e.message, ...e.detail };
    }
    finally {
      for (const sandbox of sandboxes.values())
        sandbox.dispose();
    }
    for (const record of records) {
      if (record.cause !== 'no-context')
        report.attempted++;
      if (record.outcome === 'match') {
        report.matched++;
        report.compared++;
        if (record.outsideReads)
          report.matchedWithOutsideReads++;
      }
      else if (record.outcome === 'mismatch') {
        report.mismatched++;
        report.compared++;
      }
      else
        report.unknown++;
      tally(report.roles, record.role, record.outcome);
      tally(report.evidence, record.evidence, record.outcome);
    }
    const firstMismatch = records.find(record => record.outcome === 'mismatch');
    const firstUnknown = records.find(record => record.outcome === 'unknown');
    if (firstUnknown)
      report.firstUnknown = { ...firstUnknown };
    if (report.exit === 0) {
      report.exit = firstMismatch ? 1 : firstUnknown ? 2 : 0;
      report.status = report.exit === 0 ? 'complete' : report.exit === 1 ? 'different' : 'unavailable';
      if (firstMismatch)
        report.firstDifference = { ...firstMismatch };
    }
    const calls = records.map(record => JSON.stringify(record)).join('\n') + (records.length ? '\n' : '');
    writePrivate(out, 'calls.jsonl', calls);
    report.callsSha256 = sha(calls);
  }
  writePrivate(out, 'report.json', JSON.stringify(report, null, 2) + '\n');
  return report;
}
