import {fileURLToPath} from 'node:url';
import {packagingCli} from '../../workflow/case-review/packaging.ts';
export const PACK_DIR=fileURLToPath(new URL('./',import.meta.url));
if(import.meta.main)process.exitCode=await packagingCli({'xml-format':PACK_DIR},process.argv.slice(2));
export {xmlParser, decodeXmlText} from './functions/xml.ts';
export type {XmlModel, XmlElement} from './functions/xml.ts';
