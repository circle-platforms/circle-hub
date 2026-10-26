// Independent full-tree verification. Only the integrator runs --collect against a deployed Hub.
// Usage: --tree <original> --out <private-directory> [--builds <gold> ...] [--facets <view>]
//        [--production <record> ...] [--collect --token-file <file> [--url <endpoint>] [--batch 40] [--timeout-ms <ms>]]
// Missing facts carry a concrete next action. Missing inputs are not-run, never answers declared wrong.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { callTools, type CallOptions, type ToolText } from '../hub-call.ts';
import { locationsGold, lineKey, stripPrefix, } from '../gold/locations.ts';
import { privatePath, writePrivateJson, type BuildsGold, type BuildCandidate } from '../gold/builds.ts';
import { parseFacetView } from './location-index.ts';

export const USAGE = `
用法：--tree <树原件> --out <仓库外目录> [--builds <构建金标准> ...]
      [--facets <分面视图>] [--production <生产记录JSON> ...]
      [--collect --token-file <令牌文件> [--url <Hub MCP地址>] [--batch 40] [--timeout-ms <毫秒>]]
client_key 只由原树字节摘要、包、产品和批次文档派生，与 --out 无关。幂等窗口内（默认24小时）以相同原树、原会话和 --batch 采集到新目录会复用原运行；超窗先由集成者查已有运行。
不带 --collect 时只读 out/runs；需要重新比较时复制 runs 到新目录，既有明细不可覆盖。
输入文件和输出目录均在 Git 之外。新文件 0600，目录 0700；屏幕只有计数、摘要和判定。

--builds：每条版本线一份 {"line":"<版本线>","candidates":[{"name":"<名称>","family":"<名称族>","base":"<基础构建>","built":null,"released":null}]}。
built 为构建站制作时间字符串或 null，released 为发布日期字符串或 null。缺某条线的金标准，候选比较记没跑，并列出补取命令。

--production：由集成者从数据库只读导出；脚本不连接数据库，不假定存在生产记录导出 CLI。
每个 JSON 文件可以是一条完整记录，也可以是记录数组。每条至少包含 digest、kind、schema、body：
{
  "digest":"<64位十六进制记录摘要>", "kind":"action", "schema":"action@1",
  "body":{
    "action":"generate",
    "detail":{
      "root":"<这份分面视图的根摘要>",
      "lists":[{
        "producer":"<生产器标识>", "slot":"<输入槽>",
        "skipped":[{"external":"agile:mindmap:<文档编号>","reason":"<记录原有的逐份原因>","retry":true}]
      }]
    }
  }
}
body 必须是 JSON 对象，不能是转义后的 JSON 文本；SQL 导出时使用 body::jsonb。
保留记录原有的完整 body、lists 引用及字段，不把汇总数字改写成逐份原因，也不要补造上例字段。
脚本只用明确绑定文档的 reason/read_tier 分类；没有逐份事实或根不对应，就记原因不明，明细写出文档、根、记录引用和下一条只读 SQL。
没有用例节点、不是脑图的原因若只存在于汇总警告，数据库导出本身不能补出逐份事实；请集成者向生产者补取该文档的逐份证据后重跑。

只读导出 SQL 模板（由集成者运行，将查询输出保存为仓库外 0600 新文件）：
BEGIN READ ONLY;
SELECT COALESCE(jsonb_agg(jsonb_build_object('digest',digest,'kind',kind,'schema',schema,'created_at',created_at,'body',body::jsonb) ORDER BY seq),'[]'::jsonb)
FROM records WHERE kind='action' AND body::jsonb->>'action'='generate'
AND body::jsonb#>>'{detail,root}'='<分面根摘要>';
ROLLBACK;
已知记录摘要时可把根条件换成 digest='<生产记录摘要>'。缺记录引用和根时先询问集成者，不执行无范围查询。
`;

export interface Capture { session?: string; transport_error?: boolean; request: { tool: string; args: unknown }; response: ToolText }
export interface ResultItem { document: string; location: Record<string, unknown> | null; candidates: unknown[] | null }
export type Pending = { document: string; fact: string; next_action: string; next_command?: string; recovery?: { tool: string; args: unknown; session: string | null; start_args?: unknown; run?: string | null } };
type Difference = { document: string; field: string; gold: unknown; actual: unknown; reason: string; next_action?: string };
type Missing = { document: string; reason: string; next_action: string };
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const hash = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const builtSecond = (value: unknown): unknown => typeof value === 'string' ? value.replace(/\.\d+(?=Z?$)/, '').replace(/Z$/, '') : value;
const norm = (v: string): string => v.normalize('NFKC').trim();
const idOf = (value: unknown): string | null => typeof value === 'string' && value !== '' ? value.replace(/^doc:/, '') : null;

/** Read exactly the full JSON carried by get_nodes' structured content, never the displayed page. */
export function capturedResult(capture: Capture): unknown | null {
  if (capture.request.tool !== 'get_nodes' || capture.response.isError || !object(capture.response.structured)) return null;
  const answer = capture.response.structured;
  if (answer.call_result !== 'ok' || !object(answer.content) || typeof answer.content.text !== 'string') return null;
  try { return JSON.parse(answer.content.text); } catch { return null; }
}

