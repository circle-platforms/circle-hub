// The files one pack version adds, removes or modifies against another, by path and digest: pack publish --dry-run compares
// the version it checks with the version in use.
import type { ChangeKind } from '../../../contracts/generated/vocabulary.ts';
import type { PackManifest } from '../../../contracts/src/pack.ts';

export interface PackFileChange {
  path: string;
  change: ChangeKind;
}

/** Every listed file that differs, in path order. pack.json is not among them: its digest is the version's. */
export function packChanges(from: Pick<PackManifest, 'files'>, to: Pick<PackManifest, 'files'>): PackFileChange[] {
  const before = new Map(from.files.map((file) => [file.path, file.sha256]));
  const after = new Map(to.files.map((file) => [file.path, file.sha256]));
  const out: PackFileChange[] = [];
  for (const [path, sha256] of after) {
    const earlier = before.get(path);
    if (earlier === undefined) out.push({ path, change: 'added' });
    else if (earlier !== sha256) out.push({ path, change: 'modified' });
  }
  for (const path of before.keys()) if (!after.has(path)) out.push({ path, change: 'removed' });
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
