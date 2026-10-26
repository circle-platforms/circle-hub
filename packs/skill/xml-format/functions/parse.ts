// Sandboxed wire boundary: source bytes in, format-neutral document data out.
import { xmlParser } from './xml.ts';
import { ParseError, ParseLimitError, QUOTATION_UNITS, type ParseOptions } from './format.ts';
import { selectorSegment } from './selectors.ts';

export default function parse(input: { bytes: string; options?: ParseOptions }) {
  try {
    const document = xmlParser.parse(Buffer.from(input.bytes, 'base64'), input.options);
    const selectors = document.listSelectors('');
    const properties = document.listSelectors('', { properties: true });
    const aliases = new Set(properties);

    // Add root with [1] if root is unique
    let rootName: string | null = null;
    if (selectors.length > 0 && selectors[0].startsWith('x/')) {
      const slash = selectors[0].indexOf('/', 2);
      rootName = slash < 0 ? selectors[0].slice(2) : selectors[0].slice(2, slash);
      if (!rootName.includes('[')) {
        for (const sel of properties) {
          if (sel === 'x/' + rootName) {
            aliases.add('x/' + rootName + '[1]');
          } else if (sel.startsWith('x/' + rootName + '/')) {
            aliases.add('x/' + rootName + '[1]/' + sel.slice(rootName.length + 3));
          }
        }
      }
    }

    // Add position-based paths and attributes as aliases
    for (const sel of selectors) {
      const fragment = document.locate(sel);
      if (!fragment) continue;
      if (fragment.data && typeof fragment.data === 'object') {
        const data = fragment.data as { index?: string | null; attributes?: Record<string, string> };
        const index = data.index;
        if (typeof index === 'string') {
          aliases.add(index);
          const attrs = data.attributes ?? {};
          for (const name of Object.keys(attrs)) {
            try {
              const seg = selectorSegment('@' + name);
              aliases.add(`${index}/${seg}`);
            } catch {}
          }
        }
      }
    }

    const fragmentMap = new Map<string, { lookup: string; selector: string; text: string; byteRange: [number, number] | null; data?: unknown }>();
    for (const alias of aliases) {
      const fragment = document.locate(alias);
      if (fragment) {
        fragmentMap.set(alias, {
          lookup: alias,
          selector: fragment.selector,
          text: fragment.text,
          byteRange: fragment.byteRange,
          data: fragment.data,
        });
      }
    }

    const quotation = document as typeof document & { [QUOTATION_UNITS]: (options: { properties: boolean }) => unknown };
    return {
      document: {
        parser: document.parser,
        model: document.model,
        summary: document.summary(),
        selectors,
        properties,
        fragments: Array.from(fragmentMap.values()),
        quotation: {
          plain: quotation[QUOTATION_UNITS]({ properties: false }),
          properties: quotation[QUOTATION_UNITS]({ properties: true }),
        },
      },
    };
  } catch (error) {
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
}