/** The location and candidate claims of each item, including rejected, incomplete and unknown partitions. */
export function resultItems(raw: unknown): ResultItem[] {
  if (!object(raw)) return [];
  const body = object(raw.body) ? raw.body : raw;
  if (!object(body.partitions)) return [];
  const out: ResultItem[] = [];
  for (const partition of Object.values(body.partitions)) for (const value of list(partition)) {
    if (!object(value)) continue;
    const document = idOf(value.item ?? value.id);
    if (!document) continue;
    const locationData: Record<string, unknown>[] = [], candidateData: unknown[][] = [];
    for (const requirement of list(value.requirements)) {
      if (!object(requirement)) continue;
      for (const claim of list(requirement.claims)) {
        if (!object(claim) || !object(claim.statement) || !object(claim.statement.data)) continue;
        const data = claim.statement.data;
        if (requirement.requirement === 'location' && (data.case_id === undefined || String(data.case_id) === document)) locationData.push(data);
        if (requirement.requirement === 'build_candidates' && Array.isArray(data.candidates)) candidateData.push(data.candidates);
      }
    }
    const distinctLocations = [...new Map(locationData.map(d => [JSON.stringify(d), d])).values()];
    const distinctCandidates = [...new Map(candidateData.map(d => [JSON.stringify(d), d])).values()];
    out.push({ document, location: distinctLocations.length === 1 ? distinctLocations[0] : null, candidates: distinctCandidates.length === 1 ? distinctCandidates[0] : null });
  }
  return out;
}

/** Every raw call and response is retained; the filename order is also the digest order. */
export function readCaptures(out: string): { captures: Capture[]; sha256: string; files: string[] } {
  const directory = privatePath(join(out, 'runs'));
  const files = readdirSync(directory).filter(name => name.endsWith('.json')).sort();
  const digest = createHash('sha256');
  const captures = files.map(name => {
    const bytes = readFileSync(privatePath(join(directory, name))); digest.update(bytes);
    const raw: unknown = JSON.parse(bytes.toString('utf8'));
    if (!object(raw) || !object(raw.request) || typeof raw.request.tool !== 'string' || !object(raw.response) || typeof raw.response.text !== 'string' || typeof raw.response.isError !== 'boolean') throw new Error('保存的调用缺少请求或原始应答');
    return raw as unknown as Capture;
  });
  return { captures, sha256: digest.digest('hex'), files };
}

function requestedDocuments(capture: Capture): string[] {
  const args = capture.request.args;
  if (!object(args) || !object(args.inputs)) return [];
  return list(args.inputs.documents).flatMap(input => object(input) && typeof input.external === 'string' && input.external.startsWith('agile:mindmap:') ? [input.external.slice('agile:mindmap:'.length)] : []);
}
export function transportFailure(capture: Capture): boolean {
  if (capture.transport_error) return true;
  const value = capture.response.structured;
  return capture.response.isError && !(object(value) && value.call_result === 'error' && list(value.errors).some(error => object(error) && typeof error.code === 'string'));
}
export function uncertainStarts(captures: Capture[]): Map<string, { args: unknown; session: string | null }> {
  const pending = new Map<string, { args: unknown; session: string | null }>();
  for (const capture of captures) {
    if (capture.request.tool !== 'start_run') continue;
    const docs = requestedDocuments(capture), value = capture.response.structured;
    if (transportFailure(capture)) for (const doc of docs) pending.set(doc, { args: capture.request.args, session: capture.session ?? null });
    else if (!capture.response.isError && object(value) && value.call_result === 'ok') for (const doc of docs) pending.delete(doc);
  }
  return pending;
}

export interface UnreadResult {reference:string|null;run:string|null;session:string|null;args:unknown}

/** An accepted run reference without a complete readable capture is an unobserved result, not an empty result. */
export function unreadResults(captures: Capture[]): Map<string,UnreadResult> {
  const readable = new Set<string>();
  for(const capture of captures) if(!transportFailure(capture) && capturedResult(capture)!==null && object(capture.request.args) && typeof capture.request.args.reference==='string') readable.add(capture.request.args.reference);
  const pending = new Map<string,UnreadResult>();
  for(const capture of captures) {
    if(capture.request.tool!=='start_run' || transportFailure(capture) || capture.response.isError)continue;
    const answer=capture.response.structured;
    if(!object(answer) || answer.call_result!=='ok')continue;
    const reference=object(answer.result) && typeof answer.result.reference==='string' ? answer.result.reference : null;
    const run=object(answer.run) && typeof answer.run.run==='string' ? answer.run.run : null;
    for(const document of requestedDocuments(capture)) {if(reference!==null && readable.has(reference))pending.delete(document);else pending.set(document,{reference,run,session:capture.session ?? null,args:capture.request.args});}
  }
  return pending;
}
export const collectionRecoveryAction = ():string => '保持同一原树导出、原会话和 --batch，在幂等窗口内（默认 24 小时）运行 node scripts/real/accept/location-tree.ts --collect --tree <同一原树文件> --batch <原批量> --token-file <原令牌文件> --out <仓库外新目录>，保留原 --builds、--facets、--production 和 --url 参数。每批派生保存的同一 client_key，Hub 返回同一运行并重读结果；之后从新 --out 比较或用同一种子抽样。若原 key 缺失或窗口已过，先由集成者查已有运行，不能直接新建 key 重跑';

