// Item projection of the case-location pack (W01): the mind-map documents bound to the subject slot, with the tree facts the
// agile system pack derived for each (BoundInput.meta: title, ancestors, root), become one item per document (default) or
// one item per case node (parameter granularity case). The fields carry what the projection read about the item; the run
// facts (product names, parameters) reach the check through the subject builder. The summary is the answer of locate.ts on
// the same input, so the model reads the location next to the item's id and label (a tool result is read as id, label and
// summary). A location must name one node of one bound document: with several documents the selector is one no other bound
// document resolves (and FragmentRef.source names the document).
import { locateInputOf, locateItem, summaryOf } from './locate.ts';
import { readParameters } from './params.ts';
import { PACK, guarded, isRecord, shown, strings } from './text.ts';
import type { BoundInput, ItemFields, KityMinderModel, LocatedDocument, MindMapNode, PackWarning, ProjectedItem } from './types.ts';

/** The input slot of the documents (workflow.json). */
export const SLOT = 'documents';
const PARSER = 'kityminder@1';
const MAX_ITEM_ID = 200;
const MAX_DOCUMENT_ID = 120;
const MAX_LABEL = 200;
/**
 * Budgets under the sandbox's default output limit (8 MiB), so that a run too large is a refusal with a fix: the projection's
 * own output, and the number of items, because the check answers every item in one call with about the item's fields plus
 * 1 KiB of statement and notes each.
 */
export const OUTPUT_BUDGET = 5 * 1024 * 1024;
export const MAX_ITEMS = 2500;
const DOCUMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const EXTERNAL = /^[a-z][a-z0-9-]*:[a-z][a-z0-9_-]*:([^@]+)(?:@.*)?$/;

type Refusal = { error: { code: string; message: string; fix: string; documents?: string[] }; warnings: PackWarning[] };
type Output = { items: ProjectedItem[]; warnings: PackWarning[] } | Refusal;

function refusal(code: string, message: string, fix: string, warnings: PackWarning[] = [], documents?: string[]): Refusal {
  return { error: { code: `${PACK}.${code}`, message, fix, ...(documents !== undefined && documents.length > 0 ? { documents } : {}) }, warnings };
}

/** UTF-8 bytes of a text (a lone surrogate counts three bytes, like U+FFFD). */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** The root's name as the system pack gives it: a string, or an object with a name, title or label. */
function rootName(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (isRecord(value)) {
    for (const key of ['name', 'title', 'label']) {
      const text = value[key];
      if (typeof text === 'string' && text.trim() !== '') return text;
    }
  }
  return null;
}

/** The document id: the key of the external object (agile:mindmap:<key>[@revision]), else a short digest. */
function documentIdOf(input: BoundInput): string {
  const key = input.external === null ? null : (EXTERNAL.exec(input.external)?.[1] ?? null);
  return key ?? `src-${input.sha256.slice(0, 16)}`;
}

function isModel(model: unknown): model is KityMinderModel {
  return isRecord(model) && Array.isArray(model.nodes) && model.nodes.length > 0 && model.nodes.every((n) => isRecord(n) && typeof n.selector === 'string' && typeof n.text === 'string');
}

/** Nodes of a document addressable by id (selector n/<id>): only these can be unique among several documents. */
function idSelectors(model: KityMinderModel): Set<string> {
  return new Set(model.nodes.filter((n) => n.selector.startsWith('n/')).map((n) => n.selector));
}

/** The case priority of the team template (decision 18: a node is a case when tagged or marked with it). */
const CASE_PRIORITY = 2;

function isCase(node: MindMapNode): boolean {
  return isRecord(node.data) && ((Array.isArray(node.data.resource) && node.data.resource.length > 0) || node.data.priority === CASE_PRIORITY);
}

/** Texts of the map nodes between the map root and a node (both excluded), top down. */
function mapPath(nodes: readonly MindMapNode[], index: number): string[] {
  const out: string[] = [];
  const seen = new Set<number>();
  for (let at = nodes[index].parent; at !== null && at !== 0 && !seen.has(at); at = nodes[at]?.parent ?? null) {
    seen.add(at);
    out.push(nodes[at]?.text ?? '');
  }
  return out.reverse();
}

