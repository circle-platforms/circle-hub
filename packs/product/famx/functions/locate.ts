// Version line, release train and module of a mind-map document from the labels of its ancestors in the agile tree
// (root first). Convention under the product project: `NNN：<line>` (060：10.6.1) → `NNN：<line>-<suffix>` (004：10.6.1-R2-
// 2026/7, 101：10.6.1-主线-CentOS-2026/06/30) → module (SLB, SSL, WebUI, 系统 ...) → document. Prefix codes are three
// letters or digits (with a digit), optionally in groups (000-001-002), before an ASCII or full-width colon.
import type { LocateResult } from './types.ts';
import { idsFromTitle } from './ids.ts';
import { lineKey } from './naming.ts';
import { asArray, guarded, internalError, isRecord, squeeze } from './util.ts';

// famx-directory@1, declared in README: prefix code, colon, version line, train, then module.
const PREFIX = /^((?=[0-9A-Za-z-]*[0-9])[0-9A-Za-z]{3}(?:-[0-9A-Za-z]{3}){0,3})\s*[:：]\s*/;
const LINE = /^v?([0-9]{1,3}(?:\.[0-9]{1,3}){1,3})$/i;
// famx-directory@1, train layer: the whole label after the prefix code is a version, one or more of the declared
// separators (`-`, `_` or a space) and a non-empty single-line suffix.
const TRAIN = /^v?([0-9]{1,3}(?:\.[0-9]{1,3}){1,3})[-_\s]+([^\r\n]+)$/i;
const MAX_LABELS = 64;
const MAX_LABEL = 1000;

/** The label text with a declared prefix code removed; nothing is folded, and labels are cut at MAX_LABEL. */
export function stripPrefix(label: string): string {
  const text = label.slice(0, MAX_LABEL);
  const match = PREFIX.exec(text);
  return match ? text.slice(match[0].length).trim() : text;
}

/** Version candidates in the declared coded agile ancestor layers, without selecting a winner on conflict. */
export function directoryBindingLines(labels: readonly string[]): { lines: string[]; complete: boolean; module: string|null } {
  // A partial path or label is not evidence of a complete version level.
  if (labels.length > MAX_LABELS || labels.some((label) => label.length > MAX_LABEL)) return { lines: [], complete: false, module:null };
  const lines: string[] = [];
  let sawTrain = false;
  let module:string|null=null;
  for (const [index,label] of labels.entries()) {
    const prefix = PREFIX.exec(label);
    if (prefix === null) continue;
    const rest = label.slice(prefix[0].length).trim();
    const line = LINE.exec(rest);
    const train = line === null && !sawTrain ? TRAIN.exec(rest) : null;
    if (train !== null) {sawTrain = true;const next=labels[index+1];if(next!==undefined){const value=stripPrefix(next);if(isModuleName(value))module=value;}}
    const version = line?.[1] ?? train?.[1];
    if (version !== undefined) {
      // The case-location convention compares the first three components as a line.
      const canonical = lineKey(version.split('.').slice(0, 3).join('.'));
      if (!lines.includes(canonical)) lines.push(canonical);
    }
  }
  return { lines, complete: true, module };
}

function isModuleName(text: string): boolean {
  // famx-directory@1: the single segment immediately below the release-train node is the module.
  return /^[^\r\n]{1,1000}$/.test(text);
}

export function locateFromAncestors(labels: string[]): LocateResult {
  const notes: string[] = [];
  const out: LocateResult = { line: null, train: null, module: null, notes };
  try {
    const values = asArray(labels);
    if (!Array.isArray(labels)) notes.push('祖先标签不是数组');
    const texts = values.slice(0, MAX_LABELS).map((value) => (typeof value === 'string' ? stripPrefix(value) : null));
    if (values.length > MAX_LABELS) notes.push(`祖先标签超过 ${MAX_LABELS} 个，只看前 ${MAX_LABELS} 个`);
    if (texts.some((text) => text === null)) notes.push('有祖先标签不是字符串，已跳过');
    // The first train-like label is the release train; the version line is the nearest line label above it.
    let trainAt = -1;
    let trainVersion: string | null = null;
    const lines: string[] = [];
    for (let index = 0; index < texts.length && trainAt < 0; index++) {
      const text = texts[index];
      if (text === null) continue;
      const line = LINE.exec(text);
      if (line) {
        lines.push(line[1]);
        continue;
      }
      const train = TRAIN.exec(text);
      if (train) {
        trainAt = index;
        trainVersion = train[1];
        out.train = text;
      }
    }
    const distinct = [...new Set(lines)];
    if (distinct.length > 1) notes.push(`祖先里有多个版本线节点（${distinct.join('、')}），取最靠近文档的 ${distinct[distinct.length - 1]}`);
    if (lines.length > 0) out.line = lines[lines.length - 1];
    if (trainVersion !== null && out.train !== null) {
      if (out.line === null) {
        out.line = trainVersion;
        notes.push(`没有版本线节点，版本线取自发布火车 ${out.train}`);
      } else if (lineKey(trainVersion) !== lineKey(out.line)) notes.push(`发布火车 ${out.train} 的版本与版本线 ${out.line} 不一致`);
    }
    if (out.line === null) notes.push('祖先里没有版本线节点');
    if (out.train === null) notes.push('祖先里没有发布火车节点');
    const moduleAt = trainAt >= 0 ? trainAt + 1 : -1;
    if (moduleAt >= 0 && moduleAt < texts.length) {
      const text = texts[moduleAt];
      if (text !== null && isModuleName(text)) out.module = text;
      else notes.push(`发布火车下一层“${(text ?? '').slice(0, 40)}”不是模块名`);
    } else if (trainAt >= 0) notes.push('发布火车下面没有模块层');
    return out;
  } catch (error) {
    notes.push(internalError(error));
    return out;
  }
}

/** Pack function entry: the labels (root first), or `{ labels }`. */
export default function locate(input: unknown): LocateResult {
  return guarded(
    () => (isRecord(input) && Array.isArray(input.labels) ? locateFromAncestors(input.labels as string[]) : locateFromAncestors(input as string[])),
    (warning) => ({ line: null, train: null, module: null, notes: [warning] }),
  );
}
