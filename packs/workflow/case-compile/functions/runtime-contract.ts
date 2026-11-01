// Original runner contract, not an adapter into a new contract format. Identity covers all original members.
import { createHash } from 'node:crypto';
import FORMAT from '../tables/runtime-contract-format.json' with { type: 'json' };
import {readAuthority,type Authority} from './typed-contract.ts';
import { isRecord } from './text.ts';
export interface Problem { capacityExceeded?:boolean; pointer: string; message: string; fix: string }
export interface RuntimeParameter { name: string; kind: string; required: boolean; redacted: boolean }
/** The legacy reader verifies signatures only; unknown/raw metadata never becomes typed authority. */
export interface RuntimeEntry { object: string; method: string; dispatch: string; parameters: RuntimeParameter[]; sourcePointer?: string; authority?: Authority | null }
/**
 * The gateway-facing identity of the contract: the pinned original identity (the gateway only accepts
 * PINNED_CONTRACT_SHA256, which equals the original contract's canonical identity). For a runtime-contract@2 document
 * that is `original.contract_sha256`; for an original-format document it is the document's own identity. `bytes` is the
 * byte digest of the original file, as recorded by the @2 declaration (null when the document is the original itself).
 */
export interface PinnedIdentity { identity: string; bytes: string | null }
/**
 * The runner's own cleanup (a runtime-contract@2 addition, decision 112): at every case boundary and at the end of a workbook
 * the runner clears the listed objects, deriving its clear commands from every command line it sent, tested against these
 * prefix rules in source order (first hit wins). Only the prefixes are declared, never the clear commands: many are
 * module-wide and are not a teardown a case may copy. `pinned` says whether the original contract's source_hashes record
 * the same digest for the source; when it does not, the digest is the Hub-side declaration only.
 */
export interface RunnerCleanup { source: string; sha256: string; objects: string[]; rules: Array<{ prefixes: string[]; line: number | null }>; pinned: boolean }
/**
 * Device commands the runner is never asked to send (a runtime-contract@2 addition, decision 114). CES and the InfoTest
 * structural gate ban, unconditionally, the commands that take a shared environment's device down or wipe it with its
 * management access (InfoTest domain_grammar.json destructive_commands; the source and its digest are declared here). The
 * same set is written on the locked command tree, never on wording: exact paths, paths with everything under them, and path
 * segments anywhere (the lifecycle verbs). With it, a device CLI effect that names no command scope authorises every command
 * the locked tree resolves, except these.
 */
export interface DestructiveCommands { source: string; sha256: string; exact: string[]; prefixes: string[]; segments: string[] }
export interface RuntimeContract { runtimeVersion: string; digest: string; pinned: PinnedIdentity; objects: string[]; enabled: RuntimeEntry[]; cleanup?: RunnerCleanup; destructive?: DestructiveCommands }
/** Whole path segments of a /commands path, or null when it is not one. */
const segmentsOf = (path: string): string[] | null => /^\/commands(\/[^/]+)*$/.test(path) ? path.split('/').filter(Boolean) : null;
const under = (path: string, prefix: string): boolean => { const a = segmentsOf(path), b = segmentsOf(prefix); return !!a && !!b && a.length >= b.length && b.every((segment, i) => a[i] === segment); };
/**
 * Which part of the runner contract's destructive-command declaration a command path hits (decision 114), or null: an exact
 * path, a declared path and everything under it, or a declared path segment anywhere. Compared on whole path segments.
 */
export function destructiveHit(contract: RuntimeContract, path: string): string | null {
  const d = contract.destructive; if (!d) return null;
  if (d.exact.includes(path)) return `命令 ${path}`;
  const prefix = d.prefixes.find((p) => under(path, p)); if (prefix) return `${prefix} 及其下的命令`;
  const segments = segmentsOf(path) ?? []; const segment = d.segments.find((s) => segments.includes(s)); return segment ? `路径段 ${segment}` : null;
}
/**
 * Whether one effect authorises a device command path (decision 114): a declared command scope narrows as before; a device CLI
 * effect with no scope authorises the whole locked tree when the contract declares its destructive commands. A destructive
 * command is never authorised, whatever the scope.
 */
