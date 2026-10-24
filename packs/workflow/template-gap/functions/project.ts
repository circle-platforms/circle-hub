import { readCommandIdentity, commandKey } from './command-identity.ts';
import { authorClassification } from './classification.ts';
// Item projection of the template-gap pack (W01): every mind map bound to the input slot `documents` is one item. Its fields
// say which categories of the team case template (tables/template-v3.json) the cases of the document show, with the ids of
// those cases as evidence, which categories are missing, and which the run parameter `skipped` declares skipped.
// All requirements of the pack are facts: the coverage check (tables/template-v3-coverage.json) judges these fields at
// start_run and nobody fills anything (a production run).
// Refusals of the whole call: an input that is not a parsed mind map, a document listed twice, a skip the pack cannot apply
// (the caller's own parameter, never dropped silently), a document with no case, documents whose root nodes cannot be told
// apart, and a result above the output limit.
import { caseCategories, caseRevisionNodes, commandCoverage } from './commands.ts';
import type { CaseIndex } from './index.ts';
import { compareText, readCaseIndex } from './index.ts';
import TEMPLATE_TABLE from '../tables/template-v3.json' with { type: 'json' };
import { CASE_LIMITS, casesOf, idSelector, type DocumentCases } from './cases.ts';
import {declareResourceTags,RESOURCE_TAG_TABLE} from './generated/vocabulary.ts';
import { PACK, failure, guarded, isRecord, warningSink } from './common.ts';
import { categoryFacts, MAX_EVIDENCE, readTemplate, type Template } from './template.ts';
import { clip, collapseWhitespace, isBlank, isWhiteSpace, textOf, utf8Length } from './text.ts';
import type { CommandCoverage, DocumentFields, DocumentItem, ItemLocation, PackFailure, ProjectionOutcome, Skip } from './types.ts';

/** The input slot of workflow.json. */
export const SUBJECT_SLOT = 'documents';
const PARSER = 'kityminder@1';
const SHA256 = /^[0-9a-f]{64}$/;

export const LIMITS = {
  maxDocumentId: 120,
  maxLabel: 200,
  /** Skipped categories named in a summary. */
  maxNamed: 6,
  /** Long enough to name every missing category by its id (tested on the worst case). */
  maxSummary: 480,
  /** Problems of the parameter `skipped` named in one refusal. */
  maxSkipProblems: 5,
  /** The sandbox's default output limit (8 MiB): above it the projection refuses with a fix instead of failing. */
  outputBytes: 8 * 1024 * 1024,
} as const;

/** The document id of a bound input: the id of an external object (system:type:id[@revision]), or upload-<SHA-256 prefix>. */
export function documentIdOf(input: { external?: unknown; sha256?: unknown }): string | null {
  if (typeof input.external === 'string' && input.external !== '') {
    const parts = input.external.split(':');
    if (parts.length < 3) return null;
    const id = parts.slice(2).join(':');
    const at = id.indexOf('@');
    return at === -1 ? id : id.slice(0, at);
  }
  if (typeof input.sha256 === 'string' && SHA256.test(input.sha256)) return `upload-${input.sha256.slice(0, 12)}`;
  return null;
}

/** No colon (it separates the document from the node in a case id), no white space, no control character. */
function documentIdProblem(id: string): boolean {
  if (id === '' || id.length > LIMITS.maxDocumentId) return true;
  for (let i = 0; i < id.length; i++) {
    const code = id.charCodeAt(i);
    if (code === 0x3a || code < 0x20 || (code >= 0x7f && code <= 0x9f) || isWhiteSpace(code)) return true;
  }
  return false;
}

/** Labels of the folders above the document, from the top down: `folders` (the agile system pack), else `ancestors`. */
function foldersOf(meta: unknown): string[] {
  if (!isRecord(meta)) return [];
  const list = Array.isArray(meta.folders) ? meta.folders : Array.isArray(meta.ancestors) ? meta.ancestors : [];
  return list.filter((label): label is string => typeof label === 'string');
}

function rootText(nodes: readonly unknown[]): string {
  const root = nodes[0];
  if (!isRecord(root)) return '';
  if (typeof root.text === 'string') return root.text;
  return isRecord(root.data) ? (textOf(root.data.text) ?? '') : '';
}

