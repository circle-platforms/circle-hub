# hub/refs: references and parsers

Model elements: **B03** (references), **T04** (resolution, the verbatim quote check), and the read tiers of **B02**.
Other packages import only from `hub/refs/api.ts`. refs imports only `contracts/`.

## What is here

| File | Content |
| --- | --- |
| `reference.ts` | `parseReference`, `formatReference`, `normalizeReference`, `sameTarget`, `sameSource`, `srcFragment`, `treeReference`, `recReference`, selector, path and pointer codecs, `MAX_SELECTOR_LENGTH`, `ReferenceSyntaxError` |
| `parser.ts` | `Parser`, `ParsedDocument`, `Fragment`, limits, typed parse errors, `createParserRegistry`, `recognize` |
| `parsers/*.ts` | the six core parsers: `kityminder@1`, `xml@1`, `html@1`, `markdown@1`, `json@1`, `text@1` |
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
- **xml@1** uses saxes. A DOCTYPE is refused outright, so no entity is ever declared, expanded or fetched. Charset by
  RFC 7303 section 3.2: a byte order mark (UTF-8; UTF-16 is refused), else the `charset` parameter of the media type,
  else the encoding declaration; a BOM that disagrees with either is refused. UTF-8, ISO-8859-1 (true Latin-1, as the
  XML specification reads it) and US-ASCII. Start tags whose attribute values contain their own quote character or a
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
  and ASCII labels mean windows-1252 (WHATWG). Other legacy charsets decode without byte ranges.
- **markdown@1** is line based and linear time (heading clean-up included: closing `#` runs, trimming and pandoc
  attribute blocks are found by scanning back from the end of the line). ATX and setext headings make the tree; blocks
  are paragraphs, lists, block quotes, fenced and indented code, HTML blocks, thematic breaks, a leading YAML metadata
  block, and tables: pipe tables, pandoc grid, multiline and simple tables. Headings inside code fences or tables are not
  headings. A heading segment is the heading text with white space collapsed and a trailing pandoc attribute block
  (`{#id}`) removed; `[k]` is appended when the text repeats among siblings (from the second), when the text itself ends
  in `[digits]`, or when it is empty. NUL is removed from texts, never from byte ranges.
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

`quoteMatches(fragmentText, quote)`: every run of Unicode `White_Space` (spaces, tabs, CR, LF, NEL, NBSP, U+3000 and the
other space separators) counts as one space, both ends are trimmed, then the quote must be contained verbatim. How long
a white-space run is does not matter; whether there is one does (a line break between two Chinese characters must be
quoted as a space; an open question below). Case, punctuation, character width, zero-width characters and the Unicode
normalization form stay significant. An empty quote never matches, nor does one with an unpaired surrogate (it could
match half of a character). One matcher implements this everywhere: KMP over the text with each white-space run read as
one symbol, linear and without a collapsed copy. The 27 vectors of `hub/rules/quote-vectors.json` run in the refs
tests, so this check and the rules package's `quote@1` stay equal. `locateQuote` maps the match back to UTF-8 byte
offsets of the original text.

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
- **Unavailable**: absent, forbidden, a reader that throws, a missing reader, and stored bytes or records that do not
  hash to the digest all give the reader the same `{resolved: false, code: 'SOURCE_UNAVAILABLE', message: '对你不可用',
  fix}`; the real reason goes only to `onDiagnostic` (admin log). For the internal caller, the cases where the Hub could
  not check at all carry `reason` (`check_error`: a reader failed or is missing; `integrity_unproven`: content does not
  match its digest, or a record body is not JSON data). `reason` is not enumerable: JSON and object spread leave it
  out, so nothing reaches the reader; the caller records unknown with it instead of refusing the submission (T03 R[3]).
  **Unresolved** (`REFERENCE_UNRESOLVED`, with a Chinese reason): bad syntax, an unregistered parser, a source that does
  not parse with the named parser, a selector that locates nothing, a bad range, a pointer that does not exist, and a
  parser answer whose canonical selector cannot be written (the core parsers never give one).
- **Read tiers** (B02 F[5], R[4]): `model_readable` gives the text; `function_bytes_only` gives the text only when
  `consumer` is `function`, otherwise a structure-only summary and the note `labelOf('read_tier', ...)`; `retain_only`
  never gives the text, the fragment or any structure, with the note `labelOf('validity_status', 'credential_unreadable')`
  (含凭据，原文不可读). For `retain_only` the selector and range are not evaluated and the reference comes back as given:
  every reference to the source gets the same answer, so probing cannot reveal line lengths, names or headings. Such a
  read may come without bytes (`SourceRead.bytes` null); any other tier without bytes is a failed read.
