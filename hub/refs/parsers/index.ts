// Transitional platform parsers. Remaining format implementations migrate in R5 B5.
import { createParserRegistry, type Parser, type ParserRegistry } from '../parser.ts';
import { htmlParser } from './html.ts';
import { jsonParser } from './json.ts';
import { markdownParser } from './markdown.ts';
import { textParser } from './text.ts';
import { xmlParser } from './xml.ts';
import { xlsxParser } from './xlsx.ts';

/** Transitional formats only; installed skill parsers are registered separately. */
export function defaultParsers(): Parser[] {
  return [xmlParser, htmlParser, markdownParser, jsonParser, textParser, xlsxParser] as Parser[];
}

export function createDefaultRegistry(): ParserRegistry {
  return createParserRegistry(defaultParsers());
}

export { htmlParser, jsonParser, markdownParser, textParser, xmlParser };
