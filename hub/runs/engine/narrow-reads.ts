// Item-key reads are derived only from an integrity-checked bound index view, never from a subject-supplied URI.
import type { NarrowCheckRead } from '../../../contracts/src/pack.ts';
import { IndexView } from '../../../contracts/src/views.ts';
import type { UnreadSource } from '../../rules/api.ts';

export interface NarrowReadIO {
  binding: { reference: string; external?: string };
  boundText: string | null;
  read: (external: string) => Promise<{ text: string | null; reference: string; revision: string | null; manifest: string }>;
}
export interface NarrowReadResult {
  subject: unknown;
  unread: UnreadSource[];
  keys: string[];
  external?: string;
  reference?: string;
  manifest?: string;
  text?: string;
}
const parts = (pointer: string): string[] => pointer.slice(1).split('/').map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'));
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function at(subject: unknown, pointer: string): unknown {
  let value = subject;
  for (const key of parts(pointer)) {
    if ((!object(value) && !Array.isArray(value)) || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
function inject(subject: unknown, pointer: string, value: unknown): unknown {
  const copy: Record<string, unknown> = object(subject) ? structuredClone(subject) : {};
  const keys = parts(pointer); let target = copy;
  for (const key of keys.slice(0, -1)) {
    if (!object(target[key])) target[key] = {};
    target = target[key] as Record<string, unknown>;
  }
  target[keys.at(-1)!] = value;
  return copy;
}
function parse(text: string | null): IndexView | null {
  try { const result = IndexView.safeParse(text === null ? null : JSON.parse(text)); return result.success ? result.data : null; }
  catch { return null; }
}
export async function narrowSubjectRead(declaration: NarrowCheckRead, subject: unknown, maxBytes: number, io: NarrowReadIO): Promise<NarrowReadResult> {
  const result: NarrowReadResult = { subject: inject(subject, declaration.into, null), unread: [], keys: [] };
  const gap = (missing_fact: string, next_action: string, reason = 'missing_input'): NarrowReadResult => {
    result.unread.push({ reference: io.binding.reference, ...(io.binding.external ? { external: io.binding.external } : {}), slot: declaration.slot, reason, missing_fact, next_action });
    return result;
  };
  const selected = at(subject, declaration.key_path);
  if (!Array.isArray(selected) || selected.length === 0 || selected.some(key => typeof key !== 'string' || key.length === 0 || key.length > 512))
    return gap(`主体 ${declaration.key_path} 缺少非空字符串键列表`, `补齐主体 ${declaration.key_path} 的读取键后重读`);
  if (selected.length > declaration.max_keys)
    return gap(`主体读取键数 ${selected.length} 超过上限 ${declaration.max_keys}`, '调高声明的 max_keys（不超过核心上限）或拆分条目后重读', 'budget_exhausted');
  result.keys = [...new Set(selected as string[])].sort();
  const bound = parse(io.boundText);
  const match = /^(knowledge:index:.+)@([a-f0-9]{64})$/.exec(io.binding.external ?? '');
  if (!bound || !match || match[2] !== bound.build.root)
    return gap('已绑定索引的可读内容或固定修订依据缺失', '重读已绑定索引并在同一修订重新核验');
  if (bound.only && declaration.rebind !== true && result.keys.some(key => !bound.only!.includes(key)))
    return gap('主体请求键超出已绑定视图范围', '绑定覆盖这些键的来源视图后重新核验');
  const [base, query] = match[1].split('?');
  if (!query) return gap('已绑定索引缺少查询声明', '重新绑定有效索引视图后重读');
  // Preserve raw commas: the view parser splits list values before decoding each value.
  result.external = `${base}?${query.split('&').filter(part => part.split('=')[0] !== 'only').join('&')}&only=${result.keys.map(encodeURIComponent).join(',')}@${match[2]}`;
  let read: Awaited<ReturnType<NarrowReadIO['read']>>;
  try { read = await io.read(result.external); }
  catch { return gap('同一修订的收窄索引暂时读不到', '重读同一修订；修订已不可取时重新绑定并启动新修订核验', 'SOURCE_UNAVAILABLE'); }
  result.reference = read.reference; result.manifest = read.manifest;
  if (read.text === null) return gap('收窄来源尚未获准给函数读取', '请求管理员接受来源后重读', 'credential_unreadable');
  if (Buffer.byteLength(read.text, 'utf8') > maxBytes)
    return gap(`收窄索引超过 ${maxBytes} 字节读取上限`, '调高 max_bytes（不超过核心上限）或减少每条目的键后重读', 'budget_exhausted');
  const view = parse(read.text);
  if (!view || read.revision !== bound.build.root || view.product !== bound.product || view.build.root !== bound.build.root || view.build.build !== bound.build.build || view.kind !== bound.kind || view.key !== bound.key || JSON.stringify(view.fields ?? null) !== JSON.stringify(bound.fields ?? null))
    return gap('收窄响应缺少与已绑定视图一致的身份、字段或修订依据', '重读已绑定视图的同一修订并核对响应身份');
  const hashes = [...new Set(result.keys.flatMap(key => Object.hasOwn(view.keys, key) ? view.keys[key] : []))];
  if (Object.keys(view.keys).some(key => !result.keys.includes(key)))
    return gap('收窄响应包含未请求的键', '按声明的键重新读取索引');
  const kept = new Set(hashes.slice(0, declaration.max_entries));
  const bounded = { ...view, entries: Object.fromEntries(Object.entries(view.entries).filter(([sha]) => kept.has(sha))), keys: Object.fromEntries(Object.entries(view.keys).map(([key, values]) => [key, values.filter(sha => kept.has(sha))])), truncated: view.truncated || hashes.length > declaration.max_entries };
  result.subject = inject(subject, declaration.into, bounded);
  result.text = JSON.stringify(bounded);
  const listed = Array.isArray(view.only) ? view.only : null;
  const sameOnly = listed !== null && listed.length === result.keys.length && result.keys.every(key => listed.includes(key));
  const omissionMeansEmpty = sameOnly && view.truncated !== true && view.skipped === 0 && !view.cut_keys?.some(key => result.keys.includes(key));
  const missing = result.keys.filter(key => !Object.hasOwn(view.keys, key));
  if (missing.length && !omissionMeansEmpty) gap(`收窄索引缺少请求键 ${missing.join('、')} 对应的完整事实`, '重读缺失键；若仍缺失，补建这些键的索引后重新核验');
  if (view.truncated || view.skipped > 0 || view.cut_keys?.some(key => result.keys.includes(key)) || hashes.some(sha => !Object.hasOwn(view.entries, sha)) || hashes.length > declaration.max_entries)
    gap('收窄索引存在截断、跳过或缺少条目，尚无完整覆盖事实', '重读同一修订；调高视图或 max_entries 上限，补齐跳过条目后重新核验', 'budget_exhausted');
  return result;
}
