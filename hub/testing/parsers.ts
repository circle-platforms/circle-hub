// Explicit unit fixture only. Production never imports or auto-installs repository skill packages.
import {kityminderParser as implementation} from '../../packs/skill/mindmap-format/functions/kityminder.ts';
import {QUOTATION_UNITS as PACKAGE_UNITS} from '../../packs/skill/mindmap-format/functions/format.ts';
import {createParserRegistry,ParseError,ParseLimitError,ParseEncodingError,ParseSyntaxError,QUOTATION_UNITS,type Parser,type ParsedDocument,type QuotationSource,type ParseLimits} from '../refs/parser.ts';
import {defaultParsers} from '../refs/parsers/index.ts';
import type {KityMinderModel} from '../../packs/skill/mindmap-format/functions/kityminder.ts';
export type {KityMinderModel,MindMapNode} from '../../packs/skill/mindmap-format/functions/kityminder.ts';
export const kityminderParser:Parser<KityMinderModel>={...implementation,parse(bytes,options){
  try{const result=implementation.parse(bytes,options);const units=(result as typeof result&{[PACKAGE_UNITS]:QuotationSource[typeof QUOTATION_UNITS]})[PACKAGE_UNITS];return Object.assign(result,{[QUOTATION_UNITS]:units}) as ParsedDocument<KityMinderModel>;}
  catch(error){const e=error as Error&{offset?:number;limit?:keyof ParseLimits;max?:number};if(e.name==='ParseLimitError')throw new ParseLimitError('kityminder@1',e.limit!,e.max!,e.message,e.offset);if(e.name==='ParseEncodingError')throw new ParseEncodingError('kityminder@1',e.message,e.offset);if(e.name==='ParseSyntaxError')throw new ParseSyntaxError('kityminder@1',e.message,e.offset);throw new ParseError('kityminder@1',e.message);}
}};
export const testParsers=()=>[kityminderParser,...defaultParsers()];
export const createTestParserRegistry=()=>createParserRegistry(testParsers());