/** What a parameter must look like, for a refusal the caller can act on (the schemas cannot say it: no patterns there). */
const PARAMETER_RULES: Readonly<Record<string, string>> = {
  product: 'product 是 1 到 100 个字符的产品名称',
  line: 'line 是两到四段数字的版本号，例如 10.6.1',
  granularity: 'granularity 只能是 document 或 case',
  id_ranges: 'id_ranges 写成 { story: { min, max }, bug: { min, max } }，边界是非负整数，min 不大于 max',
};

export function projectItems(input: unknown): Output {
  if (!isRecord(input) || !Array.isArray(input.inputs)) return refusal('invalid_input', '输入里没有 inputs 数组', '按 projection-input@1 传入绑定的源文件');
  const parameters = readParameters(input.parameters);
  const context = isRecord(input.context) ? input.context : {};
  const names = strings(context.names);
  const product = typeof context.product === 'string' ? context.product : null;
  const warnings: PackWarning[] = [];
  if (parameters.ignored.length > 0) {
    // A declaration the scheme cannot read would be dropped without the caller knowing: refuse it with the rule instead.
    return refusal('invalid_parameter', `参数 ${parameters.ignored.join('、')} 的取值无效`, `改正后重新开始运行：${parameters.ignored.map((name) => PARAMETER_RULES[name]).join('；')}`);
  }
  if (names.length === 0 || product === null) {
    warnings.push({
      code: `${PACK}.unbound_product`,
      message: '运行没有绑定产品线：目录树的根对不上任何产品线，每个条目的产品线都定不出；开始运行时用 product 写明产品名称（同一产品线的任何名称都可以）',
    });
  }

  // The documents of the subject slot, each a parsed mind map with its tree facts.
  const documents: LocatedDocument[] = [];
  const seen = new Set<string>();
  for (const [k, raw] of (input.inputs as unknown[]).entries()) {
    if (!isRecord(raw) || raw.slot !== SLOT) continue;
    const bound = raw as unknown as BoundInput;
    const at = `第 ${k + 1} 份输入`;
    if (typeof bound.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(bound.sha256)) return refusal('invalid_input', `${at}没有源文件摘要`, '按 projection-input@1 传入绑定的源文件', warnings);
    const document = documentIdOf(bound);
    if (bound.parser !== PARSER || !isModel(bound.model)) {
      return refusal('not_a_mindmap', `文档 ${shown(document, 40)} 不是能解析的 KityMinder 脑图`, '只绑定测试脑图文档（敏捷测试平台的脑图）', warnings, [document]);
    }
    if (document.length > MAX_DOCUMENT_ID || !DOCUMENT_ID.test(document)) {
      return refusal('invalid_document_id', `${at}的文档编号“${shown(document, 40)}”不能写进条目编号（只能用字母、数字、点、下划线和连字符，最长 ${MAX_DOCUMENT_ID} 个字符）`, '用敏捷测试平台的脑图编号绑定文档', warnings);
    }
    if (seen.has(document)) return refusal('duplicate_document', `文档 ${document} 绑定了两次`, '每份文档只绑定一次', warnings, [document]);
    seen.add(document);
    const meta = isRecord(bound.meta) ? bound.meta : null;
    const root = meta === null ? null : rootName(meta.root);
    const ancestors = meta === null ? [] : strings(meta.ancestors);
    const metaTitle = meta !== null && typeof meta.title === 'string' && meta.title.trim() !== '' ? meta.title : null;
    const mapTitle = bound.model.nodes[0].text.trim() !== '' ? bound.model.nodes[0].text : null;
    if (meta === null || root === null) {
      warnings.push({
        code: `${PACK}.no_tree_meta`,
        message: meta === null ? `文档 ${document} 没有目录树信息（系统包没有给出 meta），只能按标题定位` : `文档 ${document} 的目录树信息里没有根，产品线定不出`,
        document,
      });
    }
    documents.push({ document, sha256: bound.sha256, source: bound.external ?? `src:${bound.sha256}`, root, ancestors, title: metaTitle ?? mapTitle, model: bound.model });
  }
  if (documents.length === 0) return refusal('no_document', `输入槽 ${SLOT} 里没有文档`, `在 inputs.${SLOT} 里给出要定位的脑图文档`, warnings);

  const selectors = documents.map((d) => idSelectors(d.model));
  const several = documents.length > 1;
  /** A selector of document k that no other bound document resolves. */
  const unique = (k: number, selector: string): boolean => selector.startsWith('n/') && selectors.every((set, j) => j === k || !set.has(selector));

  const items: ProjectedItem[] = [];
  const ambiguous: string[] = [];
  const itemOf = (d: LocatedDocument, id: string, label: string, selector: string, fields: ItemFields): ProjectedItem => {
    const { answer, judgment } = locateItem(locateInputOf(id, fields, { product, names, parameters: input.parameters }));
    return { id, label, summary: summaryOf(answer, judgment), location: { slot: SLOT, source: d.sha256, parser: PARSER, selector }, fields };
  };
  const base = (d: LocatedDocument): Omit<ItemFields, 'kind' | 'node' | 'path' | 'case_title'> => ({
    document: d.document,
    source: d.source,
    root: d.root,
    ancestors: d.ancestors,
    title: d.title,
  });
  const documentItem = (d: LocatedDocument, k: number): ProjectedItem | null => {
    const nodes = d.model.nodes;
    const node = unique(k, nodes[0].selector) ? nodes[0] : (nodes.find((n) => unique(k, n.selector)) ?? (several ? null : nodes[0]));
    if (node === null) return null;
    const label = d.title === null ? '（无标题文档）' : shown(d.title, MAX_LABEL);
    return itemOf(d, d.document, label, node.selector, { kind: 'document', node: null, path: [], case_title: null, ...base(d) });
  };

  documents.forEach((d, k) => {
    if (parameters.granularity === 'document') {
      const item = documentItem(d, k);
      if (item === null) ambiguous.push(d.document);
      else items.push(item);
      return;
    }
    const nodes = d.model.nodes;
    const cases = nodes.map((node, index) => ({ node, index })).filter(({ node, index }) => index > 0 && isCase(node));
    if (cases.length === 0) {
      warnings.push({ code: `${PACK}.no_case_nodes`, message: `文档 ${d.document} 里没有用例节点（带标签或带标记的节点），按整份文档定位`, document: d.document });
      const item = documentItem(d, k);
      if (item === null) ambiguous.push(d.document);
      else items.push(item);
      return;
    }
    for (const { node, index } of cases) {
      if (several && !unique(k, node.selector)) {
        if (!ambiguous.includes(d.document)) ambiguous.push(d.document);
        continue;
      }
      const plain = node.id !== null && node.selector.startsWith('n/') ? `${d.document}:${node.id}` : null;
      const id = plain !== null && plain.length <= MAX_ITEM_ID ? plain : `${d.document}:@${index}`;
      const title = node.text;
      items.push(
        itemOf(d, id, title.trim() === '' ? '（空标题）' : shown(title, MAX_LABEL), node.selector, {
          kind: 'case',
          node: node.id,
          path: mapPath(nodes, index),
          case_title: title,
          ...base(d),
        }),
      );
    }
  });
  if (ambiguous.length > 0) {
    return refusal(
      'ambiguous_location',
      `${ambiguous.length} 份文档（${ambiguous.slice(0, 5).join('、')}${ambiguous.length > 5 ? ' 等' : ''}）里的节点没有在这次绑定的文档里独一无二的编号，条目的位置会同时指向几份文档`,
      parameters.granularity === 'case' ? '按用例定位时每次只绑定一份文档，分开开始运行' : '把这些文档分开开始运行',
      warnings,
      ambiguous,
    );
  }
  if (items.length > MAX_ITEMS) {
    return refusal('too_large', `这次绑定的文档投影出 ${items.length} 个条目，一次运行最多 ${MAX_ITEMS} 个`, '少绑定几份文档，或者按文档（granularity document）定位', warnings.slice(0, 20), documents.map((d) => d.document).slice(0, 20));
  }
  const result = { items, warnings };
  const bytes = utf8Length(JSON.stringify(result));
  if (bytes > OUTPUT_BUDGET) {
    return refusal('too_large', `投影结果有 ${bytes} 字节（${items.length} 个条目），超过投影函数的输出上限`, '少绑定几份文档，或者按文档（granularity document）定位', warnings.slice(0, 20), documents.map((d) => d.document).slice(0, 20));
  }
  return result;
}

export default function project(input: unknown): unknown {
  return guarded<unknown>(
    () => projectItems(input),
    (message) => refusal('internal_error', `投影函数内部出错：${message}`, '这是任务包的缺陷，请把输入交给任务包维护人'),
  );
}
