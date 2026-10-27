import {fileURLToPath} from 'node:url';
import {packagingCli} from '../../workflow/case-review/packaging.ts';
export const PACK_DIR=fileURLToPath(new URL('./',import.meta.url));
if(import.meta.main)process.exitCode=await packagingCli({'workbook-format':PACK_DIR},process.argv.slice(2));
export {xlsxParser} from './functions/xlsx.ts';
export type {XlsxModel,XlsxCell,XlsxSheet} from './functions/xlsx.ts';
