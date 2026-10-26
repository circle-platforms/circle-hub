// Explicit unit fixture only. Production never imports or auto-installs repository skill packages.
import {kityminderParser as implementation} from '../../packs/skill/mindmap-format/functions/kityminder.ts';
import {QUOTATION_UNITS as PACKAGE_UNITS} from '../../packs/skill/mindmap-format/functions/format.ts';
import {xlsxParser as xlsxImplementation} from '../../packs/skill/workbook-format/functions/xlsx.ts';
import {xmlParser as xmlImplementation} from '../../packs/skill/xml-format/functions/xml.ts';
import {QUOTATION_UNITS as XML_PACKAGE_UNITS} from '../../packs/skill/xml-format/functions/format.ts';
import {htmlParser as htmlImplementation} from '../../packs/skill/html-format/functions/html.ts';
import {QUOTATION_UNITS as HTML_PACKAGE_UNITS} from '../../packs/skill/html-format/functions/format.ts';
import {createParserRegistry,ParseError,ParseLimitError,ParseEncodingError,ParseSyntaxError,ParseForbiddenError,QUOTATION_UNITS,type Parser,type ParsedDocument,type QuotationSource,type ParseLimits} from '../refs/parser.ts';
import {defaultParsers} from '../refs/parsers/index.ts';
import type {KityMinderModel} from '../../packs/skill/mindmap-format/functions/kityminder.ts';
import type {XlsxModel} from '../../packs/skill/workbook-format/functions/xlsx.ts';
import type {XmlModel, XmlElement} from '../../packs/skill/xml-format/functions/xml.ts';
import type {HtmlModel, HtmlBlock, HtmlLink, HtmlRun, HtmlWrapper} from '../../packs/skill/html-format/functions/html.ts';
export type {KityMinderModel,MindMapNode} from '../../packs/skill/mindmap-format/functions/kityminder.ts';
export type {XlsxModel,XlsxCell,XlsxSheet} from '../../packs/skill/workbook-format/functions/xlsx.ts';
export type {XmlModel, XmlElement} from '../../packs/skill/xml-format/functions/xml.ts';
export type {HtmlModel, HtmlBlock, HtmlLink, HtmlRun, HtmlWrapper} from '../../packs/skill/html-format/functions/html.ts';
export const kityminderParser:Parser<KityMinderModel>={...implementation,parse(bytes,options){
  try{const result=implementation.parse(bytes,options);const units=(result as typeof result&{[PACKAGE_UNITS]:QuotationSource[typeof QUOTATION_UNITS]})[PACKAGE_UNITS];return Object.assign(result,{[QUOTATION_UNITS]:units}) as ParsedDocument<KityMinderModel>;}
  catch(error){const e=error as Error&{offset?:number;limit?:keyof ParseLimits;max?:number};if(e.name==='ParseLimitError')throw new ParseLimitError('kityminder@1',e.limit!,e.max!,e.message,e.offset);if(e.name==='ParseEncodingError')throw new ParseEncodingError('kityminder@1',e.message,e.offset);if(e.name==='ParseSyntaxError')throw new ParseSyntaxError('kityminder@1',e.message,e.offset);throw new ParseError('kityminder@1',e.message);}
}};
export const xlsxParser:Parser<XlsxModel>={...xlsxImplementation,parse(bytes,options){
  try{return xlsxImplementation.parse(bytes,options) as ParsedDocument<XlsxModel>;}
  catch(error){const e=error as Error&{offset?:number;limit?:keyof ParseLimits;max?:number};if(e.name==='ParseLimitError')throw new ParseLimitError('xlsx@1',e.limit!,e.max!,e.message,e.offset);if(e.name==='ParseEncodingError')throw new ParseEncodingError('xlsx@1',e.message,e.offset);if(e.name==='ParseSyntaxError')throw new ParseSyntaxError('xlsx@1',e.message,e.offset);throw new ParseError('xlsx@1',e.message);}
}};
export const xmlParser:Parser<XmlModel>={...xmlImplementation,parse(bytes,options){
  try{const result=xmlImplementation.parse(bytes,options);const units=(result as typeof result&{[XML_PACKAGE_UNITS]:QuotationSource[typeof QUOTATION_UNITS]})[XML_PACKAGE_UNITS];return Object.assign(result,{[QUOTATION_UNITS]:units}) as ParsedDocument<XmlModel>;}
  catch(error){const e=error as Error&{offset?:number;limit?:keyof ParseLimits;max?:number;fix?:string};if(e.name==='ParseLimitError')throw new ParseLimitError('xml@1',e.limit!,e.max!,e.message,e.offset);if(e.name==='ParseEncodingError')throw new ParseEncodingError('xml@1',e.message,e.offset);if(e.name==='ParseSyntaxError')throw new ParseSyntaxError('xml@1',e.message,e.offset);if(e.name==='ParseForbiddenError')throw new ParseForbiddenError('xml@1',e.message,e.offset??null,null,e.fix);throw new ParseError('xml@1',e.message);}
}};
export const htmlParser:Parser<HtmlModel>={...htmlImplementation,parse(bytes,options){
  try{const result=htmlImplementation.parse(bytes,options);const units=(result as typeof result&{[HTML_PACKAGE_UNITS]:QuotationSource[typeof QUOTATION_UNITS]})[HTML_PACKAGE_UNITS];return Object.assign(result,{[QUOTATION_UNITS]:units}) as ParsedDocument<HtmlModel>;}
  catch(error){const e=error as Error&{offset?:number;limit?:keyof ParseLimits;max?:number;fix?:string};if(e.name==='ParseLimitError')throw new ParseLimitError('html@1',e.limit!,e.max!,e.message,e.offset,e.fix);if(e.name==='ParseEncodingError')throw new ParseEncodingError('html@1',e.message,e.offset);if(e.name==='ParseSyntaxError')throw new ParseSyntaxError('html@1',e.message,e.offset);if(e.name==='ParseForbiddenError')throw new ParseForbiddenError('html@1',e.message,e.offset??null,null,e.fix);throw new ParseError('html@1',e.message);}
}};
export const testParsers=()=>[kityminderParser,xlsxParser,xmlParser,htmlParser,...defaultParsers()];
export const createTestParserRegistry=()=>createParserRegistry(testParsers());
