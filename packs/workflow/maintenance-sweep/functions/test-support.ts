import type { ChangeKind } from '../../../../contracts/generated/vocabulary.ts';
// Synthetic impact views for the maintenance-sweep tests. Not a pack file.

export const FROM_ROOT = 'ab'.repeat(32);
export const TO_ROOT = 'cd'.repeat(32);
export const SOURCE = 'ef'.repeat(32);

export const hex = (n: number): string => n.toString(16).padStart(64, '0');
export const tree = (root: string, path: string, entry: string): string => `tree:${root}${path}@${entry}`;

export interface CaseSpec {
  document: string | number;
  node: string | number;
  title?: string;
  priority?: number | null;
  negative?: boolean;
}

export interface ChangeSpec {
  path: string;
  change: ChangeKind;
  before?: { [key: string]: unknown }[];
  after?: { [key: string]: unknown }[];
  behaviourBefore?: string[];
  behaviourAfter?: string[];
  from?: CaseSpec[];
  to?: CaseSpec[];
}

export interface BuildOptions {
  /** The changed kinds the view was asked for; default definition-only (decision 11). */
  changedKinds?: string[];
  /** The catalog the view was filtered to (catalog-entry@1 members compared by syntax); null: no catalog filter. */
  catalog?: string | null;
  skipped?: { from: number; to: number };
  truncated?: boolean;
  changedPaths?: number;
  notes?: string[];
  attached?: string[];
  unplaced?: Array<CaseSpec & { path: string }>;
  unchanged?: { path: string; to?: CaseSpec[]; from?: CaseSpec[] };
}

/** The hand-built pair the review questions are answered on. */
export function reviewChanges(): ChangeSpec[] {
  return [
    {
      path: '/commands/extra',
      change: 'modified',
      before: [{ name: 'extra', args: [{ name: 'n', type: 'string' }] }],
      after: [{ name: 'extra', args: [{ name: 'n', type: 'integer' }] }],
      to: [{ document: 'doc-2', node: 'n2', title: '设置数量', priority: 2 }],
    },
    {
      path: '/commands/show',
      change: 'modified',
      before: [{ name: 'show', help: '旧帮助' }],
      after: [{ name: 'show', help: '新帮助' }],
      behaviourBefore: ['旧的行为说明'],
      behaviourAfter: ['新的行为说明'],
      from: [{ document: 'doc-9', node: 'old', title: '较早构建里的用例', priority: 1 }],
      to: [{ document: 'doc-1', node: 'n1', title: '查看部件状态', priority: 1, negative: true }],
    },
    {
      path: '/commands/add',
      change: 'added',
      after: [{ name: 'add' }],
      to: [
        { document: 'doc-1', node: 'n1', title: '查看部件状态', priority: 1, negative: true },
        { document: 'doc-6', node: 'n1', title: '只覆盖新增命令', priority: 3 },
      ],
    },
    {
      path: '/commands/drop',
      change: 'removed',
      before: [{ name: 'drop' }],
      from: [{ document: 'doc-3', node: 'n9', title: '已删除命令上的用例', priority: 1 }],
    },
    {
      path: '/commands/bare',
      change: 'added',
      after: [{ name: 'bare' }],
    },
    {
      path: '/commands/text',
      change: 'modified',
      before: [{ name: 'text', help: '相同' }],
      after: [{ name: 'text', help: '相同' }],
      behaviourBefore: ['说明甲'],
      behaviourAfter: ['说明乙'],
      to: [{ document: 'doc-5', node: 'n1', title: '只改了行为说明', priority: 1 }],
    },
  ];
}

export function reviewOptions(): BuildOptions {
  return {
    unchanged: { path: '/commands/same', to: [{ document: 'doc-4', node: 'n1', title: '未变更路径上的用例', priority: 1 }] },
    unplaced: [{ document: 'doc-8', node: 'n1', title: '没有放在变更路径上的用例', path: '/commands/other', priority: 1 }],
  };
}

