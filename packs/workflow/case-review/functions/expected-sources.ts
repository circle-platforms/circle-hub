// Expected sources of a case-review run (pack function): the PLM stories and bugs named in the document title and the folders
// above it, and a manual search for the feature words of the title. Only external object ids come out; the Hub reads them
// with the system packs and binds what it read (role expected) with its revision.
//
// Id conventions of real titles (numbers here are invented): "bug to case 70412", "Bug 118000&118001", "bug57001", "Test
// List of Bug 138001", "需求20931", "Story#20777", "PLM20518-...", "bug to case-需求20931" (the word next to the number wins),
// and unmarked numbers at the start: "31057-...", "146001 146002...", "回归 - 112233", "Test-129001-...".
// Only a word right before a number names its kind: bug, 缺陷 (bug); story, 需求 (story). "bug to case" names a document type
// and "PLM" the system, and real titles put story numbers after both, so the numbers after them are unmarked. An unmarked id
// takes the kind whose id range alone contains it when the product pack gives the ranges (parameters.idRanges); otherwise both
// kinds are read (parameters.bareIds). The defect system numbers stories and bugs apart, so both records may exist and one of
// them be unrelated to the document: the reason and the warning say so, and the reviewer checks the record's title before
// citing it (or names the kind with stories / bugs).
// Release-train labels ("201：3.2.1-主线-2026/06/30"), years, dates and version numbers are not ids.
import { PACK, failure, guarded, isRecord, warningSink, type WarningSink } from './common.ts';
import { clip, collapseWhitespace, isBlank, mustEncodeInExternalId, percentEncode, textOf } from './text.ts';
import type { ExternalObjectId, FoundId, IdKind, IdRange, SourceBasis, SourcesOutput } from './types.ts';

/** Code units of one title or label that are scanned; real titles are far shorter. */
const MAX_SCAN = 2000;
const MAX_TERM = 32;
const DEFAULT_TERMS = 8;
const MAX_TERMS = 16;
const MAX_NAMED = 20;

const KIND_LABEL: Record<IdKind, string> = { story: '需求', bug: '缺陷' };