export function unreadResultRecovery(pending:UnreadResult):NonNullable<Pending['recovery']> {
  return pending.reference === null ? {tool:'start_run',args:pending.args,session:pending.session,run:pending.run} : {tool:'get_nodes',args:{reference:pending.reference},session:pending.session,start_args:pending.args,run:pending.run};
}
export function unreadResultAction(pending:UnreadResult):string {
  if(pending.reference !== null) return collectionRecoveryAction();
  const key=object(pending.args) && typeof pending.args.client_key==='string' ? pending.args.client_key : '未提供（请集成者从原调用补取）';
  return '运行已受理但没有结果引用；请集成者按运行 '+(pending.run ?? '未提供（请从原受理应答补取）')+'、client_key '+key+' 和保存的请求参数核对 Hub 侧运行及结果记录，修复持久化缺口。同键在幂等窗口内只返回已有运行，不会补生成结果；不要按结果缺条目处理，也不要直接新建 key 重跑。窗口过后仍须先由集成者核对已有运行，再决定是否开新运行，读取完整结果到仓库外新 --out 后重新比较或抽样';
}

export function refusedDocuments(captures: Capture[], includeBatch = false): Map<string, string> {
  const refused = new Map<string, string>();
  for (const capture of captures) {
    if (capture.request.tool !== 'start_run') continue;
    const docs = requestedDocuments(capture), answer = capture.response.structured;
    if (!capture.response.isError && object(answer) && answer.call_result === 'ok') { docs.forEach(doc => refused.delete(doc)); continue; }
    if (transportFailure(capture)) continue;
    const errors = object(answer) ? list(answer.errors) : [];
    const indexed = errors.map(error => object(error) && typeof error.path === 'string' ? /^\/inputs\/documents\/(\d+)(?:\/.*)?$/.exec(error.path) : null);
    const precise = errors.length > 0 && indexed.every(match => match && Number(match[1]) < docs.length);
    const positions = precise && !includeBatch ? [...new Set(indexed.map(match => Number(match![1])))] : docs.map((_, i) => i);
    for (const index of positions) {
      const direct = !precise || indexed.some(match => Number(match![1]) === index);
      const codes = errors.filter((_, i) => !precise || !direct || Number(indexed[i]![1]) === index).map(e => object(e) && typeof e.code === 'string' ? e.code : '错误码未提供').join('、') || '错误码未提供';
      refused.set(docs[index], (direct ? '' : '同批开始被拒，未取得运行结果；同批错误：') + codes);
    }
  }
  return refused;
}

export async function collectRuns(documents: string[], out: string, options: CallOptions, batch = 40, call: typeof callTools = callTools, treeSha256: string): Promise<void> {
  mkdirSync(privatePath(out), { recursive: true, mode: 0o700 });
  const directory = privatePath(join(out, 'runs'));
  mkdirSync(directory, { mode: 0o700 }); // Exclusive reservation: a second collect cannot overwrite a prior capture.
  let sequence = 0;
  const invoke = async (tool: string, args: unknown): Promise<Capture> => {
    let response: ToolText;
    let transportError = false;
    try { response = (await call(options, [{ tool, args }]))[0] ?? { isError: true, text: '', structured: { call_result: 'error', errors: [] } }; }
    catch { transportError = true; response = { isError: true, text: '', structured: { call_result: 'error', errors: [] } }; }
    const capture = { session: options.session, request: { tool, args }, response, ...(transportError ? { transport_error: true } : {}) };
    writePrivateJson(join(directory, `${String(++sequence).padStart(6, '0')}.${tool}.json`), capture);
    return capture;
  };
  const run = async (docs: string[], retry: boolean): Promise<void> => {
    if (!docs.length) return;
    const capture = await invoke('start_run', { client_key: 'location-tree-' + hash(JSON.stringify({ tree_sha256: treeSha256, pack: 'case-location', product: 'famx', documents: docs })).slice(0, 48), pack: 'case-location', product: 'famx', inputs: { documents: docs.map(document => ({ external: `agile:mindmap:${document}` })) } });
    const answer = capture.response.structured;
    if (transportFailure(capture)) return;
    if (!capture.response.isError && object(answer) && answer.call_result === 'ok') {
      const reference = object(answer.result) ? answer.result.reference : null;
      if (typeof reference === 'string') await invoke('get_nodes', { reference });
      return;
    }
    if (!retry) return;
    const refused = refusedDocuments([capture]);
    const rest = docs.filter(document => !refused.has(document));
    if (rest.length && rest.length < docs.length) await run(rest, false);
  };
  for (let at = 0; at < documents.length; at += batch) await run(documents.slice(at, at + batch), true);
}

