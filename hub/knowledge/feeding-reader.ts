// Views delegate to the authenticated Hub write/read layer. Its position comes from the immutable record sequence,
// not an extra client-supplied field in a generated object. A missing historical freeze remains null.
import type {VersionBinding} from '../../contracts/src/feeding.ts';
import type {Principal} from '../records/api.ts';
import type {FeedingReader} from './feeding-types.ts';
export class RecordFeedingReader implements FeedingReader {
 readonly layer:FeedingReader;
 constructor(layer:FeedingReader){this.layer=layer;}
 cut(product:string,offset:number|null,principal?:Principal){return this.layer.cut(product,offset,principal);}
 frozenOffset(run:string){return this.layer.frozenOffset(run);}
}

/** The bound lines of an object: every binding that says bound; conflict candidates are returned beside, never resolved. */
export function boundLines(bindings: readonly VersionBinding[]): { bound: string[]; conflicts: string[][]; undeclared: boolean } {
  const bound = new Set<string>();
  const conflicts: string[][] = [];
  let undeclared = false;
  for (const binding of bindings) {
    if (binding.state === 'bound' && binding.line !== null) bound.add(binding.line);
    if (binding.state === 'conflict') conflicts.push(binding.candidates);
    if (binding.state === 'undeclared') undeclared = true;
  }
  return { bound: [...bound].sort(), conflicts, undeclared };
}
