// kityminder@1: KityMinder mind maps, `{root, template, theme, version}` or the same document double-encoded as a JSON string.
// Selectors: `n/<data.id>` for a node whose id is unique, `i[/<k>...]` for the node at child positions k (0-based) from the
// root, and either followed by `/@<field>` for one data field. A node without a unique id, or whose `n/` selector would
// be longer than MAX_SELECTOR_LENGTH, is addressed by `i/...` only.
import {
  QUOTATION_UNITS,
  ParseLimitError,
  ParseSyntaxError,
  checkSize,
  depthError,
  effectiveLimits,
  nodesError,
  selectorCharsError,
  type Fragment,
  type JsonObject,
  type JsonValue,
  type ParsedDocument,
  type Parser,
  type ParseLimits,
  type ParseOptions,
  type QuotationSource,
  type QuotationUnit,
} from '../parser.ts';
import { MAX_SEGMENTS, MAX_SELECTOR_LENGTH, ReferenceSyntaxError, selectorSegment, trySelectorSegments } from '../reference.ts';
import { decodeUtf8 } from '../text-decoding.ts';
import { inspectJson, isPlainObject, jsonErrorIndex, jsonText } from './json-walk.ts';

const KEY = 'kityminder@1';
const LIMITS: Readonly<ParseLimits> = { maxBytes: 16 * 1024 * 1024, maxDepth: 200, maxNodes: 100_000 };
const INDEX = /^(?:0|[1-9][0-9]{0,8})$/;

export type MindMapNode = {
  /** `data.id` when it is a non-empty string (numbers are written as decimal text), else null. */
  id: string | null;
  text: string;
  /** Every data field as given, including id and text. */
  data: JsonObject;
  /** Indices of the children in `nodes`, in document order. */
  children: number[];
  /** Index of the parent in `nodes`; follow it to the root for the parent chain. */
  parent: number | null;
  depth: number;
  /** Canonical selector of the node. */
  selector: string;
  /** Node members other than data and children, when present. */
  extra: JsonObject | null;
};

export type KityMinderModel = {
  doubleEncoded: boolean;
  /** Members of the wrapper other than root (template, theme, version, ...). */
  meta: JsonObject;
  /** Nodes in pre-order; nodes[0] is the root. */
  nodes: MindMapNode[];
  duplicateIds: string[];
  missingIds: number;
  nulRemoved: number;
  /** Unpaired surrogates (from escapes such as \ud83d) replaced by U+FFFD; always set by the parser. */
  surrogatesReplaced?: number;
};

function nodeText(data: JsonObject): string {
  const text = data.text;
  if (typeof text === 'string') return text;
  if (typeof text === 'number' || typeof text === 'boolean') return String(text);
  return '';
}

function nodeId(data: JsonObject): string | null {
  const id = data.id;
  if (typeof id === 'string' && id !== '') return id;
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  return null;
}

