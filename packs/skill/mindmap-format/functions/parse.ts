// Sandboxed wire boundary: source bytes in, format-neutral document data out.
import { kityminderParser } from './kityminder.ts';
import { ParseError, ParseLimitError, QUOTATION_UNITS, type Fragment, type ParseOptions } from './format.ts';
import { selectorSegment, MAX_SELECTOR_LENGTH, MAX_SEGMENTS } from './selectors.ts';

const FRAGMENT_BUDGET = 4 * 1024 * 1024;

type Wire = { lookup: string; selector: string; text: string; byteRange: [number, number] | null; data?: unknown };

function packError(error: unknown) {
  if (!(error instanceof ParseError)) throw error;
  return {
    error: {
      name: error.name,
      message: error.message,
      offset: error.offset,
      fix: error.fix,
      ...(error instanceof ParseLimitError ? { limit: error.limit, max: error.max } : {}),
    },
  };
}

function wire(lookup: string, fragment: { selector: string; text: string; byteRange: [number, number] | null; data?: unknown }): Wire {
  const row: Wire = { lookup, selector: fragment.selector, text: fragment.text, byteRange: fragment.byteRange };
  if (fragment.data !== undefined) row.data = fragment.data;
  return row;
}

function take(lookups: Iterable<string>, locate: (lookup: string) => Fragment | null): Wire[] | null {
  const seen = new Set<string>();
  const rows: Wire[] = [];
  let bytes = 2;
  for (const lookup of lookups) {
    if (seen.has(lookup)) continue;
    seen.add(lookup);
    const fragment = locate(lookup);
    if (!fragment) continue;
    const row = wire(lookup, fragment);
    const size = Buffer.byteLength(JSON.stringify(row), 'utf8') + (rows.length > 0 ? 1 : 0);
    if (bytes + size > FRAGMENT_BUDGET) return null;
    rows.push(row);
    bytes += size;
  }
  return rows;
}

function aliases(document: ReturnType<typeof kityminderParser.parse>): string[] {
  const properties = document.listSelectors('', { properties: true });
  const aliases = new Set(properties);
  const paths: string[] = [];
  for (const [index, node] of document.model.nodes.entries()) {
    const path = node.parent === null ? 'i' : paths[node.parent] + '/' + document.model.nodes[node.parent].children.indexOf(index);
    paths.push(path);
    if (path.length > MAX_SELECTOR_LENGTH || path.split('/').length > MAX_SEGMENTS) continue;
    aliases.add(path);
    for (const key of Object.keys(node.data)) {
      const field = path + '/' + selectorSegment('@' + key);
      if (field.length <= MAX_SELECTOR_LENGTH) aliases.add(field);
    }
  }
  return [...aliases];
}

function opened(input: { bytes: string; options?: ParseOptions }) {
  return kityminderParser.parse(Buffer.from(input.bytes, 'base64'), input.options);
}

function documentOf(document: ReturnType<typeof kityminderParser.parse>, fragments: Wire[] | undefined) {
  const quotation = document as typeof document & { [QUOTATION_UNITS]: (options: { properties: boolean }) => unknown };
  return {
    document: {
      parser: document.parser,
      model: document.model,
      summary: document.summary(),
      selectors: document.listSelectors(''),
      properties: document.listSelectors('', { properties: true }),
      ...(fragments ? { fragments } : {}),
      quotation: {
        plain: quotation[QUOTATION_UNITS]({ properties: false }),
        properties: quotation[QUOTATION_UNITS]({ properties: true }),
      },
    },
  };
}

export function locate(input: { bytes: string; options?: ParseOptions; selectors?: unknown }) {
  try {
    if (!Array.isArray(input.selectors) || input.selectors.length > 256 || input.selectors.some((selector) => typeof selector !== 'string')) {
      return { error: { name: 'ParseError', message: 'locate 一次最多接受 256 个选择器', offset: null, fix: '把选择器分成至多 256 个的一批后重试' } };
    }
    const document = opened(input);
    const fragments: Wire[] = [];
    const seen = new Set<string>();
    for (const lookup of input.selectors) {
      if (seen.has(lookup)) continue;
      seen.add(lookup);
      const fragment = document.locate(lookup);
      if (fragment) fragments.push(wire(lookup, fragment));
    }
    return { fragments };
  } catch (error) {
    return packError(error);
  }
}

export default function parse(input: { bytes: string; options?: ParseOptions }) {
  try {
    const document = opened(input);
    const fragments = take(aliases(document), (lookup) => document.locate(lookup));
    return documentOf(document, fragments ?? undefined);
  } catch (error) {
    return packError(error);
  }
}
