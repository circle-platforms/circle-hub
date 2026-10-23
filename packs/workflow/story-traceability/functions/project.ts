// Pure projection: caller-supplied ids, or ids explicitly declared by a configured build record.
import type { BoundInput, ProjectedItem } from '../../../../contracts/src/pack.ts';
import { absent, nonscalar, scalar, type Scalar } from './plm-fields.ts';
import type { ProvenanceType } from '../../../../contracts/generated/vocabulary.ts';
import { scopeText } from './scope.ts';
import { normalizeId } from './ids.ts';
import { isRecord, strings, shown, utf8Length } from './text.ts';
import { readIndexView } from './views.ts';

export type Story = { id: string; status: Scalar; stage: Scalar; fields_absent: string[]; fields_nonscalar: string[]; title: string | null };
export type Case = { case: string; title: string; document: string | null; reference: string; stories: string[] | null };
export type Row = Story & { plm_returned: boolean; plm_responded: boolean; indexed_match_count: number; case_count_lower_bound: boolean; coverage_complete: boolean; cases: Case[]; references: string[]; build: string; scope: ProvenanceType };
export const validId = (id: string): boolean => /^[1-9][0-9]{0,14}$/.test(normalizeId(id));
class ProjectionRefusal extends Error {
  readonly fix: string;
  constructor(message: string, fix: string) { super(message); this.fix = fix; }
}
const fail = (message: string, fix: string) => ({ error: { code: 'story-traceability.invalid_input', message, fix }, warnings: [] });

