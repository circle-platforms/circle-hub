# hub/refs: references and parsers

Model elements: **B03** (references), **T04** (resolution, the verbatim quote check), and the read tiers of **B02**.
Other packages import only from `hub/refs/api.ts`. refs imports only `contracts/`.

## What is here

| File | Content |
| --- | --- |
| `reference.ts` | `parseReference`, `formatReference`, `normalizeReference`, `sameTarget`, `sameSource`, `srcFragment`, `treeReference`, `recReference`, selector, path and pointer codecs, `MAX_SELECTOR_LENGTH`, `ReferenceSyntaxError` |
| `parser.ts` | `Parser`, `ParsedDocument`, `Fragment`, limits, typed parse errors, `createParserRegistry`, `recognize` |
| `parsers/*.ts` | the seven core parsers: `kityminder@1`, `xml@1`, `html@1`, `markdown@1`, `json@1`, `text@1`, `xlsx@1` |
| `quote.ts` | `quoteMatches`, `locateQuote`, `findQuote`, `candidatesFrom` |
| `resolve.ts` | `SourceReader`, `TreeReader`, `RecordReader`, `resolveReference`, `verifyQuote`, document cache, `isGroundable` |
| `canonical-json.ts` | RFC 8785 serialization and `recordDigest`, used to re-verify `rec:` references |
| `fixtures/` | synthetic inputs mirroring the real structures (all content invented) |

## Reference text

The four forms of `REFERENCE_FORMS` (contracts/generated/protocol.ts), parsed strictly. Every valid reference has exactly
one spelling; anything else raises `ReferenceSyntaxError` (code `REFERENCE_UNRESOLVED`, Chinese message, `position`).

```
src:<sha256>[/<parser>@<major>/<selector>[:<from>-<to>]]
tree:<root>/<path>[@<entry>]          tree:<root>/ is the root node
entry:<entry>
rec:<record>[#<JSON Pointer>]
```

- Digests are 64 lowercase hex characters. Parser names match `[a-z][a-z0-9_.-]{0,63}`, majors are decimal without
  leading zeros. A parser always comes with a selector, and only a src fragment may carry a range.
- Selectors and paths are `/`-separated non-empty segments; pointers follow RFC 6901 (`~0`, `~1`, empty tokens allowed).
- **Escaping**: a character is percent-encoded (UTF-8, upper-case hex) if and only if it is `%`, a control or format
  character (`\p{Cc}`, `\p{Cf}`: zero-width and bidi marks included), any space or separator (`\p{Z}`), or structural
  in that part: `/` and `:` in selectors, `/` and `@` in tree paths, `#` in pointers. Everything else, CJK included,
  is written raw. An escape where none is needed, lower-case hex or a raw reserved character is non-canonical and refused.
- The `Reference` objects of contracts/src/reference.ts hold the canonical text of `selector`, `path` and `pointer`, so
  `formatReference` and `parseReference` are exact inverses. `selectorSegments`/`selectorOf`, `pathSegments`/`pathOf`
  and `pointerTokens`/`pointerOf` convert to and from decoded segments.
- `:<from>-<to>` is a half-open range of **UTF-8 bytes of the fragment's text** (`from < to`), the same for every parser,
  so it does not depend on the source encoding. A range that leaves the text or splits a character does not resolve.
- An external object identity (`system:type:id@revision`) is not a reference (B03 R[5]) and is refused.
- `normalizeReference` accepts loose spellings (surrounding white space, upper-case scheme or hex, escapes in any case or
  where none is needed, raw spaces, a trailing `/`, leading zeros) and returns the canonical text or raises. It is a
  sequence of linear scans (no backtracking regular expression) and refuses input longer than 9216 characters
  (`MAX_REFERENCE_LENGTH` plus 1024 for white space and redundant escapes) before any work, so model text is safe input.
  `sameTarget` compares canonical texts; `sameSource` compares scheme and primary digest.
- `MAX_SELECTOR_LENGTH` (4096) is the longest canonical selector a core parser lists or answers with; any src reference
  built from it, with a range, fits `MAX_REFERENCE_LENGTH`. The case-review pack uses the same 4096 for its `n/` ids.

## Parsers and selectors