// A word before numbers. Matched on NFKC, lower-cased text; ASCII words must not continue a word.
const MARKER = /(?<![a-z0-9])(?:bug[\s_-]*to[\s_-]*cases?|bug2case|bugs?|stor(?:y|ies)|plm)|缺陷|需求单?/gu;
// A second word right after the first one ("bug to case-需求20931"): the one next to the number wins.
const INNER_MARKER = /(?:需求单?|缺陷|stor(?:y|ies)|bugs?)/uy;
const SEPARATORS = /[\s#:：\-_~.—–]*/uy;
const DIGITS = /[0-9]+/y;
const LIST_SEPARATOR = /\s*[&、,，+;；]\s*#?(?=[0-9])/uy;
const BARE_LIST_SEPARATOR = /\s*[&、,，+;；]\s*(?=[0-9])|\s+(?=[0-9])/uy;
const NEUTRAL_PREFIXES = ['regression', '二轮回归', '三轮回归', '回归测试', '回归', 'test', '测试'];

/** The kind a word names; null for "bug to case" (a document type) and "PLM" (the defect system). */
function kindOfMarker(marker: string): IdKind | null {
  if (marker === 'plm' || marker.startsWith('bug2case') || /^bug[\s_-]*to/.test(marker)) return null;
  return marker.startsWith('bug') || marker.startsWith('缺陷') ? 'bug' : 'story';
}

function sticky(pattern: RegExp, text: string, at: number): string | null {
  pattern.lastIndex = at;
  const match = pattern.exec(text);
  return match === null ? null : match[0];
}

/** Numbers read from `at`: a list joined by &, 、, commas or +, each within the digit bounds; stops at the first bad one. */
function readIds(text: string, at: number, bare: boolean): { ids: string[]; end: number } {
  const ids: string[] = [];
  let pos = at;
  for (;;) {
    const digits = sticky(DIGITS, text, pos);
    if (digits === null) break;
    const after = text.slice(pos + digits.length, pos + digits.length + 2);
    const min = bare ? 4 : 2;
    const max = bare ? 7 : 9;
    if (digits.length < min || digits.length > max || digits.startsWith('0')) break;
    if (/^\.[0-9]/.test(after)) break; // a version number
    if (bare) {
      if (digits.length === 4 && Number(digits) >= 1900 && Number(digits) <= 2099) break; // a year
      if (/^\s*[:：/年月日号]/u.test(text.slice(pos + digits.length, pos + digits.length + 4))) break; // an ordering prefix or a date
    }
    ids.push(digits);
    pos += digits.length;
    const separator = sticky(bare ? BARE_LIST_SEPARATOR : LIST_SEPARATOR, text, pos);
    if (separator === null) break;
    pos += separator.length;
  }
  return { ids, end: pos };
}

/** Ids after a word anywhere in the text; the kind is null after "bug to case" and "PLM". */
export function markedIds(text: string): FoundId[] {
  const lower = text.slice(0, MAX_SCAN).normalize('NFKC').toLowerCase();
  const out: FoundId[] = [];
  MARKER.lastIndex = 0;
  for (let match = MARKER.exec(lower); match !== null; match = MARKER.exec(lower)) {
    let word = match[0];
    let pos = match.index + word.length;
    pos += (sticky(SEPARATORS, lower, pos) ?? '').length;
    const inner = sticky(INNER_MARKER, lower, pos);
    if (inner !== null) {
      word = inner;
      pos += inner.length;
      pos += (sticky(SEPARATORS, lower, pos) ?? '').length;
    }
    const { ids, end } = readIds(lower, pos, false);
    if (ids.length === 0) continue;
    const kind = kindOfMarker(word);
    const snippet = lower.slice(match.index, end);
    for (const id of ids) out.push({ kind, id, marker: kind === null ? null : word, text: snippet });
    MARKER.lastIndex = end;
  }
  return out;
}

/** Unmarked ids at the very start of the text, after an optional neutral word ("回归", "Test"). */
export function leadingIds(text: string): FoundId[] {
  const lower = text.slice(0, MAX_SCAN).normalize('NFKC').toLowerCase();
  let pos = (sticky(/\s*/uy, lower, 0) ?? '').length;
  for (const prefix of NEUTRAL_PREFIXES) {
    if (lower.startsWith(prefix, pos)) {
      pos += prefix.length;
      pos += (sticky(SEPARATORS, lower, pos) ?? '').length;
      break;
    }
  }
  const { ids, end } = readIds(lower, pos, true);
  const snippet = lower.slice(0, end);
  return ids.map((id) => ({ kind: null, id, marker: null, text: snippet }));
}

/** Every id of one text, once: the ones a word names, then the unmarked ones (a number a word names is not repeated). */
export function extractIds(text: string): FoundId[] {
  const found = [...markedIds(text), ...leadingIds(text)];
  const named = new Set(found.filter((entry) => entry.kind !== null).map((entry) => entry.id));
  const seen = new Set<string>();
  return found.filter((entry) => {
    if (entry.kind === null && named.has(entry.id)) return false;
    const key = `${entry.kind}:${entry.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Search terms -----------------------------------------------------------------------------------------------------------

const TOKEN = /[a-z0-9]+(?:[._][a-z0-9]+)*|\p{Script=Han}+/giu;
/** Words that end a term wherever they stand in a Han run. */
const SPLIT_WORDS = [
  '测试用例', '用例', '测试', '回归', '二轮', '三轮', '需求', '缺陷', '支持', '验证', '问题', '修复', '版本', '场景', '情况', '是否', '能否', '可以', '无法',
  '不能', '进行', '使用', '通过', '特定', '偶发', '导致', '一个', '多个', '所有', '以及',
].sort((a, b) => b.length - a.length);
/**
 * Conjunctions: they split a run only with two Han characters or more on each side. 的 and the positional characters
 * (后, 时, 在, 对, 下, 中) never split: they are parts of common words (目的地址, 后端, 时间, 在线, 对端, 下发, 中心).
 */
const JOINERS = new Set(['和', '与', '及', '或']);
/** Too general to search for alone; kept inside longer runs (健康检查). */
const GENERIC = new Set(['功能', '检查']);
const ASCII_STOP = new Set(['bug', 'bugs', 'to', 'case', 'cases', 'test', 'tests', 'testing', 'list', 'of', 'the', 'a', 'an', 'and', 'or', 'for', 'in', 'on', 'with', 'story', 'plm', 'support', 'supports', 'fix', 'regression', 'bug2case']);
/** A last segment of exactly three Han characters after a dash or underscore: in sampled titles nearly always the author's name. */
const TRAILING_NAME = /[-_—–]\s*\p{Script=Han}{3}\s*$/u;

function splitRun(run: string): string[] {
  let parts = [run];
  for (const word of SPLIT_WORDS) parts = parts.flatMap((part) => part.split(word));
  const out: string[] = [];
  for (const part of parts) {
    const chars = [...part];
    let start = 0;
    for (let i = 0; i < chars.length; i++) {
      if (JOINERS.has(chars[i]) && i - start >= 2 && chars.length - i - 1 >= 2) {
        out.push(chars.slice(start, i).join(''));
        start = i + 1;
      }
    }
    out.push(chars.slice(start).join(''));
  }
  return out.filter((part) => [...part].length >= 2 && !GENERIC.has(part));
}

/** Feature words of a title: Han runs split at function words, and ASCII words; ids, versions, dates, markers, product names and a trailing author name left out. */
export function featureTerms(title: string, productNames: readonly string[] = [], max = DEFAULT_TERMS): string[] {
  let text = title.slice(0, MAX_SCAN).normalize('NFKC');
  const name = TRAILING_NAME.exec(text);
  if (name !== null && name.index > 0) text = text.slice(0, name.index);
  const names = productNames.map((entry) => entry.normalize('NFKC').toLowerCase()).filter((entry) => entry !== '');
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (term: string): void => {
    const key = term.toLowerCase();
    if (out.length >= max || seen.has(key)) return;
    seen.add(key);
    out.push([...term].slice(0, MAX_TERM).join(''));
  };
  for (const match of text.matchAll(TOKEN)) {
    const token = match[0];
    if (/^\p{Script=Han}/u.test(token)) {
      for (const part of splitRun(token)) add(part);
      continue;
    }
    const lower = token.toLowerCase();
    if (token.length < 2 || ASCII_STOP.has(lower)) continue;
    if (/^[0-9._]+$/.test(token) || /[0-9]{4,}/.test(token) || /[0-9]+\.[0-9]+\.[0-9]+/.test(token)) continue;
    if (/^(?:plm|bug|story)[0-9]/.test(lower)) continue;
    if (names.some((entry) => lower === entry || (lower.startsWith(entry) && /^[0-9._]/.test(lower.slice(entry.length))))) continue;
    add(token);
  }
  return out;
}

/** One search term inside an external id: white space, '@', '%', '+' and controls percent-encoded, lone surrogates dropped. */
function encodeTerm(term: string): string {
  let out = '';
  for (const ch of term) {
    const code = ch.codePointAt(0) as number;
    if (code >= 0xd800 && code <= 0xdfff) continue;
    out += mustEncodeInExternalId(code) ? percentEncode(code) : ch;
  }
  return out;
}

export function specSearchId(terms: readonly string[]): ExternalObjectId | null {
  const encoded = terms.map(encodeTerm).filter((term) => term !== '');
  return encoded.length === 0 ? null : `manual:spec-search:${encoded.join('+')}`;
}

// The function ---------------------------------------------------------------------------------------------------------------

type BareIds = 'both' | IdKind | 'skip';
type Params = {
  stories: string[] | null;
  bugs: string[] | null;
  ranges: { story: IdRange | null; bug: IdRange | null } | null;
  bareIds: BareIds;
  specSearch: boolean;
  maxTerms: number;
};
const BARE_IDS = ['both', 'story', 'bug', 'skip'] as const satisfies readonly BareIds[];

function idList(value: unknown, name: string, warnings: WarningSink): string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) {
    warnings.note({ code: `${PACK}.parameter_ignored`, message: `参数 ${name} 不是数组，已忽略`, data: { parameter: name } });
    return null;
  }
  const out: string[] = [];
  for (const entry of value) {
    const text = typeof entry === 'number' && Number.isSafeInteger(entry) ? String(entry) : typeof entry === 'string' ? entry.trim() : '';
    if (/^[1-9][0-9]{0,11}$/.test(text)) out.push(text);
    else warnings.note({ code: `${PACK}.parameter_ignored`, message: `参数 ${name} 里的 ${clip(String(textOf(entry) ?? typeof entry), 40).text} 不是编号，已忽略`, data: { parameter: name } });
  }
  return out;
}

/** One kind's range: absent (null), or `{ min?, max? }` with non-negative integer bounds, min <= max. */
function readRange(value: unknown): IdRange | null | undefined {
  if (value === undefined) return null;
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'min' && key !== 'max')) return undefined;
  const range: IdRange = {};
  for (const [key, bound] of Object.entries(value)) {
    if (bound === undefined) continue;
    if (typeof bound !== 'number' || !Number.isSafeInteger(bound) || bound < 0) return undefined;
    if (key === 'min') range.min = bound;
    else range.max = bound;
  }
  if (range.min !== undefined && range.max !== undefined && range.min > range.max) return undefined;
  return range;
}

function readParams(raw: unknown, warnings: WarningSink): Params {
  const params: Params = { stories: null, bugs: null, ranges: null, bareIds: 'both', specSearch: true, maxTerms: DEFAULT_TERMS };
  if (!isRecord(raw)) return params;
  const ignored = (parameter: string, message: string): void => warnings.note({ code: `${PACK}.parameter_ignored`, message, data: { parameter } });
  params.stories = idList(raw.stories, 'stories', warnings);
  params.bugs = idList(raw.bugs, 'bugs', warnings);
  if (raw.idRanges !== undefined) {
    const ranges = isRecord(raw.idRanges) && Object.keys(raw.idRanges).every((key) => key === 'story' || key === 'bug') ? raw.idRanges : null;
    const story = ranges === null ? undefined : readRange(ranges.story);
    const bug = ranges === null ? undefined : readRange(ranges.bug);
    if (story === undefined || bug === undefined) ignored('idRanges', '参数 idRanges 应为 { story?: { min?, max? }, bug?: { min?, max? } }，边界是非负整数且 min 不大于 max；已忽略');
    else if (story !== null || bug !== null) params.ranges = { story, bug };
  }
  if (raw.bareIds !== undefined) {
    const bare = BARE_IDS.find((candidate) => candidate === raw.bareIds);
    if (bare !== undefined) params.bareIds = bare;
    else ignored('bareIds', '参数 bareIds 只能是 both、story、bug 或 skip，按 both 处理');
  }
  if (raw.specSearch !== undefined) {
    if (typeof raw.specSearch === 'boolean') params.specSearch = raw.specSearch;
    else ignored('specSearch', '参数 specSearch 不是布尔值，按 true 处理');
  }
  if (raw.maxTerms !== undefined) {
    if (typeof raw.maxTerms === 'number' && Number.isInteger(raw.maxTerms) && raw.maxTerms >= 1 && raw.maxTerms <= MAX_TERMS) params.maxTerms = raw.maxTerms;
    else ignored('maxTerms', `参数 maxTerms 应为 1 到 ${MAX_TERMS} 的整数，按 ${DEFAULT_TERMS} 处理`);
  }
  return params;
}

const inRange = (id: string, range: IdRange | null): boolean => {
  if (range === null) return true;
  const value = Number(id);
  return (range.min === undefined || value >= range.min) && (range.max === undefined || value <= range.max);
};

/** The kinds an id is read as, and how that was decided. */
function kindsOf(found: FoundId, params: Params): { kinds: IdKind[]; how: 'marker' | 'range' | 'bare' } {
  if (found.kind !== null) return { kinds: [found.kind], how: 'marker' };
  if (params.ranges !== null) {
    const story = inRange(found.id, params.ranges.story);
    const bug = inRange(found.id, params.ranges.bug);
    if (story !== bug) return { kinds: [story ? 'story' : 'bug'], how: 'range' };
  }
  const bare = params.bareIds;
  return { kinds: bare === 'both' ? ['story', 'bug'] : bare === 'skip' ? [] : [bare], how: 'bare' };
}

function rootText(model: unknown): string | null {
  if (!isRecord(model) || !Array.isArray(model.nodes) || model.nodes.length === 0) return null;
  const root = model.nodes[0];
  if (!isRecord(root)) return null;
  if (typeof root.text === 'string') return root.text;
  return isRecord(root.data) ? textOf(root.data.text) : null;
}

export function expectedSources(input: unknown): SourcesOutput {
  const warnings = warningSink();
  if (!isRecord(input) || !Array.isArray(input.documents)) {
    return failure('invalid_input', '输入里没有 documents 数组', '按 { documents: [{ documentId, model, title?, ancestors? }], product, parameters } 传入');
  }
  const params = readParams(input.parameters, warnings);
  const product = isRecord(input.product) && Array.isArray(input.product.names) ? input.product.names.filter((name): name is string => typeof name === 'string') : [];
  const external: ExternalObjectId[] = [];
  const basis: SourceBasis[] = [];
  const seen = new Set<string>();
  const unknownKind: string[] = [];
  const bind = (entry: SourceBasis): void => {
    if (seen.has(entry.external)) return;
    seen.add(entry.external);
    external.push(entry.external);
    basis.push(entry);
  };
  const explicit = params.stories !== null || params.bugs !== null;
  for (const [kind, ids] of [['story', params.stories], ['bug', params.bugs]] as const) {
    for (const id of ids ?? []) bind({ external: `plm:${kind}:${id}`, document: null, from: 'parameter', text: id, marker: null, reason: `调用方在参数里给出的${KIND_LABEL[kind]}编号` });
  }
  for (const [position, raw] of input.documents.entries()) {
    const documentId = isRecord(raw) ? textOf(raw.documentId) : null;
    if (!isRecord(raw) || documentId === null || isBlank(documentId)) {
      warnings.add({ code: `${PACK}.document_skipped`, message: `第 ${position + 1} 份文档缺少 documentId，没有读取它的期望来源`, data: { position } });
      continue;
    }
    const title = typeof raw.title === 'string' ? raw.title : null;
    const root = rootText(raw.model);
    const texts: Array<{ from: SourceBasis['from']; text: string; where: string }> = [];
    if (title !== null && !isBlank(title)) texts.push({ from: 'title', text: title, where: '标题' });
    if (root !== null && !isBlank(root) && collapseWhitespace(root) !== collapseWhitespace(title ?? '')) texts.push({ from: 'root', text: root, where: '脑图根节点' });
    const ancestors = Array.isArray(raw.ancestors) ? raw.ancestors.filter((label): label is string => typeof label === 'string' && !isBlank(label)) : [];
    for (const label of [...ancestors].reverse()) texts.push({ from: 'ancestor', text: label, where: `上级目录“${clip(collapseWhitespace(label), 40).text}”` });
    if (texts.length === 0) warnings.add({ code: `${PACK}.document_skipped`, message: `文档 ${documentId} 没有标题，读不出期望来源`, document: documentId });
    if (!explicit) {
      for (const { from, text, where } of texts) {
        for (const found of extractIds(text)) {
          const { kinds, how } = kindsOf(found, params);
          if (how === 'bare' && params.bareIds !== 'story' && params.bareIds !== 'bug' && !unknownKind.includes(found.id)) unknownKind.push(found.id);
          for (const kind of kinds) {
            const reason =
              how === 'marker'
                ? `${where}里的“${clip(found.text, 60).text}”标明是${KIND_LABEL[kind]}`
                : how === 'range'
                  ? `${where}里的编号 ${found.id} 没有标明类型，按缺陷系统的编号范围（参数 idRanges）是${KIND_LABEL[kind]}`
                  : params.bareIds === 'both'
                    ? `${where}里的编号 ${found.id} 没有标明是需求还是缺陷，需求和缺陷都读取：两种分开编号，都存在时其中一种可能与这份文档无关，引用前先核对记录的标题；不存在的那一种读取时记为不可用`
                    : `${where}里的编号 ${found.id} 没有标明类型，按参数 bareIds 当作${KIND_LABEL[kind]}`;
            bind({ external: `plm:${kind}:${found.id}`, document: documentId, from, text: clip(collapseWhitespace(text), 200).text, marker: found.marker, reason });
          }
        }
      }
    }
    const main = texts.find((entry) => entry.from !== 'ancestor');
    if (params.specSearch && main !== undefined) {
      const id = specSearchId(featureTerms(main.text, product, params.maxTerms));
      if (id !== null) bind({ external: id, document: documentId, from: main.from, text: clip(collapseWhitespace(main.text), 200).text, marker: null, reason: `${main.where}里的功能词，用来检索规格书` });
    }
  }
  if (unknownKind.length > 0) {
    const named = unknownKind.slice(0, MAX_NAMED);
    const list = `${named.slice(0, 5).join('、')}${unknownKind.length > 5 ? ' 等' : ''}`;
    warnings.note({
      code: `${PACK}.id_kind_unknown`,
      message:
        params.bareIds === 'both'
          ? `${unknownKind.length} 个编号没有标明是需求还是缺陷（${list}），需求和缺陷都读取；两种分开编号，都存在时其中一种可能与文档无关，引用前先核对记录的标题；给出编号范围（参数 idRanges），或用参数 stories、bugs 直接给出编号，可以只读对的那一种`
          : `${unknownKind.length} 个编号没有标明是需求还是缺陷（${list}），按参数 bareIds=skip 没有读取`,
      data: { ids: named, count: unknownKind.length, read: params.bareIds === 'both' ? 'both' : 'none' },
    });
  }
  return { external, basis, warnings: warnings.list() };
}

export default function (input: unknown): unknown {
  return guarded(() => expectedSources(input));
}
