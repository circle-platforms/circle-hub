// Sandboxed wire boundary: source bytes in, format-neutral document data out.
import { htmlParser } from './html.ts';
import { ParseError, ParseLimitError, QUOTATION_UNITS, type Fragment, type ParseOptions } from './format.ts';

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

function rangeText(blocks: { text: string }[]): number {
  const at = [0];
  for (const block of blocks) at.push(at[at.length - 1] + block.text.length + 1);
  let text = 0;
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      text += at[j + 1] - at[i] - 1;
      if (text > FRAGMENT_BUDGET) return text;
    }
  }
  return text;
}

function eagerLookups(document: ReturnType<typeof htmlParser.parse>): string[] | null {
  const selectors = document.listSelectors('');
  const blocks = document.model.blocks;
  if (rangeText(blocks) > FRAGMENT_BUDGET) return null;
  const lookups = [...selectors];
  if (blocks.length >= 2) lookups.push(`b/0-${blocks.length - 1}`);
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) lookups.push(`b/${i}-${j}`);
  }
  return lookups;
}

function opened(input: { bytes: string; options?: ParseOptions }) {
  return htmlParser.parse(Buffer.from(input.bytes, 'base64'), input.options);
}

function documentOf(document: ReturnType<typeof htmlParser.parse>, fragments: Wire[] | undefined) {
  const quotation = (document as unknown as { [QUOTATION_UNITS]: () => unknown })[QUOTATION_UNITS]();
  return {
    document: {
      parser: document.parser,
      model: document.model,
      summary: document.summary(),
      selectors: document.listSelectors(''),
      properties: document.listSelectors('', { properties: true }),
      ...(fragments ? { fragments } : {}),
      quotation: { plain: quotation, properties: quotation },
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
    const lookups = eagerLookups(document);
    const fragments = lookups === null ? null : take(lookups, (lookup) => document.locate(lookup));
    return documentOf(document, fragments ?? undefined);
  } catch (error) {
    return packError(error);
  }
}
