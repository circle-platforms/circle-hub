// Pure projection: caller-supplied ids, or ids explicitly declared by a configured build record.
import type { BoundInput, ProjectedItem } from '../../../../contracts/src/pack.ts';
import { absent, nonscalar, scalar, type Scalar } from './plm-fields.ts';
import type { ProvenanceType } from '../../../../contracts/generated/vocabulary.ts';
import { sameBuild } from './build-match.ts';
import { scopeText } from './scope.ts';
import { normalizeId } from './ids.ts';
import { isRecord, strings, shown, utf8Length } from './text.ts';
import { readIndexView } from './views.ts';

export type Story = { id: string; status: Scalar; stage: Scalar; fields_absent: string[]; fields_nonscalar: string[]; title: string | null };
export type Case = { case: string; title: string; document: string | null; reference: string; stories: string[] | null };
export type SelectedBuild = { id: string; name: string; reference: string; case_build: string; case_root: string };
export type Row = Story & { selected_build?: Pick<SelectedBuild, 'id' | 'name'>; plm_returned: boolean; plm_responded: boolean; indexed_match_count: number; case_count_lower_bound: boolean; coverage_complete: boolean; cases: Case[]; references: string[]; build: string; scope: ProvenanceType };
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


  let selectedBuild: SelectedBuild | undefined;
  const rows = new Map<string, Row>();
  const locations = new Map<string, { source: string; selector: string; slot: string }>();
  const scope: ProvenanceType = storyInputs.length > 0 ? 'declared' : 'observed';
  function add(raw: string, record: unknown, source: BoundInput, selector: string) {
    if (!validId(raw)) throw new ProjectionRefusal('需求编号应为最多 15 位正整数', '请用户提供有效的需求编号后重新绑定');
    const id = normalizeId(raw);
    const r = isRecord(record) ? record : null;
    const next: Row = { id, title: r && typeof r.title === 'string' ? r.title : null,
      status: r ? scalar(r.status) : null, stage: r ? scalar(r.stage) : null, fields_absent: r ? absent(r) : [], fields_nonscalar: r ? nonscalar(r) : [],
      ...(selectedBuild ? { selected_build: { id: selectedBuild.id, name: selectedBuild.name } } : {}),
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
    if (Object.hasOwn(model, 'product_resolution') && model.product_resolution !== 'resolved') return fail('PLM 产品尚未唯一解析，未取得可核验的产品构建列表', '核对产品名单，调整 plm:builds 的名字集合或明确产品编号后重读；不把未读取当作构建编号不存在');
    if (!Array.isArray(model.builds)) return fail('PLM 构建列表没有 builds 数组', '重新绑定有效的 PLM 构建列表原件，或向用户索取需求编号');
    const builds = model.builds;
    const matches = builds.flatMap((b, at) => isRecord(b) && normalizeId(String(b.id).trim()) === buildId ? [at] : []);
    if (matches.length > 1) return fail(`PLM 构建编号 ${buildId} 对应多条记录，不能确定所选记录`, '请核对 PLM 构建原件并重新读取唯一记录，或直接给出需求编号');
    const at = matches[0] ?? -1;
    const build = builds[at];
    if (!isRecord(build)) return fail(`PLM 构建列表未包含规范化编号 ${buildId}`, '请用户确认构建编号，或直接提供需求编号');
    if (typeof build.name !== 'string' || build.name.trim() === '') return fail(`PLM 构建记录 ${buildId} 缺少原始 name，无法证明它对应构建 ${view.build} 和知识根 ${view.root}`, '重新读取保留记录原始 name 的 PLM 构建列表，选中与 cases 用例视图对应的记录，或直接提供需求编号');
    if (isRecord(build.fields) && Object.hasOwn(build.fields, 'name') && build.fields.name !== build.name) return fail(`PLM 构建记录 ${buildId} 的 name 与原始标量字段矛盾`, '重新读取一致的 PLM 构建记录并绑定对应的 cases 用例视图');
    if (!sameBuild(build.name, view, input.context)) return fail(`PLM 构建记录 ${buildId} 的 name ${build.name} 未证明与用例视图构建 ${view.build}、知识根 ${view.root} 相同`, '下一步重绑与所选 PLM 原始 name 同名的 cases 用例视图，再重开运行；当前没有只读别名查询接口，不猜跨名称族对应关系');
    selectedBuild = { id: buildId, name: build.name, reference: `src:${source.sha256}/json@1/p/builds/${at}`, case_build: view.build, case_root: view.root };

    if (!Array.isArray(build.stories)) return fail(`构建记录 ${buildId} 未提供可用的需求编号数组；${typeof build.scope_note === 'string' ? build.scope_note : '当前投影未说明原始字段名或配置'}`, '请管理员核对 settings.build_story_field 和构建记录原件，或向用户索取需求编号');
    if (build.stories.length === 0) return fail(`构建记录 ${buildId} 的需求编号数组为空`, '请用户提供要核对的需求编号，或请管理员确认该构建的需求范围；不把空数组解释成字段缺失');
    for (const id of build.stories) add(String(id), null, source, `p/builds/${at}`);
  }
  if (rows.size === 0) return fail('需求范围为空', '提供非空需求编号列表后重新绑定');
  if (rows.size > 8000) return selectedBuild
    ? fail(`PLM 构建记录 ${selectedBuild.id} 的需求范围有 ${rows.size} 条，超过每运行 8000 条上限`, '请任务包维护人提供保留同一构建来源的分块核对，或由用户明确给出需求编号后按声明范围另开分批运行；不要重复绑定整份构建范围')
    : fail(`用户声明的需求范围有 ${rows.size} 条，超过每运行 8000 条上限`, '把用户明确给出的需求编号列表分批，每批最多 8000 条后运行');
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
  const absenceComplete = view.only === null && view.skipped === 0 && view.scope_complete!==false && view.total_keys === Object.keys(view.keys).length && view.key_space_complete===true;
  const undetermined: string[] = [];
  for (const row of rows.values()) {
    const digests = digestsById.get(row.id) ?? new Set<string>();
    row.indexed_match_count = digests.size;
    const ownKeys = Object.keys(view.keys).filter(key => normalizeId(key) === row.id);
    const missingBodies = [...digests].some(digest => view.entries[digest] === undefined);
    // Only the generating read's bound numeric metadata can establish whether entries were omitted.
    const excluded = view.excluded_entries === null ? view.truncated : view.excluded_entries > 0;
    row.case_count_lower_bound = digests.size > 0 && (ownKeys.some(key => view.cut_keys.includes(key))
      || !absenceComplete || missingBodies || excluded || view.truncated && view.cut_keys.length === 0);
    row.coverage_complete = digests.size > 0 ? !row.case_count_lower_bound : absenceComplete;
    if (digests.size === 0 && !absenceComplete) undetermined.push(row.id);
  }
  if (undetermined.length) return fail(`缺少需求 ${undetermined.join('、')} 的完整规范化编号检索：知识根 ${view.root}，键 ${Object.keys(view.keys).length}/${view.total_keys}，正文 ${Object.keys(view.entries).length}/${view.total_entries}，未读来源 ${view.skipped}；来源说明：${view.notes.join('；') || '请读取该根的来源清单定位未读来源'}；不能据此判断没有条目`,
    `可先去掉无法确定的编号 ${undetermined.join('、')} 后重新运行其余编号；先核对这些编号在索引中的原始键写法，可用 only=<原始键> 视图取得命中；未命中仍不能证明不存在。请核心维护人提供按规范化编号匹配的 only= 及完整性标记（见 README Needs），再绑定明确覆盖这些编号的视图；来源确实缺失时由管理员恢复来源并运行知识同步`);
  const items: ProjectedItem[] = [...rows.values()].sort((a, b) => Number(a.id) - Number(b.id)).map(row => {
    row.cases = [...(byId.get(row.id)?.values() ?? [])].sort((a, b) => a.case < b.case ? -1 : a.case > b.case ? 1 : (a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0));
    const loc = locations.get(row.id)!;
    return { id: row.id, label: shown(`需求 ${row.id}${row.title ? ` ${row.title}` : ''}`),
      summary: shown(`${row.indexed_match_count ? row.case_count_lower_bound ? `至少 ${row.indexed_match_count} 个已索引条目` : `${row.cases.length} 个用例` : '无已索引用例（完整视图内）'}；${scopeText(scope)}`),
      location: { slot: loc.slot, source: loc.source, parser: 'json@1', selector: loc.selector }, fields: row as unknown as Record<string, unknown> };
  });
  const facts = { ...(selectedBuild ? { selected_build: selectedBuild } : {}), product: view.product, build: view.build, root: view.root, scope, view: { source: view.source, truncated: view.truncated, skipped: view.skipped, missing: view.missing,
    cut_keys: view.cut_keys, only: view.only, ...(view.key_space_complete!==null?{key_space_complete:view.key_space_complete}:{}), ...(view.scope_complete!==null?{scope_complete:view.scope_complete}:{}), total_keys: view.total_keys, total_entries: view.total_entries, listed_keys: Object.keys(view.keys).length, listed_entries: Object.keys(view.entries).length } };
  const result = { items, groups: [facts], warnings: read.warnings };
  if (utf8Length(JSON.stringify(result)) > 5 * 1024 * 1024) return selectedBuild
    ? fail(`PLM 构建记录 ${selectedBuild.id} 的需求范围投影超过 5 MiB`, '请任务包维护人提供保留同一构建来源的分块核对，或由用户明确给出需求编号后按声明范围另开分批运行；不要重复绑定整份构建范围')
    : fail('投影结果超过 5 MiB', '把需求编号列表分成更小的批次');
  return result;
}
export default function project(input: unknown): unknown {
  try { return projectItems(input); } catch (error) {
    return error instanceof ProjectionRefusal ? fail(error.message, error.fix) : fail('投影函数内部出错', '请任务包维护人修复投影后重跑');
  }
}
