import {fileURLToPath} from 'node:url';
import {packagingCli} from '../../workflow/case-review/packaging.ts';
export const PACK_DIR=fileURLToPath(new URL('./',import.meta.url));
if(import.meta.main)process.exitCode=await packagingCli({'mindmap-format':PACK_DIR},process.argv.slice(2));
export {kityminderParser} from './functions/kityminder.ts';
export type {KityMinderModel,MindMapNode} from './functions/kityminder.ts';