export function scopeAllows(contract: RuntimeContract, effect: { roles: string[]; command_scope?: string[]; commands?: unknown[] }, path: string): boolean {
  if (destructiveHit(contract, path) !== null) return false;
  if (effect.command_scope !== undefined) return effect.command_scope.some((prefix) => under(path, prefix));
  if (effect.commands !== undefined) return true;
  return contract.destructive !== undefined && effect.roles.includes('device_cli');
}
const sourceDocuments = new WeakMap<RuntimeContract, Record<string, unknown>>();
export function sourceDocument(contract: RuntimeContract): Record<string, unknown> | null { return sourceDocuments.get(contract) ?? null; }
export type ParsedRuntimeContract = { ok: true; contract: RuntimeContract } | { ok: false; problems: Problem[] };
const SHA = /^[a-f0-9]{64}$/;
const pointer = (value: string): string => value.replaceAll('~', '~0').replaceAll('/', '~1');
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** Python-compatible sorted compact JSON, with UTF-8 text preserved. Unsafe numbers cannot prove original identity. */
export function contractCanonical(value: unknown): string {
  if (typeof value === 'string' && /[\uD800-\uDFFF]/u.test(value)) throw new Error('合约文字含未配对的代理字符，无法按 UTF-8 重算');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('合约数字必须是可精确表示的整数');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(contractCanonical).join(',')}]`;
  if (!isRecord(value)) throw new Error('合约含有不是 JSON 的值');
  return `{${Object.keys(value).sort().map((key) => {
    if (/[\uD800-\uDFFF]/.test(key)) throw new Error('合约键含有 BMP 以外或未配对的字符');
    return `${JSON.stringify(key)}:${contractCanonical(value[key])}`;
  }).join(',')}}`;
}
export function runtimeDigest(value: Record<string, unknown>): string {
  const unsigned = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'contract_sha256'));
  return createHash('sha256').update(contractCanonical(unsigned), 'utf8').digest('hex');
}
export function runtimeMethod(contract: RuntimeContract, object: string, method: string): RuntimeEntry | null {
  return contract.enabled.find((entry) => entry.object === object && entry.method === method) ?? null;
}
/** The members a runtime-contract@2 document adds on top of the original contract (Hub-side deployment declaration). */
const ADDITIONS = ['types', 'roles', 'effects', 'promotions', 'cleanup', 'destructive'];
/**
 * Runtime members B1 reads that the pinned original contract does not have. That original (canonical identity
 * ca32544f…) has exactly minimum_version, runner_source, runner_sha256 and found_times_supported. block_model and
 * checkpoint_two_argument are the closed @2 additions; found_times_supported stays. This is not "drop every unknown
 * runtime member".
 */
export const RUNTIME_ADDITIONS = ['block_model', 'checkpoint_two_argument'] as const;
function withoutRuntimeAdditions(member: Record<string, unknown>): Record<string, unknown> {
  if (!RUNTIME_ADDITIONS.some((field) => Object.hasOwn(member, field))) return member;
  return Object.fromEntries(Object.entries(member).filter(([field]) => !RUNTIME_ADDITIONS.some((addition) => addition === field)));
}
/**
 * Removes the @2 additions (types, roles, effects, per-entry typed_authority, the runtime members in
 * RUNTIME_ADDITIONS, and the original declaration itself) and restores the original schema and its contract_sha256:
 * the recovered document must carry the original contract's canonical identity. Every runtime member outside that
 * closed set stays. Returns null when the value is not a @2 document with an original declaration.
 */
export function stripAdditions(value: Record<string, unknown>): Record<string, unknown> | null {
  if (value.schema !== 'runtime-contract@2' || !isRecord(value.original)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value)) {
    if (key === 'schema' || key === 'contract_sha256' || key === 'original' || ADDITIONS.includes(key)) continue;
    out[key] = key === 'entries' && Array.isArray(member)
      ? member.map((entry) => isRecord(entry) ? Object.fromEntries(Object.entries(entry).filter(([field]) => field !== 'typed_authority')) : entry)
      : key === 'runtime' && isRecord(member) ? withoutRuntimeAdditions(member) : member;
  }
  out.schema = FORMAT.contract_schema;
  out.contract_sha256 = value.original.contract_sha256;
  return out;
}
/** Whole-document refusal: no unknown format value can silently remove an unsafe entry from the integrity check. */
export function parseRuntimeContract(value: unknown, expected?: { runtimeVersion: string; digest: string }): ParsedRuntimeContract {
  const problems: Problem[] = [];
  const issue = (at: string, message: string) => problems.push({ pointer: at, message, fix: '按运行器原始函数合约格式改正并重算身份；管理员重新发布合约和匹配的运行环境配置' });
  if (!isRecord(value)) return { ok: false, problems: [{ pointer: '', message: '运行器合约不是对象', fix: '绑定发布的原格式运行器合约' }] };
  const inspect = (v: unknown, at: string): void => {
    if (typeof v === 'string' && /[\uD800-\uDFFF]/u.test(v)) issue(at, '文字含有未配对的代理字符，无法按 UTF-8 重算');
    if (typeof v === 'number' && !Number.isSafeInteger(v)) issue(at, '数字不是可精确表示的整数');
    if (Array.isArray(v)) v.forEach((child, i) => inspect(child, `${at}/${i}`));
    else if (isRecord(v)) for (const [key, child] of Object.entries(v)) {
      if (/[\uD800-\uDFFF]/.test(key)) issue(`${at}/${pointer(key)}`, '键含有 BMP 以外或未配对的字符');
      inspect(child, `${at}/${pointer(key)}`);
    }
  };
  inspect(value, '');
  if (value.schema !== FORMAT.contract_schema && value.schema !== 'runtime-contract@2') issue('/schema', '不是运行器原始函数合约 schema');
  if (value.complete !== true) issue('/complete', '合约没有声明完整');
  const runtime = isRecord(value.runtime) ? value.runtime : {};
  for (const field of ['minimum_version', 'runner_source']) if (!nonempty(runtime[field])) issue(`/runtime/${field}`, '缺少运行时标识或源文件名');
  if (typeof runtime.runner_sha256 !== 'string' || !SHA.test(runtime.runner_sha256)) issue('/runtime/runner_sha256', '源文件摘要写法无效');
  if (typeof runtime.found_times_supported !== 'boolean') issue('/runtime/found_times_supported', '能力标志不是布尔值');
  if (!isRecord(value.source_hashes)) issue('/source_hashes', '缺少源文件摘要表');
  else for (const [path, digest] of Object.entries(value.source_hashes)) if (!path || typeof digest !== 'string' || !SHA.test(digest)) issue(`/source_hashes/${pointer(path)}`, '源文件摘要写法无效');
  if (!isRecord(value.atlas_snapshot)) issue('/atlas_snapshot', '缺少快照元数据');
  if (!(Array.isArray(value.execute_actions) || isRecord(value.execute_actions))) issue('/execute_actions', '缺少原格式动作注册表（仅核身份完整性，角色覆盖另按包声明表核验）');
  if (!isRecord(value.certification) || value.certification.schema !== FORMAT.certification_schema || !Number.isSafeInteger(value.certification.receipt_count) || (value.certification.receipt_count as number) < 0) issue('/certification', '认证集合形状无效');
  const objects = new Map<string, string>();
  if (!Array.isArray(value.objects)) issue('/objects', '没有对象列表');
  for (const [i, object] of (Array.isArray(value.objects) ? value.objects : []).entries()) {
    const at = `/objects/${i}`;
    if (!isRecord(object)) { issue(at, '对象条目不是对象'); continue; }
    // The name lives in `e` in the real contract; `name` stays accepted. Both present and different is a refusal:
    // the reader never picks between two names.
    const name = nonempty(object.e) ? String(object.e) : nonempty(object.name) ? String(object.name) : '';
    if (nonempty(object.e) && nonempty(object.name) && object.e !== object.name) issue(`${at}/e`, '对象同时写了 e 和 name 且不相同，不改原件也不猜');
    if (!name) issue(`${at}/e`, '对象没有名称');
    else { if (objects.has(name)) issue(`${at}/e`, '对象名重复'); objects.set(name, String(object.status)); }
    if (!FORMAT.statuses.includes(String(object.status))) issue(`${at}/status`, '不认识的对象状态');
    if (object.reason !== undefined && typeof object.reason !== 'string') issue(`${at}/reason`, '禁用原因不是文字');
  }
  // A @2 promotion enables a certification candidate the original contract records as device certified (its status_authority
  // a device receipt set) once the contract publisher names it with that same authority and gives it typed authority; the
  // final release replay is the dispatch of a workbook that uses it (decision 104, as InfoTest's promoted release replay).
  const promotions = new Map<string, { index: number; status_authority: string }>();
  if (value.promotions !== undefined) {
    if (value.schema !== 'runtime-contract@2' || !Array.isArray(value.promotions) || value.promotions.length > 64) issue('/promotions', '认证候选推广只能是 runtime-contract@2 里至多 64 条的列表');
    else for (const [k, row] of value.promotions.entries()) {
      const at = `/promotions/${k}`;
      if (!isRecord(row) || Object.keys(row).some((key) => !['object', 'method', 'status_authority', 'reason'].includes(key)) || !nonempty(row.object) || !nonempty(row.method) || typeof row.status_authority !== 'string' || !row.status_authority.startsWith(FORMAT.receipt_authority_prefix) || !SHA.test(row.status_authority.slice(FORMAT.receipt_authority_prefix.length)) || !nonempty(row.reason) || String(row.reason).length > 400) { issue(at, '推广须写对象、方法、该条目的设备回执集认证依据和理由'); continue; }
      const key = JSON.stringify([row.object, row.method]);
      if (promotions.has(key)) issue(at, '同一条目重复推广'); else promotions.set(key, { index: k, status_authority: row.status_authority });
    }
  }
  let cleanup: RunnerCleanup | undefined;
  if (value.cleanup !== undefined) {
    const c = value.cleanup;
    const rules = isRecord(c) && Array.isArray(c.rules) ? c.rules : [];
    const prefix = (p: unknown): p is string => typeof p === 'string' && /\S/.test(p) && p.length <= 200 && !/[\r\n]/.test(p);
    if (value.schema !== 'runtime-contract@2' || !isRecord(c) || Object.keys(c).some((key) => !['source', 'sha256', 'objects', 'rules'].includes(key)) || !nonempty(c.source) || typeof c.sha256 !== 'string' || !SHA.test(c.sha256)
      || !Array.isArray(c.objects) || c.objects.length === 0 || c.objects.length > 16 || c.objects.some((o) => !nonempty(o)) || new Set(c.objects).size !== c.objects.length
      || rules.length === 0 || rules.length > 512 || rules.some((r) => !isRecord(r) || Object.keys(r).some((key) => !['prefixes', 'line'].includes(key)) || !Array.isArray(r.prefixes) || r.prefixes.length === 0 || r.prefixes.length > 16 || !r.prefixes.every(prefix) || r.line !== undefined && (!Number.isSafeInteger(r.line) || (r.line as number) < 1))) {
      issue('/cleanup', '运行器清理声明只能是 runtime-contract@2 里的 source、sha256、objects（1–16 个对象）和 rules（1–512 条，每条 1–16 个单行前缀，可带源码行号）');
    } else {
      for (const [k, o] of (c.objects as string[]).entries()) if (!objects.has(o)) issue(`/cleanup/objects/${k}`, '清理声明的对象不在合约对象列表里');
      const recorded = isRecord(value.source_hashes) ? value.source_hashes[c.source as string] : undefined;
      if (recorded !== undefined && recorded !== c.sha256) issue('/cleanup/sha256', '清理源文件摘要与原合约源文件摘要表记的不同');
      cleanup = { source: String(c.source), sha256: c.sha256, objects: [...c.objects as string[]], rules: rules.map((r) => ({ prefixes: [...(r as { prefixes: string[] }).prefixes], line: typeof (r as { line?: unknown }).line === 'number' ? (r as { line: number }).line : null })), pinned: recorded === c.sha256 };
    }
  }
  let destructive: DestructiveCommands | undefined;
  if (value.destructive !== undefined) {
    const d = value.destructive;
    const path = (p: unknown): boolean => typeof p === 'string' && p.length <= 300 && /^\/commands(\/[^/\s]+)+$/.test(p);
    const segment = (p: unknown): boolean => typeof p === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(p);
    const list = (v: unknown, ok: (p: unknown) => boolean): boolean => v === undefined || (Array.isArray(v) && v.length <= 64 && v.every(ok) && new Set(v).size === v.length);
    if (value.schema !== 'runtime-contract@2' || !isRecord(d) || Object.keys(d).some((key) => !['source', 'sha256', 'exact', 'prefixes', 'segments'].includes(key)) || !nonempty(d.source) || typeof d.sha256 !== 'string' || !SHA.test(d.sha256)
      || !list(d.exact, path) || !list(d.prefixes, path) || !list(d.segments, segment) || [d.exact, d.prefixes, d.segments].every((v) => !Array.isArray(v) || v.length === 0)) {
      issue('/destructive', '破坏性命令声明只能是 runtime-contract@2 里的 source、sha256，和至少一项非空的 exact、prefixes（/commands 下的命令树路径，最多 64 条）或 segments（路径段，最多 64 个）');
    } else {
      destructive = { source: String(d.source), sha256: d.sha256 as string, exact: [...((d.exact as string[] | undefined) ?? [])], prefixes: [...((d.prefixes as string[] | undefined) ?? [])], segments: [...((d.segments as string[] | undefined) ?? [])] };
    }
  }
  const promotedPairs = new Set<string>();
  const enabled: RuntimeEntry[] = [];
  const pairs = new Set<string>();
  if (!Array.isArray(value.entries)) issue('/entries', '没有函数条目列表');
  for (const [i, entry] of (Array.isArray(value.entries) ? value.entries : []).entries()) {
    const at = `/entries/${i}`;
    if (!isRecord(entry)) { issue(at, '函数条目不是对象'); continue; }
    if (!nonempty(entry.e) || !objects.has(String(entry.e))) issue(`${at}/e`, '函数条目的对象不存在');
    if (!nonempty(entry.f)) issue(`${at}/f`, '函数条目没有方法名');
    const pair = JSON.stringify([entry.e, entry.f]);
    if (pairs.has(pair)) issue(at, '对象和方法组合重复');
    pairs.add(pair);
    if (!FORMAT.statuses.includes(String(entry.status))) issue(`${at}/status`, '不认识的条目状态');
    if (!FORMAT.dispatches.includes(String(entry.dispatch))) issue(`${at}/dispatch`, '不认识的派发方式');
    if (entry.status === 'enabled' && objects.get(String(entry.e)) !== 'enabled') issue(`${at}/status`, '未启用对象下存在启用条目');
    const authority = entry.status_authority;
    if (typeof authority !== 'string' || !(FORMAT.status_authorities.includes(authority) || authority.startsWith(FORMAT.receipt_authority_prefix) && SHA.test(authority.slice(FORMAT.receipt_authority_prefix.length)))) issue(`${at}/status_authority`, '不认识的状态来源');
    for (const field of ['python_symbol', 'g_syntax', 'h_semantics', 'i_semantics', 'reason', 'minimum_runtime']) if (typeof entry[field] !== 'string') issue(`${at}/${field}`, '函数说明字段不是文字');
    if (!isRecord(entry.source) || !nonempty(entry.source.path) || !Number.isSafeInteger(entry.source.line) || (entry.source.line as number) < 1) issue(`${at}/source`, '函数源位置不合式');
    if (entry.certification_candidate !== undefined && typeof entry.certification_candidate !== 'boolean') issue(`${at}/certification_candidate`, '认证候选标志不是布尔值');
    const signature = isRecord(entry.signature) ? entry.signature : {};
    if (!Array.isArray(signature.parameters)) issue(`${at}/signature/parameters`, '没有签名参数列表');
    const parameters: RuntimeParameter[] = [];
    const names = new Set<string>();
    for (const [k, param] of (Array.isArray(signature.parameters) ? signature.parameters : []).entries()) {
      const pat = `${at}/signature/parameters/${k}`;
      if (!isRecord(param)) { issue(pat, '参数不是对象'); continue; }
      if (!nonempty(param.name) || names.has(String(param.name))) issue(`${pat}/name`, '参数名为空或重复');
      names.add(String(param.name));
      if (!FORMAT.parameter_kinds.includes(String(param.kind))) issue(`${pat}/kind`, '不认识的参数种类');
      if (typeof param.required !== 'boolean') issue(`${pat}/required`, '必填标志不是布尔值');
      if (!(param.default === null || typeof param.default === 'string')) issue(`${pat}/default`, '默认值不是源码文字或 null');
      parameters.push({ name: String(param.name), kind: String(param.kind), required: param.required === true, redacted: param.default === FORMAT.redacted_default });
    }
    for (const [field, required] of [['required', true], ['optional', false]] as const) {
      const wanted = parameters.filter((param) => param.required === required).map((param) => param.name);
      if (JSON.stringify(signature[field]) !== JSON.stringify(wanted)) issue(`${at}/signature/${field}`, '签名参数分组与逐参数标志不一致');
    }
    if (typeof signature.text !== 'string') issue(`${at}/signature/text`, '签名说明不是文字');
    const promotion = promotions.get(pair);
    if (promotion) {
      if (entry.certification_candidate !== true || entry.status !== 'enabled' || entry.status_authority !== promotion.status_authority) issue(`/promotions/${promotion.index}`, '推广的条目不是已启用的认证候选，或认证依据与原合约记录不同');
      else if (!isRecord(entry.typed_authority)) issue(`/promotions/${promotion.index}`, '推广的认证候选必须带 runtime-contract@2 的类型权限');
      else promotedPairs.add(pair);
    }
    if (entry.status === 'enabled' && (entry.certification_candidate !== true || promotedPairs.has(pair))) enabled.push({ object: String(entry.e), method: String(entry.f), dispatch: String(entry.dispatch), parameters, sourcePointer: at, authority: readAuthority(value,entry,parameters.map(p=>p.name)) });
  }
  for (const [key, promotion] of promotions) if (!pairs.has(key)) issue(`/promotions/${promotion.index}`, '推广的对象和方法在合约里不存在');
  let digest = '';
  try { digest = runtimeDigest(value); } catch { /* Precise numeric/key problems were already listed above. */ }
  if (typeof value.contract_sha256 !== 'string' || !SHA.test(value.contract_sha256)) issue('/contract_sha256', '声明的合约摘要无效');
  else if (digest !== value.contract_sha256) issue('/contract_sha256', '重算合约摘要与声明值不一致');
  // A @2 document must declare the original contract it was built on (canonical identity and byte digest). The
  // gateway pins the original identity (PINNED_CONTRACT_SHA256); the @2 additions are a Hub-side deployment
  // declaration whose removal must recover the original contract's identity.
  let pinned: PinnedIdentity = { identity: digest, bytes: null };
  if (value.schema === 'runtime-contract@2') {
    const original = isRecord(value.original) ? value.original : null;
    if (original === null || typeof original.contract_sha256 !== 'string' || !SHA.test(original.contract_sha256) || typeof original.sha256 !== 'string' || !SHA.test(original.sha256)) {
      issue('/original', 'runtime-contract@2 必须显式带原合约的规范身份与字节摘要');
    } else {
      const recovered = stripAdditions(value);
      let recoveredDigest = '';
      try { recoveredDigest = recovered === null ? '' : runtimeDigest(recovered); } catch { /* listed below as a mismatch */ }
      if (recoveredDigest !== original.contract_sha256) issue('/original', '去掉 @2 增补后恢复不出原合约的规范身份');
      pinned = { identity: original.contract_sha256, bytes: original.sha256 };
    }
  }
  if (expected && (expected.digest !== pinned.identity || expected.runtimeVersion !== runtime.minimum_version)) issue('/runtime', '合约身份与运行环境配置的期望值不一致');
  if (problems.length) return { ok: false, problems };
  const contract: RuntimeContract = { digest, runtimeVersion: String(runtime.minimum_version), pinned, objects: [...objects.keys()], enabled, ...(cleanup ? { cleanup } : {}), ...(destructive ? { destructive } : {}) };
  sourceDocuments.set(contract, value);
  return { ok: true, contract };
}
