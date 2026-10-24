// Pack data of the case index (product knowledge and the team's conventions; pure constants and small pure helpers):
// - the external ids and build roles the sync plan and the case producer share;
// - the case rule of the team's test mind maps, as the case-review workflow pack's projection reads them (its defaults:
//   case priority 2, group priority 1, precondition priority 3); a case is a node the tagged rule or the marked rule names;
// - the tag spellings that make a case negative (case-review tags.ts; a test keeps both equal);
// Expected quality is a client judgment, never a producer text match.

/** Build role of the case documents (a list of agile:case ids) and of the agile tree they were located in. */
export const CASE_DOCUMENTS_ROLE = 'case_documents';
export const CASE_TREE_ROLE = 'case_tree';
/** The agile system pack's read of every configured root at once. */
export const CASE_TREE_ID = 'agile:tree:roots';
/**
 * The agile system pack's read of one document for the case index: no nested read, and the content names its document in
 * the wrapper member CASE_MEMBER (`agile: {id}`), which kityminder@1 keeps in model.meta (agile.ts CASE_MEMBER; a test
 * keeps both equal).
 */
export const CASE_PREFIX = 'agile:case:';
export const CASE_MEMBER = 'agile';
/** The review read of a document (title and folders as nested reads); the case index does not use it. */
export const MINDMAP_PREFIX = 'agile:mindmap:';
/** The synthetic default imposes no case-index floor; real sync receives the declared deployment variable. */
export const DEFAULT_MIN_LINE: string | null = null;
/** Document ids the agile system pack can read (agile.ts ID); anything else is never listed. */
export const AGILE_ID = /^[0-9A-Za-z_-]{1,64}$/;

/** The case rule of the case-review projection (project.ts DEFAULTS). */
export const CASE_RULE = { casePriority: 2, groupPriority: 1, preconditionPriority: 3 } as const;

// ---------------------------------------------------------------- tags (case-review tags.ts, copied: packs cannot import each other)

const CATEGORIES = ['Functional', 'Configuration', 'Integration', 'Compatibility', 'Negative', 'Stress'] as const;
type Category = (typeof CATEGORIES)[number];
const SPELLINGS: Readonly<Record<Category, readonly string[]>> = {
  Functional: ['functional', 'function', 'functions', 'functionality', 'func', '功能', '功能性', '基本功能'],
  Configuration: ['configuration', 'configurations', 'config', 'configs', 'configure', 'cfg', '配置'],
  Integration: ['integration', 'integrations', 'integrated', 'integrate', '集成'],
  Compatibility: ['compatibility', 'compatible', 'compat', '兼容', '兼容性'],
  Negative: ['negative', 'neg', '负向', '负面', '反向', '逆向', '异常'],
  Stress: ['stress', 'pressure', '压力', '压测'],
};
const BY_KEY = new Map<string, Category>();
for (const category of CATEGORIES) for (const key of SPELLINGS[category]) BY_KEY.set(key, category);
const EDGE = new Set([...'[]【】()（）{}<>《》「」『』"\'“”‘’`#*.,;:!?。，；：！？、']);
const SUFFIXES = ['测试用例', 'testing', 'tests', 'cases', '测试', '用例', 'test', 'case'];
const MAX_TAG = 200;

/** Unicode White_Space (the set of case-review text.ts): every run becomes one space, both ends trimmed. */
function isWhiteSpace(code: number): boolean {
  if (code <= 0x20) return code === 0x20 || (code >= 0x09 && code <= 0x0d);
  if (code < 0x85) return false;
  return code === 0x85 || code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000;
}

function collapse(text: string): string {
  let out = '';
  let space = false;
  for (let i = 0; i < text.length; i++) {
    if (isWhiteSpace(text.charCodeAt(i))) space = true;
    else {
      if (space && out !== '') out += ' ';
      space = false;
      out += text[i];
    }
  }
  return out;
}

/** The folded tag the spellings are matched in (case-review tagKey). */
export function tagKey(raw: string): string {
  const chars = [...collapse(raw.normalize('NFKC')).toLowerCase()];
  let start = 0;
  let end = chars.length;
  while (start < end && (EDGE.has(chars[start]) || chars[start] === ' ')) start += 1;
  while (end > start && (EDGE.has(chars[end - 1]) || chars[end - 1] === ' ')) end -= 1;
  return chars.slice(start, end).join('').replace(/[\s\-_]+/g, '');
}

function categoryOf(tag: string): Category | null {
  if (tag === '' || tag.length > MAX_TAG) return null;
  const key = tagKey(tag);
  const direct = BY_KEY.get(key);
  if (direct !== undefined) return direct;
  for (const suffix of SUFFIXES) {
    if (key.length > suffix.length && key.endsWith(suffix)) {
      const stripped = BY_KEY.get(key.slice(0, -suffix.length));
      if (stripped !== undefined) return stripped;
    }
  }
  return null;
}

/** Negative exactly when a tag names the Negative category; null when no tag is written (an untagged case). */
export function negativeOf(tags: readonly string[]): boolean | null {
  if (!tags.some((tag) => !isBlank(tag))) return null;
  return tags.some((tag) => categoryOf(tag) === 'Negative');
}

/** No character outside Unicode White_Space. */
export function isBlank(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (!isWhiteSpace(text.charCodeAt(i))) return false;
  return true;
}

// Expected quality is not computed in the product producer.

