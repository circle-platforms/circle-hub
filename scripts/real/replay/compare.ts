import { availableParallelism } from 'node:os';
import { lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, posix } from 'node:path';
import { canonical, keyOf, ReplayError, requireFact, sha, type Bundle, type ToolPair } from './types.ts';
import { inspectBundle, privateDirectory, safeFile, writePrivate } from './bundle.ts';
import { runReplay } from './run.ts';
import { fromMirror, GuardSandbox, runGuard, safeName, validGuardFile, type GuardFile } from './guard.ts';
import { hookIdentityEnvironment, hookRegistration, interpretCircle118, mcpToolName, preToolUseInput118, type HookRegistration } from './protocol.ts';

export interface GuardCase {
  session: string;
  call: string;
  /** The JSON the hook gets on standard input, as Circle 1.17.0 builds it. `tool_input` is the recorded arguments, or those with `variables` applied. */
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

/** The candidate: one file that replaces one file of the context, or a folder of files that replaces the guard's own folder. */
export interface Candidate {
  mode: 'file' | 'folder';
  /** A file: its name and bytes, as given. A folder: the relative names of its files. */
  files: Map<string, Buffer>;
}
/** Reads the candidate's paths: a single regular file is a file; several paths, or a directory, are a folder of files (no symbolic links). */
export function readCandidate(paths: string[]): Candidate {
  requireFact(paths.length > 0, '候选路径缺失');
  const files = new Map<string, Buffer>();
  const add = (name: string, bytes: Buffer) => {
    requireFact(safeName(name) && !files.has(name), '候选文件名无效或重复', { name });
    files.set(name, bytes);
  };
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      requireFact(!entry.isSymbolicLink(), '候选文件夹里不能有符号链接', { name: entry.name });
      if (entry.isDirectory())
        walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      else if (entry.isFile())
        add(`${prefix}${entry.name}`, readFileSync(join(dir, entry.name)));
    }
  };
  let folder = paths.length > 1;
  for (const path of paths) {
    const info = lstatSync(path);
    requireFact(!info.isSymbolicLink() && (info.isFile() || info.isDirectory()), '候选路径必须是普通文件或目录');
    if (info.isDirectory()) {
      folder = true;
      walk(path, '');
    }
    else
      add(basename(path), readFileSync(path));
  }
  return { mode: folder ? 'folder' : 'file', files };
}

