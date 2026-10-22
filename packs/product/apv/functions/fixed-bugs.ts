// Defect entries of a build's fixed-bug list as the build site publishes it (Bugs_Fixed_with_<build>.html, an html@1 model).
// The real page is one body block of br-separated anchors: the anchor text is the bug number and the href names the
// defect system (a query string with m=bug, f=view, id= is PLM; one ending show_bug.cgi?id= is the older Bugzilla).
// Some pages end with a "======ID from PLM=======" line and bare numbers after it (PLM ids). Older layouts are a table
// whose cells are blocks (a bug number cell, then its summary cell) or lines that start with a bug number; they stay.
// Each bug is one defect entry (K02 R[3]) with status fixed, `data.bug` the id, `data.system` the system the href
// proves (unknown when it proves nothing), the build as its applicability and the cells it rests on as fragments
// (a/<link> for anchors, b/<k> or b/<a>-<b> otherwise); path null: it stays unplaced at the root (its summary is the
// hint for a placement proposal). A number is taken once; repeats are warned.
import type { ProducerOutput } from '../../../../contracts/src/product.ts';
import type { ProducedEntry } from './types.ts';
import { asArray, asString, isRecord, squeeze } from './util.ts';

const PARSER = 'html@1';
const ID_ONLY = /^#?([0-9]{3,9})$/;
const LEADING_ID = /^(?:bug\s*#?\s*)?([0-9]{3,9})\s*[:：.、\-–—)]\s*(\S.*)$/i;
const PLM_MARKER = /^=+\s*ID from PLM\s*=+\s*$/i;
const TAIL_ID = /^\s*#?([0-9]{3,9})\s*$/;
const MAX_TEXT = 1000;

type BugSystem = 'plm' | 'bugzilla' | 'unknown';
type Block = { text: string };

/** The defect system an href proves: PLM's bug view query, the older system's show_bug.cgi, else unknown. */
function systemOf(href: string): BugSystem {
  if (/[?&]m=bug(?:[&#]|$)/.test(href) && /[?&]f=view(?:[&#]|$)/.test(href) && /[?&]id=/.test(href)) return 'plm';
  if (/show_bug\.cgi\?id=[0-9]+$/.test(href)) return 'bugzilla';
  return 'unknown';
}

export function fixedBugEntries(model: unknown, build: string | null): ProducerOutput {
  const warnings: string[] = [];
  if (!isRecord(model) || !Array.isArray(model.blocks)) return { entries: [], warnings: ['修复缺陷清单不是 html@1 模型（缺 blocks）'] };
  const blocks: Block[] = asArray(model.blocks).map((b) => ({ text: isRecord(b) ? (asString(b.text) ?? '') : '' }));
  const entries: ProducedEntry[] = [];
  const seen = new Set<string>();
  const add = (id: string, text: string, selector: string, system: BugSystem, afterPlmMarker = false): void => {
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
      data: { status: 'fixed', bug: id, text: summary, build, form: 'fixed_list', system, ...(afterPlmMarker ? { after_plm_marker: true } : {}) },
      fragments: [{ parser: PARSER, selector }],
      applicability: build === null ? null : { builds: [build] },
    });
  };

  // 1. The current page shape: every anchor whose text is a number, classified by its href, fragment the anchor itself.
  for (const [index, raw] of asArray(model.links).entries()) {
    if (!isRecord(raw)) continue;
    const text = squeeze(asString(raw.text) ?? '');
    const only = ID_ONLY.exec(text);
    if (only !== null) add(only[1], '', `a/${index}`, systemOf(squeeze(asString(raw.href) ?? '')));
  }

  // 2. Bare numbers after the "======ID from PLM=======" marker (PLM ids), from the block that holds the marker.
  for (let k = 0; k < blocks.length; k++) {
    const lines = blocks[k].text.split('\n');
    const markerAt = lines.findIndex((line) => PLM_MARKER.test(line.trim()));
    if (markerAt < 0) continue;
    for (const line of lines.slice(markerAt + 1)) {
      const tail = TAIL_ID.exec(line);
      if (tail !== null) add(tail[1], '', `b/${k}`, 'plm', true);
    }
  }

  // 3. The older shapes: a number cell with its summary cell, a line starting with a number.
  for (let k = 0; k < blocks.length; k++) {
    const text = squeeze(blocks[k].text);
    const only = ID_ONLY.exec(text);
    if (only !== null) {
      // A number cell: its summary is the next block unless that is another number cell.
      const next = blocks[k + 1];
      const nextText = next === undefined ? '' : squeeze(next.text);
      if (next !== undefined && nextText !== '' && ID_ONLY.exec(nextText) === null) {
        add(only[1], nextText, `b/${k}-${k + 1}`, 'unknown');
        k += 1;
      } else add(only[1], '', `b/${k}`, 'unknown');
      continue;
    }
    const leading = LEADING_ID.exec(text);
    if (leading !== null) add(leading[1], leading[2], `b/${k}`, 'unknown');
  }
  if (entries.length === 0) warnings.push('修复缺陷清单里没有认出缺陷编号');
  return { entries, warnings };
}