function productionReasons(records: unknown[]): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const visit = (value: unknown, inherited: string | null, depth: number): void => {
    if (depth > 80) return;
    if (Array.isArray(value)) { value.forEach(v => visit(v, inherited, depth + 1)); return; }
    if (!object(value)) return;
    const origin = object(value.origin) && object(value.origin.read) ? value.origin.read.object : null;
    const external = typeof value.external === 'string' ? value.external : origin;
    const document = typeof external === 'string' && external.startsWith('agile:mindmap:') ? external.slice('agile:mindmap:'.length).split('@')[0] : typeof value.document === 'string' ? value.document : inherited;
    const reason = typeof value.reason === 'string' ? value.reason : '';
    if (document) {
      const code = value.read_tier === 'retain_only' || /retain_only|SOURCE_CREDENTIAL|含凭据|只保留/.test(reason) ? 'retain_only' : /没有用例节点|无用例节点/.test(reason) ? 'no_cases' : /不是.*脑图|非脑图/.test(reason) ? 'not_mindmap' : null;
      if (code) { const set = found.get(document) ?? new Set<string>(); set.add(code); found.set(document, set); }
    }
    Object.values(value).forEach(v => visit(v, document, depth + 1));
  };
  records.forEach(record => visit(record, null, 0));
  return found;
}

/** Read-only SQL for the integrator; values are quoted and the query is always bounded. */
function productionQuery(reference: string | null, root: string | null): string {
  const quote = (text: string) => "'" + text.replaceAll("'", "''") + "'";
  const condition = reference ? 'digest=' + quote(reference.slice(4)) : root ? "body::jsonb#>>'{detail,root}'=" + quote(root) : "digest='<本份文档对应的生产记录摘要>'";
  return "BEGIN READ ONLY; SELECT COALESCE(jsonb_agg(jsonb_build_object('digest',digest,'kind',kind,'schema',schema,'created_at',created_at,'body',body::jsonb) ORDER BY seq),'[]'::jsonb) FROM records WHERE kind='action' AND body::jsonb->>'action'='generate' AND " + condition + '; ROLLBACK;';
}

/** Bind a missing document to its actual production record; never invent a record from a batch total. */
function productionReference(records: unknown[], document: string): string | null {
  const references = new Set<string>();
  const visit = (value: unknown, reference: string | null, depth = 0): void => {
    if (depth > 80) return;
    if (Array.isArray(value)) { value.forEach(v => visit(v, reference, depth + 1)); return; }
    if (!object(value)) return;
    if (typeof value.digest === 'string' && /^[0-9a-f]{64}$/.test(value.digest)) reference = `rec:${value.digest}`;
    if (typeof value.reference === 'string' && /^rec:[0-9a-f]{64}$/.test(value.reference)) reference = value.reference;
    if (reference && (value.external === `agile:mindmap:${document}` || value.document === document)) references.add(reference);
    Object.values(value).forEach(v => visit(v, reference, depth + 1));
  };
  records.forEach(record => visit(record, null));
  return references.size === 1 ? [...references][0] : null;
}

/** Structural paths come from the original tree, never from the checked location output. */
function originalPaths(tree: unknown): Map<string, string[]> {
  const listed = new Map<string, string[]>(), leaves = new Map<string, string[]>();
  const label = (value: Record<string, unknown>): string => String(value.label ?? value.title ?? value.name ?? value.text ?? '');
  const root = object(tree) && object(tree.root) ? tree.root : object(tree) && Array.isArray(tree.children) ? tree : null;
  const rootLabel = root && typeof (root.label ?? root.title) === 'string' ? String(root.label ?? root.title) : '';
  const above = rootLabel ? [rootLabel] : [];
  if (root) for (const id of [...list(root.cases), ...(object(tree) ? list(tree.cases) : [])]) listed.set(String(id), above);
  const initial = Array.isArray(tree) ? tree : object(tree) && Array.isArray(tree.children) ? tree.children : [];
  const stack = initial.slice().reverse().map(value => ({ value, above }));
  while (stack.length) {
    const next = stack.pop()!; if (!object(next.value)) continue;
    const node = next.value, children = list(node.children), cases = list(node.cases);
    const path = label(node) ? [...next.above, label(node)] : next.above;
    if (!children.length && !cases.length && node.id !== undefined && !leaves.has(String(node.id))) leaves.set(String(node.id), next.above);
    for (const id of cases) if (!listed.has(String(id)) || listed.get(String(id))!.length < path.length) listed.set(String(id), path);
    for (const value of children.slice().reverse()) stack.push({ value, above: path });
  }
  return new Map([...listed, ...leaves]);
}

function mismatchReason(field: string, expected: string | null, actual: string | null, data: Record<string, unknown>, path: readonly string[]): string {
  if (expected !== null && actual !== null && norm(stripPrefix(actual).text) === norm(expected)) return '前缀代码';
  if (field === 'line' && expected !== null && actual !== null && path.some(p => lineKey(stripPrefix(p).text) === lineKey(actual))) return '版本线节点取法';
  return '其他';
}