type Document = { uploaded: boolean; id: string; sha256: string; title: string; path: string[]; cases: DocumentCases; source: Record<string, unknown> };

type SkipEntry = Skip & { document: string | null };

/**
 * The document a skip names, as a document id: the id itself, the external object (system:type:id, with or without
 * @revision), the id with @revision, or the upload reference src:<sha256> of any input.
 */
function skipTarget(value: string, bySha: ReadonlyMap<string, string>): string {
  if (value.startsWith('src:')) return bySha.get(value.slice(4)) ?? value;
  if (value.includes(':')) return documentIdOf({ external: value }) ?? value;
  const at = value.indexOf('@');
  return at === -1 ? value : value.slice(0, at);
}

/**
 * The declared skips (W02 F[8]: a parameter the caller binds): a template category, a reason that is not blank, an optional
 * document of this run, each (document, category) at most once. A skip the pack cannot apply refuses the run with a fix
 * rather than being dropped, so the caller learns that the declaration did not take effect.
 */
function readSkips(raw: unknown, template: Template, documents: readonly Document[], admitted: ReadonlyMap<string, CommandCoverage>): SkipEntry[] | PackFailure {
  if (raw === undefined) return [];
  const ids = documents.map((document) => document.id);
  const listed = `${ids.slice(0, CASE_LIMITS.maxNamed).join('、')}${ids.length > CASE_LIMITS.maxNamed ? ` 等 ${ids.length} 份` : ''}`;
  const fix = `skipped 的每一项写模板里的类别编号和用户给出的理由（不能只有空白）；document 写这次运行里的文档编号（${listed}），或者不写 document，让这一项对所有文档生效；同一份文档的同一个类别和命令只写一项；command 写已绑定索引的完整 CommandIdentity，仅跳过该命令，不写 command 则对整份文档和它的每个命令生效`;
  if (!Array.isArray(raw)) return failure('skip_invalid', '参数 skipped 不是数组', fix);
  const known = new Set(template.categories.map((category) => category.id));
  const inRun = new Set(ids);
  const commandCategories = new Set(template.categories.filter(c => c.group === 'command').map(c => c.id));
  const bySha = new Map(documents.map((document) => [document.sha256, document.id]));
  const problems: string[] = [];
  const out: SkipEntry[] = [];
  const named = new Map<string, number>();
  raw.forEach((entry, index) => {
    const at = `第 ${index + 1} 项`;
    if (!isRecord(entry)) return void problems.push(`${at}不是对象`);
    const category = typeof entry.category === 'string' ? entry.category : null;
    if (category === null || !known.has(category)) return void problems.push(`${at}的类别${category === null ? '没有写' : ` ${clip(category, 40).text} 不是模板里的类别编号`}`);
    if (typeof entry.reason !== 'string' || isBlank(entry.reason)) return void problems.push(`${at}跳过类别 ${category} 却没有写理由（只有空白也不算）`);
    if (entry.document !== undefined && typeof entry.document !== 'string') return void problems.push(`${at}的 document 不是文字`);
    const document = typeof entry.document === 'string' ? skipTarget(entry.document, bySha) : null;
    if (document !== null && !inRun.has(document)) return void problems.push(`${at}写的文档 ${clip(entry.document as string, 60).text} 不在这次运行里`);
    const command = entry.command === undefined ? undefined : readCommandIdentity(entry.command);
    if (entry.command !== undefined && (command === null || !commandCategories.has(category))) return void problems.push(`${at}的 command 要写完整 CommandIdentity，category 只允许 command 组`);
    const identity = command ?? undefined;
    const targets = (document === null ? ids : [document]).filter(id => identity === undefined || [...(admitted.get(id)?.commands.flatMap(c => c.identity ? [c.identity] : []) ?? []), ...(admitted.get(id)?.pending_identities ?? [])].some(i => commandKey(i) === commandKey(identity)));
    if (!targets.length || command !== undefined && document !== null && !targets.includes(document)) return void problems.push(`${at}的命令不在该文档的已绑定索引里；绑定包含该命令的 case_index 后重跑`);
    for (const target of targets) {
      const prefix = `${target}\u0000${category}\u0000`;
      const key = `${prefix}${identity ? commandKey(identity) : ''}`;
      const earlier = named.get(key);
      if (earlier !== undefined) return void problems.push(`${at}和第 ${earlier + 1} 项都对文档 ${target} 跳过类别 ${category}${command === undefined ? '' : `（命令 ${identity?.path}）`}`);
      const overlap = command === undefined ? [...named.keys()].find(k => k.startsWith(prefix)) : named.has(prefix) ? prefix : undefined;
      if (overlap !== undefined) return void problems.push(`${at}与第 ${(named.get(overlap) ?? 0) + 1} 项对同一文档、类别和命令重复跳过`);
      named.set(key, index);
    }
    out.push({ category, reason: entry.reason, document, ...(identity !== undefined ? { command: identity } : {}) });
  });
  if (problems.length === 0) return out;
  const shown = problems.slice(0, LIMITS.maxSkipProblems).join('；');
  return failure('skip_invalid', `参数 skipped 有 ${problems.length} 项不能用：${shown}${problems.length > LIMITS.maxSkipProblems ? ' 等' : ''}`, fix);
}

