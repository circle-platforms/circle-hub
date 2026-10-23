import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_MAX_SELECTOR_CHARS,
  ParseError,
  createDefaultRegistry,
  createParserRegistry,
  defaultParsers,
  effectiveLimits,
  jsonParser,
  mediaTypeCharset,
  mediaTypeEssence,
  recognize,
  textParser,
  type Parser,
} from './api.ts';
import { fixture, utf8 } from './test-support.ts';

describe('parser registry', () => {
  const registry = createDefaultRegistry();

  it('registers the six core parsers by id@version', () => {
    assert.deepEqual(
      registry.list().map((parser) => `${parser.id}@${parser.version}`),
      ['kityminder@1', 'xml@1', 'html@1', 'markdown@1', 'json@1', 'text@1', 'xlsx@1'],
    );
    assert.equal(registry.get('kityminder@1')?.id, 'kityminder');
    assert.equal(registry.get('kityminder'), undefined);
    assert.equal(registry.get('kityminder@2'), undefined);
  });

  it('finds parsers by media type, exact matches before wildcards', () => {
    assert.deepEqual(registry.forMediaType('application/json; charset=utf-8').map((p) => p.id), ['kityminder', 'json']);
    assert.deepEqual(registry.forMediaType('TEXT/MARKDOWN').map((p) => p.id), ['markdown', 'text']);
    assert.deepEqual(registry.forMediaType('text/csv').map((p) => p.id), ['text']);
    assert.deepEqual(registry.forMediaType('text/plain').map((p) => p.id), ['text']);
    assert.deepEqual(registry.forMediaType('text/xml').map((p) => p.id), ['xml', 'text']);
    assert.deepEqual(registry.forMediaType('image/png'), []);
  });

  it('refuses duplicate and malformed registrations', () => {
    assert.throws(() => registry.register(jsonParser));
    const bad = { ...textParser, id: 'Bad Name' } as Parser;
    assert.throws(() => createParserRegistry([bad]));
    assert.throws(() => createParserRegistry([{ ...textParser, version: -1 } as Parser]));
    assert.equal(createParserRegistry(defaultParsers()).list().length, 7);
  });

  it('recognizes a file with the first parser that accepts it', () => {
    const map = recognize(registry, fixture('mindmap.km.json'), 'application/json');
    assert.equal(map?.parser.id, 'kityminder');
    assert.equal(map?.document.summary().nodes, 150);
    const plain = recognize(registry, utf8('{"a":1}'), 'application/json');
    assert.equal(plain?.parser.id, 'json');
    assert.equal(recognize(registry, utf8('{bad'), 'application/json'), null);
    assert.equal(recognize(registry, new Uint8Array([0x89, 0x50]), 'image/png'), null);
  });

  it('reads media type parameters', () => {
    assert.equal(mediaTypeEssence(' Text/HTML ; charset="ISO-8859-1"'), 'text/html');
    assert.equal(mediaTypeCharset('text/html; q=1; charset="ISO-8859-1"'), 'iso-8859-1');
    assert.equal(mediaTypeCharset('text/html'), null);
    assert.equal(mediaTypeCharset(undefined), null);
  });

  it('lets callers lower or raise limits with positive integers only', () => {
    assert.deepEqual(effectiveLimits({ maxBytes: 10, maxDepth: 2, maxNodes: 3 }, { maxDepth: 5 }), {
      maxBytes: 10,
      maxDepth: 5,
      maxNodes: 3,
      maxAttributes: Number.MAX_SAFE_INTEGER,
      maxSelectorChars: DEFAULT_MAX_SELECTOR_CHARS,
    });
    assert.equal(effectiveLimits(textParser.limits, { maxSelectorChars: 9 }).maxSelectorChars, 9);
    assert.throws(() => effectiveLimits(textParser.limits, { maxNodes: 0 }), RangeError);
    assert.throws(() => effectiveLimits(textParser.limits, { maxBytes: 1.5 }), RangeError);
  });

  it('gives every parse error a registered code and a Chinese message', () => {
    for (const parser of defaultParsers()) {
      try {
        parser.parse(new Uint8Array([0xff, 0xfe, 0xfd]));
        assert.fail(`${parser.id} accepted invalid bytes`);
      } catch (error) {
        assert.ok(error instanceof ParseError, parser.id);
        assert.equal(error.code, 'SOURCE_UNPARSEABLE');
        assert.equal(error.parser, `${parser.id}@${parser.version}`);
        assert.match(error.message, /\p{Script=Han}/u);
      }
    }
  });
});
