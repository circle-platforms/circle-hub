export interface NameCandidate { shown: string; key: string }

export const LISTED_NAMES = 5;
export const MAX_EDITS = 2;
const RANKED_EDITS = 64;

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
  nearest: NameCandidate | null;
  listed: string[];
  total: number;
}

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
