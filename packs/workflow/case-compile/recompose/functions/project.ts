import { analyzeStructure } from './generated/skills/mindmap-format/case-structure/index.ts';

const MAX_SCOPE_CASES = 64;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
type RecomposeProjection = {
  error?: { code: string; message: string; fix: string; pointer?: string };
  items?: Array<{
    id: string;
    label: string;
    location: { slot: string; parser: string; selector: string };
    fields: Record<string, any>;
  }>;
  groups?: Array<Record<string, any>>;
  warnings: Array<{ code: string; message: string }>;
};

const fail = (message: string, fix: string, pointer?: string): RecomposeProjection => ({
  error: { code: 'SUBMISSION_SCHEMA_VIOLATION', message, fix, ...(pointer ? { pointer } : {}) },
  warnings: [],
});

export default function (input: any): RecomposeProjection {
  const subject = input.inputs?.find((s: any) => s.slot === 'subject');
  if (subject?.parser !== 'kityminder@1') {
    return fail('重组必须绑定完整脑图结构', '作者重新导出并重读完整脑图');
  }
  const context = input.context ?? {};
  const report = analyzeStructure(subject.model, subject.sha256, input.parameters?.case_depths);
  const allSelected = report.cases.filter((c) => !c.excluded.length && c.autoid !== null);
  const excluded = report.cases.filter((c) => c.excluded.length);

  const scopeAsked = input.parameters?.scope;
  let frozenScope: { words: string; cases: string[] } | null = null;
  let scoped: Set<string> | null = null;
  if (scopeAsked !== undefined) {
    if (!isRecord(scopeAsked) || Object.keys(scopeAsked).some((k) => k !== 'words' && k !== 'cases')) {
      return fail('parameters.scope 只允许 words 与 cases 两个字段', '写成 {"words":"<范围原话>","cases":["<autoid>",...]}', '/parameters/scope');
    }
    if (typeof scopeAsked.words !== 'string' || scopeAsked.words.trim().length === 0 || scopeAsked.words.length > 4000) {
      return fail('parameters.scope.words 不能为空且长度不超过 4000 字', '在 scope.words 填入本次范围说明原文', '/parameters/scope/words');
    }
    if (
      !Array.isArray(scopeAsked.cases) ||
      scopeAsked.cases.length === 0 ||
      scopeAsked.cases.length > MAX_SCOPE_CASES ||
      scopeAsked.cases.some((v) => typeof v !== 'string' || !v.length || v.length > 128) ||
      new Set(scopeAsked.cases).size !== scopeAsked.cases.length
    ) {
      return fail(`parameters.scope.cases 必须是不重复的非空 autoid 文字列表（1 至 ${MAX_SCOPE_CASES} 条）`, '写成 ["<autoid>", ...]，从用例原文复制 autoid', '/parameters/scope/cases');
    }
    const available = new Set(allSelected.map((c) => c.autoid as string));
    const missing = (scopeAsked.cases as string[]).filter((id) => !available.has(id));
    if (missing.length > 0) {
      return fail(`scope.cases 里的 ${missing.slice(0, 5).join('、')} 在脑图可选的带 autoid 自动化用例里找不到`, '核对完整脑图和 autoid 原文后重新开始重组运行', '/parameters/scope/cases');
    }
    frozenScope = { words: scopeAsked.words.trim(), cases: [...(scopeAsked.cases as string[])] };
    scoped = new Set(frozenScope.cases);
  }

  const selected = scoped ? allSelected.filter((c) => scoped.has(c.autoid as string)) : allSelected;
  const outOfScope = scoped
    ? allSelected
        .filter((c) => !scoped.has(c.autoid as string))
        .map((c) => ({ autoid: c.autoid as string, title: c.atoms.find((a: any) => a.kind === 'intent')?.text ?? '' }))
    : [];

  return {
    items: selected.map((c) => ({
      id: c.selector,
      label: c.autoid ?? c.id,
      location: { slot: 'subject', parser: 'kityminder@1', selector: c.selector },
      fields: {
        case_id: c.autoid ?? c.id,
        title: c.atoms.find((a: any) => a.kind === 'intent')?.text ?? undefined,
        source_ref: 'src:' + subject.sha256,
        node: c.selector,
        atoms: c.atoms,
        missing: c.missing,
        qualification: c.eligible ? 'eligible' : 'undetermined',
        layout: c.layout,
      },
    })),
    groups: [
      {
        kind: 'recompose-scope@1',
        source_ref: 'src:' + subject.sha256,
        items: selected.map((c) => c.selector),
        ...(frozenScope ? { scope: { words: frozenScope.words, cases: frozenScope.cases, out_of_scope: outOfScope } } : {}),
        excluded,
        unclassified: report.unclassified,
        inputs: input.inputs?.filter((s: any) => s.slot !== 'subject'),
        run: context.run,
        predecessor: context.predecessor,
      },
    ],
    warnings: report.unclassified.length ? [{ code: 'recompose.node_undetermined', message: '存在结构未判定节点，已逐节点保留缺事实和作者出口' }] : [],
  };
}
