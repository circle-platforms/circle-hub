import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { backgroundIds, canonical, keyOf, refusedBeforeHook, ReplayError, requireFact, sha, type Bundle, type Gap, type Message, type SessionRow, type ToolPair } from './types.ts';
import { appFingerprint } from './bundle.ts';
export interface ReplayReport {
  schema: 'circle-replay-report@1';
  status: 'complete' | 'different' | 'unavailable';
  exit: number;
  expected: Bundle['counts'];
  actual: {
    messages: number;
    calls: number;
    responses: number;
    denials: number;
    sessions: number;
    background: number;
    errors: number;
  } | null;
  trace?: Record<string, unknown>[];
  semanticSha256?: string;
  gaps: Gap[];
  firstDifference?: Record<string, unknown>;
  coverage: Record<string, unknown>;
}
export interface PlayOptions {
  pace?: 'fast' | 'recorded';
  speed?: number;
}
async function moduleAt(app: string, name: string): Promise<any> {
  try { return await import(pathToFileURL(join(app, 'dist', name + '.js')).href); }
  catch { throw new ReplayError('已安装应用缺少可加载的回放接口', 2, { module: name }); }
}
function semantic(m: Message): unknown {
  return { role: m.role, content: m.content, tool_calls: m.tool_calls, tool_call_id: m.tool_call_id, name: m.name, status: m.status, internal: m.internal, hook: m.hook, thinking: m.thinking };
}
function mChannel(m: Message): string { return m.role === 'assistant' ? 'scripted_model' : m.role === 'tool' ? 'harness_tool' : m.internal === 'hook_notice' && m.hook?.kind !== 'active' ? 'harness_hook' : m.internal ? 'replay_host' : 'harness_input'; }
function failDifference(session: string, event: string, expected: unknown, actual: unknown): never {
  throw new ReplayError('回放事件与记录不符', 1, { session, event, expectedSha256: sha(canonical(expected)), actualSha256: sha(canonical(actual)) });
}
export async function play(bundle: Bundle, app: string, options: PlayOptions = {}): Promise<ReplayReport> {
  const actual = { messages: 0, calls: 0, responses: 0, denials: 0, sessions: 0, background: 0, errors: 0 };
  const trace: Record<string, unknown>[] = [];
  const report: ReplayReport = { schema: 'circle-replay-report@1', status: 'unavailable', exit: 2, expected: bundle.counts, actual, trace, gaps: [...bundle.gaps], coverage: { harness: 'not_started', model: 'recorded', tools: 'recorded_boundaries', policy: 'synthetic_allow_for_inert_tools', originalRequests: 'unavailable', originalToolSchemas: 'unavailable', nativeCircleRuntime: false } };
  const scratch = mkdtempSync(join(tmpdir(), 'circle-replay-run-'));
  let store: any;
  try {
    if (bundle.source.appVersion !== '1.17.0') throw new ReplayError('回放适配器不支持此 Circle 版本', 2);
    const actualApp = appFingerprint(app);
    requireFact(canonical(actualApp.files) === canonical(bundle.source.appFiles), 'Circle 应用摘要与捕获版本不符');
    if (bundle.gaps.some(g => g.blocking))
      throw new ReplayError('回放缺少必要边界证据', 2);
    const [{ Harness }, { CheckpointStore }, { ContextManager }, { HookRunner }, { Sandbox }, { buildTools }, { EventBus }, { emptyUsage }, { orderModeToolResults }, { prepareToolCall }, { pruneMessages }] = await Promise.all(['harness', 'checkpoint_store', 'context_middleware', 'hooks', 'sandbox', 'tools', 'events', 'types', 'tool_history', 'tool_call_compat', 'middleware/tool_result_prune'].map(name => moduleAt(app, name)));
    const home = join(scratch, 'home'), work = join(scratch, 'work');
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(work, { mode: 0o700 });
    store = new CheckpointStore(home);
    const projector = new ContextManager(store, join(scratch, 'project'));
    const metadata = new Map<string, any>(buildTools(new Sandbox(work, join(scratch, 'project'))).map((t: any) => [t.name, t]));
    const sessions = new Map(bundle.sessions.map(s => [s.id, s]));
    const actualIds = new Map<string, string>(), messageMap = new Map<string, string>();
    const done = new Set<string>(), runs = new Map<string, Promise<void>>();
    const alignedCounts = new Map<string, number>();
    const events = new Map(bundle.events.map(e => [e.id, e]));
    const started = new Set<string>(), hooked = new Set<string>();
    const currentAssistant = new Map<string, string>();
    const invocationOrder: {
      session: string;
      call: string;
    }[] = [];
    report.coverage.invocationOrder = invocationOrder;
    const hookOrder: {
      session: string;
      call: string;
    }[] = [];
    report.coverage.hookOrder = hookOrder;
    const observedCalls = new Set<string>();
    const jobs = new Set<string>(), fileStates = new Map<string, string>();
    const contextGaps = new Set<string>();
    let fatal: ReplayError | undefined;
    const mark = (sid: string, rowId: string) => {
      const event = events.get(rowId)!; for (const dep of event.dependsOn)
        requireFact(done.has(dep), '事件提前越过依赖', { session: sid, event: rowId, dependency: dep }); done.add(rowId);
    };
    const align = (s: SessionRow) => {
      const original = bundle.paths.get(s.id)!;
      const stored: Message[] = store.messages(actualIds.get(s.id)!);
      if (stored.length > original.length)
        failDifference(s.id, original.at(-1)?.id ?? '', original.length, stored.length);
      const from = alignedCounts.get(s.id) ?? 0;
      requireFact(stored.length >= from, '历史存储意外回退');
      for (let i = from; i < stored.length; i++) {
        const expected = bundle.messages.get(original[i].ref)!;
        if (canonical(semantic(expected)) !== canonical(semantic(stored[i])))
          failDifference(s.id, original[i].id, semantic(expected), semantic(stored[i]));
        const previous = messageMap.get(keyOf(s.id, expected.id));
        requireFact(!previous || previous === stored[i].id, '来源消息映射发生变化');
        messageMap.set(keyOf(s.id, expected.id), stored[i].id);
        if (!done.has(original[i].id)) {
          mark(s.id, original[i].id);
          actual.messages++;
          trace.push({ event: original[i].id, session: s.id, kind: events.get(original[i].id)!.kind, source: mChannel(expected), expectedSha256: sha(canonical(semantic(expected))), actualSha256: sha(canonical(semantic(stored[i]))) });
          if (stored[i].role === 'tool' && stored[i].status === 'error')
            actual.errors++;
        }
      }
      alignedCounts.set(s.id, stored.length);
      return stored.length;
    };
    const appendHost = (s: SessionRow) => {
      let n = align(s);
      const path = bundle.paths.get(s.id)!;
      while (n < path.length) {
        const row = path[n], m = bundle.messages.get(row.ref)!;
        if (!m.internal)
          break;
        if (m.internal === 'hook_notice' && m.hook?.kind !== 'active')
          break;
        for (const dep of events.get(row.id)!.dependsOn)
          requireFact(done.has(dep), '宿主通知提前越过依赖', { event: row.id, dependency: dep });
        if (m.internal === 'job_notice') {
          const ids = backgroundIds(m);
          requireFact(ids.length > 0, '后台通知身份缺失');
          for (const id of ids) {
            requireFact(jobs.has(keyOf(s.id, id)), '后台通知缺少已启动任务');
            jobs.delete(keyOf(s.id, id));
            actual.background++;
          }
        }
        store.append(actualIds.get(s.id), [structuredClone(m)]);
        n = align(s);
      }
    };
    const sourceState = (s: SessionRow, n: number) => {
      const ancestors = new Set(bundle.paths.get(s.id)!.slice(0, n).map(r => r.id));
      const available = s.contexts.filter(c => ancestors.has(c.checkpoint));
      const state = available.at(-1)?.state ?? { prunedIds: [], stripThinkingIds: [], offloaded: {} };
      if (available.length) {
        const anchor = available.at(-1)!.checkpoint;
        const variants = available.filter(c => c.checkpoint === anchor).map(c => ({ prunedIds: c.state.prunedIds, stripThinkingIds: c.state.stripThinkingIds, offloaded: c.state.offloaded, droppedMedia: c.state.droppedMedia ?? [], summary: c.state.summary ?? null }));
        if (new Set(variants.map(canonical)).size > 1)
          throw new ReplayError('同一请求边界的上下文状态存在歧义', 2, { session: s.id });
      }
      return state;
    };
    const sourceProjection = (s: SessionRow, n: number) => {
      const state = sourceState(s, n);
      const convert = (ids: unknown) => Array.isArray(ids) ? ids.map(id => { requireFact(typeof id === 'string' && messageMap.has(keyOf(s.id, id)), '上下文引用尚未生成的消息'); return messageMap.get(keyOf(s.id, id))!; }) : [];
      const converted = { ...state, prunedIds: convert(state.prunedIds), stripThinkingIds: convert(state.stripThinkingIds), offloaded: Object.fromEntries(Object.entries((state.offloaded ?? {}) as Record<string, unknown>).map(([id, path]) => { requireFact(messageMap.has(keyOf(s.id, id)), '投影文件引用缺少消息'); return [messageMap.get(keyOf(s.id, id))!, path]; })), subagentSessionIds: Array.isArray(state.subagentSessionIds) ? state.subagentSessionIds.map(id => actualIds.get(String(id))).filter(Boolean) : [] };
      store.setContextState(actualIds.get(s.id), converted);
      return orderModeToolResults(projector.project(actualIds.get(s.id)));
    };
    const normalizeArgs = (p: ToolPair, tools: any[]) => {
      try {
        return prepareToolCall(p.call, tools).call.args;
      }
      catch {
        return p.call.args;
      }
    };
    const selectedPair = (s: SessionRow, name: string, args: unknown, used: Set<string>, tools: any[]) => {
      const matches = [...bundle.pairs.values()].filter(p => p.session === s.id && p.assistant === currentAssistant.get(s.id) && p.call.name === name && !used.has(keyOf(s.id, p.call.id)) && canonical(normalizeArgs(p, tools)) === canonical(args));
      requireFact(matches.length > 0, '没有对应的历史工具调用', { session: s.id });
      if (matches.length > 1 && new Set(matches.map(p => canonical(p.denied ?? null))).size > 1)
        throw new ReplayError('同批相同参数的 Hook 决定无法唯一绑定', 2);
      const p = matches[0];
      used.add(keyOf(s.id, p.call.id));
      return p;
    };
    const fileEffect = (s: SessionRow, p: ToolPair) => {
      if (p.message.status !== 'success')
        return;
      const a = p.call.args;
      if (typeof a.file_path !== 'string')
        return;
      const key = resolve(s.workspace, a.file_path);
      if (p.call.name === 'write_file' && typeof a.content === 'string')
        fileStates.set(key, a.content);
      if (p.call.name === 'edit_file' && typeof a.old_string === 'string' && typeof a.new_string === 'string') {
        const before = fileStates.get(key);
        if (before !== undefined && a.old_string.length > 0 && before.split(a.old_string).length === 2)
          fileStates.set(key, before.replace(a.old_string, a.new_string));
        else if (!contextGaps.has(key)) {
          contextGaps.add(key);
          report.gaps.push({ fact: '编辑前文件版本未被完整观察', next: '文件效果保持未知，结果文字仍按记录回放', session: s.id, event: p.result.id });
        }
      }
      if (p.call.name === 'delete')
        fileStates.delete(key);
    };
    const runSession = async (sid: string): Promise<void> => {
      const existing = runs.get(sid);
      if (existing)
        return existing;
      const execute = async () => {
        const s = sessions.get(sid)!;
        actual.sessions++;
        const path = bundle.paths.get(sid)!;
        requireFact(path.length > 0, '空会话不可回放');
        const session = store.create(work, 'scripted-replay', 'replay', undefined, s.parent_id ? actualIds.get(s.parent_id) : undefined);
        actualIds.set(sid, session.id);
        let tools: any[] = [];
        const callPairs = [...bundle.pairs.values()].filter(p => p.session === sid);
        const names = [...new Set(callPairs.map(p => p.call.name))];
        tools = names.filter(name => !callPairs.filter(p => p.call.name === name).every(p => p.message.status === 'error' && p.message.content === `tool is not available: ${name}`)).map(name => {
          const meta = metadata.get(name);
          return {
            name, description: meta?.description ?? 'Recorded boundary tool', parameters: meta?.parameters ?? { type: 'object', additionalProperties: true }, effect: meta?.effect ?? 'read', variables: false,
            run: async (args: Record<string, unknown>, context: {
              callId: string;
            }) => {
              try {
                if (fatal)
                  throw fatal;
                align(s);
                const p = bundle.pairs.get(keyOf(sid, context.callId));
                requireFact(p && p.call.name === name && !started.has(keyOf(sid, p.call.id)), '工具调用身份无效或重复');
                if (canonical(normalizeArgs(p, tools)) !== canonical(args))
                  failDifference(sid, p.assistant, normalizeArgs(p, tools), args);
                started.add(keyOf(sid, p.call.id));
                if (p.child) {
                  await runSession(p.child);
                  const child = sessions.get(p.child)!;
                  align(child);
                }
                if (p.job) {
                  jobs.add(keyOf(sid, p.job));
                }
                fileEffect(s, p);
                if (p.message.status === 'error')
                  throw new Error(p.message.content);
                return p.message.content;
              }
              catch (error) {
                if (error instanceof ReplayError)
                  fatal = error;
                throw error;
              }
            }
          };
        });
        const loaded = { hooks: [], errors: [], projectIgnored: false, projectChanged: [] };
        const hooks = new HookRunner(loaded, { workspace: work, home });
        hooks.run = async (request: any) => {
          if (request.event !== 'before_tool')
            return { decision: 'none', reason: '', context: '', outcomes: [], notices: [] };
          if (fatal)
            throw fatal;
          align(s);
          const p = selectedPair(s, request.toolName, request.toolInput, hooked, tools);
          if (refusedBeforeHook(p.call, p.message))
            return { decision: 'none', reason: '', context: '', outcomes: [], notices: [] };
          hookOrder.push({ session: sid, call: p.call.id });
          if (p.denied) {
            actual.denials++;
            return { decision: 'deny', reason: p.denied.reason ?? '', context: '', outcomes: [], notices: [p.denied] };
          }
          return { decision: 'none', reason: '', context: '', outcomes: [], notices: [] };
        };
        const model = {
          model: 'scripted-replay', sideRequests: false, contextWindow: 1000000000, complete: async (request: any) => {
            if (fatal)
              throw fatal;
            appendHost(s);
            const n = align(s);
            const expected = path[n];
            requireFact(expected, '出现超出来源的模型请求', { session: sid });
            const m = bundle.messages.get(expected.ref)!;
            requireFact(m.role === 'assistant', '来源下一条不是模型响应', { session: sid, event: expected.id });
            const original = bundle.paths.get(s.id)!.slice(0, n).map(row => bundle.messages.get(row.ref)!);
            const projected = orderModeToolResults(pruneMessages(structuredClone(original), sourceState(s, n)));
            const frame: Message[] = request.messages;
            const sourceActual = projected.map((v: Message) => semantic(v));
            if (canonical(sourceActual) !== canonical(frame.map(semantic)))
              failDifference(sid, expected.id, sourceActual, frame.map(semantic));
            trace.push({ event: expected.id, session: sid, kind: 'request_projection', expectedSha256: sha(canonical(sourceActual)), actualSha256: sha(canonical(frame.map(semantic))) });
            currentAssistant.set(sid, expected.id);
            actual.responses++;
            if (options.pace === 'recorded') {
              const previous = path[n - 1];
              const delay = Math.max(0, expected.created - (previous?.created ?? expected.created)) / (options.speed ?? 1);
              if (delay)
                await new Promise(resolve => setTimeout(resolve, delay));
            }
            const copy = structuredClone(m);
            delete copy.usage;
            delete copy.cost;
            delete copy.provider_content;
            delete copy.thinking_scope;
            delete copy.thinking_seconds;
            request.token(copy.content);
            return { message: copy, usage: emptyUsage(), usageReported: true };
          }
        };
        const policy = { credentialFiles: [], review: () => ({ verdict: 'ASK', message: '', reason: '', pattern: '', scope: '', warn_delete: false, prefix: [], covered_by: [] }), allowedBySettings: () => true, needsApproval: () => false, tabAlwaysAsks: () => false, mode: () => 'auto', readOnlyCommand: () => false, remember: () => { } };
        const bus = new EventBus(session.id);
        bus.subscribe((event: any) => {
          if (event.kind !== 'tool_call')
            return; const key = keyOf(sid, event.payload.id); const p = bundle.pairs.get(key); if (!p || observedCalls.has(key) || event.payload.name !== p.call.name) {
              fatal = new ReplayError('Harness 产生未知或重复工具调用', 1, { session: sid });
              return;
            } observedCalls.add(key); invocationOrder.push({ session: sid, call: p.call.id }); actual.calls++;
        });
        let h: any;
        h = new Harness({
          model, tools, store, session, system: 'Replay recorded decisions. All tools are inert boundary fixtures.', policy, headless: true, maxSteps: path.length + 1, hooks, sessionHooks: sid === bundle.source.root, approve: async () => 'approve', variables: () => ({}), secrets: () => ({}), redact: (text: string) => text, bus, prepareMessages: async () => {
            if (fatal)
              throw fatal; appendHost(s); return sourceProjection(s, align(s));
          }
        });

        let previous = -1;
        while (true) {
          appendHost(s);
          const n = align(s);
          if (n === path.length)
            break;
          requireFact(n > previous, '回放没有消费新事件');
          previous = n;
          const m = bundle.messages.get(path[n].ref)!;
          if (m.role === 'user' && !m.internal)
            await h.run(m.content, m.display);
          else if (m.role === 'assistant')
            await h.run();
          else
            throw new ReplayError('会话边界无法推进', 2, { session: sid, event: path[n].id });
          if (fatal)
            throw fatal;
          align(s);
        }
      };
      const promise = execute();
      runs.set(sid, promise);
      return promise;
    };
    await runSession(bundle.source.root);
    if (fatal)
      throw fatal;
    requireFact(runs.size === bundle.sessions.length && done.size === bundle.counts.messages, '存在未消费会话或事件');
    requireFact(actual.calls === bundle.counts.calls && actual.responses === bundle.counts.responses && actual.errors === bundle.counts.errors, 'Harness 调用或模型响应计数不符');
    requireFact(actual.denials === bundle.counts.denials && actual.background === bundle.counts.background, 'Hook 或后台事件计数不符');
    report.status = 'complete';
    report.exit = 0;
    report.coverage.harness = 'installed_circle_1.17.0';
    report.coverage.fileEffects = { knownVersions: fileStates.size, unknownEdits: contextGaps.size };
    const actualSemantic = bundle.sessions.map(s => ({ session: s.id, messages: (store.messages(actualIds.get(s.id)) as Message[]).map(semantic) }));
    const expectedSemantic = bundle.sessions.map(s => ({ session: s.id, messages: bundle.paths.get(s.id)!.map(row => semantic(bundle.messages.get(row.ref)!)) }));
    requireFact(canonical(actualSemantic) === canonical(expectedSemantic), '最终完整历史与来源不符');
    report.semanticSha256 = sha(canonical(actualSemantic));
  }
  catch (error) {
    const e = error instanceof ReplayError ? error : new ReplayError('回放运行异常', 1, { errorSha256: sha(error instanceof Error ? error.message : String(error)) });
    report.exit = e.exit;
    report.status = e.exit === 2 ? 'unavailable' : 'different';
    report.firstDifference = { fact: e.message, ...e.detail };
  }
  finally {
    try {
      store?.close();
    }
    finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  return report;
}
