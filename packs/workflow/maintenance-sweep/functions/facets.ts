// Local facet-view@1 parser: pack functions can load only modules inside this pack.
import { clip, isRecord } from './text.ts';
const SHA = /^[a-f0-9]{64}$/;
/**
 * What the bound facet view says. `unplaced` is the count of the null commands row. `unknown` is the view's unknown_entries
 * when the view is truncated for that reason alone (unknown_only), else 0: cases left out of the lists because their command
 * attribution is unknown, which are neither zero nor unplaced. `notes` are the view's notes, quoted for people and never
 * read to decide anything.
 */
export interface FacetCount { unplaced: number; build: string; skipped: number; unknown: number; notes: string[] }
export const FACETS_FIX = '在 inputs.facets 绑定 knowledge:facets:<产品>:<起始构建>?kind=case&by=commands；缺完整计数时读取 notes 和根引用交当前用户供集成者定位行数、字节预算或来源排除原因；同一根不自动重试，待修复并取得完整输入后再启动';
export class FacetsError extends Error {readonly reason:'shape'|'truncated'|'skipped_mismatch';readonly fix:string;constructor(reason:'shape'|'truncated'|'skipped_mismatch',message:string){super(message);this.name='FacetsError';this.reason=reason;this.fix=reason==='skipped_mismatch'?'重新从同一个根导出 impact 和 facets 后重新绑定，不混用不同完整性观察':FACETS_FIX;}}
export function readFacets(input: { inputs: unknown[] }, target: { product: string; fromRoot: string ; skippedFrom:number }): FacetCount {
  const bound = input.inputs.filter((v) => isRecord(v) && v.slot === 'facets');
  if (bound.length !== 1) throw new FacetsError('shape', 'facets 槽必须绑定且只绑定一个分面视图，缺少所选构建的未归位用例计数');
  const source = bound[0];
  if (!isRecord(source) || typeof source.sha256 !== 'string' || !SHA.test(source.sha256)) throw new FacetsError('shape', '分面视图缺少源文件摘要');
  const v = source.model;
  if (!isRecord(v) || v.schema !== 'facet-view@1' || v.product !== target.product || !isRecord(v.build) || typeof v.build.build !== 'string' || !v.build.build || v.build.root !== target.fromRoot || v.kind !== 'case' || !Array.isArray(v.by) || v.by.length !== 1 || v.by[0] !== 'commands') throw new FacetsError('shape', '分面视图必须是同一产品起始根的 kind=case&by=commands');
  if (typeof v.truncated !== 'boolean' || !Number.isInteger(v.total) || (v.total as number) < 0 || !Number.isInteger(v.skipped) || (v.skipped as number) < 0 || !Array.isArray(v.notes) || v.notes.some((n) => typeof n !== 'string') || !Array.isArray(v.rows)) throw new FacetsError('shape', '分面视图缺少合式的计数、完整性或说明字段');
  // The two fields that say why a view is truncated (contracts/src/views.ts): unknown_entries is a positive count on a
  // truncated view, unknown_only is true and comes with that count; both are absent when the view has no unknown entries.
  const unknownEntries = v.unknown_entries;
  if (unknownEntries !== undefined && (typeof unknownEntries !== 'number' || !Number.isInteger(unknownEntries) || unknownEntries <= 0 || v.truncated !== true)) throw new FacetsError('shape', '分面视图的 unknown_entries 不合式：只能是截断视图上的正整数');
  if (v.unknown_only !== undefined && (v.unknown_only !== true || unknownEntries === undefined)) throw new FacetsError('shape', '分面视图的 unknown_only 不合式：只能是 true，并带 unknown_entries');
  if(v.skipped!==target.skippedFrom)throw new FacetsError('skipped_mismatch','分面视图与影响视图的所选根 skipped 不一致；重新导出同一根的两份视图');
  // Truncated only because some cases' command attribution is unknown (the slot opts in with unknown_entries: disclose):
  // the counts are read and those cases are said as unknown. Any other truncation is refused as before.
  const unknown = v.truncated && v.unknown_only === true ? (unknownEntries as number) : 0;
  if (v.truncated && unknown === 0) throw new FacetsError('truncated', `分面视图被截断，缺少完整的未归位用例计数。notes：${v.notes.length ? v.notes.slice(0, 3).map((note) => String(note).slice(0, 200)).join('；') : '视图未给出原因'}。同一根重复读取不会补齐；下一步把原因及根引用交当前用户供集成者修复预算/排除问题，或等待不会截断的汇总接口，再继续启动`);
  const seen = new Set<unknown>();
  let unplaced = 0;
  for (const row of v.rows) {
    if (!isRecord(row) || !isRecord(row.values) || Object.keys(row.values).length !== 1 || !Object.hasOwn(row.values, 'commands') || !(row.values.commands === null || typeof row.values.commands === 'string') || !Number.isInteger(row.count) || (row.count as number) <= 0 || (row.count as number) > (v.total as number) || seen.has(row.values.commands)) throw new FacetsError('shape', '分面视图的行、计数或分组不合式');
    seen.add(row.values.commands);
    if (row.values.commands === null) unplaced = row.count as number;
  }
  return { unplaced, build: v.build.build, skipped:v.skipped as number, unknown, notes: v.notes as string[] };
}
export function unplacedMessage(count: FacetCount): string {
  return `构建 ${count.build} 的较早构建用例索引里${count.skipped>0?'至少':count.unknown>0?'已知':'有'} ${count.unplaced} 个用例没有解析出命令（未归位），没算进巡检范围。${count.skipped>0?`另有 ${count.skipped} 份来源未读，其中的用例不知道。`: ''}${count.unplaced > 0 ? '客户端下一步自动提取最多一页用例样例及继续引用，供人工查看；它们的命令是否删除或修改，需要查看用例取得命令归属事实。' : count.skipped>0?'先按未读来源说明补取事实，不能把未读部分当作没有用例。':count.unknown>0?'':'索引中没有未归位的用例。'}`;
}

/** The view's notes as one quotation for people: each note at most 200 code points, all of them at most 800. */
export function quotedNotes(notes: readonly string[]): string {
  return notes.length === 0 ? '视图未给出说明' : clip(notes.map((note) => clip(note, 200)).join('；'), 800);
}

/**
 * The cases whose command attribution is unknown, said as unknown: their count, that it is neither zero nor unplaced, what
 * they leave open when the diff has a path they could need maintenance on (`open`), and the next step with the view's notes
 * quoted. Callers put the subject before it (另有 / 较早构建有).
 */
export function unknownSentence(unknown: number, notes: readonly string[], open: boolean): string {
  return `${unknown} 个用例的命令归属未知：分面视图看不出它们用到哪些命令，不是 0 个，也不算未归位。${open ? '它们所在的命令是否删除或修改不知道，巡检可能漏了其中需要维护的用例。' : ''}下一步照分面视图的说明补齐它们的命令归属${open ? '，再重新开始运行' : ''}（视图说明：${quotedNotes(notes)}）。`;
}
