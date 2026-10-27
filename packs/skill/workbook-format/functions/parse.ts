// Sandboxed wire boundary: source bytes in, format-neutral document data out.
import { XlsxCrcError, xlsxParser } from './xlsx.ts';
import { ParseError, ParseLimitError, type ParseOptions } from './format.ts';

const FRAGMENT_BUDGET = 4 * 1024 * 1024;

type Wire = { lookup: string; selector: string; text: string; byteRange: null; data?: unknown };

function packError(error: unknown) {
  if (!(error instanceof ParseError)) throw error;
  return {
    error: {
      name: error.name,
      message: error.message,
      offset: error.offset,
      fix: error.fix,
      ...(error instanceof XlsxCrcError ? { crc_mismatch: true } : {}),
      ...(error instanceof ParseLimitError ? { limit: error.limit, max: error.max } : {}),
    },
  };
}

function wire(lookup: string, fragment: { selector: string; text: string; byteRange: [number, number] | null; data?: unknown }): Wire {
  const row: Wire = { lookup, selector: fragment.selector, text: fragment.text, byteRange: null };
  if (fragment.data !== undefined) row.data = fragment.data;
  return row;
}

function opened(input: { bytes: string; options?: ParseOptions }) {
  return xlsxParser.parse(Buffer.from(input.bytes, 'base64'), input.options);
}

function fragmentFor(document: ReturnType<typeof xlsxParser.parse>, lookup: string): Wire | null {
  const direct = document.locate(lookup);
  // The format parser chooses position selectors only where names are ambiguous;
  // manufacturing additional aliases here changes the original selector grammar.
  return direct ? wire(lookup, direct) : null;
}

function eagerRows(document: ReturnType<typeof xlsxParser.parse>): Wire[] | null {
  const rows: Wire[] = [];
  const seen = new Set<string>();
  let bytes = 2;
  const push = (lookup: string): boolean => {
    if (seen.has(lookup)) return true;
    const row = fragmentFor(document, lookup);
    if (!row) return true;
    seen.add(lookup);
    const size = Buffer.byteLength(JSON.stringify(row), 'utf8') + (rows.length > 0 ? 1 : 0);
    if (bytes + size > FRAGMENT_BUDGET) return false;
    rows.push(row);
    bytes += size;
    return true;
  };
  for (const selector of document.listSelectors('')) if (!push(selector)) return null;
  return rows;
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
      const row = fragmentFor(document, lookup);
      if (row) fragments.push(row);
    }
    return { fragments };
  } catch (error) {
    return packError(error);
  }
}

export default function parse(input: { bytes: string; options?: ParseOptions }) {
  try {
    const document = opened(input);
    const fragments = eagerRows(document);
    // The native workbook parser has no shared quotation index: its candidates
    // are its listed fragments. Preserve that behavior across the sandbox wire.
    const selectors = document.listSelectors('');
    const units = selectors.map((selector) => {
      const fragment = document.locate(selector)!;
      return {selector, text: fragment.text, byteRange: fragment.byteRange, parent: -1, start: -1, end: -1};
    });
    const quotation = {stream: '', units};
    return {
      document: {
        parser: document.parser,
        model: document.model,
        summary: document.summary(),
        selectors,
        properties: document.listSelectors('', { properties: true }),
        ...(fragments ? { fragments } : {}),
        quotation: { plain: quotation, properties: quotation },
      },
    };
  } catch (error) {
    return packError(error);
  }
}
