// Pure projection: caller-supplied ids, or ids explicitly declared by a configured build record.
import type { BoundInput, ProjectedItem } from '../../../../contracts/src/pack.ts';
import { normalizeId } from './ids.ts';
import { isRecord, strings, shown, utf8Length } from './text.ts';
import { readIndexView } from './views.ts';

export type Story = { id: string; status: string | null; stage: string | null; title: string | null };
export type Case = { case: string; title: string; document: string | null; reference: string; stories: string[] | null };
export type Row = Story & { plm_returned: boolean; cases: Case[]; references: string[]; build: string; scope: string };
export const validId = (id: string): boolean => /^[1-9][0-9]{0,14}$/.test(normalizeId(id));
const fail = (message: string, fix: string) => ({ error: { code: 'story-traceability.invalid_input', message, fix } });

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
  const scope = storyInputs.length > 0 ? '需求范围由用户提供' : '需求范围取自构建记录';
  function add(raw: string, record: unknown, source: BoundInput, selector: string) {
    if (!validId(raw)) throw new Error('需求编号应为最多 15 位正整数');
    const id = normalizeId(raw);
    const r = isRecord(record) ? record : null;
    const next: Row = { id, title: r && typeof r.title === 'string' ? r.title : null,
      status: r && typeof r.status === 'string' ? r.status : null, stage: r && typeof r.stage === 'string' ? r.stage : null,
      plm_returned: r !== null, cases: [], references: [`src:${source.sha256}/json@1/${selector}`], build: view.build, scope };
    const previous = rows.get(id);
    if (previous && previous.plm_returned && next.plm_returned && JSON.stringify([previous.status, previous.stage, previous.title]) !== JSON.stringify([next.status, next.stage, next.title])) throw new Error('同一需求的 PLM 原件内容冲突，请重新导出一致原件');
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
    if (!validId(params.build_id)) return fail('构建编号无效', '明确给出 build_id 正整数编号');
    const model = isRecord(source.model) ? source.model : {};
    const builds = Array.isArray(model.builds) ? model.builds : [];
    const at = builds.findIndex(b => isRecord(b) && String(b.id) === params.build_id);
    const build = builds[at];
    if (!isRecord(build) || !Array.isArray(build.stories) || build.stories.length === 0) {
      return fail(`构建记录里没有需求字段，请给出需求编号；${isRecord(build) && typeof build.scope_note === 'string' ? build.scope_note : '缺少指定构建记录'}`, '向用户索取需求编号；请管理员核实 PLM 资源 settings.build_story_field 和构建记录原件');
    }
    for (const id of build.stories) add(String(id), null, source, `p/builds/${at}`);
  }
  if (rows.size === 0 || rows.size > 8000) return fail('需求范围为空或超过 8000 条', '提供非空需求编号列表；超限则分批运行');
  const byId = new Map<string, Map<string, Case>>();
  for (const [key, digests] of Object.entries(view.keys)) {
    const id = normalizeId(key);
    const bucket = byId.get(id) ?? new Map<string, Case>(); byId.set(id, bucket);
    for (const digest of digests) {
      const entry = view.entries[digest]; if (!entry) continue;
      const data = entry.data;
      bucket.set(digest, { case: typeof data.node === 'string' ? data.node : digest, title: typeof data.title === 'string' ? data.title : entry.statement,
        document: typeof data.document === 'string' ? data.document : null, reference: entry.reference,
        stories: Object.hasOwn(data, 'stories') ? strings(data.stories) : null });
    }
  }
  const items: ProjectedItem[] = [...rows.values()].sort((a, b) => Number(a.id) - Number(b.id)).map(row => {
    row.cases = [...(byId.get(row.id)?.values() ?? [])].sort((a, b) => a.case < b.case ? -1 : a.case > b.case ? 1 : (a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0));
    const loc = locations.get(row.id)!;
    return { id: row.id, label: shown(`需求 ${row.id}${row.title ? ` ${row.title}` : ''}`),
      summary: shown(`${row.cases.length ? `${row.cases.length} 个用例` : '无已索引用例（未知）'}；${scope}`),
      location: { slot: loc.slot, source: loc.source, parser: 'json@1', selector: loc.selector }, fields: row as unknown as Record<string, unknown> };
  });
  const facts = { product: view.product, build: view.build, root: view.root, scope, view: { source: view.source, truncated: view.truncated, skipped: view.skipped, missing: view.missing,
    total_keys: view.total_keys, total_entries: view.total_entries, listed_keys: Object.keys(view.keys).length, listed_entries: Object.keys(view.entries).length } };
  const result = { items, groups: [facts], warnings: read.warnings };
  if (utf8Length(JSON.stringify(result)) > 5 * 1024 * 1024) return fail('投影结果超过 5 MiB', '把需求编号列表分成更小的批次');
  return result;
}
export default function project(input: unknown): unknown {
  try { return projectItems(input); } catch { return fail('需求原件无效或内容冲突', '核对需求编号和 PLM 原件；请管理员修正来源后重跑'); }
}
