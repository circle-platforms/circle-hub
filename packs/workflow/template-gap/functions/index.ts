// Frozen case-index admission. Runtime dependencies stay inside this workflow pack.
import type { IndexView } from '../../../../contracts/src/views.ts';
import type { PackFailure } from './types.ts';
import { failure, isRecord } from './common.ts';
export type CaseIndex = IndexView;
export const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const sha = /^[a-f0-9]{64}$/;
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
export function readCaseIndex(input: Record<string, unknown>, agileDocuments: string[]): CaseIndex | null | PackFailure {
  const bound = (input.inputs as unknown[]).filter(v => isRecord(v) && v.slot === 'case_index');
  if (bound.length === 0) return null;
  const context = isRecord(input.context) ? input.context : {};
  const expected = [...new Set(agileDocuments)].sort(compareText);
  const fix = `锁定构建 ${String(context.build ?? '未提供')}；按这个构建重新绑定 knowledge:index:<产品>:<构建>?kind=case&key=document&only=${expected.join(',')}&fields=document,node,commands；only 只写这次敏捷平台文档，不含上传文件`;
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
  if (!isRecord(v.keys) || !isRecord(v.entries)) return bad('缺少 keys 或 entries');
  if (v.fields !== undefined && (!strings(v.fields) || !['document', 'node', 'commands'].every(k => (v.fields as string[]).includes(k)))) return bad('fields 缺少 document、node 或 commands');
  for (const [document, digests] of Object.entries(v.keys)) {
    if (!expected.includes(document) || !strings(digests)) return bad('keys 含运行范围外的文档或非摘要列表');
    for (const digest of digests) {
      const entry = v.entries[digest];
      if (!sha.test(digest) || !isRecord(entry) || entry.entry !== digest || entry.kind !== 'case' || typeof entry.reference !== 'string' || !entry.reference.startsWith(`tree:${v.build.root}/`) || !entry.reference.endsWith(`@${digest}`)) return bad('条目身份、种类或 tree 引用不一致');
      if (!isRecord(entry.data) || entry.data.document !== document || typeof entry.data.node !== 'string' || entry.data.node === '' || !strings(entry.data.commands) || entry.data.commands.some(p => p === '')) return bad('条目缺少可连接的 document、node 或已解析 commands');
    }
  }
  if ((v.cut_keys as string[] | undefined)?.some(key => !expected.includes(key))) return bad('cut_keys 含运行范围外的文档');
  const listed = new Set(Object.values(v.keys).flatMap(value => value as string[]));
  if (Object.keys(v.entries).some(key => !listed.has(key)) || v.total_keys < Object.keys(v.keys).length || v.total_entries < listed.size) return bad('索引条目、键和计数不一致');
  if (!v.truncated && (v.total_keys !== Object.keys(v.keys).length || v.total_entries !== listed.size || (v.cut_keys as string[] | undefined)?.length)) return bad('索引声称完整，但键、条目计数或 cut_keys 不一致');
  // Reorder only identity lists; command spellings are opaque paths produced upstream, never parsed or guessed here.
  const entries: CaseIndex['entries'] = {};
  const keys: CaseIndex['keys'] = {};
  for (const document of Object.keys(v.keys).sort(compareText)) {
    keys[document] = [...new Set(v.keys[document] as string[])].sort(compareText);
    for (const digest of keys[document]!) {
      const e = (v.entries as Record<string, any>)[digest];
      entries[digest] = { entry: digest, kind: 'case', statement: '', reference: e.reference, data: { document, node: e.data.node, commands: [...new Set<string>(e.data.commands)].sort(compareText) } };
    }
  }
  return { schema: 'index-view@1', product: v.product, build: { root: v.build.root, build: v.build.build }, kind: 'case', key: 'document', only: expected, fields: ['document', 'node', 'commands'], keys, entries, cut_keys: [...new Set(v.cut_keys as string[] ?? [])].sort(compareText), truncated: v.truncated, skipped: v.skipped, total_keys: v.total_keys, total_entries: v.total_entries, notes: [...v.notes].sort(compareText) };
}