- `groundable` says whether the reference may stand alone as a claim's grounds: never an `entry:` (B01 R[5]); a `rec:`
  only for results and the Hub's own records, kinds `claim`, `validation_result`, `action`, `effect` (B01 R[4]).
- `verifyQuote(result, quote)` is true or false on readable text and null when the text cannot be checked.
- `createDocumentCache(n)` keeps parsed documents keyed by digest, parser and media type (safe: bytes behind a digest
  never change). Permission is still checked by the reader on every call.

## Decisions and deviations from the brief

1. `Parser.parse` is synchronous for the core parsers. A pack-provided parser run in the sandbox would need an
   asynchronous adapter; none exists in milestone 1.
2. `ParseError.code` is `SUBMISSION_SCHEMA_VIOLATION`, the closest registered code (start_run refuses an input that does
   not parse, which is an item projection failure). resolveReference maps parse failures to `REFERENCE_UNRESOLVED`
   itself. A dedicated code is requested below.
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
- HTML in UTF-16, and XML in any encoding other than UTF-8, ISO-8859-1 and US-ASCII, is refused.

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

## Open questions

- **White space presence in quotations** (owner decision needed; T04 R[1], brief section 6). Today a quotation must
  have white space wherever the source has it, only the length of a run is free. A Chinese manual hard-wrapped between
  two characters (`会话保持超时\n时间`) therefore needs the quote `会话保持超时 时间`, and `设为0时` does not match
  `设为 0 时`. The not-found diagnostic now says so (it used to claim white space never matters). A proposal: also drop a
  white-space run when a character on either side is East Asian wide or fullwidth (CJK text has no word spaces);
  Latin tokens stay separated (`set 10 0` still differs from `set 100`). It would flip two vectors of
  `hub/rules/quote-vectors.json` ("white space is collapsed, not removed" and "an extra space in the quote differs"),
  so hub/rules and hub/refs must change together, after the owner decides.

## Needs from other packages

- **contracts**: (1) a protocol code for "the source does not parse with the declared parser" (for example
  `SOURCE_UNPARSEABLE`, fix "上传能按声明格式解析的文件，或换用对应的解析器"), or confirmation that
  `SUBMISSION_SCHEMA_VIOLATION` is meant; (2) move RFC 8785 `canonicalize` into contracts so hub/records and hub/refs
  share one implementation (until then `recordDigest` here must stay byte-identical to the records digest); (3) update
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
- **rules**: none; `hub/rules/quote-vectors.json` is read by the refs tests, so a change to it reaches both packages.

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
  including escaped underscores. Decoded control characters stay in the value; repaired XML (including raw NUL) is
  refused rather than silently changed. A decoded unpaired surrogate is an encoding error.
- `sharedStrings[]`: decoded strings in table order. A missing table or out-of-range referenced index is refused.
- `definedNames[]`: `name`, `scope` (null for workbook scope, otherwise the zero-based `localSheetId`) and literal
  `reference`. Name references and formulas are not interpreted or followed; repeated names in different scopes stay
  distinct.

Rows and cells with omitted coordinates use the format's sequential defaults. `lastRow` is the largest row coordinate
of any cell, including an empty style-only cell; empty row declarations and worksheet `dimension` do not inflate it.
Multi-sheet workbooks, hidden/very-hidden sheets, hidden rows, formulas and values beginning with `=` are accepted as
structure. No workflow-specific subset is enforced here.

Selectors are `c/<zero-based sheet index>/<A1 reference>` and `n/<zero-based defined-name index>`. If a coordinate occurs
more than once, each occurrence instead has `i/<sheet index>/<row index>/<cell index>`, all indices zero-based; no
occurrence is silently discarded. Each fragment's data is the corresponding cell/name object. `byteRange` is null:
fragments are decoded from package members, not contiguous ranges in the original ZIP. Lists follow workbook/row/cell
order, then name order; prefix and limit work as for the other parsers. `summary()` contains counts only, never names,
paths, value text, formula content or external addresses. XML node/depth/attribute limits and selector budgets also
apply. XML encodings follow xml@1 (UTF-8, ISO-8859-1 and US-ASCII; UTF-16 is not supported). The same bytes and
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
