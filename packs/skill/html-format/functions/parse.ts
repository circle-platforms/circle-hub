// Sandboxed wire boundary: source bytes in, format-neutral document data out.
import { htmlParser } from './html.ts';
import { ParseError, ParseLimitError, QUOTATION_UNITS, type ParseOptions } from './format.ts';

export default function parse(input: { bytes: string; options?: ParseOptions }) {
  try {
    const document = htmlParser.parse(Buffer.from(input.bytes, 'base64'), input.options);
    const selectors = document.listSelectors('');
    const properties = document.listSelectors('', { properties: true });
    const fragmentMap = new Map<string, { lookup: string; selector: string; text: string; byteRange: [number, number] | null; data?: unknown }>();

    for (const sel of selectors) {
      const fragment = document.locate(sel);
      if (fragment) {
        fragmentMap.set(sel, {
          lookup: sel,
          selector: fragment.selector,
          text: fragment.text,
          byteRange: fragment.byteRange,
          data: fragment.data,
        });
      }
    }

    const blockCount = document.model.blocks.length;
    if (blockCount >= 2) {
      const wholeSel = `b/0-${blockCount - 1}`;
      const f = document.locate(wholeSel);
      if (f && !fragmentMap.has(wholeSel)) {
        fragmentMap.set(wholeSel, {
          lookup: wholeSel,
          selector: f.selector,
          text: f.text,
          byteRange: f.byteRange,
          data: f.data,
        });
      }
    }

    // Add block ranges b/i-j so queries like b/1-2 resolve
    if (blockCount <= 200) {
      for (let i = 0; i < blockCount; i++) {
        for (let j = i + 1; j < blockCount; j++) {
          const rangeSel = `b/${i}-${j}`;
          if (!fragmentMap.has(rangeSel)) {
            const f = document.locate(rangeSel);
            if (f) {
              fragmentMap.set(rangeSel, {
                lookup: rangeSel,
                selector: f.selector,
                text: f.text,
                byteRange: f.byteRange,
                data: f.data,
              });
            }
          }
        }
      }
    }

    const quotation = (document as unknown as { [QUOTATION_UNITS]: () => unknown })[QUOTATION_UNITS]();
    return {
      document: {
        parser: document.parser,
        model: document.model,
        summary: document.summary(),
        selectors,
        properties,
        fragments: Array.from(fragmentMap.values()),
        quotation: {
          plain: quotation,
          properties: quotation,
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
