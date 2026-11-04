// The product's side of the fixed-revision SVN directory walk that sync's source plan and the manual producer share.
// The walk itself is the adoc-format skill's generic module (packs/skill/adoc-format/functions/directory.ts), present
// here as the generated package-local copy ../generated/adoc-directory.ts because a sandboxed function reads only its own
// pack. This file adds only the product's own refusal codes; the version-line directory spelling is the `layout` that
// product.json declares next to each family's root, passed to directoryOf by the callers.
import {DirectorySourceError} from '../generated/adoc-directory.ts';

export {DIRECTORY_LIMITS as ADOC_LIMITS,DirectorySourceError as ManualSourceError,booksOf,directoryOf,listedSources,mainsOf,rootId} from '../generated/adoc-directory.ts';
export type {BookGroup,BookMain,BookWalk,DirectoryTree} from '../generated/adoc-directory.ts';
/** A refusal raised by this product's own checks, under the product pack's code namespace. */
export const stop=(code:string,message:string,next='核对本族 ROOT、MAIN 和同修订号 SVN 原件后重跑同步'):never=>{throw new DirectorySourceError('famx.adoc.'+code,message,next);};