/** The skips that apply to one document, in template order. */
function skipsFor(document: string, entries: readonly SkipEntry[], template: Template): Skip[] {
  const chosen = new Map<string, string>();
  for (const entry of entries) if (entry.command === undefined && (entry.document === null || entry.document === document)) chosen.set(entry.category, entry.reason);
  return template.categories.filter((category) => chosen.has(category.id)).map((category) => ({ category: category.id, reason: chosen.get(category.id) as string }));
}

/**
 * The one line the model reads (with id and label): cases, every missing category, the declared skips, how many categories
 * occur, untagged nodes. Categories are written `label（id）`; when that does not fit, every one is written by its id only.
 */
function summaryOf(fields: DocumentFields, template: Template): string {
  const labels = new Map(template.categories.map((category) => [category.id, category.label]));
  const uncovered = fields.categories.filter((category) => category.required && !category.present).length;
  const compose = (name: (id: string) => string, note: string, brief = false): string => {
    const parts = [`用例 ${fields.caseCount} 个`];
    const command = fields.command_coverage;
    if (command) {
      const partial = (command.missing_identities?.length ?? 0) > 0 || (command.unclassified?.length ?? 0) > 0 || command.truncated || command.skippedSources > 0 || command.cutKeys.includes(fields.document) || command.unmatched.length > 0;
      const missing = command.commands.filter(row => row.missing.length > 0).length;
      if (command.uploaded) parts.push('按命令：上传文件不在索引里');
      else if (command.rule_mismatch) parts.push('按命令：规则不一致，用默认 marked 重跑');
      else if (!command.bound) parts.push('按命令：未计算，缺 case_index');
      else if (!command.documentIndexed && !command.truncated && command.skippedSources === 0 && !command.cutKeys.includes(fields.document)) parts.push('按命令：文档不在完整索引里，用收了该文档的构建或同步收进后重跑');
      else if (partial) parts.push(`按命令：已读 ${command.commands.length} 个命令，${missing} 个潜在缺口待补证，知识同步后重跑，未判覆盖完整`);
      else if (!command.documentIndexed) parts.push('按命令：文档不在索引里');
      else parts.push(`按命令：${command.commands.length} 个命令，${missing} 个缺类别${command.commands.length === 0 ? '；用例未解析出命令' : ''}`);
    }
    if (!fields.scope_complete) parts.push('用例范围未完整读取，不能判缺类别；修复原件解析后重读');
    else if (fields.unclassified.length > 0) parts.push(`未分类用例 ${fields.unclassified.length} 个；缺逐用例类别判断，先由客户端补主张或作者补 category_ids，再提交核验；不判缺类别`);
    else if (fields.missing.length > 0) parts.push(`缺 ${fields.missing.length} 个模板类别${note}：${fields.missing.map(name).join('、')}`);
    else if (uncovered > 0) parts.push(`模板类别没有缺失（${uncovered} 个声明跳过）`);
    else parts.push(`${fields.categories.length} 个模板类别都已覆盖`);
    if (fields.skipped.length > 0) {
      const shown = fields.skipped.slice(0, LIMITS.maxNamed).map((skip) => name(skip.category));
      parts.push(`参数 skipped 声明跳过 ${fields.skipped.length} 个：${shown.join('、')}${fields.skipped.length > LIMITS.maxNamed ? ' 等' : ''}`);
    }
    parts.push(`模板类别出现 ${fields.categories.filter((category) => category.present).length}/${fields.categories.length} 个`);
    parts.push(brief ? `用例规则：${fields.case_rule === 'marked' ? '标签或标记' : '只认标签'}；仅标记 ${fields.marked_only} 个` : `用例规则：${fields.case_rule === 'marked' ? '标签或标记' : '只认标签'}；其中 ${fields.marked_only} 个只靠标记识别（没有标签）`);
    if (fields.untagged > 0) parts.push(brief ? `未计入未标签 ${fields.untagged} 个` : `另有 ${fields.untagged} 个没有标签、写法像用例的节点没有计入`);
    return parts.join('；');
  };
  const full = compose((id) => `${labels.get(id) ?? id}（${id}）`, '');
  if (full.length <= LIMITS.maxSummary) return full;
  const ids = compose((id) => id, '（只列编号）');
  if (ids.length <= LIMITS.maxSummary) return ids;
  return clip(compose((id) => id, '（只列编号）', true), LIMITS.maxSummary).text;
}

