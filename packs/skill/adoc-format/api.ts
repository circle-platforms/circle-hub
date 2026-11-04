// Public surface of the adoc-format skill pack for the Hub core and tools. pack.json lists only the shipped files
// (SKILL.md, skill.json and functions/), never this file, the README, the tests or testing/. Product packs cannot import
// it from their sandbox; they carry the generated copy of functions/directory.ts that tools/gen-contracts.ts writes.
//
//   node packs/skill/adoc-format/api.ts check | sign | stage <directory>
import {fileURLToPath} from 'node:url';

export const PACK_ID='adoc-format';
/** Absolute path of the pack's source directory, with a trailing separator. */
export const PACK_DIR=fileURLToPath(new URL('./',import.meta.url));

export {DIRECTORY_LIMITS,DirectorySourceError,ERROR_PREFIX,booksOf,directoryOf,layoutOf,listedSources,mainsOf,rootId,safePath,treeOf} from './functions/directory.ts';
export type {BookGroup,BookMain,BookWalk,Directory,DirectoryLayout,DirectoryTree,Member} from './functions/directory.ts';

// The packaging tool is loaded only when this file runs as a command, so importing the surface pulls in no other pack.
if(import.meta.main){
 const {packagingCli}=await import('../../workflow/case-review/packaging.ts');
 process.exitCode=await packagingCli({[PACK_ID]:PACK_DIR},process.argv.slice(2));
}
