// The names a caller gets when it asks for something by a name the Hub does not have: a workflow, a named document. Only names
// the caller may use are ever given (the caller's own list, never a catalog), the nearest one only when it is plain which
// one that is, and no name decides anything: the answer is a pointer for the caller to check, not a guess the Hub acts on.

/** A name the caller may use: `shown` is what the answer says (a workflow as `id@version`), `key` what the asked name is compared with. */
export interface NameCandidate { shown: string; key: string }

/** How many names a refusal lists when none is near enough to be the one meant. */
export const LISTED_NAMES = 5;
/** The most edits (insert, delete, replace one character) between the name asked for and a name that may be the one meant. */
export const MAX_EDITS = 2;
/** How far apart names are told, for the order of a list: the nearest first, far beyond what makes a name the one meant. */
const RANKED_EDITS = 64;

/**
 * The edit distance between two names when it is at most `max`, else `max + 1`. The work is bounded by the length of the
 * shorter name times `max`, however long the longer one is: a name that cannot be within `max` edits is answered by its length.
 */
export function boundedDistance(left: string, right: string, max: number): number {
  const over = max + 1;
  if (Math.abs(left.length - right.length) > max) return over;
  let previous = Array.from({ length: right.length + 1 }, (_, column) => (column <= max ? column : over));
  for (let row = 1; row <= left.length; row++) {
    const current = new Array<number>(right.length + 1).fill(over);
    if (row <= max) current[0] = row;
    let best = current[0]!;
    for (let column = Math.max(1, row - max); column <= Math.min(right.length, row + max); column++) {
      const value = Math.min(
        current[column - 1]! + 1,
        previous[column]! + 1,
        previous[column - 1]! + (left.charCodeAt(row - 1) === right.charCodeAt(column - 1) ? 0 : 1),
      );
      current[column] = Math.min(value, over);
      best = Math.min(best, current[column]!);
    }
    if (best > max) return over;
    previous = current;
  }
  return Math.min(previous[right.length]!, over);
}

export interface NameSuggestion {
  /** The one name that is plainly the one meant, or null. */
  nearest: NameCandidate | null;
  /** At most LISTED_NAMES names, the nearest first, as `shown`. */
  listed: string[];
  /** How many names the caller may use in all. */
  total: number;
}

/**
 * The name meant by `asked` among the names the caller may use. A name is the one meant when it is within a few edits of
 * the name asked for (fewer for a short name) and no other name is as near; otherwise the nearest few are listed, so the
 * caller reads them and picks. Letter case is not told apart.
 */
export function suggestNames(asked: string, candidates: readonly NameCandidate[]): NameSuggestion {
  const wanted = asked.toLowerCase();
  const names = [...new Map(candidates.map((candidate) => [candidate.shown, candidate])).values()];
  const ranked = names
    .map((candidate) => ({ candidate, distance: boundedDistance(wanted, candidate.key.toLowerCase(), RANKED_EDITS) }))
    .sort((left, right) => left.distance - right.distance || (left.candidate.shown < right.candidate.shown ? -1 : left.candidate.shown > right.candidate.shown ? 1 : 0));
  const best = ranked[0];
  const allowed = best === undefined ? 0 : Math.min(MAX_EDITS, Math.floor(Math.max(wanted.length, best.candidate.key.length) / 3));
  const plain = best !== undefined && best.distance <= allowed && (ranked.length === 1 || ranked[1]!.distance > best.distance);
  return { nearest: plain ? best.candidate : null, listed: ranked.slice(0, LISTED_NAMES).map((row) => row.candidate.shown), total: ranked.length };
}