function validBuildGold(value: unknown): value is BuildsGold {
  if (!object(value) || typeof value.line !== 'string' || !/^v?[0-9]+(?:\.[0-9]+)+$/i.test(value.line) || !Array.isArray(value.candidates)) return false;
  return value.candidates.every(c => object(c) && ['name', 'family', 'base'].every(k => typeof c[k] === 'string' && c[k] !== '') && (c.built === null || typeof c.built === 'string') && (c.released === null || typeof c.released === 'string')) && new Set(value.candidates.map(c => (c as BuildCandidate).name)).size === value.candidates.length;
}

export function compareLocationTree(tree: unknown, captures: Capture[], buildGold: BuildsGold[] = [], facets?: unknown, productions: unknown[] = []) {
  const gold = locationsGold(tree).all ?? [], paths = originalPaths(tree);
  const summary = {
    documents: gold.length, equal: 0, not_equal: 0, fields: { line: 0, train: 0, module: 0 },
    reasons: { version_nodes: 0, prefix_codes: 0, other: 0 },
    missing: { start_refused: 0, start_uncertain: 0, result_unread: 0, no_item: 0, no_location_data: 0 }, only_result: 0,
    candidates: { equal: 0, not_equal: 0, not_run: 0 },
    facets: undefined as undefined | { only_tree: number; only_view: number; truncated: boolean | null; skipped: number | null; reasons: { no_cases: number; not_mindmap: number; retain_only: number; unknown: number } },
  };
  const details = { mismatches: [] as Difference[], missing: [] as Missing[], not_run: [] as Pending[], only_result: [] as string[], facet_missing: [] as Array<{ document: string; reason: string; fact: string; production_reference: string | null; next_action: string; next_command: string }>, facet_only_view: [] as string[], candidates: [] as Difference[], scope: '发布日期不是包的数据字段，不在核对范围' };
  const byDocument = new Map<string, ResultItem[]>();
  const resultReferences = new Map<string, string>();
  const seenResults = new Set<string>();
  for (const capture of captures) {
    const result = capturedResult(capture);
    if (result === null) continue;
    const digest = hash(JSON.stringify(result)); if (seenResults.has(digest)) continue; seenResults.add(digest);
    for (const item of resultItems(result)) {
      byDocument.set(item.document, [...(byDocument.get(item.document) ?? []), item]);
      if (object(capture.request.args) && typeof capture.request.args.reference === 'string') resultReferences.set(item.document, capture.request.args.reference);
    }
  }
  const refused = refusedDocuments(captures, true), uncertain = uncertainStarts(captures), unread = unreadResults(captures);
  const builds = new Map<string, BuildCandidate[]>();
  for (const value of buildGold) {
    if (!validBuildGold(value)) throw new Error('构建独立答案输入形状无效；下一步：用 builds.ts 重新导出');
    const key = lineKey(value.line);
    if (builds.has(key)) throw new Error('同一版本线有多份构建独立答案；下一步：合并列表页后重导出一份');
    builds.set(key, [...value.candidates].sort((a, b) => (a.built === null) !== (b.built === null) ? a.built === null ? 1 : -1 : (b.built ?? '').localeCompare(a.built ?? '') || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
  }
  for (const expected of gold) {
    const rows = byDocument.get(expected.document) ?? [];
    const actual = rows.length === 1 ? rows[0] : null;
    const category = rows.length === 0 ? (uncertain.has(expected.document) ? 'start_uncertain' : unread.has(expected.document) ? 'result_unread' : refused.has(expected.document) ? 'start_refused' : 'no_item') : actual?.location && ['line', 'train', 'module'].every(k => actual.location![k] === null || typeof actual.location![k] === 'string') ? null : 'no_location_data';
    if (category) {
      summary.missing[category]++;
      if (category === 'result_unread') {
        const pending=unread.get(expected.document)!;const next_action=unreadResultAction(pending);
        summary.candidates.not_run++;
        details.missing.push({document:expected.document,reason:'结果未读到',next_action});
        details.not_run.push({document:expected.document,fact:pending.reference===null?'运行已受理但没有结果引用':'已受理运行的完整定位与候选结果',next_action,recovery:unreadResultRecovery(pending)});
        continue;
      }
      if (category === 'start_uncertain') {
        const recovery = uncertain.get(expected.document)!;
        const next_action = collectionRecoveryAction();
        details.missing.push({ document: expected.document, reason: '调用超时或连接中断，运行是否已开始待取回', next_action });
        details.not_run.push({ document: expected.document, fact: '原 start_run 是否已经持久化及其完整结果', next_action, recovery: { tool: 'start_run', args: recovery.args, session: recovery.session } });
        continue;
      }
      details.missing.push({ document: expected.document, reason: category === 'start_refused' ? refused.get(expected.document)! : category === 'no_item' ? '结果里没有条目' : '定位数据缺少或有多份冲突', next_action: category === 'start_refused' ? '按错误码检查该文档可读性后单独重跑' : '重读该结果的完整 JSON；仍缺则单独重跑该文档' });
      continue;
    }
    let unequal = false;
    for (const field of ['line', 'train', 'module'] as const) {
      const a = actual!.location![field] as string | null, g = expected[field];
      const equal = a === null || g === null ? a === g : field === 'line' ? lineKey(a) === lineKey(g) : norm(a) === norm(g);
      if (!equal) {
        unequal = true; summary.fields[field]++;
        const reason = mismatchReason(field, g, a, actual!.location!, paths.get(expected.document) ?? []);
        summary.reasons[reason === '前缀代码' ? 'prefix_codes' : reason === '版本线节点取法' ? 'version_nodes' : 'other']++;
        details.mismatches.push({ document: expected.document, field, gold: g, actual: a, reason });
      }
    }
    if (unequal) summary.not_equal++; else summary.equal++;
    const candidates = expected.line === null ? [] : builds.get(lineKey(expected.line));
    const resultReference = resultReferences.get(expected.document) ?? '<本份结果引用>';
    const readAction = '重读 get_nodes ' + JSON.stringify({ reference: resultReference }) + ' 的完整候选数据；仍缺则同步构建列表后单独重跑本份文档';
    if (candidates === undefined) {
      summary.candidates.not_run++;
      details.not_run.push({ document: expected.document, fact: candidates === undefined ? expected.line === null ? '本份文档没有可用于候选比较的目录版本线' : '文档 ' + expected.document + ' 所在版本线 ' + expected.line + ' 的 --builds 独立答案输入' : '本份文档的完整 build_candidates 候选数据', next_action: candidates === undefined ? expected.line === null ? '询问集成者核实本份原树的版本线节点；确认约定后重导出原树，不能补造版本线' : '导出这条版本线两个名称族列表页，执行 next_command，补 --builds 文件后用新输出目录重跑比较' : readAction, ...(candidates === undefined && expected.line !== null ? { next_command: "node scripts/real/gold/builds.ts --page '<仓库外FAMX列表页>' --page '<仓库外FAMY列表页>' --line '" + expected.line + "' --out '<仓库外新金标准文件>'" } : {}) });
      continue;
    }
    if (actual!.candidates === null) { summary.candidates.not_equal++; details.candidates.push({ document: expected.document, field: 'candidates', gold: '完整候选数组', actual: null, reason: '结果缺候选数据或有多份冲突', next_action: readAction }); continue; }
    const actualCandidates = actual!.candidates!;
    const ordered = candidates;
    const before = details.candidates.length;
    if (actualCandidates.length !== ordered.length) details.candidates.push({ document: expected.document, field: 'count', gold: ordered.length, actual: actualCandidates.length, reason: expected.line === null && actualCandidates.length > 0 ? '目录没有版本线却给出候选' : '候选数不等' });
    ordered.forEach((g, index) => {
      const value = actualCandidates[index];
      if (!object(value)) { details.candidates.push({ document: expected.document, field: 'candidates/' + index, gold: g, actual: null, reason: '结果缺候选条目', next_action: readAction }); return; }
      const expectedFields = { name: g.name, family: g.family, base: g.base, alias: g.name !== g.base, built_at: g.built, released: g.released !== null };
      for (const [field, fact] of Object.entries(expectedFields)) {
        if (!Object.hasOwn(value, field)) { details.candidates.push({ document: expected.document, field: 'candidates/' + index + '/' + field, gold: fact, actual: null, reason: '结果缺候选字段', next_action: readAction }); continue; }
        if ((field === 'built_at' ? builtSecond(value[field]) !== builtSecond(fact) : value[field] !== fact)) details.candidates.push({ document: expected.document, field: `candidates/${index}/${field}`, gold: fact, actual: value[field], reason: '字段不等' });
      }
    });
    if (details.candidates.length > before) summary.candidates.not_equal++;
    else summary.candidates.equal++;
  }
  const goldIds = new Set(gold.map(d => d.document));
  details.only_result = [...byDocument.keys()].filter(id => !goldIds.has(id)).sort(); summary.only_result = details.only_result.length;
  if (facets !== undefined) {
    const view = parseFacetView(facets);
    const facetRoot = object(facets) && object(facets.build) && typeof facets.build.root === 'string' ? facets.build.root : null;
    const scopedProductions = productions.filter(value => {
      if (facetRoot === null) return true;
      const outer = object(value) && object(value.record) ? value.record : value;
      const body = object(outer) && object(outer.body) ? outer.body : outer;
      return object(body) && object(body.detail) && body.detail.root === facetRoot;
    });
    const reasons = productionReasons(scopedProductions);
    const counts = { no_cases: 0, not_mindmap: 0, retain_only: 0, unknown: 0 };
    for (const doc of gold.filter(d => !view.has(d.document))) {
      const found = [...(reasons.get(doc.document) ?? [])];
      const category = found.length === 1 ? found[0] as keyof typeof counts : 'unknown'; counts[category]++;
      const reference = productionReference(scopedProductions, doc.document);
      details.facet_missing.push({ document: doc.document, reason: category, fact: '文档 ' + doc.document + ' 在分面根 ' + (facetRoot ?? '（输入未提供根摘要）') + ' 对应的逐份生产记录（或跳过记录）', production_reference: reference, next_action: category === 'unknown' ? reference ? '请集成者按 next_command 从数据库只读导出这条生产记录的完整 JSON；若只有批次汇总数，询问集成者补取本份文档的逐份原因，再用 --production 重跑比较' : '先询问集成者取得本份文档在此分面根所属的生产记录引用，再由集成者执行 next_command 里的只读 SQL；若只有汇总数，请集成者补取逐份原因' : '', next_command: category === 'unknown' ? productionQuery(reference, facetRoot) : '' });
    }
    for (const row of details.facet_missing) if (row.reason === 'unknown') details.not_run.push({ document: row.document, fact: row.fact, next_action: row.next_action, next_command: row.next_command });
    for (const field of ['truncated', 'skipped']) if (!object(facets) || (field === 'truncated' ? typeof facets[field] !== 'boolean' : typeof facets[field] !== 'number')) details.not_run.push({ document: '（分面视图输入）', fact: 'facets.' + field + ' 字段', next_action: '由集成者重新导出完整分面视图，保留该字段，再用 --facets 重跑' });
    details.facet_only_view = [...view.keys()].filter(id => !goldIds.has(id)).sort();
    summary.facets = { only_tree: details.facet_missing.length, only_view: details.facet_only_view.length, truncated: object(facets) && typeof facets.truncated === 'boolean' ? facets.truncated : null, skipped: object(facets) && typeof facets.skipped === 'number' ? facets.skipped : null, reasons: counts };
  }
  return { summary, details };
}

/** The screen contains counts and digests; every value and actionable missing fact is in the private details. */
export async function main(argv: string[], deps: { call?: typeof callTools; print?: (line: string) => void } = {}): Promise<number> {
  const print = deps.print ?? (line => process.stdout.write(line + '\n'));
  if (argv.length === 1 && argv[0] === '--help') { print(USAGE); return 0; }
  const values = new Map<string, string[]>(); let collect = false;
  let stage = '参数及 --tree/--out 输入', next = '补齐树原件、仓库外输出目录和有效参数后重跑';
  try {
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i]; if (flag === '--collect') { collect = true; continue; }
      if (!['--tree', '--out', '--facets', '--builds', '--production', '--token-file', '--url', '--batch', '--timeout-ms'].includes(flag) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('参数无效');
      values.set(flag, [...(values.get(flag) ?? []), argv[++i]]);
    }
    const one = (key: string): string | undefined => { const all = values.get(key) ?? []; if (all.length > 1) throw new Error('参数重复'); return all[0]; };
    const treeFile = one('--tree'), outArg = one('--out');
    if (!treeFile || !outArg) throw new Error('缺输入');
    stage = '--tree 树原件输入'; next = '由集成者导出用例树原件到仓库外，再补 --tree 重跑';
    const out = privatePath(outArg), treeBytes = readFileSync(privatePath(treeFile)), tree: unknown = JSON.parse(treeBytes.toString('utf8'));
    const goldDocuments = locationsGold(tree).all ?? [];
    if (!goldDocuments.length) { print('没跑：--tree 树原件里没有文档；下一步：由集成者重新导出敏捷平台用例树原件后重跑'); return 2; }
    const inputDigests = { builds: [] as string[], production: [] as string[], facets: null as string | null };
    const builds = (values.get('--builds') ?? []).map((file, index) => {
      stage = '第 ' + (index + 1) + ' 份 --builds 构建独立答案输入'; next = '导出两个名称族列表页，运行 builds.ts 生成带 line 的独立答案，再补 --builds 重跑';
      const bytes = readFileSync(privatePath(file)); inputDigests.builds.push(hash(bytes));
      const gold: unknown = JSON.parse(bytes.toString('utf8'));
      if (!validBuildGold(gold)) throw new Error('构建输入缺版本线和候选');
      return gold as unknown as BuildsGold;
    });
    if (new Set(builds.map(g => lineKey(g.line))).size !== builds.length) { stage = '--builds 的版本线输入'; next = '每条版本线只保留一份合并所有列表页的独立答案，再重跑'; throw new Error('版本线重复'); }
    const productions = (values.get('--production') ?? []).flatMap((file, index) => {
      stage = '第 ' + (index + 1) + ' 份 --production 生产记录输入'; next = '由集成者按 --help 或先前明细里的只读 SQL 导出这份完整生产记录，body 用 JSON 对象，再补 --production 重跑';
      const bytes = readFileSync(privatePath(file)); inputDigests.production.push(hash(bytes));
      const raw: unknown = JSON.parse(bytes.toString('utf8'));
      const records = Array.isArray(raw) ? raw : [raw];
      if (!records.every(value => object(value) && typeof value.digest === 'string' && /^[0-9a-f]{64}$/.test(value.digest) && value.kind === 'action' && typeof value.schema === 'string' && object(value.body) && value.body.action === 'generate' && object(value.body.detail))) throw new Error('生产记录输入形状无效');
      return records;
    });
    stage = '--facets 分面视图输入（若声明）'; next = '由集成者重读完整分面视图到仓库外，再补 --facets 重跑';
    const facetsFile = one('--facets'), facetBytes = facetsFile ? readFileSync(privatePath(facetsFile)) : null;
    const facets: unknown = facetBytes ? JSON.parse(facetBytes.toString('utf8')) : undefined;
    inputDigests.facets = facetBytes ? hash(facetBytes) : null;
    if (collect) {
      stage = '--token-file 令牌文件输入'; next = '由集成者提供仓库外令牌文件后重跑，不重试认证';
      const tokenFile = one('--token-file'); if (!tokenFile) throw new Error('缺令牌输入');
      const token = readFileSync(privatePath(tokenFile), 'utf8').trim(); if (!token) throw new Error('缺令牌输入');
      const batch = Number(one('--batch') ?? 40), timeoutMs = one('--timeout-ms') === undefined ? undefined : Number(one('--timeout-ms'));
      if (!Number.isSafeInteger(batch) || batch < 1 || batch > 1000 || (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1))) throw new Error('参数无效');
      const ids = goldDocuments.map(d => d.document);
      stage = '--out/runs 新采集目录'; next = '使用全新的仓库外输出目录重跑采集，保留既有 runs 不覆盖';
      await collectRuns(ids, out, { url: one('--url') ?? 'http://127.0.0.1:7420/mcp', token, session: 'location-tree', ...(timeoutMs === undefined ? {} : { timeoutMs }) }, batch, deps.call, hash(treeBytes));
    }
    stage = '--out/runs 保存的调用输入'; next = '先由集成者运行 --collect 取得完整应答；回放时复制 runs 到新输出目录';
    const saved = readCaptures(out), report = compareLocationTree(tree, saved.captures, builds, facets, productions);
    const details = { ...report, input_sha256: inputDigests, tree_sha256: hash(treeBytes), results_sha256: saved.sha256 };
    stage = '--out/details.json 输出（不可覆盖）'; next = '复制 runs 到新的仓库外输出目录后补齐输入重跑比较，保留旧明细';
    const target = join(out, 'details.json'), content = JSON.stringify(details, null, 2) + '\n';
    if (existsSync(target)) { if (readFileSync(privatePath(target), 'utf8') !== content) throw new Error('输出已存在'); }
    else writePrivateJson(target, details);
    const s = report.summary, definiteMissing = s.missing.start_refused + s.missing.no_item + s.missing.no_location_data, missing = definiteMissing + s.missing.start_uncertain + s.missing.result_unread;
    print(`树里的文档 ${s.documents} 份；相等 ${s.equal}，不等 ${s.not_equal}（版本线 ${s.fields.line}、火车 ${s.fields.train}、模块 ${s.fields.module}）；缺 ${missing}（开始被拒 ${s.missing.start_refused}、开始状态待取回 ${s.missing.start_uncertain}、结果未读到 ${s.missing.result_unread}、没有条目 ${s.missing.no_item}、没有定位数据 ${s.missing.no_location_data}）；只在结果里 ${s.only_result}`);
    print(`不等原因：版本线节点取法 ${s.reasons.version_nodes}、前缀代码 ${s.reasons.prefix_codes}、其他 ${s.reasons.other}`);
    print(`候选：相等 ${s.candidates.equal}，不等 ${s.candidates.not_equal}，没跑 ${s.candidates.not_run}；发布日期不是包的数据字段，不在核对范围`);
    if (s.facets) print(`视图：树有视图无 ${s.facets.only_tree}，视图有树无 ${s.facets.only_view}；truncated=${s.facets.truncated === null ? '没跑' : s.facets.truncated}，skipped=${s.facets.skipped ?? '没跑'}；原因：没有用例节点 ${s.facets.reasons.no_cases}、不是脑图 ${s.facets.reasons.not_mindmap}、凭据只保留 ${s.facets.reasons.retain_only}、原因不明 ${s.facets.reasons.unknown}`);
    print(`树原件 sha256 ${details.tree_sha256}`); print(`结果文件 sha256 ${saved.sha256}`);
    const fail = s.not_equal + definiteMissing + s.only_result + s.candidates.not_equal;
    const notRun = report.details.not_run.length;
    print(`没跑的比较项 ${notRun} 项`);
    print(`判定：${fail > 0 ? '不通过' : notRun > 0 ? '没跑完' : '通过'}`);
    if (notRun || s.facets?.reasons.unknown) print('下一步：按仓库外明细补齐指定输入或重读、重跑；缺逐份原因时向生产记录负责人补取，再运行比较');
    return fail > 0 ? 1 : notRun > 0 ? 2 : 0;
  } catch {
    print('没跑：' + stage + ' 不可用；下一步：' + next);
    return 2;
  }
}
if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