export interface CompareOptions {
  bundle: string;
  app: string;
  /** The candidate guard: a file, or several files and directories (a folder of files). Without it the context's own files run as recorded: the baseline check. */
  guard?: string | string[];
  /** A file candidate: the context file it replaces, for every case it applies to. Without it each case names its own (`replace`, else its entry). */
  replace?: string;
  /** A folder candidate: its entry, a name in the folder. The entry of each case by default. */
  candidateEntry?: string;
  /** A file that replaces the settings.json beside the guard's folder (in the folder's parent), for the candidate's runs. */
  candidateSettings?: string;
  /** How the candidate is spoken to and heard: Circle 1.17.0's before_tool (default) or Circle 1.18.0-local.2's PreToolUse. */
  protocol?: '1.17.0' | '1.18';
  /** 1.18: the MCP server whose tools 1.17.0 named `<server>_<tool>` and 1.18 names `mcp__<server>__<tool>`. */
  mcpServer?: string;
  /** 1.18: the `permission_mode` the hook is told. */
  permissionMode?: string;
  /** 1.18: what a failure of the hook does, when the candidate's settings do not say. */
  onFailure?: 'block' | 'continue';
  /** Compare what the candidate decided with what was recorded by kind (deny, ask, go ahead) and not by the words of its reason. */
  decisionOnly?: boolean;
  /** Run the candidate on the cases marked `candidate: false` too. */
  allCases?: boolean;
  out: string;
  timeoutMs?: number;
  guardTimeoutMs?: number;
  /** Judge every call instead of stopping at the first difference or the first call that cannot be judged. */
  survey?: boolean;
  /** A short real directory for the equal-length mirror prefix (default: /tmp). */
  mirrorBase?: string;
}
export type DecisionKind = 'deny' | 'ask' | 'go';
const kindOf = (decision: string): DecisionKind => decision === 'deny' ? 'deny' : decision === 'ask' ? 'ask' : 'go';
export interface CallRecord {
  index: number;
  session: string;
  call: string;
  tool: string;
  /** The name the candidate was given for the tool, when the protocol renamed it. */
  candidateTool?: string;
  /** `candidate`: the candidate ran. `reference`: the case's own files ran (no candidate, or a case the candidate does not apply to). */
  role: 'candidate' | 'reference';
  evidence: string;
  expectedDecision: string;
  outcome: 'match' | 'mismatch' | 'unknown';
  /** Why the call could not be judged. */
  cause?: string;
  actualDecision?: string;
  /** Set when the candidate is compared by the kind of its decision. */
  expectedKind?: DecisionKind;
  actualKind?: DecisionKind;
  /** The guard crashed or printed no JSON. */
  failed?: boolean;
  /** Same kind of decision, other words (a candidate compared by decision only). */
  reasonChanged?: boolean;
  rewritten?: boolean;
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
  /** Only when they are not zero or false: a candidate compared by the kind of its decision, matches in other words, answers that rewrote the call, hooks that failed. */
  decisionOnly?: boolean;
  reasonChanged?: number;
  rewritten?: number;
  failedHooks?: number;
  candidate?: {
    protocol: string;
    form: 'file' | 'folder';
    files: Record<string, string>;
    entry?: string;
    settingsSha256?: string;
    hook?: { name: string; onFailure: string; source: string };
  };
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
const asBase64 = (bytes: Buffer): GuardFile => ({ base64: bytes.toString('base64') });
/** The agent type Circle tells a hook for a call made in a subagent: the `subagent_type` of the task call that started it. */
function agentTypeOf(b: Bundle, session: string): string {
  const task: ToolPair | undefined = [...b.pairs.values()].find(p => p.child === session);
  return String(task?.call.args.subagent_type || 'general-purpose');
}
export async function compareReplay(options: CompareOptions): Promise<CompareReport> {
  const b = inspectBundle(options.bundle);
  const out = privateDirectory(options.out, [b.directory, b.source.home, ...b.source.workspaces, options.app]);
  const baseline = await runReplay({ bundle: options.bundle, app: options.app, out: join(out, 'baseline'), timeoutMs: options.timeoutMs });
  const survey = options.survey === true;
  const guardPaths = options.guard === undefined ? [] : Array.isArray(options.guard) ? options.guard : [options.guard];
  const report: CompareReport = { exit: baseline.exit, status: baseline.status, mode: guardPaths.length ? 'candidate' : 'baseline', survey, compared: 0, attempted: 0, matched: 0, mismatched: 0, unknown: 0, matchedWithOutsideReads: 0, roles: {}, evidence: {} };
  if (baseline.firstDifference)
    report.firstDifference = baseline.firstDifference;
  if (baseline.exit === 0) {
    const records: CallRecord[] = [];
    const sandboxes = new Map<string, GuardSandbox>();
    try {
      if (!b.source.indexHashes['guard-contexts.json'])
        throw new ReplayError('缺少历史守卫状态与明确的候选输入映射', 2);
      const candidate = guardPaths.length ? readCandidate(guardPaths) : undefined;
      const protocol = options.protocol ?? '1.17.0';
      requireFact(protocol === '1.17.0' || protocol === '1.18', '候选协议只能是 1.17.0 或 1.18');
      requireFact(candidate !== undefined || (options.replace === undefined && options.candidateEntry === undefined && options.candidateSettings === undefined && protocol === '1.17.0' && !options.allCases), '候选选项需要候选文件');
      requireFact(candidate?.mode === 'folder' || options.candidateEntry === undefined, '入口选项只用于候选文件夹');
      requireFact(candidate?.mode !== 'folder' || options.replace === undefined, '替换选项只用于单个候选文件');
      const settingsBytes = options.candidateSettings === undefined ? undefined : readFileSync(options.candidateSettings);
      if (candidate) {
        const files = Object.fromEntries([...candidate.files].map(([name, bytes]) => [name, sha(bytes)]));
        if (candidate.mode === 'file') {
          const [bytes] = candidate.files.values();
          writePrivate(out, 'candidate-source.bin', bytes);
          report.candidateSha256 = sha(bytes);
        }
        else {
          mkdirSync(join(out, 'candidate'), { mode: 0o700 });
          for (const [name, bytes] of candidate.files) {
            mkdirSync(join(out, 'candidate', posix.dirname(name)), { recursive: true, mode: 0o700 });
            writePrivate(join(out, 'candidate'), name, bytes);
          }
          report.candidateSha256 = sha(canonical(files));
        }
        if (settingsBytes)
          writePrivate(out, 'candidate-settings.json', settingsBytes);
        report.candidate = { protocol, form: candidate.mode, files, ...(settingsBytes ? { settingsSha256: sha(settingsBytes) } : {}) };
      }
      const contextBytes = safeFile(b.directory, 'guard-contexts.json');
      report.contextSha256 = sha(contextBytes);
      const context = JSON.parse(contextBytes.toString()) as GuardContextInput;
      validateGuardContext(context, b);
      const cases = new Map(context.cases.map(c => [keyOf(c.session, c.call), c]));
      const applies = (c: GuardCase) => candidate !== undefined && (c.candidate !== false || options.allCases === true);
      const filesOf = (c: GuardCase) => c.set !== undefined ? context.sets![c.set] : c.files!;
      if (candidate?.mode === 'file' && options.replace !== undefined) {
        requireFact(safeName(options.replace), '候选替换目标需要相对路径');
        for (const c of context.cases)
          requireFact(!applies(c) || Object.hasOwn(filesOf(c), options.replace), '候选替换目标不在守卫上下文的文件里', { session: c.session, call: c.call });
      }
      if (candidate?.mode === 'folder') {
        for (const c of context.cases) {
          if (!applies(c))
            continue;
          requireFact(posix.dirname(c.entry) !== '.', '候选文件夹需要守卫入口位于一个子目录里', { session: c.session, call: c.call });
          requireFact(candidate.files.has(options.candidateEntry ?? posix.basename(c.entry)), '候选文件夹里没有守卫入口', { entry: options.candidateEntry ?? posix.basename(c.entry) });
        }
      }
      // What a failure of the candidate's hook does (1.18): the candidate's own settings say, else the option, else Circle's own default (carry on).
      let hook: HookRegistration & { source: string } = { name: 'candidate', onFailure: options.onFailure ?? 'block', source: options.onFailure ? 'option' : 'default' };
      if (protocol === '1.18' && candidate) {
        const registered = settingsBytes ? hookRegistration(settingsBytes.toString('utf8'), options.candidateEntry ?? posix.basename(context.cases[0]?.entry ?? 'guard')) : undefined;
        if (registered)
          hook = { ...registered, ...(options.onFailure ? { onFailure: options.onFailure } : {}), source: options.onFailure ? 'option' : 'settings' };
        report.candidate!.hook = { name: hook.name, onFailure: hook.onFailure, source: hook.source };
      }
      if (candidate?.mode === 'folder')
        report.candidate!.entry = options.candidateEntry ?? '(entry of each case)';
      const mcpServer = options.mcpServer ?? 'hub';
      const permissionMode = options.permissionMode ?? 'bypassPermissions';
      // Only calls the Harness put to the hook are judged: a call refused before that (invalid arguments) has no decision in the history.
      const order = (baseline.coverage.hookOrder ?? baseline.coverage.invocationOrder) as { session: string; call: string }[];
      if (!order.length)
        throw new ReplayError('没有任何调用交给过守卫，无法比较', 2);
      const timeout = options.guardTimeoutMs ?? 10000;
      /** The files, entry and mapped text files a case's guard runs with. */
      const prepare = (c: GuardCase, candidateRuns: boolean) => {
        const base = filesOf(c);
        if (!candidateRuns || !candidate)
          return { files: base, entry: c.entry, replace: undefined, mapped: [] as string[], name: '' };
        const dir = posix.dirname(c.entry);
        const home = posix.dirname(dir);
        const settingsName = home === '.' ? 'settings.json' : `${home}/settings.json`;
        if (candidate.mode === 'file') {
          const name = options.replace ?? c.replace ?? c.entry;
          const files = settingsBytes ? { ...base, [settingsName]: settingsBytes.toString('utf8') } : base;
          return { files, entry: c.entry, replace: { name, bytes: candidate.files.values().next().value as Buffer }, mapped: settingsBytes ? [settingsName] : [], name };
        }
        const files: Record<string, GuardFile> = Object.fromEntries(Object.entries(base).filter(([name]) => !name.startsWith(`${dir}/`)));
        for (const [name, bytes] of candidate.files)
          files[`${dir}/${name}`] = asBase64(bytes);
        if (settingsBytes)
          files[settingsName] = settingsBytes.toString('utf8');
        return { files, entry: `${dir}/${options.candidateEntry ?? posix.basename(c.entry)}`, replace: undefined, mapped: settingsBytes ? [settingsName] : [], name: 'folder' };
      };
      const sandboxFor = (c: GuardCase, candidateRuns: boolean) => {
        const prepared = prepare(c, candidateRuns);
        const key = c.set !== undefined ? JSON.stringify([c.set, candidateRuns, prepared.name]) : undefined;
        const known = key === undefined ? undefined : sandboxes.get(key);
        if (known)
          return { sandbox: known, entry: prepared.entry, shared: true };
        const sandbox = new GuardSandbox({ files: prepared.files, replace: prepared.replace, mapped: prepared.mapped, mirror: context.mirror ? { from: context.mirror, base: options.mirrorBase } : undefined });
        if (key !== undefined)
          sandboxes.set(key, sandbox);
        return { sandbox, entry: prepared.entry, shared: key !== undefined };
      };
      const evaluate = async (index: number): Promise<CallRecord> => {
        const { session, call } = order[index];
        const c = cases.get(keyOf(session, call));
        const pair = b.pairs.get(keyOf(session, call))!;
        const base = { index, session, call, tool: pair.call.name };
        if (!c)
          return { ...base, role: 'reference', evidence: 'none', expectedDecision: 'unknown', outcome: 'unknown', cause: 'no-context', expectedReasonSha256: sha(''), inputSha256: '', outsideReads: 0 };
        const candidateRuns = applies(c);
        const use118 = candidateRuns && protocol === '1.18';
        const record: CallRecord = { ...base, role: candidateRuns ? 'candidate' : 'reference', evidence: c.baseline.evidence ?? 'unspecified', expectedDecision: c.baseline.decision, outcome: 'unknown', expectedReasonSha256: sha(c.baseline.reason), inputSha256: sha(canonical(c.input)), outsideReads: 0 };
        const evidence = join(out, `guard-${index}`);
        mkdirSync(evidence, { mode: 0o700 });
        const { sandbox, entry, shared } = sandboxFor(c, candidateRuns);
        try {
          // 1.18 is spoken to in its own fields (hook_event_name, agent_id, tool_use_id) and 1.17.0's tool names are renamed.
          let given: Record<string, unknown> = c.input;
          if (use118) {
            const candidateTool = mcpToolName(pair.call.name, mcpServer);
            if (candidateTool !== pair.call.name)
              record.candidateTool = candidateTool;
            given = preToolUseInput118({ root: b.source.root, session: c.session, agentType: c.session === b.source.root ? undefined : agentTypeOf(b, c.session), permissionMode, cwd: String(c.input.cwd ?? ''), toolName: candidateTool, toolInput: c.input.tool_input, toolUseId: c.call, paths: c.input.paths });
          }
          const shown = sandbox.input(given);
          const run = await runGuard(sandbox, entry, shown, timeout, evidence, use118 ? { env: hookIdentityEnvironment({ root: b.source.root, session: c.session, cwd: String(shown.cwd) }), interpret: interpretCircle118(hook) } : {});
          const reason = sandbox.mirror ? fromMirror(run.reason, sandbox.mirror) : run.reason;
          record.actualDecision = run.decision;
          record.actualReasonSha256 = sha(reason);
          record.failed = run.failed;
          if (run.rewritten)
            record.rewritten = true;
          record.outsideReads = run.outsideReads.length;
          if (run.outsideReads.length)
            record.outsideReadsSha256 = sha(canonical(run.outsideReads));
          const byKind = options.decisionOnly === true && candidateRuns;
          if (byKind) {
            record.expectedKind = kindOf(c.baseline.decision);
            record.actualKind = kindOf(run.decision);
          }
          const same = byKind ? record.actualKind === record.expectedKind : run.decision === c.baseline.decision && reason === c.baseline.reason;
          if (same && byKind && record.expectedKind === 'deny' && reason !== c.baseline.reason)
            record.reasonChanged = true;
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
      if (record.reasonChanged)
        report.reasonChanged = (report.reasonChanged ?? 0) + 1;
      if (record.rewritten)
        report.rewritten = (report.rewritten ?? 0) + 1;
      if (record.failed && report.mode === 'candidate')
        report.failedHooks = (report.failedHooks ?? 0) + 1;
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
    if (options.decisionOnly)
      report.decisionOnly = true;
  }
  writePrivate(out, 'report.json', JSON.stringify(report, null, 2) + '\n');
  return report;
}
