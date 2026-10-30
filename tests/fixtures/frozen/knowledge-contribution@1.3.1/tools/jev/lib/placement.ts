// Client-only tree option policy; option descriptions are filtered separately before this helper.
import { NONE_OPTION } from './decide.ts';
const MAX_REAL_OPTIONS=254;const ARRAY_INDEX=/^(?:0|[1-9][0-9]*)$/;
export interface PlacementChild {name:string;description:string|null;path:string}
export function narrowCandidates(children: readonly PlacementChild[], text: string): PlacementChild[] | null {
  if (children.length <= MAX_REAL_OPTIONS) return [...children];
  const folded = text.normalize('NFC').toLowerCase();
  const kept = children.filter((child) => folded.includes(child.name.normalize('NFC').toLowerCase()));
  return kept.length === 0 || kept.length > MAX_REAL_OPTIONS ? null : kept;
}

/** Option names for children: the name itself when the service can take it, else child-<k>. */
export function optionNames(children: readonly PlacementChild[]): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>([NONE_OPTION]);
  children.forEach((child, index) => {
    const name = child.name;
    const usable =
      name.length <= 128 && name.trim() === name && name !== '' && name !== NONE_OPTION && !ARRAY_INDEX.test(name) && name !== '__proto__' && !/\p{Cc}/u.test(name) && name.isWellFormed();
    let option = usable ? name : `child-${index + 1}`;
    while (taken.has(option)) option = `${option}-${index + 1}`;
    taken.add(option);
    out.set(option, name);
  });
  return out;
}
