// Transitional platform parsers. Remaining format implementations migrate in R5 B5.
import { createParserRegistry, type Parser, type ParserRegistry } from '../parser.ts';
import { jsonParser } from './json.ts';
import { markdownParser } from './markdown.ts';
import { textParser } from './text.ts';

/** Transitional formats only; installed skill parsers are registered separately. */
export function defaultParsers(): Parser[] {
  return [markdownParser, jsonParser, textParser] as Parser[];
}

export function createDefaultRegistry(): ParserRegistry {
  return createParserRegistry(defaultParsers());
}

export { jsonParser, markdownParser, textParser };
