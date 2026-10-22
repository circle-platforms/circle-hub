// Defect entries of a build's fixed-bug list as the build site publishes it (Bugs_Fixed_with_<build>.html, an html@1 model):
// a table whose cells are blocks (a bug number cell, then its summary cell) or lines that start with a bug number. Each bug
// is one defect entry (K02 R[3]) with status fixed, the build as its applicability and the cells it rests on as fragments
// (b/<k> or b/<a>-<b>); path null: the typed-judgment model places it (its summary is the hint). The page was not sampled;
// the structure follows the build site's other pages, so unknown layouts give no entry and a warning, never a guess.
import type { ProducerOutput } from '../../../../contracts/src/product.ts';
import type { ProducedEntry } from './types.ts';
import { asArray, asString, isRecord, squeeze } from './util.ts';

const PARSER = 'html@1';
const ID_ONLY = /^#?([0-9]{3,9})$/;
const LEADING_ID = /^(?:bug\s*#?\s*)?([0-9]{3,9})\s*[:：.、\-–—)]\s*(\S.*)$/i;
const MAX_TEXT = 1000;

type Block = { text: string };

export function fixedBugEntries(model: unknown, build: string | null): ProducerOutput {
  const warnings: string[] = [];
  const blocks: Block[] = isRecord(model) ? asArray(model.blocks).map((b) => ({ text: isRecord(b) ? squeeze(asString(b.text) ?? '') : '' })) : [];
  if (!isRecord(model) || !Array.isArray(model.blocks)) return { entries: [], warnings: ['修复缺陷清单不是 html@1 模型（缺 blocks）'] };
  const entries: ProducedEntry[] = [];
  const seen = new Set<string>();
  const add = (id: string, text: string, selector: string): void => {
    if (seen.has(id)) {
      warnings.push(`缺陷 ${id} 列了两次，只取第一次`);
      return;
    }
    seen.add(id);
    const summary = text.slice(0, MAX_TEXT);
    entries.push({
      kind: 'defect',
      path: null,
      statement: summary === '' ? `缺陷 ${id}` : `缺陷 ${id}：${summary}`,
      data: { status: 'fixed', bugId: id, text: summary, build, form: 'fixed_list' },
      fragments: [{ parser: PARSER, selector }],
      applicability: build === null ? null : { builds: [build] },
    });
  };
  for (let k = 0; k < blocks.length; k++) {
    const text = blocks[k].text;
    const only = ID_ONLY.exec(text);
    if (only !== null) {
      // A number cell: its summary is the next block unless that is another number cell.
      const next = blocks[k + 1];
      if (next !== undefined && next.text !== '' && ID_ONLY.exec(next.text) === null) {
        add(only[1], next.text, `b/${k}-${k + 1}`);
        k += 1;
      } else add(only[1], '', `b/${k}`);
      continue;
    }
    const leading = LEADING_ID.exec(text);
    if (leading !== null) add(leading[1], leading[2], `b/${k}`);
  }
  if (entries.length === 0) warnings.push('修复缺陷清单里没有认出缺陷编号');
  return { entries, warnings };
}
