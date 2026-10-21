// Helpers over Build values shared by the listing parser, the build selection and the sync plan: whether a build links a
// command tree of its own, and which copy of a build name listed more than once is kept (a total, content-based order).
import type { Build } from './types.ts';
import { canonicalJson, compareNullable, compareText, isRecord } from './util.ts';

/** True when the build's files link a command tree: a record with a non-empty href (JSON may carry null, {} or ''). */
export function hasCommandTree(build: Build): boolean {
  const files: unknown = isRecord(build) ? build.files : undefined;
  if (!isRecord(files)) return false;
  const tree = files.commandTree;
  return isRecord(tree) && typeof tree.href === 'string' && tree.href.trim() !== '';
}

/**
 * Order of two copies of one build name, the copy to keep first: the later build time (a rebuild under the same name), then
 * a release before none and the later release first, then the copy that links a command tree, then canonical JSON. Total,
 * so the copy kept never depends on the order in which the copies arrive.
 */
export function compareCopies(a: Build, b: Build): number {
  return (
    compareNullable(b.built, a.built) ||
    compareNullable(b.released, a.released) ||
    Number(hasCommandTree(b)) - Number(hasCommandTree(a)) ||
    compareText(canonicalJson(a), canonicalJson(b))
  );
}
