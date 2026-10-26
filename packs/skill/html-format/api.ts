import {fileURLToPath} from 'node:url';
import {packagingCli} from '../../workflow/case-review/packaging.ts';
export const PACK_DIR=fileURLToPath(new URL('./',import.meta.url));
if(import.meta.main)process.exitCode=await packagingCli({'html-format':PACK_DIR},process.argv.slice(2));
export {htmlParser, decodeHtmlText} from './functions/html.ts';
export type {HtmlModel, HtmlBlock, HtmlLink, HtmlRun, HtmlWrapper} from './functions/html.ts';
