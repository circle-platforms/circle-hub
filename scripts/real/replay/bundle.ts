import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { backgroundIds, canonical, deniedLine, keyOf, ReplayError, requireFact, sha, type Bundle, type ContextRow, type Event, type Gap, type Message, type RecordRow, type SessionRow, type Source, type ToolPair } from './types.ts';
export function safeFile(root: string, rel: string): Buffer {
  requireFact(!isAbsolute(rel) && rel.split(/[\\/]/).every(p => p !== '' && p !== '.' && p !== '..'), '文件引用无效');
  let at = resolve(root);
  requireFact(!lstatSync(at).isSymbolicLink() && lstatSync(at).isDirectory(), '来源目录无效');
  for (const part of rel.split('/')) {
    at = join(at, part);
    requireFact(!lstatSync(at).isSymbolicLink(), '拒绝跟随符号链接');
  }
  requireFact(lstatSync(at).isFile(), '来源不是普通文件');
  return readFileSync(at);
}
export function privateDirectory(out: string, forbidden: string[] = []): string {
  const target = resolve(out);
  requireFact(!existsSync(target), '输出目录已经存在');
  let parent = dirname(target);
  while (!existsSync(parent))
    parent = dirname(parent);
  const actual = join(realpathSync(parent), relative(parent, target));
  for (const root of forbidden) {
    const real = existsSync(root) ? realpathSync(root) : resolve(root);
    requireFact(actual !== real && !actual.startsWith(real + '/'), '输出目录位于来源目录内');
  }
  let p = actual;
  while (true) {
    requireFact(!existsSync(join(p, '.git')), '输出目录必须位于 Git 工作树外');
    const next = dirname(p);
    if (next === p)
      break;
    p = next;
  }
  mkdirSync(actual, { recursive: true, mode: 0o700 });
  return actual;
}
export function writePrivate(root: string, file: string, value: string | Uint8Array): void { writeFileSync(join(root, file), value, { flag: 'wx', mode: 0o600 }); }
export function appFingerprint(app: string): {
  version: string;
  files: Record<string, string>;
} {
  const files: Record<string, string> = {};
  const pkg = safeFile(app, 'package.json');
  files['package.json'] = sha(pkg);
  const version = JSON.parse(pkg.toString()).version;
  requireFact(typeof version === 'string', '应用版本缺失');
  const walk = (rel: string) => {
    for (const ent of readdirSync(join(app, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      requireFact(!ent.isSymbolicLink(), '应用模块不能是符号链接');
      const p = `${rel}/${ent.name}`;
      if (ent.isDirectory())
        walk(p);
      else if (/\.(?:js|json|ts)$/.test(ent.name))
        files[p] = sha(safeFile(app, p));
    }
  };
  walk('dist');
  if (existsSync(join(app, 'package-lock.json')))
    files['package-lock.json'] = sha(safeFile(app, 'package-lock.json'));
  return { version, files };
}
function messageOf(bytes: Buffer): Message {
  let m: Message;
  try {
    m = JSON.parse(bytes.toString());
  }
  catch {
    throw new ReplayError('消息不是有效 JSON');
  }
  requireFact(m && typeof m.id === 'string' && ['user', 'assistant', 'tool', 'system'].includes(m.role) && typeof m.content === 'string', '消息结构无效');
  if (m.tool_calls !== undefined)
    requireFact(Array.isArray(m.tool_calls) && m.tool_calls.every(c => typeof c.id === 'string' && typeof c.name === 'string' && c.args && typeof c.args === 'object' && !Array.isArray(c.args)), '工具调用结构无效');
  return m;
}
export function compile(sessions: SessionRow[], messages: Map<string, Message>, root: string): Pick<Bundle, 'paths' | 'pairs' | 'counts'> & {
  events: Event[];
  gaps: Gap[];
} {
  requireFact(sessions.length > 0 && new Set(sessions.map(s => s.id)).size === sessions.length, '会话集合无效');
  const bySession = new Map(sessions.map(s => [s.id, s]));
  requireFact(bySession.has(root), '根会话缺失');
  const paths = new Map<string, RecordRow[]>(), pairs = new Map<string, ToolPair>(), events: Event[] = [], gaps: Gap[] = [];
  const allIds = new Set<string>();
  let branches = 0;
  for (const s of sessions) {
    requireFact(s.id === root || bySession.has(s.parent_id ?? ''), '子会话父级缺失');
    const parents = new Set<string>();
    let ancestor: SessionRow | undefined = s;
    while (ancestor) {
      requireFact(!parents.has(ancestor.id), '会话父级存在环');
      parents.add(ancestor.id);
      ancestor = ancestor.id === root ? undefined : bySession.get(ancestor.parent_id ?? '');
    }
    const rows = new Map(s.records.map(r => [r.id, r]));
    requireFact(rows.size === s.records.length, 'checkpoint 重复');
    for (const r of s.records) {
      requireFact(!allIds.has(r.id), '跨会话 checkpoint 重复');
      allIds.add(r.id);
      requireFact(messages.has(r.ref), '消息内容缺失');
    }
    const chain: RecordRow[] = [];
    const seen = new Set<string>();
    let id = s.head;
    while (id) {
      requireFact(!seen.has(id) && rows.has(id), 'checkpoint 祖先链断开或存在环');
      seen.add(id);
      const r = rows.get(id)!;
      chain.push(r);
      id = r.parent;
    }
    chain.reverse();
    paths.set(s.id, chain);
    branches += s.records.length - chain.length;
    const messageIds = chain.map(r => messages.get(r.ref)!.id);
    requireFact(new Set(messageIds).size === messageIds.length, '会话消息身份重复');
    let assistant: RecordRow | undefined;
    const resultKeys = new Set<string>();
    for (let ordinal = 0; ordinal < chain.length; ordinal++) {
      const r = chain[ordinal], m = messages.get(r.ref)!;
      const deps = ordinal ? [chain[ordinal - 1].id] : [];
      events.push({ id: r.id, kind: m.role === 'assistant' ? 'model_response' : m.role === 'tool' ? 'tool_result' : m.internal ? 'host_message' : 'input', session: s.id, ordinal, checkpoint: r.id, dependsOn: deps, sourceCreated: r.created, payloadRef: r.ref, derivation: 'circle-checkpoint@1' });
      if (m.role === 'assistant') {
        assistant = r;
        for (const c of m.tool_calls ?? []) {
          const key = keyOf(s.id, c.id);
          requireFact(!pairs.has(key), '工具调用 ID 重复');
          pairs.set(key, { session: s.id, assistant: r.id, call: c, result: r, message: m });
        }
      }
      if (m.role === 'tool') {
        const key = keyOf(s.id, m.tool_call_id ?? '');
        const pair = pairs.get(key);
        requireFact(pair && pair.assistant === assistant?.id && !resultKeys.has(key) && m.name === pair.call.name, '工具结果缺失关联、名称不符或重复');
        requireFact(m.status === 'success' || m.status === 'error', '工具结果状态缺失');
        pair.result = r;
        pair.message = m;
        resultKeys.add(key);
      }
    }
    for (const pair of pairs.values())
      if (pair.session === s.id)
        requireFact(resultKeys.has(keyOf(s.id, pair.call.id)), '工具调用缺少结果');
    for (let a = 0; a < chain.length; a++) {
      const am = messages.get(chain[a].ref)!;
      if (am.role !== 'assistant')
        continue;
      let b = a + 1;
      while (b < chain.length && messages.get(chain[b].ref)!.role !== 'assistant')
        b++;
      const block = chain.slice(a + 1, b);
      for (const row of block) {
        const notice = messages.get(row.ref)!;
        if (notice.hook?.kind !== 'denied')
          continue;
        const h = notice.hook;
        const hits = [...pairs.values()].filter(p => p.session === s.id && p.assistant === chain[a].id && p.message.name === h.tool && p.message.content === `${deniedLine} ${h.reason || 'hook denied'}`);
        if (hits.length !== 1 || hits[0].denied) {
          gaps.push({ fact: 'Hook 通知缺少唯一结果绑定', next: '提供明确调用身份或版本化批次关系', session: s.id, event: row.id, blocking: true });
          continue;
        }
        hits[0].denied = h;
        requireFact(block.findIndex(r => r.id === hits[0].result.id) < block.findIndex(r => r.id === row.id), 'Hook 通知先于工具结果');
      }
    }
    for (const c of s.contexts) {
      requireFact(rows.has(c.checkpoint) && c.state && typeof c.state === 'object' && !Array.isArray(c.state), '上下文状态缺少来源 checkpoint');
      if (c.state.offloaded && Object.keys(c.state.offloaded as object).length)
        gaps.push({ fact: '包含尚未支持的外置上下文投影', next: '提供对应外置字节与版本适配器', session: s.id, blocking: true });
      if (c.state.summary)
        gaps.push({ fact: '包含尚未支持的摘要投影', next: '为对应版本提供摘要回放适配器', session: s.id, blocking: true });
    }
  }
  const used = new Set<string>();
  for (const child of sessions.filter(s => s.id !== root)) {
    const input = messages.get(paths.get(child.id)?.[0]?.ref ?? '');
    const matches = [...pairs.values()].filter(p => p.session === child.parent_id && p.call.name === 'task' && typeof p.call.args.description === 'string' && p.call.args.description.length > 0 && input?.content.includes(p.call.args.description));
    if (matches.length !== 1 || used.has(keyOf(matches[0].session, matches[0].call.id))) {
      gaps.push({ fact: '子会话与 task 缺少唯一绑定', next: '提供明确的父调用与子会话身份绑定', session: child.id, blocking: true });
      continue;
    }
    const pair = matches[0];
    pair.child = child.id;
    used.add(keyOf(pair.session, pair.call.id));
    const first = events.find(e => e.id === paths.get(child.id)![0].id)!;
    first.dependsOn.push(pair.assistant);
    const result = events.find(e => e.id === pair.result.id)!;
    const last = paths.get(child.id)!.at(-1);
    if (last)
      result.dependsOn.push(last.id);
    const text = [...paths.get(child.id)!].reverse().map(r => messages.get(r.ref)!).find(m => m.role === 'assistant')?.content;
    if (!text || !pair.message.content.includes(text))
      gaps.push({ fact: '父 task 结果没有包含子会话最终文本', next: '核对 task 包装或补齐子会话终态', session: child.id, blocking: true });
  }
  for (const s of sessions) {
    const jobs = new Map<string, ToolPair>();
    for (const row of paths.get(s.id)!) {
      const m = messages.get(row.ref)!;
      if (m.role === 'tool') {
        const p = pairs.get(keyOf(s.id, m.tool_call_id!))!;
        if (p.call.name === 'execute' && p.call.args.background === true && m.status === 'success') {
          const id = /^In background: (j[1-9][0-9]*) · /.exec(m.content)?.[1];
          if (!id || jobs.has(id))
            gaps.push({ fact: '后台启动缺少唯一任务身份', next: '提供结构化任务身份', event: row.id, blocking: true });
          else {
            p.job = id;
            jobs.set(id, p);
          }
        }
      }
      if (m.internal === 'job_notice') {
        const ids = backgroundIds(m);
        if (!ids.length)
          gaps.push({ fact: '后台完成通知身份格式未知', next: '提供固定版本的宿主通知适配器', event: row.id, blocking: true });
        for (const id of ids) {
          const p = jobs.get(id);
          if (!p)
            gaps.push({ fact: '后台完成通知缺少启动绑定', next: '提供原始后台启动结果', event: row.id, blocking: true });
          else {
            events.find(e => e.id === row.id)!.dependsOn.push(p.result.id);
            jobs.delete(id);
          }
        }
      }
    }
    for (const p of jobs.values())
      gaps.push({ fact: '后台任务缺少完成通知', next: '捕获完整任务边界', event: p.result.id, blocking: true });
  }
  const indegree = new Map(events.map(e => [e.id, e.dependsOn.length]));
  const children = new Map<string, string[]>();
  for (const e of events)
    for (const dep of e.dependsOn) {
      const list = children.get(dep) ?? [];
      list.push(e.id);
      children.set(dep, list);
    }
  const ready = [...indegree].filter(([, n]) => n === 0).map(([id]) => id);
  const done = new Set<string>();
  while (ready.length) {
    const id = ready.pop()!;
    if (done.has(id))
      continue;
    done.add(id);
    for (const child of children.get(id) ?? []) {
      const n = indegree.get(child)! - 1;
      indegree.set(child, n);
      if (!n)
        ready.push(child);
    }
  }
  requireFact(done.size === events.length, '事件依赖断开或存在环');
  const active = [...paths.values()].flat().map(r => messages.get(r.ref)!);
  if (active.some(m => Array.isArray(m.attachments) && m.attachments.length > 0))
    gaps.push({ fact: '此版本不支持附件回放', next: '提供附件字节及投影适配器', blocking: true });
  if (active.some(m => m.interrupted === true))
    gaps.push({ fact: '记录包含中断响应', next: '提供中断与恢复事件适配器', blocking: true });
  return { paths, pairs, events, gaps, counts: { sessions: sessions.length, messages: active.length, calls: pairs.size, responses: active.filter(m => m.role === 'assistant').length, errors: [...pairs.values()].filter(p => p.message.status === 'error').length, denials: active.filter(m => m.hook?.kind === 'denied').length, branches, contexts: sessions.reduce((n, s) => n + s.contexts.length, 0), background: [...pairs.values()].filter(p => p.job).length } };
}
export function capture(options: {
  home: string;
  session: string;
  app: string;
  out: string;
  guardContext?: string;
}): void {
  const home = realpathSync(options.home);
  safeFile(home, 'circle.sqlite');
  const db = new DatabaseSync(join(home, 'circle.sqlite'), { readOnly: true });
  const sessions: SessionRow[] = [];
  const blobs = new Map<string, Buffer>();
  try {
    db.exec('BEGIN');
    const rows = db.prepare('WITH RECURSIVE selected(id) AS(SELECT id FROM sessions WHERE id=? UNION SELECT s.id FROM sessions s JOIN selected t ON s.parent_id=t.id) SELECT s.id,s.parent_id,s.workspace,s.head,s.created,s.updated FROM sessions s JOIN selected t ON t.id=s.id ORDER BY s.created,s.id').all(options.session);
    const hasContexts = Boolean(db.prepare("select 1 from sqlite_master where type='table' and name='context_versions'").get());
    for (const value of rows) {
      const s = value as unknown as Omit<SessionRow, 'records' | 'contexts'>;
      const records: RecordRow[] = [];
      for (const rr of db.prepare('SELECT id,parent,created,CAST(message AS BLOB) bytes FROM checkpoints WHERE session_id=? ORDER BY created,rowid').all(s.id)) {
        const raw = Buffer.from(rr.bytes as Uint8Array);
        const ref = sha(raw);
        messageOf(raw);
        blobs.set(ref, raw);
        records.push({ id: String(rr.id), parent: rr.parent === null ? null : String(rr.parent), created: Number(rr.created), ref });
      }
      const contexts: ContextRow[] = hasContexts ? db.prepare('select v.version,v.checkpoint_id,v.created,CAST(v.state AS BLOB) stateBytes from context_versions v join checkpoints c on c.id=v.checkpoint_id where c.session_id=? order by v.version').all(s.id).map(v => { const bytes = Buffer.from(v.stateBytes as Uint8Array); const ref = sha(bytes); blobs.set(ref, bytes); return { version: Number(v.version), checkpoint: String(v.checkpoint_id), created: Number(v.created), ref, state: JSON.parse(bytes.toString()) }; }) : [];
      sessions.push({ ...s, records, contexts });
    }
    db.exec('ROLLBACK');
  }
  finally {
    db.close();
  }
  const messages = new Map(sessions.flatMap(s => s.records.map(r => [r.ref, messageOf(blobs.get(r.ref)!)] as const)));
  const graph = compile(sessions, messages, options.session);
  const app = appFingerprint(options.app);
  const gaps: Gap[] = [...graph.gaps, { fact: '缺少完整模型请求报文与历史工具声明快照', next: '仅核验有记录支持的消息及工具边界' }, { fact: '非拒绝 Hook 决定缺少逐调用身份', next: 'none 是模拟默认值，不宣称历史允许' }];
  const artifacts: Source['artifacts'] = [];
  const virtuals = new Set<string>();
  for (const m of messages.values())
    for (const v of m.content.matchAll(/\/(?:background_jobs|large_tool_results)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?\.(?:log|txt|jsonl)/g))
      virtuals.add(v[0]);
  for (const virtual of virtuals) {
    let found = false;
    for (const workspace of [...new Set(sessions.map(s => s.workspace))]) {
      const name = basename(workspace).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40).replace(/^[._]+|[._]+$/g, '') || 'root';
      const rel = `projects/${name}-${sha(workspace).slice(0, 12)}${virtual}`;
      if (!existsSync(join(home, rel)))
        continue;
      const before = statSync(join(home, rel));
      const bytes = safeFile(home, rel);
      const after = statSync(join(home, rel));
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        gaps.push({ fact: '引用文件读取期间发生变化', next: '在稳定边界重新捕获' });
        continue;
      }
      const ref = sha(bytes);
      blobs.set(ref, bytes);
      artifacts.push({ virtual, ref, observed: new Date().toISOString() });
      found = true;
      break;
    }
    if (!found) {
      artifacts.push({ virtual, observed: new Date().toISOString() });
      gaps.push({ fact: '未定位到记录引用的文件', next: '提供对应版本的文件证据，不能推断完整输出' });
    }
  }
  const out = privateDirectory(options.out, [home, ...sessions.map(s => s.workspace), options.app]);
  mkdirSync(join(out, 'blobs'), { mode: 0o700 });
  for (const [ref, bytes] of blobs)
    writePrivate(out, `blobs/${ref}`, bytes);
  const indexes = { 'sessions.json': JSON.stringify(sessions), 'events.jsonl': graph.events.map(e => JSON.stringify(e)).join('\n') + '\n', 'gaps.json': JSON.stringify(gaps) };
  if (options.guardContext) {
    const raw = readFileSync(options.guardContext);
    const context = JSON.parse(raw.toString());
    const { schema, cases } = context;
    requireFact(schema === 'circle-replay-guard-context@1' && Array.isArray(cases), '守卫上下文格式无效');
    (indexes as Record<string, string>)['guard-contexts.json'] = raw.toString();
  }
  for (const [file, content] of Object.entries(indexes))
    writePrivate(out, file, content);
  const source: Source = { schema: 'circle-replay-source@1', root: options.session, captured: new Date().toISOString(), home, workspaces: [...new Set(sessions.map(s => s.workspace))], appVersion: app.version, appFiles: app.files, captureNode: { version: process.version, sha256: sha(readFileSync(process.execPath)) }, indexHashes: Object.fromEntries(Object.entries(indexes).map(([file, data]) => [file, sha(data)])), rowsSha256: sha(canonical(sessions)), artifacts };
  writePrivate(out, 'source.json', JSON.stringify(source, null, 2) + '\n');
}
export function inspectBundle(directory: string): Bundle {
  const source = JSON.parse(safeFile(directory, 'source.json').toString()) as Source;
  requireFact(source.schema === 'circle-replay-source@1', '回放包版本不支持');
  for (const file of ['sessions.json', 'events.jsonl', 'gaps.json'])
    requireFact(typeof source.indexHashes[file] === 'string', '必要索引摘要缺失');
  for (const [file, hash] of Object.entries(source.indexHashes))
    requireFact(sha(safeFile(directory, file)) === hash, '索引摘要不符');
  const sessions = JSON.parse(safeFile(directory, 'sessions.json').toString()) as SessionRow[];
  requireFact(sha(canonical(sessions)) === source.rowsSha256, '来源行摘要不符');
  const messages = new Map<string, Message>();
  for (const s of sessions)
    for (const r of s.records) {
      requireFact(/^[a-f0-9]{64}$/.test(r.ref), '内容摘要无效');
      const bytes = safeFile(directory, `blobs/${r.ref}`);
      requireFact(sha(bytes) === r.ref, '消息字节摘要不符');
      messages.set(r.ref, messageOf(bytes));
    }
  for (const s of sessions)
    for (const c of s.contexts) {
      requireFact(/^[a-f0-9]{64}$/.test(c.ref), '上下文来源摘要缺失');
      const bytes = safeFile(directory, `blobs/${c.ref}`);
      requireFact(sha(bytes) === c.ref && canonical(JSON.parse(bytes.toString())) === canonical(c.state), '上下文字节或派生状态不符');
    }
  for (const a of source.artifacts) {
    if (!a.ref)
      continue;
    requireFact(/^[a-f0-9]{64}$/.test(a.ref) && sha(safeFile(directory, `blobs/${a.ref}`)) === a.ref, '引用文件摘要不符');
  }
  const graph = compile(sessions, messages, source.root);
  const events = safeFile(directory, 'events.jsonl').toString().trim().split('\n').map(line => JSON.parse(line)) as Event[];
  requireFact(canonical(events) === canonical(graph.events), '事件索引与来源图不符');
  const gaps = JSON.parse(safeFile(directory, 'gaps.json').toString()) as Gap[];
  for (const gap of graph.gaps)
    requireFact(gaps.some(g => canonical(g) === canonical(gap)), '派生缺口被遗漏');
  return { directory: resolve(directory), source, sessions, messages, events, gaps, paths: graph.paths, pairs: graph.pairs, counts: graph.counts };
}
