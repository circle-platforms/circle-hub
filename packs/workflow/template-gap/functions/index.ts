import { readCommandIdentity } from './command-identity.ts';
// Frozen case-index admission. Runtime dependencies stay inside this workflow pack.
import type { IndexView } from '../../../../contracts/src/views.ts';
import type { PackFailure } from './types.ts';
import { failure, isRecord } from './common.ts';
export type CaseIndex = IndexView;
export const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const sha = /^[a-f0-9]{64}$/;
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
export function indexBindingFix(build: unknown, documents: string[]): string {
  const expected = [...new Set(documents)].sort(compareText);
  // An upload has no agile document number, so no only= admits it: an empty only is not a view id (T1-3, 2026-10-30).
  if (expected.length === 0) return `这次的被判对象都是上传文件：用例索引按敏捷平台文档编号收窄，上传文件对不上；要按命令核对覆盖，把 documents 改绑敏捷平台脑图 {"external":"agile:mindmap:<编号>"} 后重新开始运行，否则去掉 case_index；不要写空的 only`;
  return `锁定构建 ${String(build ?? '未提供')}；按这个构建重新绑定 knowledge:index:<产品>:<构建>?kind=case&key=document&only=${expected.join(',')}&fields=document,node,commands,command_identities,command_tree_root,title,path_labels,object；only 只写这次敏捷平台文档，不含上传文件`;
}
/**
 * index-view@1 unknown_entries: entries left out of the lists, or listed without the facts the query needs (a case whose
 * steps are not complete commands is listed under its document without commands), because those facts are unknown. Notes
 * are never read here. A present count must be a positive integer on a truncated view; unknown_only must be true and come
 * with the count. Returns the count (null when absent) or what is malformed.
 */
