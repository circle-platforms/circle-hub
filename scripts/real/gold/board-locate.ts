import { bugIdsOf } from './cases.ts';
// The board-side locator of a document's line and module, written from packs/product/famx/README.md 177-180 (the
// rule the Hub's own grouping follows) — not the case-location rule of locations.ts, whose line/version mismatch
// and module conventions differ. The labels above a document, outermost first, are scanned only up to the first
// `<version>-<suffix>` train: the line is the nearest line label above the train (else the train's version), and
// the module is the label right under the train when it is a plain name (no ids, no version, not a test activity),
// kept even when the train and the line versions differ.
const LINE = /^v?([0-9]{1,3}(?:\.[0-9]{1,3}){1,3})$/i;
const TRAIN = /^v?([0-9]{1,3}(?:\.[0-9]{1,3}){1,3})(?=[-_\s])\S*?[-_\s]+\S/i;
const NOT_MODULE = /测试|回归|用例|需求|bug|case|patch|story|plm|提测/i;
const PREFIX = /^((?=[0-9A-Za-z-]*[0-9])[0-9A-Za-z]{3}(?:-[0-9A-Za-z]{3}){0,3})\s*:\s*/;
// The pack cuts labels at 1000 (locate.ts MAX_LABEL); this gold follows the same limit.
const MAX_LABEL = 1000;
const MAX_MODULE = 40;

const squeeze = (text: string): string => text.trim().replace(/\s+/g, ' ');

/** The label with its prefix code removed (NFKC, labels cut at the pack's length). */
export function stripPrefix(label: string): string {
  const text = squeeze(label.slice(0, MAX_LABEL).normalize('NFKC'));
  const match = PREFIX.exec(text);
  return match ? text.slice(match[0].length).trim() : text;
}

/** The public FAMX rule separates input truncation from module length and excludes every four-digit run. */
function isModuleName(text: string): boolean {
  if (text === '' || text.length > MAX_MODULE || NOT_MODULE.test(text) || LINE.test(text) || TRAIN.test(text)) return false;
  if (/[0-9]{4,}/.test(text)) return false;
  return bugIdsOf(text).length === 0;
}

export interface BoardLocation {
  line: string | null;
  train: string | null;
  module: string | null;
}

/** The line and module of one document from its ancestor labels (outermost first). */
export function boardLocate(ancestors: readonly (string | null)[]): BoardLocation {
  const out: BoardLocation = { line: null, train: null, module: null };
  const texts = ancestors.map((label) => (typeof label === 'string' ? stripPrefix(label) : null));
  let trainAt = -1;
  let trainVersion: string | null = null;
  const lines: string[] = [];
  for (let index = 0; index < texts.length && trainAt < 0; index++) {
    const text = texts[index];
    if (text === null) continue;
    const line = LINE.exec(text);
    if (line) {
      lines.push(line[1]!);
      continue;
    }
    const train = TRAIN.exec(text);
    if (train) {
      trainAt = index;
      trainVersion = train[1]!;
      out.train = text;
    }
  }
  if (lines.length > 0) out.line = lines[lines.length - 1]!;
  if (trainVersion !== null && out.line === null) out.line = trainVersion;
  const moduleAt = trainAt >= 0 ? trainAt + 1 : -1;
  if (moduleAt >= 0 && moduleAt < texts.length) {
    const text = texts[moduleAt];
    if (text !== null && isModuleName(text)) out.module = text;
  }
  return out;
}