export function projectItems(input: unknown): unknown {
  if (!isRecord(input) || !Array.isArray(input.inputs)) return fail('输入缺少绑定来源', '绑定 stories 和 cases；需求号向用户索取，不猜');
  const bound = input.inputs.filter(isRecord) as unknown as BoundInput[];
  const storyInputs = bound.filter(b => b.slot === 'stories');
  const caseInputs = bound.filter(b => b.slot === 'cases');
  if (caseInputs.length !== 1) return fail('需要一个用例索引', '绑定 cases：knowledge:index:<产品>:<构建>?kind=case&key=stories&fields=document,node,title');
  const read = readIndexView(caseInputs[0], 'cases', { kind: 'case', key: 'stories' });
  if (!read.ok) return fail(read.message, read.fix);
  const view = read.view;


  const rows = new Map<string, Row>();
  const locations = new Map<string, { source: string; selector: string; slot: string }>();
  const scope: ProvenanceType = storyInputs.length > 0 ? 'declared' : 'observed';
  function add(raw: string, record: unknown, source: BoundInput, selector: string) {
    if (!validId(raw)) throw new ProjectionRefusal('需求编号应为最多 15 位正整数', '请用户提供有效的需求编号后重新绑定');
    const id = normalizeId(raw);
    const r = isRecord(record) ? record : null;
    const next: Row = { id, title: r && typeof r.title === 'string' ? r.title : null,
      status: r ? scalar(r.status) : null, stage: r ? scalar(r.stage) : null, fields_absent: r ? absent(r) : [], fields_nonscalar: r ? nonscalar(r) : [],
      plm_returned: r !== null, plm_responded: r !== null || source.slot === 'stories' && isRecord(source.model) && Array.isArray(source.model.unread) && source.model.unread.some(value => normalizeId(String(value)) === id), indexed_match_count: 0, case_count_lower_bound: false, coverage_complete: false, cases: [], references: [`src:${source.sha256}/json@1/${selector}`], build: view.build, scope };
    const previous = rows.get(id);
    if (previous && previous.plm_returned && next.plm_returned && JSON.stringify([previous.status, previous.stage, previous.title, previous.fields_absent, previous.fields_nonscalar]) !== JSON.stringify([next.status, next.stage, next.title, next.fields_absent, next.fields_nonscalar])) throw new ProjectionRefusal('同一需求的 PLM 原件内容冲突', '请重新导出一致原件并重新绑定需求来源');
    if (!previous || (!previous.plm_returned && next.plm_returned)) { rows.set(id, next); locations.set(id, { source: source.sha256, selector, slot: source.slot }); }
  }
  if (storyInputs.length > 0) {
    for (const source of storyInputs) {
      const external = source.external?.split('@')[0] ?? '';
      if (!external.startsWith('plm:stories:')) return fail('需求槽不是 PLM 批量需求读取', '用最多 50 个规范化编号组成 plm:stories:<编号>+…');
      const ids = external.slice('plm:stories:'.length).split('+');
      if (ids.length > 50 || ids.some(id => !validId(id))) return fail('需求编号列表无效', '每批最多 50 个正整数编号');
      const model = source.model;
      if (!isRecord(model) || !Array.isArray(model.stories) || !Array.isArray(model.unread)) return fail('需求批量读取缺少 stories 或 unread', '重新读取 PLM 批量需求原件');
      for (const raw of ids) {
        const at = model.stories.findIndex(r => isRecord(r) && normalizeId(String(r.id)) === normalizeId(raw));
        add(raw, model.stories[at], source, at < 0 ? 'p/unread' : `p/stories/${at}`);
      }
    }
  } else {
    const buildInputs = bound.filter(b => b.slot === 'build');
    const params = isRecord(input.parameters) ? input.parameters : {};
    if (buildInputs.length !== 1 || typeof params.build_id !== 'string') return fail('缺少需求编号', '请给出需求编号；可选绑定 PLM 构建列表并明确 build_id');
    const source = buildInputs[0];
    if (!source.external?.startsWith('plm:builds:')) return fail('构建槽不是 PLM 构建列表', '绑定 plm:builds:<产品编号>');
    const buildId = normalizeId(params.build_id.trim());
    if (!validId(buildId)) return fail('构建编号无效', '明确给出 build_id 正整数编号');
    const model = isRecord(source.model) ? source.model : {};
    if (!Array.isArray(model.builds)) return fail('PLM 构建列表没有 builds 数组', '重新绑定有效的 PLM 构建列表原件，或向用户索取需求编号');
    const builds = model.builds;
    const at = builds.findIndex(b => isRecord(b) && normalizeId(String(b.id).trim()) === buildId);
    const build = builds[at];
    if (!isRecord(build)) return fail(`PLM 构建列表未包含规范化编号 ${buildId}`, '请用户确认构建编号，或直接提供需求编号');
    if (!Array.isArray(build.stories)) return fail(`构建记录 ${buildId} 未提供可用的需求编号数组；${typeof build.scope_note === 'string' ? build.scope_note : '当前投影未说明原始字段名或配置'}`, '请管理员核对 settings.build_story_field 和构建记录原件，或向用户索取需求编号');
    if (build.stories.length === 0) return fail(`构建记录 ${buildId} 的需求编号数组为空`, '请用户提供要核对的需求编号，或请管理员确认该构建的需求范围；不把空数组解释成字段缺失');
    for (const id of build.stories) add(String(id), null, source, `p/builds/${at}`);
  }
  if (rows.size === 0 || rows.size > 8000) return fail('需求范围为空或超过 8000 条', '提供非空需求编号列表；超限则分批运行');
  const byId = new Map<string, Map<string, Case>>();
  const digestsById = new Map<string, Set<string>>();
  for (const [key, digests] of Object.entries(view.keys)) {
    const id = normalizeId(key);
    const bucket = byId.get(id) ?? new Map<string, Case>(); byId.set(id, bucket);
    const matches = digestsById.get(id) ?? new Set<string>(); digestsById.set(id, matches);
    for (const digest of digests) {
      matches.add(digest);
      const entry = view.entries[digest]; if (!entry) continue;
      const data = entry.data;
      bucket.set(digest, { case: typeof data.node === 'string' ? data.node : digest, title: typeof data.title === 'string' ? data.title : entry.statement,
        document: typeof data.document === 'string' ? data.document : null, reference: entry.reference,
        stories: Object.hasOwn(data, 'stories') ? strings(data.stories) : null });
    }
  }
  const absenceComplete = view.only === null && view.skipped === 0 && view.missing === 0
    && view.total_keys === Object.keys(view.keys).length && view.total_entries === Object.keys(view.entries).length;
  const undetermined: string[] = [];
  for (const row of rows.values()) {
    const digests = digestsById.get(row.id) ?? new Set<string>();
    row.indexed_match_count = digests.size;
    row.case_count_lower_bound = digests.size > 0 && (view.truncated || view.skipped > 0 || view.missing > 0
      || view.cut_keys.length > 0 || view.only !== null || view.total_keys !== Object.keys(view.keys).length
      || view.total_entries !== Object.keys(view.entries).length);
    row.coverage_complete = digests.size > 0 ? !row.case_count_lower_bound : absenceComplete;
    if (digests.size === 0 && !absenceComplete) undetermined.push(row.id);
  }
  if (undetermined.length) return fail(`缺少需求 ${undetermined.join('、')} 的完整规范化编号检索：知识根 ${view.root}，键 ${Object.keys(view.keys).length}/${view.total_keys}，正文 ${Object.keys(view.entries).length}/${view.total_entries}，未读来源 ${view.skipped}；来源说明：${view.notes.join('；') || '请读取该根的来源清单定位未读来源'}；不能据此判断没有条目`,
    '先核对这些编号在索引中的原始键写法，可用 only=<原始键> 视图取得命中；未命中仍不能证明不存在。请核心维护人提供按规范化编号匹配的 only= 及完整性标记（见 README Needs），再绑定明确覆盖这些编号的视图；来源确实缺失时由管理员恢复来源并运行知识同步');
  const items: ProjectedItem[] = [...rows.values()].sort((a, b) => Number(a.id) - Number(b.id)).map(row => {
    row.cases = [...(byId.get(row.id)?.values() ?? [])].sort((a, b) => a.case < b.case ? -1 : a.case > b.case ? 1 : (a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0));
    const loc = locations.get(row.id)!;
    return { id: row.id, label: shown(`需求 ${row.id}${row.title ? ` ${row.title}` : ''}`),
      summary: shown(`${row.indexed_match_count ? row.case_count_lower_bound ? `至少 ${row.indexed_match_count} 个已索引条目` : `${row.cases.length} 个用例` : '无已索引用例（完整视图内）'}；${scopeText(scope)}`),
      location: { slot: loc.slot, source: loc.source, parser: 'json@1', selector: loc.selector }, fields: row as unknown as Record<string, unknown> };
  });
  const facts = { product: view.product, build: view.build, root: view.root, scope, view: { source: view.source, truncated: view.truncated, skipped: view.skipped, missing: view.missing,
    cut_keys: view.cut_keys, only: view.only, total_keys: view.total_keys, total_entries: view.total_entries, listed_keys: Object.keys(view.keys).length, listed_entries: Object.keys(view.entries).length } };
  const result = { items, groups: [facts], warnings: read.warnings };
  if (utf8Length(JSON.stringify(result)) > 5 * 1024 * 1024) return fail('投影结果超过 5 MiB', '把需求编号列表分成更小的批次');
  return result;
}
export default function project(input: unknown): unknown {
  try { return projectItems(input); } catch (error) {
    return error instanceof ProjectionRefusal ? fail(error.message, error.fix) : fail('投影函数内部出错', '请任务包维护人修复投影后重跑');
  }
}