function parse(bytes: Uint8Array, options: ParseOptions = {}): ParsedDocument<KityMinderModel> {
  const limits = effectiveLimits(LIMITS, options);
  checkSize(KEY, bytes, limits);
  const { text, offsets } = decodeUtf8(KEY, bytes);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const index = jsonErrorIndex(error);
    throw new ParseSyntaxError(KEY, 'KityMinder 文档不是有效的 JSON', index === null ? null : offsets.at(Math.min(index, text.length)), String((error as Error).message));
  }
  let doubleEncoded = false;
  if (typeof value === 'string') {
    doubleEncoded = true;
    try {
      value = JSON.parse(value);
    } catch (error) {
      throw new ParseSyntaxError(KEY, '双重编码的 KityMinder 文档：字符串内容不是有效的 JSON', null, String((error as Error).message));
    }
  }
  // Each mind-map level is two JSON levels (node object, children array) plus nested data values; a JSON limit hit is
  // reported against the mind-map limit the caller configured.
  let shape: ReturnType<typeof inspectJson>;
  try {
    shape = inspectJson(KEY, value, limits.maxDepth * 2 + 64, limits.maxNodes * 256);
  } catch (error) {
    if (error instanceof ParseLimitError) throw error.limit === 'maxDepth' ? depthError(KEY, limits.maxDepth) : nodesError(KEY, limits.maxNodes);
    throw error;
  }
  const wrapper = shape.value;
  if (!isPlainObject(wrapper) || !isPlainObject(wrapper.root)) {
    throw new ParseSyntaxError(KEY, '不是 KityMinder 文档：缺少 root 节点对象');
  }
  const meta: JsonObject = {};
  for (const [key, member] of Object.entries(wrapper)) if (key !== 'root') Object.defineProperty(meta, key, { value: member as JsonValue, enumerable: true, writable: true, configurable: true });

  const nodes: MindMapNode[] = [];
  const stack: Array<{ raw: unknown; parent: number | null; depth: number }> = [{ raw: wrapper.root, parent: null, depth: 0 }];
  while (stack.length > 0) {
    const { raw, parent, depth } = stack.pop()!;
    if (!isPlainObject(raw)) throw new ParseSyntaxError(KEY, `第 ${nodes.length + 1} 个节点不是对象`);
    if (depth > limits.maxDepth) throw depthError(KEY, limits.maxDepth);
    if (nodes.length >= limits.maxNodes) throw nodesError(KEY, limits.maxNodes);
    const data = raw.data === undefined ? {} : raw.data;
    if (!isPlainObject(data)) throw new ParseSyntaxError(KEY, `第 ${nodes.length + 1} 个节点的 data 不是对象`);
    const children = raw.children === undefined || raw.children === null ? [] : raw.children;
    if (!Array.isArray(children)) throw new ParseSyntaxError(KEY, `第 ${nodes.length + 1} 个节点的 children 不是数组`);
    const extraKeys = Object.keys(raw).filter((key) => key !== 'data' && key !== 'children');
    let extra: JsonObject | null = null;
    if (extraKeys.length > 0) {
      extra = {};
      for (const key of extraKeys) Object.defineProperty(extra, key, { value: raw[key] as JsonValue, enumerable: true, writable: true, configurable: true });
    }
    const index = nodes.length;
    const fields = data as JsonObject;
    nodes.push({ id: nodeId(fields), text: nodeText(fields), data: fields, children: [], parent, depth, selector: '', extra });
    if (parent !== null) nodes[parent].children.push(index);
    for (let i = children.length - 1; i >= 0; i--) stack.push({ raw: children[i], parent: index, depth: depth + 1 });
  }

  const counts = new Map<string, number>();
  for (const node of nodes) if (node.id !== null) counts.set(node.id, (counts.get(node.id) ?? 0) + 1);
  const byId = new Map<string, number>();
  const duplicateIds = [...counts].filter(([, count]) => count > 1).map(([id]) => id);
  const positions = new Int32Array(nodes.length);
  for (const node of nodes) node.children.forEach((child, position) => (positions[child] = position));
  const segmentOf = (raw: string): string | null => {
    try {
      return selectorSegment(raw);
    } catch (error) {
      if (error instanceof ReferenceSyntaxError) return null;
      throw error;
    }
  };
  // Position paths, built from the parent's (nodes are in pre-order); a path holds at most MAX_SEGMENTS segments, so a
  // node deeper than that has none and can only be cited by its id.
  const positionPaths = new Array<string | undefined>(nodes.length);
  const fieldSegments = new Map<string, string | null>();
  const fieldSegment = (field: string): string | null => {
    let segment = fieldSegments.get(field);
    if (segment === undefined) fieldSegments.set(field, (segment = segmentOf(`@${field}`)));
    return segment;
  };
  let selectorChars = 0;
  nodes.forEach((node, index) => {
    positionPaths[index] = node.depth + 1 > MAX_SEGMENTS ? undefined : node.parent === null ? 'i' : `${positionPaths[node.parent]}/${positions[index]}`;
    // An id starting with '@' would read as a field step, so such a node is addressed by position.
    const addressable = node.id !== null && !node.id.startsWith('@') && counts.get(node.id) === 1;
    const segment = addressable ? segmentOf(node.id!) : null;
    const byIdSelector = segment !== null && 2 + segment.length <= MAX_SELECTOR_LENGTH ? `n/${segment}` : null;
    if (byIdSelector !== null) byId.set(node.id!, index);
    const selector = byIdSelector ?? positionPaths[index];
    // Position selectors are bounded by the reference segment limit.
    if (selector === undefined) throw depthError(KEY, MAX_SEGMENTS - 1);
    node.selector = selector;
    selectorChars += node.selector.length;
    for (const field of Object.keys(node.data)) {
      const step = fieldSegment(field);
      if (step !== null && node.selector.length + 1 + step.length <= MAX_SELECTOR_LENGTH) selectorChars += node.selector.length + 1 + step.length;
    }
    if (selectorChars > limits.maxSelectorChars) throw selectorCharsError(KEY, limits.maxSelectorChars);
  });
  const model: KityMinderModel = {
    doubleEncoded,
    meta,
    nodes,
    duplicateIds,
    missingIds: nodes.filter((node) => node.id === null).length,
    nulRemoved: shape.nulRemoved,
    surrogatesReplaced: shape.surrogatesReplaced,
  };

  const ancestors = (index: number): number[] => {
    const out: number[] = [];
    for (let at = nodes[index].parent; at !== null; at = nodes[at].parent) out.push(at);
    return out.reverse();
  };
  const nodeFragment = (index: number): Fragment => {
    const node = nodes[index];
    return {
      selector: node.selector,
      text: node.text,
      byteRange: null,
      data: {
        id: node.id,
        depth: node.depth,
        data: node.data,
        parent: node.parent === null ? null : nodes[node.parent].selector,
        children: node.children.map((child) => nodes[child].selector),
        ancestors: ancestors(index).map((at) => ({ selector: nodes[at].selector, text: nodes[at].text })),
      },
    };
  };
  /** `<node selector>/@<field>`, or null when it cannot be written or would be too long. */
  const fieldSelector = (node: MindMapNode, field: string): string | null => {
    const step = fieldSegment(field);
    return step === null || node.selector.length + 1 + step.length > MAX_SELECTOR_LENGTH ? null : `${node.selector}/${step}`;
  };
  const fieldFragment = (index: number, field: string): Fragment | null => {
    const node = nodes[index];
    if (!Object.hasOwn(node.data, field)) return null;
    const selector = fieldSelector(node, field);
    if (selector === null) return null;
    const value = node.data[field];
    return { selector, text: jsonText(value), byteRange: null, data: { node: node.selector, field, value } };
  };
  const find = (segments: string[]): number | null => {
    if (segments[0] === 'n') {
      if (segments.length < 2) return null;
      return byId.get(segments[1]) ?? null;
    }
    if (segments[0] !== 'i') return null;
    let at = 0;
    for (const step of segments.slice(1)) {
      if (!INDEX.test(step)) return null;
      const child = nodes[at].children[Number(step)];
      if (child === undefined) return null;
      at = child;
    }
    return at;
  };

  const document: ParsedDocument<KityMinderModel> & QuotationSource = {
    parser: KEY,
    model,
    locate(selector) {
      const segments = trySelectorSegments(selector);
      if (!segments || segments.length === 0) return null;
      const last = segments.at(-1)!;
      const field = segments.length > 1 && last.startsWith('@') ? last.slice(1) : null;
      const path = field === null ? segments : segments.slice(0, -1);
      if (path[0] === 'n' && path.length !== 2) return null;
      const index = find(path);
      if (index === null) return null;
      if (field === null) return nodeFragment(index);
      return field === '' ? null : fieldFragment(index, field);
    },
    listSelectors(prefix = '', options = {}) {
      const limit = options.limit ?? Number.POSITIVE_INFINITY;
      const out: string[] = [];
      for (let index = 0; index < nodes.length && out.length < limit; index++) {
        const node = nodes[index];
        if (node.selector.startsWith(prefix)) out.push(node.selector);
        if (!options.properties) continue;
        for (const field of Object.keys(node.data)) {
          if (out.length >= limit) break;
          const selector = fieldSelector(node, field);
          if (selector !== null && selector.startsWith(prefix)) out.push(selector);
        }
      }
      return out;
    },
    [QUOTATION_UNITS]({ properties }) {
      // A node stands for its own `text` field, so that field is not a second place; the other fields are their own.
      const units: QuotationUnit[] = [];
      for (const node of nodes) {
        units.push({ selector: node.selector, text: node.text, byteRange: null, parent: -1, start: -1, end: -1 });
        if (!properties) continue;
        for (const field of Object.keys(node.data)) {
          if (field === 'text') continue;
          const selector = fieldSelector(node, field);
          if (selector !== null) units.push({ selector, text: jsonText(node.data[field]), byteRange: null, parent: -1, start: -1, end: -1 });
        }
      }
      return { stream: '', units };
    },
    summary() {
      const dataFields: JsonObject = {};
      for (const node of nodes) {
        for (const field of Object.keys(node.data)) {
          const count = Object.hasOwn(dataFields, field) ? (dataFields[field] as number) : 0;
          Object.defineProperty(dataFields, field, { value: count + 1, enumerable: true, writable: true, configurable: true });
        }
      }
      return {
        parser: KEY,
        nodes: nodes.length,
        depth: nodes.reduce((max, node) => Math.max(max, node.depth), 0),
        doubleEncoded,
        missingIds: model.missingIds,
        duplicateIds: duplicateIds.length,
        dataFields,
        nulRemoved: shape.nulRemoved,
        surrogatesReplaced: shape.surrogatesReplaced,
      };
    },
  };
  return document;
}

export const kityminderParser: Parser<KityMinderModel> = { id: 'kityminder', version: 1, mediaTypes: ['application/json'], limits: LIMITS, parse };