| Parser | Media types | Selectors | Fragment text | Byte range |
| --- | --- | --- | --- | --- |
| `kityminder@1` | application/json | `n/<data.id>` (unique ids only), `i[/<k>]...` child positions from the root (0-based); either `/@<field>` for one data field | node text; a field as its string, else JSON | none |
| `xml@1` | application/xml, text/xml | `x/<name>/<name>[k]...` (k from 1, written only when the name repeats among siblings), `i[/<k>]...` element positions (0-based); either `/@<attribute>` | XPath string value of the element; attribute value | element, start tag to end tag |
| `html@1` | text/html, application/xhtml+xml | `b/<k>` block, `b/<a>-<b>` blocks a to b (a < b), `a/<k>` link (0-based) | rendered block text (`<br>` is a line break); blocks joined with LF; link text | text span of the block (or blocks); the link element |
| `markdown@1` | text/markdown, text/x-markdown | `h/<heading>/...` a section; `b/<k>[/<heading>...]` block k directly inside that section, or before the first heading | section or block exactly as written, NUL removed | section from its heading line; block lines |
| `json@1` | application/json | `p` the document, `p/<token>/...` member names and array indices | strings as they are, other values as JSON | none |
| `text@1` | text/plain, text/* | `l/<n>` line n (from 1), `l/<a>-<b>` lines a to b (a < b) | the lines joined with LF | from the first line's start to the last line's end |
| `xlsx@1` | application/vnd.openxmlformats-officedocument.spreadsheetml.sheet | `c/<sheet name>/<A1>`, `n/<name>`, `n/<sheet name>/<local name>`; `i/<sheet>/<row>/<cell>` or `i/n/<name index>` fallback (0-based) | decoded cell value or name reference | none |

`locate` returns null for anything that does not locate exactly one fragment (it never throws for bad selectors) and
returns the canonical selector in `Fragment.selector`: an XML index path or an explicit `[1]` resolves to the name path.
`listSelectors(prefix?, { limit?, properties? })` lists canonical selectors in document order (ranges are locatable but
not listed); `properties` adds XML attributes and mind-map fields. `summary()` holds structure only (counts, depth,
element or field names), never document text, so it is safe for sources the reader may not read.

**Selector length.** A canonical selector is at most `MAX_SELECTOR_LENGTH` characters. When a name path would be longer,
`xml@1` and `kityminder@1` fall back to the position path (`i/...`); `markdown@1` sections and blocks and `json@1` values
have no position form, so they get no selector (`MarkdownSection.selector` and `MarkdownBlock.selector` are null, the
fragment is not listed and does not locate). Name paths repeat their ancestors, so long names over many nodes would
still multiply: every parser that builds such paths adds up the length of everything `listSelectors` could return and
refuses the document past `maxSelectorChars` (default 64 Mi characters, room for a million selectors of 64 characters;
not yet measured on the real command trees and manuals) with `ParseLimitError` (`limit: 'maxSelectorChars'`).
Selectors are built from their parent's, never by copying paths.

Parser details:

- **kityminder@1** accepts the wrapper `{root, template, theme, version}` (other wrapper members kept in `meta`) and the
  same document double-encoded as one JSON string. The model keeps every node in pre-order with its text, all data
  fields as given, ordered child indices, the parent index (the parent chain) and the canonical selector. Duplicate or
  missing ids are reported (`duplicateIds`, `missingIds`); such nodes, ids starting with `@`, and ids whose `n/`
  selector would be too long are addressed by position. Numeric ids and texts are written as decimal text.
- **xml@1** uses saxes. Entity-free external DOCTYPE identifiers are accepted and never fetched. Internal subsets accept only comments
  and processing instructions; entities, attribute lists, other markup declarations and parameter references are refused.
  The model and summary record DOCTYPE presence and that external subsets were not read.
  Charset precedence is BOM, media-type charset, then XML declaration; contradictory BOM declarations are refused.
  UTF-8, BOM-marked UTF-16LE/BE, GB18030, GBK, Big5, true ISO-8859-1 and US-ASCII are supported. Start tags whose attribute values contain their own quote character or a
  `<` are repaired before parsing by swapping those characters for unused private-use placeholders (same length, so
  positions stay exact) and swapping them back in the values: the closing quote of a value is the first one followed by
  the end of the tag, or by white space and another attribute. The repair is linear: whether a quote can close a value
  depends only on what follows it, so each quote is examined once; a value with no plausible end within 64 KiB is left
  to saxes as written. Other start-tag irregularities that saxes recovers from (missing white space, attributes without
  value, unquoted values, duplicates, bad entities or disallowed characters inside values) are tolerated. U+0000 in an
  attribute name or value is removed and counted in `nulRemoved` (model and summary); in text content it is refused, as
  XML requires. Every tolerated or repaired element carries `irregular` (Chinese notes) and, in its fragment data, the
  `startTag` as written. Any other malformation is a `ParseSyntaxError`. Element texts are slices of one text, the root's
  string value, built once; a name step looks up same-name siblings in a map, so `locate` costs the depth of the path.
- **html@1** uses parse5 with scripting off; nothing runs. Blocks follow CSS block boxes (anonymous blocks take the tag
  of the enclosing block), text is white-space collapsed except in `pre`, NBSP is kept. Each run carries its
  formatting wrappers (`font`, `b`, `strong`, `em`, `i`, `u`, `span`, ...) with their attributes, outermost first, and
  each block lists the distinct wrapper tags as `flags`; a red `font` around a released build stays visible as
  `{tag: 'font', attributes: {color: 'red'}}`. Runs inside the same wrappers share one wrapper list. `href` is the
  attribute value as parsed (quoted or not, entities decoded, never resolved against a base). Charset: BOM, then the
  media type parameter, then a `<meta>` charset, then UTF-8 if the bytes are valid UTF-8, else windows-1252. ISO-8859-1
  and ASCII labels mean windows-1252 (WHATWG). BOM-marked UTF-16 and declared GB18030/GBK/Big5 retain byte
  ranges; other legacy charsets keep the existing decoder behavior without byte ranges.
- **markdown@1** is line based and linear time (heading clean-up included: closing `#` runs, trimming and pandoc
  attribute blocks are found by scanning back from the end of the line). ATX and setext headings make the tree; blocks
  are paragraphs, lists, block quotes, fenced and indented code, HTML blocks, thematic breaks, a leading YAML metadata
  block, and tables: pipe tables, pandoc grid, multiline and simple tables. Headings inside code fences or tables are not
  headings. A heading segment is the heading text with white space collapsed and a trailing pandoc attribute block
  (`{#id}`) removed; `[k]` is appended when the text repeats among siblings (from the second), when the text itself ends
  in `[digits]`, or when it is empty. NUL is removed from texts, never from byte ranges. Every block also carries
  `path`: the decoded heading segments of its section, spelled exactly as in its `h/` selector (`[]` before the first
  heading, null when the section has no selector), so a reader sees the section path without decoding selectors; a
  skipped heading level nests under the nearest lower one and adds no segment.
- **json@1** keeps the parsed value; member names are compared as own properties only (`__proto__` is an ordinary
  key). Empty member names cannot be addressed. Member order of a re-serialized object follows ECMAScript rules.
- **text@1** splits on CRLF, CR and LF; a final terminator does not open an extra line.

All parsers: strict UTF-8 by default with the byte offset of the first invalid sequence; a declared charset where
supported; U+0000 removed from all model text (PostgreSQL text and jsonb refuse it) and counted in `nulRemoved`; other
control characters kept where the format allows them. JSON strings (kityminder@1, json@1) with unpaired surrogates from
escapes such as `\ud83d` get U+FFFD instead, counted in `surrogatesReplaced`; a member name with one is refused
(`ParseEncodingError`), since renaming could merge two members. Typed errors: `ParseLimitError` (`limit`, `max`),
`ParseEncodingError`, `ParseSyntaxError`, `ParseForbiddenError`, all `ParseError` with `code`, `parser`, `offset`,
`detail`. Nothing is evaluated, imported or fetched.

### Limits (defaults, overridable per call with positive integers)

| Parser | maxBytes | maxDepth | maxNodes | maxAttributes | maxSelectorChars |
| --- | --- | --- | --- | --- | --- |
| kityminder@1 | 16 MiB | 200 mind-map levels | 100 000 nodes | | 64 Mi |
| xml@1 | 16 MiB | 100 elements | 1 000 000 elements | 1 024 per tag | 64 Mi |
| html@1 | 16 MiB | 256 | 2 000 000 nodes (elements, text nodes, template contents) | 512 per tag and per element | (not needed) |
| markdown@1 | 16 MiB | 6 heading levels | 1 000 000 lines | | 64 Mi |
| json@1 | 16 MiB | 128 | 2 000 000 values | | 64 Mi |
| text@1 | 16 MiB | 1 | 1 000 000 lines | | (not needed) |
| xlsx@1 | 16 MiB (hard ZIP cap) | 100 XML levels | 1 000 000 XML elements across parts | 1 024 per tag | 64 Mi |

parse5 checks each new attribute against all earlier ones of the tag, scope checks walk the open-element stack, and
misnested markup makes it move nodes between child lists, so hostile input can cost quadratic time. html@1 therefore:
counts attributes per tag with a linear pre-scan that can only over-count (raw-text elements are skipped only when the
document has no `svg`, `math`, `frameset` or `select`: inside `select`, parse5 ignores `style`, `xmp`, `iframe`,
`noembed`, `noframes`, `title` and `plaintext` start tags and reads their content as markup); and parses through a
guarded tree adapter that checks depth and node limits on every insertion (text nodes and template contents included,
and depth counts on through nested templates), searches child lists from the end (foster parenting inserts before the
table, the last child), charges every scanned or shifted entry to a budget of 64 per allowed node, and caps the
attributes repeated `<html>` and `<body>` tags merge into one element at `maxAttributes`. Wrapper lists the model
spells out are capped at 4 entries per allowed node. Those two budgets raise `ParseLimitError` with `limit: 'maxNodes'`
and a message saying which. Measured on this machine: 10 MB of ordinary input parses in 0.1 to 1 s per parser; 10 MB
of tags with 500 attributes each takes about 2 s; every hostile input in the tests is refused or parsed in under 2 s.

## Quotations (T04 R[1])

`quoteMatches(fragmentText, quote)` uses decision 37: a Unicode White_Space run adjacent to a W/F code point is
removed; other interior runs count as one space and both ends are trimmed. The normalized quote must be a non-empty
verbatim substring. Case, punctuation, character width, zero-width characters and Unicode normalization form stay
significant. An unpaired surrogate never matches half a character. The same contextual function serves normalization
and the streaming KMP matcher, without a collapsed copy per candidate. The 29 shared vectors run on both refs and
rules; `locateQuote` maps matches back to UTF-8 byte offsets in the original unmodified fragment text.

`findQuote(candidates, quote)` returns the resolution (`resolved`, `ambiguous`, `unresolved`, from the vocabulary) over
candidate fragments. Every occurrence belongs to the innermost candidate around it, and the places are the candidates
that own an occurrence: a sentence found in a block and in its section is one place, while a section that also holds
the sentence in its heading, or across two of its blocks, is a second place, pinned on that occurrence. Each match
carries a `ranged` src reference (`:from-to`) pinning the occurrence it stands for, and `location.occurrences` counts
the occurrences that belong to it. Nesting comes from `span` (candidates on one shared text: the search reads that text
once), from `within` (the enclosing candidate), or else from `byteRange` in the same source.
`candidatesFrom(document, sha256, {role, prefix, properties, limit})` lists a parsed source as candidates. For the core
parsers the candidates are the fragments quotations are checked against: json@1 lists values, not the JSON text of
objects and arrays; a mind-map node stands for its own `text` field; text@1 and html@1 add the whole document
(`l/1-<n>`, `b/0-<n>`) so a quotation across a line break or a block boundary resolves. The cost of one search is linear
in the document, whatever the nesting depth.

## Resolution (B03 R[0], R[1]; B02)

`resolveReference(reference, ctx)` with `ctx = { reader, parsers, sources?, trees?, records?, consumer?, documents?,
onDiagnostic? }`. It never rejects for anything a reference or a stored source can contain.

- **src**: the parser is checked first (so that answer never depends on the source); then `SourceReader.read(sha256,
  reader)`; the bytes are re-hashed and their length compared with `size`; the parser locates the selector; a range is
  cut from the fragment text. The answer carries the canonical reference with the parser's canonical selector.
  A whole-file reference (no parser) returns the decoded text of textual media types: XML and HTML by the charset rules
  of xml@1 and html@1 (so a declaration counts), other text by the media type.
- **tree** and **entry**: `TreeReader.read(root, path, entry, reader)` and `readEntry(entry, reader)`; the knowledge
  package verifies its own digests and returns the warranting source fragments as `grounds` (B01 R[5]); grounds that are
  not canonical references are dropped and reported. With the optional `hasRoot(root, reader)`, a path or pinned entry
  missing from a root the reader may see is `REFERENCE_UNRESOLVED` (知识树里没有这个路径), like a src selector that
  locates nothing; a root the reader may not see stays `SOURCE_UNAVAILABLE`.
- **rec**: `RecordReader.read(digest, reader)`; the digest is recomputed (`recordDigest`: SHA-256 of the RFC 8785 JSON of
  `{kind, schema, provenance, created_at, body}`), the JSON Pointer is followed into the body, and the validity of the
  nearest enclosing object that has one (a claim) is returned (B03 R[0]).
- **Unavailable**: absent or forbidden sources remain the identical `SOURCE_UNAVAILABLE` answer. A service caller
  without an enclosing retry boundary enables `retryReads`: initial read plus two retries, 10/20 ms backoff. Null
  permission answers are never retried. Exhaustion or a missing configured reader reports `SOURCE_RETRYABLE`, names
  the missing read and the next retry time; integrity failures report `SOURCE_INTEGRITY_UNPROVEN` and ask the
  administrator to restore the original from backup and verify its digest. Typed integrity faults are never retried
  as transient faults. Internal, non-enumerable `reason` still keeps these faults out of boundary refusals (T03 R[3]).
  **Unresolved** (`REFERENCE_UNRESOLVED`, with a Chinese reason): bad syntax, an unregistered parser, a source that does
  not parse with the named parser, a selector that locates nothing, a bad range, a pointer that does not exist, and a
  parser answer whose canonical selector cannot be written (the core parsers never give one).
- **Read tiers** (B02 F[5], R[4]): `model_readable` gives the text; `function_bytes_only` gives the text only when
  `consumer` is `function`, otherwise a structure-only summary and the note `labelOf('read_tier', ...)`; `retain_only`
  never gives the text, the fragment or any structure, with the note `labelOf('validity_status', 'credential_unreadable')`
  (含凭据，原文不可读). For `retain_only` the selector and range are not evaluated and the reference comes back as given:
  every reference to the source gets the same answer, so probing cannot reveal line lengths, names or headings. Such a
  read may come without bytes (`SourceRead.bytes` null); any other tier without bytes is an integrity failure.
- `groundable` says whether the reference may stand alone as a claim's grounds: never an `entry:` (B01 R[5]); a `rec:`
  only for results and the Hub's own records, kinds `claim`, `validation_result`, `action`, `effect` (B01 R[4]).
- `verifyQuote(result, quote)` is true or false on readable text and null when the text cannot be checked.
- `createDocumentCache(n)` keeps parsed documents keyed by digest, parser and media type (safe: bytes behind a digest
  never change). Permission is still checked by the reader on every call.

## Decisions and deviations from the brief

The original XLSX registration changed `hub/refs/resolve.test.ts` outside this task's allowed paths: two intentionally
fixtures now use xlsx@999 for the unregistered parser, because xlsx@1 is registered. This necessary test
update is retained and disclosed to the integrator as a scope deviation; this review batch does not edit that file.

1. `Parser.parse` is synchronous for the core parsers. A pack-provided parser run in the sandbox would need an
   asynchronous adapter; none exists in milestone 1.
2. `ParseError.code` is `SOURCE_UNPARSEABLE` (decision 37). resolveReference continues to map fragment parsing
   failures to `REFERENCE_UNRESOLVED`. recognize keeps its first-success/null API; its optional onRejected callback
   receives only the last ParseError when every candidate refuses, with no callback on success or an empty registry.
3. Reference objects hold canonical (escaped) text in `selector`, `path` and `pointer` instead of decoded values, which
   keeps the parser's selector opaque to refs and makes text and object exact inverses. For ordinary pointers the
   field is literally the RFC 6901 pointer.
4. The `:from-to` range counts UTF-8 bytes of the fragment text, not source bytes, so it means the same for every parser
   and every source encoding. `Fragment.byteRange` gives the fragment's span in the source bytes where known.
5. `listSelectors` takes an optional second argument `{limit, properties}`. Readers may return values or promises.
6. refs carries its own RFC 8785 serializer for the record digest because it may import only contracts. It refuses
   exactly what `hub/records/canonical.ts` refuses (holes, `undefined` elements, non-plain objects, lone surrogates,
   cycles, non-finite numbers, nesting past 1000); a scratch comparison of both on 20 000 random values found no
   difference.
7. Markdown `maxNodes` counts lines and `maxDepth` heading levels; text `maxNodes` counts lines; html `maxNodes` counts
   elements, text nodes and template contents (raised from 1 000 000 to 2 000 000 when text nodes started to count, so
   the capacity for ordinary pages is unchanged).
8. contracts/src/reference.ts shows the example `src:<sha256>/kityminder@1/n3a9/root.children.2`; the brief's
   `n/<data.id>` grammar is implemented. The comment there is stale (request below).
9. A selector budget (`MAX_SELECTOR_LENGTH`, 4096) and a document total (`maxSelectorChars`, a new optional field of
   `ParseLimits` and `ParseOptions`) bound what selectors cost. As a result `MarkdownBlock.selector` is `string | null`
   (as `MarkdownSection.selector` already was), and an XML element or mind-map node with a very long name path has a
   position path as its canonical selector.
10. `retain_only` sources no longer have their selector checked (the earlier README said "still checked"): checking it
    answered probes. A reference to a line that does not exist resolves to the same unreadable answer.
11. `html@1` gained the selector `b/<a>-<b>`, mirroring text@1's `l/<a>-<b>`; existing selectors keep their meaning.
12. New optional model fields: `XmlModel.nulRemoved` and `KityMinderModel.surrogatesReplaced` (the parsers always set
    them; optional so that models written by hand in pack tests still type-check).
13. New optional model field `MarkdownBlock.path`: the decoded heading segments of the block's section (selector
    spelling, ordinals included), `[]` for the preamble and null exactly when the section's selector is null. The array
    is shared by the blocks of one section and, like the rest of the model, must be treated as read-only; a heading
    path past `MAX_SELECTOR_LENGTH` gives null, so a long path is never repeated per block.

## Known limits

- Parsed models and fragment `data` are plain objects shared through the document cache and are not frozen (freezing
  large models costs time): treat them as read-only.
- Selector aliases (an XML index path and its name path) are unified by `resolveReference` (canonical selector in the
  answer), not by `sameTarget`, which compares text only.
- Markdown follows CommonMark and pandoc closely but not completely: list items are one block per list, setext
  headings may span lines, lazy continuation is simplified, link reference definitions are ordinary paragraphs.
- Markdown has no fragment for the whole document, so a quotation across two top-level sections, or across two blocks
  before the first heading, does not resolve (one across two blocks of a section resolves to the section).
- A candidate whose nested candidates are known only by `within` or `byteRange` (an HTML link inside its block,
  candidates written by hand) is counted exactly, but when it owns occurrences both inside and outside a nested one,
  its pin is its first occurrence, which may lie inside the nested one. Candidates on a shared text are pinned exactly.
- `QuoteMatch.text` is the whole fragment text; an outer fragment (an XML root, a whole text file) can be large, so
  callers that show matches should cut it.
- The XML repair heuristic can misplace a closing quote when a help text contains white space, a word and `=` right
  after an inner quote (`"... "key=value" ..."`); such elements are flagged `irregular` with the start tag as written.
- XML supports only the encodings declared above. UTF-16 requires a BOM. Other legacy HTML encodings retain the
  existing platform decoder behavior and have no byte-range map.

## Tests

```
npx tsc --noEmit
node --test "hub/refs/**/*.test.ts"
```

The suite (295 tests, 20 to 30 s on this machine) covers: canonical round trips and property-style tests on 3000 generated references,
3000 segment lists, 6000 corrupted references and 4000 random strings; malformed references with positions; hostile
loose spellings under a time bound; each parser on its fixture, including the alias entries of a second name family in
the listing (`based on`, released and not); adversarial inputs (10 MB inputs per parser under a 10 s bound, deep
nesting, billion laughs, quadratic blowup and external entities, attribute bombs including select mode, nested
templates, repeated body tags, foster parenting, misnested formatting, deep wrappers, XML values that never close, long
headings, invalid UTF-8 with offsets, NUL and control characters, unpaired surrogates, 1500 random or corrupted inputs
per parser that must either parse or raise a ParseError); every public API (parse, listSelectors, locate on every
selector, candidatesFrom, findQuote, resolveReference) under a time bound on hostile input that parses; selector length
and total limits; quotation cases (NBSP, tabs, CRLF, U+3000 match; case, punctuation, width and normalization
differences do not; the shared hub/rules vectors; 4000 random cases against the definition; places and pins in nested
fragments, links, mind-map fields, JSON values, cross-line and cross-block quotations); resolution with fake readers
(tiers, retain-only probing, indistinguishable unavailability with the internal reason, visible and invisible tree
roots, digest re-verification, ranges, unwritable canonical selectors, cache); canonical JSON refusals.

## Quotation whitespace (decision 37)

A run of Unicode White_Space is removed when either adjacent code point has East_Asian_Width W or F. Other interior
runs collapse to one ASCII space; leading/trailing whitespace is trimmed. Case, punctuation, character width and
normalization form remain significant: `set 10 0` differs from `set 100`, while `超时\n时间` matches `超时时间`.
Classification is the frozen [Unicode 17.0.0 W/F data](https://www.unicode.org/Public/17.0.0/ucd/EastAsianWidth.txt)
in quote-whitespace.ts, including supplementary characters and wide emoji; ambiguous-width and halfwidth characters
are not treated as W/F. The Unicode license is included in unicode-license.txt.

One contextual function decides whitespace for normalization and streaming search. Matching, occurrence counts,
byte-range pinning and the not-found diagnostic use that rule; ranges still point into the unmodified fragment.
Rules independently implements the same quotation rule and reads the shared vectors; ordinary rules table matching retains its original whitespace
normalization. Shared vectors test both direct quotation checks and the cached collapsed-fragment path.

## Independent gold quotation alignment

`compile-check.ts` checkVerbatimQuote now independently implements decision 37. It uses a local regular-expression
classifier derived directly from Unicode 17.0.0 W/F source data (`scripts/real/gold/quote-widths.ts`, with source digest and Unicode license), with no Hub or pack imports.
Its ordinary collapseWhitespace utility remains unchanged for the separate expected-text containment contract.
Missing exported source bytes still produce the existing unknown receipt; this change does not make unavailable evidence pass.

The conformance harness lives in `hub/refs/gold-quotes.test.ts`: only that test imports both implementations. It reads
the same 29 synthetic rules vectors, adds Chinese hard-wrap, mixed-width, Latin-boundary and Unicode edge cases, and
compares a deterministic 5000-case synthetic Unicode corpus. Gold expected verdicts in the named vectors are literal
booleans, not computed from Hub output. A production dependency-closure test rejects imports of Hub or pack modules.

Read-only audit of the 120 local branch heads (committed snapshots, excluding uncommitted work; 39 distinct production
file versions below scripts/real/gold before this follow-up), plus quotation-related scripts/real call sites:

| Snapshot | Implementation / caller | Current rule and integration action |
| --- | --- | --- |
| Current branch | `scripts/real/gold/compile-check.ts`: compileCheck expected-text containment (`case-compile.expect_not_in_quote`); corresponding `packs/workflow/case-compile/functions/checks.ts`: foldText/checkExpectedSources | Still uses ordinary whitespace collapse for the separate package check. A hard wrap can pass the generic source-quotation check and fail this containment check. Arrange package-contract and independent gold alignment together; this follow-up changes checkVerbatimQuote only. |
| `gold-d2c` at `49e5f13c` | `scripts/real/gold/quotes.ts`: quoteMatches; judgeQuote/quotesReport; called by `scripts/real/accept/defect-to-case-compare.ts` and its batch driver | Unicode White_Space collapses to one space; Chinese hard wraps still differ. After merge, independently align it with decision 37 and run the shared vectors. |
| `gold-review` at `e41dafd6`, `gold-catalog` at `c50ecb72` | `scripts/real/lib/inject.ts`: noWhiteSpace and the contradict_manual quotation precondition | Deletes all whitespace, including Latin word boundaries. This is an injection guard, not a gold verdict; after merge, have its owner align the guard where it promises a verbatim quotation. |
| Other local branch snapshots carrying `scripts/real/gold/compile-check.ts` | checkVerbatimQuote and compileCheck expected-text containment | Same old generic checkVerbatimQuote implementation, not an additional independent rule. Preserve this branch's generic quotation fix when merging; no other branch was edited. |
| `gold-catalog` at `c50ecb72` | `scripts/real/gold/catalog-marks.ts`: quoteFromCase | Command excerpt matching uses NFKC, case folding and token/argument boundaries. It is not the generic verbatim quotation rule; do not replace its command semantics with decision 37. |

The older defect-to-case comparison in this branch reports Hub grounding claims rather than independently matching
quotation text. The gold-d2c version delegates to gold/quotes.ts above. Other matches in cases, duplicate/title,
board-location, command and regression-document readers normalize identifiers or command spellings, not verbatim
quotations. The template-gap driver compares whole summaries. Those comparisons were left unchanged. No other branch
or worktree was changed and no real-system script was run; only synthetic tests of the pure readers ran.

## Needs from other packages

- **model / integrator**: align T03 DEF with the owner-approved upload boundary: credential scan plus definite parsing
  refusals for declared/recognized-extension media types; sniffing alone is advisory and cannot refuse storage.

- **contracts / rules owner**: update the QuoteTable description in contracts/src/tables.ts to decision 37: remove
  W/F-adjacent whitespace, collapse other interior runs and trim ends. Regenerate
  contracts/generated/schemas/quote.v1.schema.json (currently the same stale description) and run gen-contracts --check.
  These contract files are outside this task's paths; no contract edit is claimed here.

- **runs**: reject an oversized aggregate bound input before sandbox serialization, naming the input slot(s), measured
  byte budget and cap, with a split/reduce action. Do not report it as a pack-author function defect. The per-model XLSX
  budget cannot by itself bound several models plus context in one projection input.

- **contracts**: update the stale XLSX example in contracts/model.json (`Service/7/C`) to the frozen xlsx@1
  name-first grammar above; parser syntax is declared by the parser, and this task does not edit the model.


- **contracts**: move RFC 8785 `canonicalize` into contracts so hub/records and hub/refs
  share one implementation (until then `recordDigest` here must stay byte-identical to the records digest); update
  the stale reference example in contracts/src/reference.ts to `src:<sha256>/kityminder@1/n/<data.id>`.
- **records**: implement `SourceReader` (bytes, media type, recorded size, read tier; null for absent and forbidden
  alike). `Artifacts.source()` withholds bytes by consumer; refs enforces the tier itself and needs the bytes of
  `function_bytes_only` sources to build the structure summary for a model, so the adapter should call it with
  `consumer: 'function'` and pass `bytes: null` through for `retain_only`. Also `RecordReader` (the envelope fields);
  state whether `ReaderIdentity {user, role, run?}` is enough for R02 visibility or which fields to add.
- **knowledge**: implement `TreeReader` (verified content; `grounds` as canonical src references from the composition
  record) and, if possible, the optional `hasRoot(root, reader)`, so a typo in a path gets a usable fix.
- **runs / server**: call `resolveReference` with `consumer: 'function'` only when feeding pack functions; use
  `verifyQuote` for QUOTE_MISMATCH and `findQuote` + `candidatesFrom` for resolve_reference previews (cut long
  `QuoteMatch.text` for display); when an `Unresolved` carries `reason`, record unknown with that reason (and, for
  `check_error`, attribution as the error table says) instead of refusing the submission; `reason` is not enumerable
  and never needs stripping.
- **rules**: independently maintain the same quote rule; `hub/rules/quote-vectors.json` is read by the refs tests, so a change to it reaches both packages.

## xlsx@1

The in-memory container decoder uses Node zlib and CRC-32, without extraction or network access. Hard caps are
16 MiB input, 256 members, 16 MiB per expanded member, 32 MiB total expanded bytes and a 100:1 expansion ratio per
member. It checks declarations before allocation, caps actual inflater output, checks consumed compressed bytes,
actual sizes and CRC, and compares local headers with the central directory. Duplicate names, encryption, unsafe
paths, links, malformed records and broken streams reject the whole source with a deterministic typed reason.
STORE and Deflate, ZIP64 sizes/directories, data descriptors, comments and ordinary extra fields are supported.
This is a generic format boundary; workbook visibility, formulas, string storage and extra package parts are data,
not workflow-specific reasons to reject a workbook.

The generic workbook model is JSON data, independent of any workflow:

- `members[]`: ZIP member `name`, uncompressed `size`, declared `contentType` (null when none is declared).
- `relationships[]`: source part (empty for package relationships), `id`, `type`, literal `target`, and `external`.
  Every internal target must exist; package-relative paths and root-relative part URIs are resolved inside the package.
  External targets are listed only, never fetched. Styles, themes, document properties, macros and link parts are listed
  without interpretation. XML parts are still checked by xml@1 for syntax, namespace correctness and repair markers.
- `sheets[]`: `name`, literal visibility `state` (default `visible`), part path, ordered `rows[]` and `lastRow`.
  Each row has `number`, `hidden` and ordered `cells[]`. Cells have A1 `reference`, literal `type` (default `n`), decoded
  value `text`, `formula` flag and numeric `style` (null when absent). Numbers, booleans, errors and dates stay as text;
  formulas are never evaluated and their value is only the stored cache. A missing cache gives empty text. Inline and
  shared rich-text runs are joined without phonetic annotations; SpreadsheetML escaped strings are decoded once,
  including escaped underscores. Decoded U+0000 is removed and counted in nulRemoved; other decoded control characters stay in the value; repaired XML (including raw NUL) is
  refused rather than silently changed. A decoded unpaired surrogate is an encoding error.
- `sharedStrings[]`: decoded strings in table order. A missing table or out-of-range referenced index is refused.
- `definedNames[]`: `name`, `scope` (null for workbook scope, otherwise the zero-based `localSheetId`) and literal
  `reference`. Name references and formulas are not interpreted or followed; repeated names in different scopes stay
  distinct.

Rows and cells with omitted coordinates use the format's sequential defaults. `lastRow` is the largest row coordinate
of any cell, including an empty style-only cell; empty row declarations and worksheet `dimension` do not inflate it.
Multi-sheet workbooks, hidden/very-hidden sheets, hidden rows, formulas and values beginning with `=` are accepted as
structure. No workflow-specific subset is enforced here.

Selectors prefer names: `c/<sheet name>/<A1 reference>`, workbook `n/<defined name>`, and local
`n/<sheet name>/<defined name>`, with each segment escaped by the refs codec. Duplicate sheet names, duplicate
coordinates, duplicate scoped names, empty names or name paths above the selector-length cap fall back to
`i/<sheet index>/<row index>/<cell index>` for cells and `i/n/<defined-name index>` for names (all indices zero-based).
No ambiguous name selector is listed or resolved; no occurrence is discarded. Each fragment's data is the corresponding cell/name object. `byteRange` is null:
fragments are decoded from package members, not contiguous ranges in the original ZIP. Lists follow workbook/row/cell
order, then name order; prefix and limit work as for the other parsers. `summary()` contains counts only, never names,
paths, value text, formula content or external addresses. XML node/depth/attribute limits and selector budgets also
apply. XML encodings follow xml@1, including BOM-marked UTF-16 and declared GB18030/GBK/Big5. The same bytes and
options produce the same model and deterministic ParseError reasons on rejection.

References for format fields: [PKWARE APPNOTE](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT),
[SpreadsheetML structure](https://learn.microsoft.com/en-us/office/open-xml/spreadsheet/structure-of-a-spreadsheetml-document),
and [escaped strings](https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/d34ae755-c53f-4a44-a363-c6dd3ee018a4).
Tests generate every archive/workbook at runtime, including one interoperability case from the already-installed
ExcelJS writer; production uses only Node zlib and the existing xml@1 parser, with no added dependency.

The parser is available as `createDefaultRegistry().get('xlsx@1')`. An upload filename ending in `.xlsx` (case insensitive)
selects `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`; a caller's explicit media type takes
precedence. ZIP bytes without a filename or media type are not guessed to be spreadsheets. Non-ZIP bytes never match
xlsx@1. Runtime registration was appended so the existing parser preference order stays intact.

XLSX workbook sheet relationships are resolved through an id map. A second sheet targeting an already-used internal
part refuses the package before any row/cell model is built; XML caching cannot multiply one worksheet's cells by the
number of sheet entries. This is a structural identity and bounded-work rule, independent of workbook policy.

ZIP member identity always comes from the raw central filename (UTF-8 with bit 11, CP437 otherwise), with the same raw
name required in the local header. A version-1 Info-ZIP Unicode Path field is accepted only with a matching raw-name
CRC and the exact same decoded name, in either header; it never renames a member. Unsafe or duplicate raw names are
refused before optional metadata can hide them. Invalid or contradictory path metadata is a generic ZIP refusal.

XLSX has a conservative 16 MiB serialized-model JSON budget. Strings are charged at their JSON-escaped UTF-8 size
(including quotes, backslashes and C0 escapes); each shared-string use is charged separately, the dictionary and defined
names once, plus conservative fixed costs per member, relationship, sheet, row and cell. The charge bounds the complete
model, not just cell value bytes, before building an oversized array or allocating an escaped model string. It leaves
headroom under a single sandbox input's default 32 MiB cap. Multiple bound models/context can still exceed that cap.


For xlsx@1, nulRemoved counts escaped U+0000 removed once per decoded source string (including shared-string entries,
sheet names and defined names), rather than once per shared-string use. Raw NUL in XML still refuses as repaired XML.

ZIP64 compares each non-sentinel EOCD count, size and offset with the ZIP64 record. Bounded extensible data remains
accepted with its header/length framing checked, as defined by APPNOTE 4.3.14; a size above 44 alone is not malformed.

Row `ht` retains the literal height or null, and `customHeight` retains the boolean flag. `hidden` means explicit
hidden=true or customHeight=true with numeric height zero; hiddenRows uses that same definition. Column visibility
is not interpreted by this model, so hiddenRows is not a statement about column visibility or whole-sheet rendering.

Each sheet preserves `relationshipId` and literal `relationshipType`; an empty chartsheet or another opaque part is
therefore distinguishable from an empty worksheet without guessing from its filename or dropping its identity.

## Refusal diagnostics

Upload checks an explicitly given media type or recognized filename extension before ingesting bytes. A definite parser refusal returns SOURCE_UNPARSEABLE, the
parser id, rule/reason and the generated fix; it creates no upload receipt. No candidate parser still permits an opaque
upload, while input binding refuses that media type explicitly. Successful fallback is still accepted. Input binding
uses the same last refusal with the input path. Guessed types are hints: a guessed-format refusal preserves the upload, retries text/plain where possible, and discloses the guess plus how to set media_type. Unexpected parser failures stay internal errors. Raw source text and
underlying library details are not included; XML assigns a fixed syntax rejection at its library adapter and keeps native prose in detail only; it does not infer reasons from message patterns.

## Declared encodings (decision 37)

Text and Markdown use BOM precedence, otherwise the media-type charset; XML additionally uses its encoding declaration.
HTML accepts UTF-16 BOMs and declared GB18030, GBK and Big5. New multibyte decoding is fatal (no replacement on error),
uses Node TextDecoder, and reports the encoding and zero-based first invalid sequence byte. UTF-16 without a BOM is
refused. Byte maps retain original sequence boundaries for line, element and HTML fragment ranges; a supplementary
character or a platform Big5 expansion shares one original sequence. No Unicode normalization is applied.
The [Encoding Standard](https://encoding.spec.whatwg.org/) documents the decoder API and sequence layouts; legacy
character mappings follow the installed Node/ICU decoder, including its Big5 special-pair mapping.

Scope disclosure for decision 37: the owner explicitly authorized rules/text.ts, quote.test.ts and its conformance
fixtures beyond the original quote-vectors-only task path; the rules README update was separately approved. The first
runtime refs import violated `rules -> refs(types)` and is now removed. This review adds rules-local W/F data; no
production quotation implementation imports the other. Shared vectors are the independent agreement check.

HTML encoding refusals label the declaration source (media-type charset or meta) at the throw site. Unsupported source labels stay in ParseError.detail only and are never interpolated into caller messages.

DTD capability boundary: xml@1 does not implement DTD attribute defaults or tokenized-attribute normalization. It
accepts entity-free ELEMENT/NOTATION declarations without validation or fetching, and refuses internal ATTLIST
and parameter references rather than silently showing incomplete attributes; no defaults
are invented. This is a format capability refusal, not a claim that such XML is invalid. External identifiers are never
fetched, and doctype metadata discloses that policy. See [XML 1.0 section 5.1](https://www.w3.org/TR/REC-xml/#proc-types).

Limit recovery is constructed at the throw site (with typed limit/max defaults); HTML derived work, wrapper and
merged-attribute budgets provide their own effective recovery, then passed intact by upload and input
binding. It is not guessed from message text. Caller-declared/extension formats can refuse; a byte-sniffed format
cannot by itself reject an upload. The upload-size gate still precedes parsing and keeps its own cap-specific fix.

XLSX rejection locations are assigned before central/local member checks. Central framing failures use that central
record's offset until a validated local header is known; archive-level checks clear member context. The archive retains
private member-location metadata for part/schema failures. Sheet/row context is selected before interpreting its values;
boolean checks name the actual attribute. No public filename or source value is needed to locate the failure.

OPC member identity is ASCII case-insensitive throughout: required metadata, relationship suffix/directory recognition,
source/target lookup and duplicate detection all use that equivalence. Original spellings remain in members and no
relationship is skipped merely because its part uses .RELS or _RELS. External targets are disclosed but never fetched.

首轮复核修正：读取失败的下一次时刻与有效条件重读共用 ResolveContext.now，只有未注入时才用墙钟；来源、树、条目和记录的失败出口一致。
