// Reuse the admitted identity indexes: no additional sets or arrays for the report.
import type { KnowledgeEntryCounts } from '../../contracts/src/views.ts';

interface IdentityIndex {
  readonly size: number;
  has(entry: string): boolean;
  keys(): Iterable<string>;
}

export function countEntryPositions(placed: IdentityIndex, unplaced: IdentityIndex): KnowledgeEntryCounts {
  let loose = 0;
  for (const entry of unplaced.keys()) if (!placed.has(entry)) loose++;
  return { total: placed.size + loose, placed: placed.size, unplaced: loose };
}
