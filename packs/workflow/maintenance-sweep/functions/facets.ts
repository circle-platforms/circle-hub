// Local facet-view@1 parser: pack functions can load only modules inside this pack.
import { isRecord } from './text.ts';
const SHA = /^[a-f0-9]{64}$/;
export interface FacetCount { unplaced: number; build: string }
export const FACETS_FIX = '在 inputs.facets 绑定 knowledge:facets:<产品>:<起始构建>?kind=case&by=commands；缺少完整的未归位计数时，先重新读取该分面视图，取得未截断的完整计数后再开始运行';
export function readFacets(input: { inputs: unknown[] }, target: { product: string; fromRoot: string }): FacetCount | string {
  const bound = input.inputs.filter((v) => isRecord(v) && v.slot === 'facets');
  if (bound.length !== 1) return 'facets 槽必须绑定且只绑定一个分面视图，缺少所选构建的未归位用例计数';
  const source = bound[0];
  if (!isRecord(source) || typeof source.sha256 !== 'string' || !SHA.test(source.sha256)) return '分面视图缺少源文件摘要';
  const v = source.model;
  if (!isRecord(v) || v.schema !== 'facet-view@1' || v.product !== target.product || !isRecord(v.build) || typeof v.build.build !== 'string' || !v.build.build || v.build.root !== target.fromRoot || v.kind !== 'case' || !Array.isArray(v.by) || v.by.length !== 1 || v.by[0] !== 'commands') return '分面视图必须是同一产品目标根的 kind=case&by=commands';
  if (typeof v.truncated !== 'boolean' || !Number.isInteger(v.total) || (v.total as number) < 0 || !Number.isInteger(v.skipped) || (v.skipped as number) < 0 || !Array.isArray(v.notes) || v.notes.some((n) => typeof n !== 'string') || !Array.isArray(v.rows)) return '分面视图缺少合式的计数、完整性或说明字段';
  if (v.truncated) return '分面视图被截断，缺少完整的未归位用例计数；先补取完整的 kind=case&by=commands 分面视图，再开始运行';
  const seen = new Set<unknown>();
  let unplaced = 0;
  for (const row of v.rows) {
    if (!isRecord(row) || !isRecord(row.values) || Object.keys(row.values).length !== 1 || !Object.hasOwn(row.values, 'commands') || !(row.values.commands === null || typeof row.values.commands === 'string') || !Number.isInteger(row.count) || (row.count as number) <= 0 || (row.count as number) > (v.total as number) || seen.has(row.values.commands)) return '分面视图的行、计数或分组不合式';
    seen.add(row.values.commands);
    if (row.values.commands === null) unplaced = row.count as number;
  }
  return { unplaced, build: v.build.build };
}
export function unplacedMessage(count: FacetCount): string {
  return `构建 ${count.build} 的较早构建用例索引里有 ${count.unplaced} 个用例没有解析出命令（未归位），没算进巡检范围。${count.unplaced > 0 ? '客户端接下来列出这些用例供用户查看；它们的命令是否删除或修改，需要查看用例取得命令归属事实。' : '索引中没有未归位的用例。'}`;
}