export function unknownEntriesOf(v: Record<string, unknown>): number | null | string {
  const hasEntries = Object.hasOwn(v, 'unknown_entries'), hasOnly = Object.hasOwn(v, 'unknown_only');
  if (hasEntries && (!Number.isSafeInteger(v.unknown_entries) || (v.unknown_entries as number) <= 0)) return 'unknown_entries 不是正整数';
  if (hasEntries && v.truncated !== true) return '视图带 unknown_entries 却没有标明截断';
  if (hasOnly && (v.unknown_only !== true || !hasEntries)) return 'unknown_only 只能是 true，且要带 unknown_entries';
  return hasEntries ? v.unknown_entries as number : null;
}
export function readCaseIndex(input: Record<string, unknown>, agileDocuments: string[]): CaseIndex | null | PackFailure {
  const bound = (input.inputs as unknown[]).filter(v => isRecord(v) && v.slot === 'case_index');
  if (bound.length === 0) return null;
  const context = isRecord(input.context) ? input.context : {};
  const expected = [...new Set(agileDocuments)].sort(compareText);
  const fix = indexBindingFix(context.build, expected);
  const bad = (fact: string): PackFailure => failure('index_invalid', `用例索引不能绑定：${fact}`, fix);
  if (bound.length !== 1) return bad('case_index 只接受一份视图');
  const source = bound[0];
  if (!isRecord(source) || source.parser !== 'json@1' || typeof source.external !== 'string' || !source.external.startsWith('knowledge:index:')) return bad('缺少 knowledge:index 的已绑定 JSON 输入');
  const v = source.model;
  if (!isRecord(v) || v.schema !== 'index-view@1' || v.kind !== 'case' || v.key !== 'document') return bad('需要 index-view@1 的 case/document 索引');
  if (!isRecord(v.build) || typeof v.build.root !== 'string' || !sha.test(v.build.root) || typeof v.build.build !== 'string' || typeof v.product !== 'string') return bad('缺少根或构建身份');
  if (v.build.root !== context.root || v.product !== context.product) return bad('索引的产品或根不是运行锁定的产品和根');
  if (!strings(v.only) || JSON.stringify([...new Set(v.only)].sort(compareText)) !== JSON.stringify(expected)) return bad('only 与这次敏捷平台文档集合不一致');
  if (typeof v.truncated !== 'boolean' || !count(v.skipped) || !count(v.total_keys) || !count(v.total_entries) || !strings(v.notes) || v.cut_keys !== undefined && !strings(v.cut_keys)) return bad('缺少或无法读取完整性事实 truncated、skipped、cut_keys、计数或 notes');
  const unknown = unknownEntriesOf(v);
  if (typeof unknown === 'string') return bad(unknown);
  if (!isRecord(v.keys) || !isRecord(v.entries)) return bad('缺少 keys 或 entries');
  if (v.fields !== undefined && (!strings(v.fields) || !['document', 'node', 'commands', 'title', 'path_labels'].every(k => (v.fields as string[]).includes(k)))) return bad('fields 缺少 document、node、commands、title 或 path_labels');
  // Listed entries whose command set the view could not give (no commands, no command_identities) are unknown entries.
  const unknownCommands = new Set<string>();
  for (const [document, digests] of Object.entries(v.keys)) {
    if (!expected.includes(document) || !strings(digests)) return bad('keys 含运行范围外的文档或非摘要列表');
    for (const digest of digests) {
      const entry = v.entries[digest];
      if (!sha.test(digest) || !isRecord(entry) || entry.entry !== digest || entry.kind !== 'case' || typeof entry.reference !== 'string') return bad('条目身份、种类或引用不一致');
      const tree=entry.reference.startsWith(`tree:${v.build.root}/`)&&entry.reference.endsWith(`@${digest}`);
      const feeding=entry.reference===`rec:${digest}`;
      if(!tree&&!feeding)return bad('条目引用既不是锁定树中的同一条目，也不是完整的喂入记录引用');
      const commandsUnknown = unknown !== null && isRecord(entry.data) && entry.data.commands === undefined && entry.data.command_identities === undefined;
      if (commandsUnknown) unknownCommands.add(digest);
      if (!isRecord(entry.data) || entry.data.document !== document || typeof entry.data.node !== 'string' || entry.data.node === '' || typeof entry.data.title !== 'string' || !strings(entry.data.path_labels) || !commandsUnknown && (!strings(entry.data.commands) || entry.data.commands.some(p => p === ''))) return bad('条目缺少可连接的 document、node 或已解析 commands');
      // The guard above narrowed entry.data; a closure does not keep that narrowing, so the checked value is held once.
      const data = entry.data;
      if(data.command_tree_root!==undefined&&data.command_tree_root!==null&&(typeof data.command_tree_root!=='string'||!sha.test(data.command_tree_root)))return bad('command_tree_root 不是完整命令树来源摘要');
      if (data.command_identities !== undefined) {
        const identities=data.command_identities;
        const treeRoot=typeof data.command_tree_root==='string'?data.command_tree_root:undefined;
        if (!Array.isArray(identities) || !identities.every(i => readCommandIdentity(i,treeRoot)!==null)) return bad('command_identities 不是冻结命令树来源下的完整 CommandIdentity 列表');
        const paths=[...new Set(identities.map(i => readCommandIdentity(i)!.path))].sort(compareText);
        if (JSON.stringify(paths)!==JSON.stringify([...new Set(entry.data.commands as string[])].sort(compareText))) return bad('commands 必须恰好是 command_identities 派生的路径集合');
      }
    }
  }
  if ((v.cut_keys as string[] | undefined)?.some(key => !expected.includes(key))) return bad('cut_keys 含运行范围外的文档');
  const listed = new Set(Object.values(v.keys).flatMap(value => value as string[]));
  if (Object.keys(v.entries).some(key => !listed.has(key)) || v.total_keys < Object.keys(v.keys).length || v.total_entries < listed.size) return bad('索引条目、键和计数不一致');
  if (!v.truncated && (v.total_keys !== Object.keys(v.keys).length || v.total_entries !== listed.size || (v.cut_keys as string[] | undefined)?.length)) return bad('索引声称完整，但键、条目计数或 cut_keys 不一致');
  if (unknown !== null && unknownCommands.size > unknown) return bad('没给 commands 的条目多于视图声明的未知条目');
  // unknown_only says nothing else was cut: taken only when the lists are all the view counts; otherwise ordinary truncation.
  const unknownOnly = unknown !== null && v.unknown_only === true && v.total_keys === Object.keys(v.keys).length && v.total_entries === listed.size && !(v.cut_keys as string[] | undefined)?.length;
  // Reorder only identity lists; command spellings are opaque paths produced upstream, never parsed or guessed here.
  const entries: CaseIndex['entries'] = {};
  const keys: CaseIndex['keys'] = {};
  for (const document of Object.keys(v.keys).sort(compareText)) {
    keys[document] = [...new Set(v.keys[document] as string[])].sort(compareText);
    for (const digest of keys[document]!) {
      const e = (v.entries as Record<string, any>)[digest];
      // An unknown command set stays absent: never written as an empty list.
      entries[digest] = { entry: digest, kind: 'case', statement: '', reference: e.reference, data: { document, node: e.data.node, title: e.data.title, path_labels: [...e.data.path_labels], ...(Array.isArray(e.data.commands)?{commands: [...new Set<string>(e.data.commands)].sort(compareText)}:{}), ...(typeof e.data.object==='string'?{object:e.data.object}:{}), ...(e.data.command_identities!==undefined?{command_identities:e.data.command_identities}: {}),...(Object.hasOwn(e.data,'command_tree_root')?{command_tree_root:e.data.command_tree_root}: {}) } };
    }
  }
  return { schema: 'index-view@1', product: v.product, build: { root: v.build.root, build: v.build.build }, kind: 'case', key: 'document', only: expected, fields: ['document', 'node', 'commands', 'title', 'path_labels',...(Object.values(entries).some(entry=>typeof entry.data.object==='string')?['object']:[])], keys, entries, cut_keys: [...new Set(v.cut_keys as string[] ?? [])].sort(compareText), truncated: v.truncated, ...(unknown !== null ? { unknown_entries: unknown } : {}), ...(unknownOnly ? { unknown_only: true as const } : {}), skipped: v.skipped, total_keys: v.total_keys, total_entries: v.total_entries, notes: [...v.notes].sort(compareText) };
}