function itemLabel(title: string): string {
  const text = collapseWhitespace(title);
  return text === '' ? '（无标题）' : clip(text, LIMITS.maxLabel).text;
}

/** For tests: another template table, a smaller output limit. The Hub calls the default export, which uses neither. */
export interface ProjectOptions {
  table?: unknown;
  outputBytes?: number;
}

export function projectDocuments(input: unknown, options: ProjectOptions = {}): ProjectionOutcome {
  const warnings = warningSink();
  if (!isRecord(input) || !Array.isArray(input.inputs)) {
    return failure('invalid_input', '输入里没有 inputs 数组', '按 projection-input@1 传入：{ inputs, parameters, context }');
  }
  const outputBytes = options.outputBytes ?? LIMITS.outputBytes;
  const template = readTemplate(options.table ?? TEMPLATE_TABLE);
  if (typeof template === 'string') return failure('template_invalid', `模板表不可用：${template}`, '这是任务包的缺陷：按 template-gap.template@1 改正 tables/template-v3.json');
  const parameters = isRecord(input.parameters) ? input.parameters : {};
  const caseRule: 'marked' | 'tagged' = parameters.case_rule === 'tagged' ? 'tagged' : 'marked';

  const documents: Document[] = [];
  const seen = new Set<string>();
  let position = 0;
  for (const raw of input.inputs) {
    if (isRecord(raw) && raw.slot !== SUBJECT_SLOT) continue;
    position += 1;
    const at = `第 ${position} 份输入`;
    if (!isRecord(raw)) return failure('invalid_input', `${at}不是对象`, '按 projection-input@1 传入绑定的输入', warnings.list());
    const id = documentIdOf(raw);
    if (id === null || documentIdProblem(id)) {
      return failure(
        'invalid_input',
        `${at}的文档编号${id === null ? '读不出来' : `“${clip(id, 40).text}”含有冒号、空白或控制字符，或者超过 ${LIMITS.maxDocumentId} 个字符`}：用例编号写成“文档编号:节点编号”，文档编号要能和节点编号分开`,
        '用敏捷平台的脑图编号（agile:mindmap:<文档编号>），或者上传脑图文件',
        warnings.list(),
      );
    }
    if (seen.has(id)) return failure('invalid_input', `文档 ${id} 在输入里出现了两次`, '每份文档只给一次', warnings.list(), [id]);
    seen.add(id);
    const model = raw.model;
    if (raw.parser !== PARSER || !isRecord(model) || !Array.isArray(model.nodes) || model.nodes.length === 0) {
      return failure(
        'invalid_input',
        `文档 ${id} 不是 KityMinder 脑图（解析器 ${typeof raw.parser === 'string' ? raw.parser : '未给出'}）`,
        '上传 KityMinder 导出的脑图 JSON，或者用 {"external": "agile:mindmap:<文档编号>"} 让 Hub 从敏捷平台读取',
        warnings.list(),
        [id],
      );
    }
    const nodes = model.nodes as unknown[];
    const cases = casesOf(id, nodes, warnings, { caseRule });
    const metaTitle = isRecord(raw.meta) && typeof raw.meta.title === 'string' && !isBlank(raw.meta.title) ? raw.meta.title : null;
    documents.push({ uploaded: typeof raw.external !== 'string' || !raw.external.startsWith('agile:mindmap:'), id, sha256: typeof raw.sha256 === 'string' ? raw.sha256 : '', title: metaTitle ?? rootText(nodes), path: foldersOf(raw.meta), cases, source: { sha256: raw.sha256, model: raw.model } });
  }
  if (documents.length === 0) return failure('invalid_input', `输入槽 ${SUBJECT_SLOT} 里没有要检查的脑图`, '在 inputs.documents 里给出至少一份脑图', warnings.list());

  const agileDocuments = input.inputs.filter(isRecord).filter(raw => raw.slot === SUBJECT_SLOT && typeof raw.external === 'string' && raw.external.startsWith('agile:mindmap:')).map(raw => documentIdOf(raw) as string);
  const caseIndex = readCaseIndex(input, agileDocuments);
  if (caseIndex !== null && 'error' in caseIndex) return { ...caseIndex, warnings: warnings.list() };

  const admitted = new Map(documents.map(document => [document.id, commandCoverage(template, document.id, document.cases.cases.map(c => ({ id: c.id, visit: c.visit, categories: [] })), caseIndex, [], document.uploaded, {}, caseRule, caseRevisionNodes(document.cases))]));
  const skips = readSkips(parameters.skipped, template, documents, admitted);
  if (!Array.isArray(skips)) return { ...skips, warnings: warnings.list() };

  const empty = documents.filter((document) => document.cases.cases.length === 0);
  if (empty.length > 0) {
    const names = empty.length === 1 ? `文档 ${empty[0].id} ` : `${empty.length} 份文档（${empty.map((document) => document.id).join('、')}）`;
    const untagged = empty.reduce((sum, document) => sum + document.cases.untagged, 0);
    const rule = caseRule === 'tagged' ? '用例是标签（resource）不为空的节点' : '用例是标签（resource）不为空的节点，或者带用例优先级 2、有子节点的节点';
    const hint = untagged > 0 ? `；其中有 ${untagged} 个没有标签、写法像用例的节点（优先级 2、有子节点），模板 v3 的用例要带测试类型标签` : '';
    return failure(
      'no_case',
      `${names}里没有用例节点：${rule}${hint}`,
      untagged > 0 ? '给这些用例节点打上测试类型标签（Functional、Configuration、Integration、Compatibility、Negative、Stress）后重新开始运行，或者把这些文档从输入里去掉' : '把没有用例的文档从输入里去掉，或者换成测试用例脑图，再重新开始运行',
      warnings.list(),
      empty.map((document) => document.id),
    );
  }

  // The item location is the root node. With several documents bound to the slot it must resolve in exactly one of them.
  const locations = new Map<string, ItemLocation>();
  const ambiguous: string[] = [];
  for (const document of documents) {
    const byId = idSelector(document.cases.rootId, document.cases.ids);
    if (documents.length === 1) locations.set(document.id, { parser: PARSER, selector: byId ?? 'i' });
    else if (byId === null || documents.some((other) => other !== document && idSelector(document.cases.rootId, other.cases.ids) !== null)) ambiguous.push(document.id);
    else locations.set(document.id, { parser: PARSER, selector: byId });
  }
  if (ambiguous.length > 0) {
    return failure(
      'root_ambiguous',
      `${ambiguous.length === 1 ? `文档 ${ambiguous[0]} ` : `${ambiguous.length} 份文档（${ambiguous.join('、')}）`}的根节点在这次运行的几份文档之间区分不开：根节点没有只出现一次的编号，或者另一份文档里也有这个编号的节点`,
      '把这些文档分开，每份单独开始一次运行；或者在脑图工具里另存一份，让根节点有自己的编号',
      warnings.list(),
      ambiguous.slice(0, CASE_LIMITS.maxNamed),
    );
  }

  try { for (const document of documents) authorClassification(template, document.cases.cases); }
  catch (error) { return failure('invalid_input', error instanceof Error ? error.message : 'category_ids 结构不合法', '在原件中用 category_ids 声明模板闭集中的精确编号，不转换标签同义词'); }
  const classifications = new Map(documents.map(d => [d.id, authorClassification(template, d.cases.cases)]));
  const fullFacts = new Map(documents.map(document => [document.id, categoryFacts(template, document.cases, { evidenceLimit: Infinity })]));
  const memberships = new Map(documents.map(document => [document.id, caseCategories(template, document.cases, fullFacts.get(document.id))]));
  const revisions = new Map(documents.map(document => [document.id, caseRevisionNodes(document.cases)]));
  const commandSkips = (id: string): Skip[] => skips.filter(s => s.document === null || s.document === id).map(({ category, reason, command }) => ({ category, reason, ...(command !== undefined ? { command } : {}) })).sort((a,b) => template.categories.findIndex(c => c.id === a.category) - template.categories.findIndex(c => c.id === b.category) || compareText(a.command ? commandKey(a.command) : '', b.command ? commandKey(b.command) : ''));
  const lock = isRecord(input.context) ? input.context : {};
  const items: DocumentItem[] = documents.map((document) => {
    const categories = fullFacts.get(document.id)!.map(fact => ({ ...fact, evidence: fact.evidence.slice(0, MAX_EVIDENCE) }));
    const skipped = skipsFor(document.id, skips, template);
    const skippedIds = new Set(skipped.map((skip) => skip.category));
    const marked_only = document.cases.markedOnly;
    const fields: DocumentFields = {
      document: document.id,
      title: document.title,
      path: document.path,
      caseCount: document.cases.cases.length,
      untagged: document.cases.untagged,
      case_rule: caseRule,
      marked_only,
      data: { case_rule: caseRule, marked_only },
      categories,
      classifications: classifications.get(document.id)!.cases,
      classification_status: classifications.get(document.id)!.unclassified.length ? 'unclassified' : 'classified',
      unclassified: classifications.get(document.id)!.unclassified,
      scope_complete: !warnings.list().some(w => w.document === document.id && ['template-gap.model_malformed', 'template-gap.depth_limit'].includes(w.code)),

      case_resources:document.cases.cases.map(c=>({case:c.id,present:c.resource!==undefined,resource:c.resource??null})),
      tag_table:RESOURCE_TAG_TABLE,
      tag_undeclared_cases:document.cases.cases.filter(c=>declareResourceTags(c.resource).status==='undeclared').length,
      command_coverage: commandCoverage(template, document.id, memberships.get(document.id)!, caseIndex, commandSkips(document.id), document.uploaded, lock, caseRule, revisions.get(document.id)),
      missing: classifications.get(document.id)!.unclassified.length || warnings.list().some(w => w.document === document.id && ['template-gap.model_malformed','template-gap.depth_limit'].includes(w.code)) ? [] : categories.filter((category) => category.required && !category.present && !skippedIds.has(category.id)).map((category) => category.id),
      skipped,
    };
    return { id: document.id, label: itemLabel(document.title), summary: summaryOf(fields, template), location: locations.get(document.id) as ItemLocation, fields };
  });
  const groups: Record<string, unknown>[] = items.map((item) => ({
    classification_source: documents.find(d => d.id === item.id)!.source,
    command_cases: memberships.get(item.id)!,
    command_nodes: revisions.get(item.id)!,
    command_skips: commandSkips(item.id),
    uploaded: documents.find(d => d.id === item.id)!.uploaded,
    kind: 'document',
    id: item.id,
    title: item.label,
    cases: item.fields.caseCount,
    case_rule: item.fields.case_rule,
    marked_only: item.fields.marked_only,
    rule_summary: `用例规则：${item.fields.case_rule === 'marked' ? '标签或标记' : '只认标签'}；其中 ${item.fields.marked_only} 个只靠标记识别（没有标签）`,
    data: item.fields.data,
  }));
  if (caseIndex !== null) {
    const source = input.inputs.filter(isRecord).find(i => i.slot === 'case_index');
    groups.push({ kind: 'case_index', view: caseIndex, reference: typeof source?.sha256 === 'string' && SHA256.test(source.sha256) ? `src:${source.sha256}` : null });
  }
  const result = { items, groups, warnings: warnings.list() };
  const bytes = utf8Length(JSON.stringify(result));
  if (bytes > outputBytes) {
    return failure('too_large', `投影结果有 ${bytes} 字节（${items.length} 份文档），超过输出上限 ${outputBytes} 字节`, '把文档分成几批，每批单独开始一次运行', [], [...seen].slice(0, CASE_LIMITS.maxNamed));
  }
  return result;
}

export default function (input: unknown): unknown {
  return guarded(() => projectDocuments(input));
}