/** An impact-view@1 object. Entry digests are assigned in input order; the scope must not depend on that order. */
export function buildImpact(changes: readonly ChangeSpec[], options: BuildOptions = {}): { [key: string]: unknown } {
  let n = 1;
  const next = (): string => (n++).toString(16).padStart(64, '0');
  const entries: { [key: string]: unknown } = {};
  const add = (kind: string, data: { [key: string]: unknown }, statement: string, path: string, root: string): string => {
    const entry = next();
    entries[entry] = { entry, kind, statement, data, reference: tree(root, path, entry) };
    return entry;
  };
  const addCase = (spec: CaseSpec, path: string, root: string): string => {
    const title = spec.title ?? '用例';
    const data: { [key: string]: unknown } = { document: spec.document, node: spec.node, title };
    if (spec.priority !== undefined) data.priority = spec.priority;
    if (spec.negative === true) data.negative = true;
    return add('case', data, title, path, root);
  };
  const changeRows: unknown[] = [];
  const placements: unknown[] = [];
  for (const change of changes) {
    const before = [
      ...(change.before ?? []).map((data) => add('definition', data, '定义', change.path, FROM_ROOT)),
      ...(change.behaviourBefore ?? []).map((text) => add('behaviour', {}, text, change.path, FROM_ROOT)),
    ];
    const after = [
      ...(change.after ?? []).map((data) => add('definition', data, '定义', change.path, TO_ROOT)),
      ...(change.behaviourAfter ?? []).map((text) => add('behaviour', {}, text, change.path, TO_ROOT)),
    ];
    const from = (change.from ?? []).map((spec) => addCase(spec, change.path, FROM_ROOT));
    const to = (change.to ?? []).map((spec) => addCase(spec, change.path, TO_ROOT));
    changeRows.push({ path: change.path, change: change.change, before, after });
    if (from.length + to.length > 0) placements.push({ path: change.path, from, to });
  }
  if (options.unchanged !== undefined) {
    const path = options.unchanged.path;
    const from = (options.unchanged.from ?? []).map((spec) => addCase(spec, path, FROM_ROOT));
    const to = (options.unchanged.to ?? []).map((spec) => addCase(spec, path, TO_ROOT));
    if (from.length + to.length > 0) placements.push({ path, from, to });
  }
  for (const spec of options.unplaced ?? []) addCase(spec, spec.path, TO_ROOT);
  const attachedFrom = placements.reduce((sum: number, row) => sum + (row as { from: unknown[] }).from.length, 0);
  const attachedTo = placements.reduce((sum: number, row) => sum + (row as { to: unknown[] }).to.length, 0);
  return {
    schema: 'impact-view@1',
    product: 'widget',
    // The pack requires catalog=commands@1 (decision 11); fixtures stand for valid bindings, so it is the default.
    // A test of the refusal passes `catalog: null` to omit the field.
    ...(options.catalog === null ? {} : { catalog: options.catalog ?? 'commands@1' }),
    from: { build: 'Rel_W_1_0_1', root: FROM_ROOT },
    to: { build: 'Rel_W_1_0_2', root: TO_ROOT },
    changed_kinds: options.changedKinds ?? ['definition'],
    attached_kinds: options.attached ?? ['case'],
    changes: changeRows,
    placements,
    entries,
    totals: { changed_paths: options.changedPaths ?? changeRows.length, attached_from: attachedFrom, attached_to: attachedTo },
    truncated: options.truncated ?? false,
    skipped: { from: options.skipped?.from ?? 0, to: options.skipped?.to ?? 0 },
    notes: options.notes ?? [],
  };
}

/** The hand-built pair the maintenance review is answered on. */
export function reviewSweep(): ChangeSpec[] {
  return [
    {
      path: '/commands/drop',
      change: 'removed',
      before: [{ name: 'drop' }],
      from: [
        { document: 'doc-1', node: 'n1', title: '删除上的甲', priority: 1 },
        { document: 'doc-2', node: 'n2', title: '删除上的乙', priority: 2 },
      ],
    },
    {
      path: '/commands/show',
      change: 'modified',
      before: [{ name: 'show', args: [{ name: 'n', type: 'string' }] }],
      after: [{ name: 'show', args: [{ name: 'n', type: 'integer' }] }],
      from: [{ document: 'doc-3', node: 'n1', title: '签名变了', priority: 1 }],
      to: [{ document: 'doc-9', node: 'n9', title: '只在后一构建', priority: 1 }],
    },
    {
      path: '/commands/help',
      change: 'modified',
      before: [{ name: 'help', help: '旧帮助' }],
      after: [{ name: 'help', help: '新帮助' }],
      from: [{ document: 'doc-4', node: 'n1', title: '帮助变了', priority: 1 }],
    },
    {
      path: '/commands/text',
      change: 'modified',
      before: [{ name: 'text', help: '相同' }],
      after: [{ name: 'text', help: '相同' }],
      behaviourBefore: ['说明甲'],
      behaviourAfter: ['说明乙'],
      from: [{ document: 'doc-5', node: 'n1', title: '只改了行为说明', priority: 1 }],
    },
    {
      path: '/commands/add',
      change: 'added',
      after: [{ name: 'add' }],
      from: [{ document: 'doc-6', node: 'n1', title: '新增路径上的旧用例', priority: 1 }],
    },
  ];
}

/** Reverses every list and the entry-table key order. A correct sweep is unchanged. */
export function reversedView(view: { [key: string]: unknown }): { [key: string]: unknown } {
  const copy = structuredClone(view) as { [key: string]: unknown };
  const changes = [...(copy.changes as { before: string[]; after: string[] }[])].reverse();
  for (const change of changes) {
    change.before = [...change.before].reverse();
    change.after = [...change.after].reverse();
  }
  const placements = [...(copy.placements as { from: string[]; to: string[] }[])].reverse();
  for (const placement of placements) {
    placement.from = [...placement.from].reverse();
    placement.to = [...placement.to].reverse();
  }
  const entries: { [key: string]: unknown } = {};
  for (const key of Object.keys(copy.entries as object).reverse()) entries[key] = (copy.entries as { [key: string]: unknown })[key];
  return { ...copy, changes, placements, entries };
}
// Bind the required synthetic disclosure input for existing projection scenarios.
export function facetInput(view: { [key: string]: unknown }, unplaced = 0): { [key: string]: unknown } {
  return { slot: 'facets', sha256: SOURCE, model: { schema: 'facet-view@1', product: view.product, build: structuredClone(view.from), kind: 'case', by: ['commands'], rows: unplaced ? [{ values: { commands: null }, count: unplaced }] : [], total: unplaced, totals:{empty:{commands:unplaced}}, truncated: false, skipped: (view.skipped as {from:number;to:number})?.from ?? 0, notes: [] } };
}
import { projectItems as rawProject, LIMITS } from './project.ts';
export { LIMITS };
export function projectItems(input: unknown, limits: Parameters<typeof rawProject>[1] = {}): unknown {
  const value = input as { inputs?: Array<{ slot?: string; model?: unknown }> };
  const impact = value?.inputs?.find((v) => v.slot === 'impact')?.model;
  if (impact && typeof impact === 'object' && !value.inputs?.some((v) => v.slot === 'facets')) return rawProject({ ...value, inputs: [...value.inputs!, facetInput(impact as { [key: string]: unknown })] }, limits);
  return rawProject(input, limits);
}
