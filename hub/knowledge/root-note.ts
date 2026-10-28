import type { ReadRoot } from '../ports.ts';

/** The sentence a view writes when it reads the seedling and the same query still has a different sync root. */
export function readRootNote(chosen: ReadRoot | null): string | null {
  if (!chosen || chosen.source !== 'seedling' || chosen.sync === null) return null;
  return `读的是树苗根（${chosen.info.root.slice(0, 12)}）；同一构建另有同步根（${chosen.sync.root.slice(0, 12)}）`;
}
