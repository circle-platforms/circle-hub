// The core parsers: generic formats only. Product formats belong to packs.
import { createParserRegistry, type Parser, type ParserRegistry } from '../parser.ts';
import { htmlParser } from './html.ts';
import { jsonParser } from './json.ts';
import { kityminderParser } from './kityminder.ts';
import { markdownParser } from './markdown.ts';
import { textParser } from './text.ts';
import { xmlParser } from './xml.ts';
import { xlsxParser } from './xlsx.ts';

/** Core parsers in preference order: for application/json the mind-map parser is tried before plain JSON. */
export function defaultParsers(): Parser[] {
  return [kityminderParser, xmlParser, htmlParser, markdownParser, jsonParser, textParser, xlsxParser] as Parser[];
}

export function createDefaultRegistry(): ParserRegistry {
  return createParserRegistry(defaultParsers());
}

export { htmlParser, jsonParser, kityminderParser, markdownParser, textParser, xmlParser };
