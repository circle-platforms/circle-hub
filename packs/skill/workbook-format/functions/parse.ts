// Sandboxed wire boundary: source bytes in, format-neutral document data out.
import { xlsxParser } from './xlsx.ts';
import { ParseError, ParseLimitError, type ParseOptions } from './format.ts';

export default function parse(input: { bytes: string; options?: ParseOptions }) {
  try {
    const document = xlsxParser.parse(Buffer.from(input.bytes, 'base64'), input.options);
    const selectors = document.listSelectors('');
    const properties: string[] = [];
    const fragmentMap = new Map<string, { lookup: string; selector: string; text: string; byteRange: null; data?: unknown }>();

    for (const selector of selectors) {
      const fragment = document.locate(selector);
      if (fragment) {
        fragmentMap.set(selector, { lookup: selector, selector: fragment.selector, text: fragment.text, byteRange: null, data: fragment.data });
      }
    }

    for (const [s, sheet] of document.model.sheets.entries()) {
      for (const [r, row] of sheet.rows.entries()) {
        for (const [c, cell] of row.cells.entries()) {
          const pos = `i/${s}/${r}/${c}`;
          if (!fragmentMap.has(pos)) {
            const canonical = document.locate(`c/${sheet.name}/${cell.reference}`);
            if (canonical) {
              fragmentMap.set(pos, { lookup: pos, selector: canonical.selector, text: cell.text, byteRange: null, data: cell });
            }
          }
        }
      }
    }

    document.model.definedNames.forEach((name, i) => {
      const pos = `i/n/${i}`;
      if (!fragmentMap.has(pos)) {
        const canonical = name.scope === null
          ? document.locate(`n/${name.name}`)
          : (name.scope < document.model.sheets.length ? document.locate(`n/${document.model.sheets[name.scope].name}/${name.name}`) : null);
        if (canonical) {
          fragmentMap.set(pos, { lookup: pos, selector: canonical.selector, text: name.reference, byteRange: null, data: name });
        }
      }
    });

    return {
      document: {
        parser: document.parser,
        model: document.model,
        summary: document.summary(),
        selectors,
        properties,
        fragments: Array.from(fragmentMap.values()),
        quotation: {
          plain: { stream: '', units: [] },
          properties: { stream: '', units: [] },
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
