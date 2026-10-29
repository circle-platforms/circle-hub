// Public surface of hub/refs: references (B03), parsers, the verbatim quote check and resolution (T04). Other packages
// import only from this file.
export {
  MAX_REFERENCE_LENGTH,
  MAX_SEGMENTS,
  MAX_SELECTOR_LENGTH,
  ReferenceSyntaxError,
  formatReference,
  normalizeReference,
  parseReference,
  pathOf,
  pathSegments,
  pointerOf,
  pointerTokens,
  recReference,
  sameSource,
  sameTarget,
  selectorOf,
  selectorSegment,
  selectorSegments,
  sourceOf,
  srcFragment,
  treeReference,
  trySelector,
  trySelectorSegments,
  withRange,
  withoutRange,
} from './reference.ts';
export type { EntryReference, RecReference, Reference, SrcReference, TreeReference } from './reference.ts';

export {
  DEFAULT_MAX_SELECTOR_CHARS,
  ParseEncodingError,
  ParseError,
  ParseForbiddenError,
  ParseLimitError,
  ParseSyntaxError,
  createParserRegistry,
  effectiveLimits,
  mediaTypeCharset,
  mediaTypeEssence,
  parserKey,
  recognize,
  recognizeAsync,
  parseDocument,
  parserCacheKey,
} from './parser.ts';
export type { ByteRange, Fragment, JsonObject, JsonValue, ListOptions, ParsedDocument, ParseLimits, ParseOptions, Parser, ParserRegistry } from './parser.ts';

export { createDefaultRegistry, defaultParsers, jsonParser, markdownParser, textParser } from './parsers/index.ts';
export type { MarkdownBlock, MarkdownModel, MarkdownSection } from './parsers/markdown.ts';
export type { TextModel } from './parsers/text.ts';

export { candidatesFrom, collapseWhitespace, findQuote, locateQuote, quoteMatches } from './quote.ts';
export type { QuoteCandidate, QuoteLocation, QuoteMatch, QuoteSearch, QuoteSpan, QuoteStream } from './quote.ts';

export { UNAVAILABLE_MESSAGE, createDocumentCache, fragmentDigest, isGroundable, prefetchReferences, resolveReference, sliceUtf8, verifyQuote } from './resolve.ts';
export type {
  DocumentCache,
  ReaderIdentity,
  RecordRead,
  RecordReader,
  ResolveContext,
  ResolveDiagnostic,
  ResolveResult,
  Resolved,
  SourceRead,
  SourceReader,
  TreeRead,
  TreeReader,
  UncheckedReason,
  Unresolved,
} from './resolve.ts';

export { canonicalJson, recordDigest } from './canonical-json.ts';

export {readContainerMembers} from './container.ts';

export {createSkillParserRegistry,bindLegacySkills,bindLegacyParser} from './skills.ts';
export type {SkillParserOptions} from './skills.ts';
export { sandboxReadDiagnostic } from './sandbox-diagnostic.ts';
