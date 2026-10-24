import {declareResourceTags} from './generated/vocabulary.ts';
export {declareResourceTags as tagDeclaration} from './generated/vocabulary.ts';
// Pack data of the case index (product knowledge and the team's conventions; pure constants and small pure helpers):
// - the external ids and build roles the sync plan and the case producer share;
// - the case rule of the team's test mind maps, as the case-review workflow pack's projection reads them (its defaults:
//   case priority 2, group priority 1, precondition priority 3); a case is a node the tagged rule or the marked rule names;
// - exact author-declared test types; spelling recovery is forbidden;
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

/** Literal identity only; kept for callers until the generated field contract is connected. */
export function tagKey(raw: string): string { return raw; }

/** Test polarity is known only from a valid, complete resource declaration containing a test type. */
export function negativeOf(tags:unknown):boolean|null {return declareResourceTags(tags).negative;}

/** No character outside Unicode White_Space. */
export function isBlank(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (!isWhiteSpace(text.charCodeAt(i))) return false;
  return true;
}

// Expected quality is not computed in the product producer.

