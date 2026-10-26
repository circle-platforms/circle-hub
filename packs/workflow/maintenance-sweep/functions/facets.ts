// Local facet-view@1 parser: pack functions can load only modules inside this pack.
import { isRecord } from './text.ts';
const SHA = /^[a-f0-9]{64}$/;
export interface FacetCount { unplaced: number; build: string; skipped: number }
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
  if(v.skipped!==target.skippedFrom)throw new FacetsError('skipped_mismatch','分面视图与影响视图的所选根 skipped 不一致；重新导出同一根的两份视图');
  if (v.truncated) throw new FacetsError('truncated', `分面视图被截断，缺少完整的未归位用例计数。notes：${v.notes.length ? v.notes.slice(0, 3).map((note) => String(note).slice(0, 200)).join('；') : '视图未给出原因'}。同一根重复读取不会补齐；下一步把原因及根引用交当前用户供集成者修复预算/排除问题，或等待不会截断的汇总接口，再继续启动`);
  const seen = new Set<unknown>();
  let unplaced = 0;
  for (const row of v.rows) {
    if (!isRecord(row) || !isRecord(row.values) || Object.keys(row.values).length !== 1 || !Object.hasOwn(row.values, 'commands') || !(row.values.commands === null || typeof row.values.commands === 'string') || !Number.isInteger(row.count) || (row.count as number) <= 0 || (row.count as number) > (v.total as number) || seen.has(row.values.commands)) throw new FacetsError('shape', '分面视图的行、计数或分组不合式');
    seen.add(row.values.commands);
    if (row.values.commands === null) unplaced = row.count as number;
  }
  return { unplaced, build: v.build.build, skipped:v.skipped as number };
}
export function unplacedMessage(count: FacetCount): string {
  return `构建 ${count.build} 的较早构建用例索引里${count.skipped>0?'至少':'有'} ${count.unplaced} 个用例没有解析出命令（未归位），没算进巡检范围。${count.skipped>0?`另有 ${count.skipped} 份来源未读，其中的用例不知道。`: ''}${count.unplaced > 0 ? '客户端下一步自动提取最多一页用例样例及继续引用，供人工查看；它们的命令是否删除或修改，需要查看用例取得命令归属事实。' : count.skipped>0?'先按未读来源说明补取事实，不能把未读部分当作没有用例。':'索引中没有未归位的用例。'}`;
}
