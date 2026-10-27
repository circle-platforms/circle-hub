// Sandboxed wire boundary: source bytes in, format-neutral document data out.
import { xmlParser, XML_COMPACT_QUOTATION } from './xml.ts';
import { ParseError, ParseLimitError, type Fragment, type ParseOptions } from './format.ts';
import { selectorSegment } from './selectors.ts';

const FRAGMENT_BUDGET = 4 * 1024 * 1024;

type Wire = { lookup: string; selector: string; text: string; byteRange: [number, number] | null; data?: unknown };
type Located = { selector: string; text: string; byteRange: [number, number] | null; data?: unknown };

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

function wire(lookup: string, fragment: Located): Wire {
  const row: Wire = { lookup, selector: fragment.selector, text: fragment.text, byteRange: fragment.byteRange };
  if (fragment.data !== undefined) row.data = fragment.data;
  return row;
}

/** Fragments whose JSON stays within the budget, or null when the same bytes would exceed it. */
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

function* aliases(document: ReturnType<typeof xmlParser.parse>, selectors: string[], properties: string[]): Iterable<string> {
  yield* properties;
  let rootName: string | null = null;
  if (selectors.length > 0 && selectors[0].startsWith('x/')) {
    const slash = selectors[0].indexOf('/', 2);
    rootName = slash < 0 ? selectors[0].slice(2) : selectors[0].slice(2, slash);
    if (!rootName.includes('[')) {
      for (const sel of properties) {
        if (sel === 'x/' + rootName) yield 'x/' + rootName + '[1]';
        else if (sel.startsWith('x/' + rootName + '/')) yield 'x/' + rootName + '[1]/' + sel.slice(rootName.length + 3);
      }
    }
  }
  for (const sel of selectors) {
    const fragment = document.locate(sel);
    if (!fragment?.data || typeof fragment.data !== 'object') continue;
    const data = fragment.data as { index?: string | null; attributes?: Record<string, string> };
    if (typeof data.index !== 'string') continue;
    yield data.index;
    for (const name of Object.keys(data.attributes ?? {})) {
      try {
        yield `${data.index}/${selectorSegment('@' + name)}`;
      } catch {
        // A name that is not a selector segment has no attribute alias.
      }
    }
  }
}

function opened(input: { bytes: string; options?: ParseOptions }) {
  return xmlParser.parse(Buffer.from(input.bytes, 'base64'), input.options);
}

function documentOf(document: ReturnType<typeof xmlParser.parse>, fragments: Wire[] | undefined, selectors: string[], properties: string[]) {
  const quotation = document as typeof document & { [XML_COMPACT_QUOTATION]: (options: { properties: boolean }) => unknown };
  // Adjacent canonical paths normally share nearly all their prefix.  The wire
  // format is additive: older packages may continue to return string arrays.
  const paths = (list: string[]) => {
    let previous = '';
    const entries = list.map(path => {
      let prefix = 0;
      while (prefix < previous.length && prefix < path.length && previous.charCodeAt(prefix) === path.charCodeAt(prefix)) prefix++;
      previous = path;
      return [prefix, path.slice(prefix)] as const;
    });
    return { encoding: 'prefix-delta@1', entries };
  };
  return {
    document: {
      parser: document.parser,
      model: document.model,
      summary: document.summary(),
      selectors: paths(selectors),
      properties: paths(properties),
      ...(fragments ? { fragments } : {}),
      quotation: {
        plain: quotation[XML_COMPACT_QUOTATION]({ properties: false }),
        properties: quotation[XML_COMPACT_QUOTATION]({ properties: true }),
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
    const selectors = document.listSelectors('');
    const properties = document.listSelectors('', { properties: true });
    const fragments = take(aliases(document, selectors, properties), (lookup) => document.locate(lookup));
    return documentOf(document, fragments ?? undefined, selectors, properties);
  } catch (error) {
    return packError(error);
  }
}
