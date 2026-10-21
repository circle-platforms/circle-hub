import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { REFERENCE_SCHEME } from '../../contracts/generated/vocabulary.ts';
import {
  MAX_REFERENCE_LENGTH,
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
  selectorSegments,
  sourceOf,
  srcFragment,
  treeReference,
  trySelectorSegments,
  withRange,
  withoutRange,
  type Reference,
} from './api.ts';
import { seeded, timed } from './test-support.ts';

const A = 'a'.repeat(64);
const B = '0123456789abcdef'.repeat(4);
const C = 'c'.repeat(64);

function rejects(text: string, position?: number): ReferenceSyntaxError {
  let caught: unknown = null;
  try {
    parseReference(text);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ReferenceSyntaxError, `expected ReferenceSyntaxError for ${JSON.stringify(text)}`);
  if (position !== undefined) assert.equal(caught.position, position, `position for ${JSON.stringify(text)}`);
  assert.equal(caught.code, 'REFERENCE_UNRESOLVED');
  assert.match(caught.message, /\p{Script=Han}/u, 'messages are Chinese');
  return caught;
}

describe('canonical references', () => {
  const cases: Array<[string, Reference]> = [
    [`src:${A}`, { scheme: 'src', sha256: A }],
    [`src:${A}/kityminder@1/n/c9x1`, { scheme: 'src', sha256: A, parser: 'kityminder@1', selector: 'n/c9x1' }],
    [`src:${A}/xml@1/x/commands/scope[2]/@help:0-12`, { scheme: 'src', sha256: A, parser: 'xml@1', selector: 'x/commands/scope[2]/@help', range: [0, 12] }],
    [`src:${A}/markdown@1/h/安装%20步骤/配置[2]`, { scheme: 'src', sha256: A, parser: 'markdown@1', selector: 'h/安装%20步骤/配置[2]' }],
    [`src:${A}/x.y_z-1@0/a%2Fb%3Ac`, { scheme: 'src', sha256: A, parser: 'x.y_z-1@0', selector: 'a%2Fb%3Ac' }],
    [`tree:${B}/`, { scheme: 'tree', root: B, path: '/' }],
    [`tree:${B}/commands/show/interface`, { scheme: 'tree', root: B, path: '/commands/show/interface' }],
    [`tree:${B}/a%40b/c@${C}`, { scheme: 'tree', root: B, path: '/a%40b/c', entry: C }],
    [`entry:${C}`, { scheme: 'entry', entry: C }],
    [`rec:${C}`, { scheme: 'rec', record: C }],
    [`rec:${C}#/partitions/delivered/2`, { scheme: 'rec', record: C, pointer: '/partitions/delivered/2' }],
    [`rec:${C}#/a~1b/~0c/%20/`, { scheme: 'rec', record: C, pointer: '/a~1b/~0c/%20/' }],
  ];
  for (const [text, ref] of cases) {
    it(`round-trips ${text.slice(0, 90)}`, () => {
      assert.deepEqual(parseReference(text), ref);
      assert.equal(formatReference(ref), text);
      assert.equal(normalizeReference(text), text);
    });
  }

  it('decodes segments, paths and pointers', () => {
    assert.deepEqual(selectorSegments('h/安装%20步骤/a%2Fb%3Ac/%25'), ['h', '安装 步骤', 'a/b:c', '%']);
    assert.deepEqual(pathSegments('/a%40b/c'), ['a@b', 'c']);
    assert.deepEqual(pathSegments('/'), []);
    assert.deepEqual(pointerTokens('/a~1b/~0c/%20/'), ['a/b', '~c', ' ', '']);
    assert.equal(pointerOf(['a/b', '~c', ' ', '']), '/a~1b/~0c/%20/');
    assert.equal(pathOf([]), '/');
    assert.equal(pathOf(['a@b', 'c d']), '/a%40b/c%20d');
  });

  it('encodes exactly the reserved characters and nothing else', () => {
    const segment = 'A-z_0.9~!$&\'()*+,;=@[]中文😀é';
    assert.equal(selectorOf([segment]), segment);
    assert.equal(selectorOf(['a b\tc d　e​f‍g\u0000h%i/j:k']), 'a%20b%09c%C2%A0d%E3%80%80e%E2%80%8Bf%E2%80%8Dg%00h%25i%2Fj%3Ak');
    assert.equal(pathOf(['x:y']), '/x:y');
    assert.equal(pointerOf(['a#b']), '/a%23b');
  });

  it('builds references with the helpers', () => {
    assert.equal(srcFragment(A, 'json@1', ['p', 'a b', '0']), `src:${A}/json@1/p/a%20b/0`);
    assert.equal(srcFragment(A, 'json@1', 'p/x', [1, 4]), `src:${A}/json@1/p/x:1-4`);
    assert.equal(treeReference(B, ['commands', 'show x']), `tree:${B}/commands/show%20x`);
    assert.equal(treeReference(B, '/', C), `tree:${B}/@${C}`);
    assert.equal(recReference(C), `rec:${C}`);
    assert.equal(recReference(C, ['items', '3']), `rec:${C}#/items/3`);
    assert.equal(withRange(`src:${A}/text@1/l/2`, [3, 9]), `src:${A}/text@1/l/2:3-9`);
    assert.equal(withoutRange(`src:${A}/text@1/l/2:3-9`), `src:${A}/text@1/l/2`);
    assert.throws(() => withRange(`src:${A}`, [0, 1]), ReferenceSyntaxError);
  });
});

describe('malformed references', () => {
  const bad: Array<[string, number?]> = [
    ['', 0],
    ['example:document:42', 0],
    ['SRC:' + A, 0],
    ['http://192.0.2.1/x', 0],
    [`src:${A.slice(1)}`, 4],
    [`src:${'A'.repeat(64)}`, 4],
    [`src:${A}x`],
    [`src:${A}/`],
    [`src:${A}/xml`],
    [`src:${A}/xml@1`],
    [`src:${A}/xml@1/`],
    [`src:${A}/Xml@1/x/a`],
    [`src:${A}/xml@01/x/a`],
    [`src:${A}/xml@/x/a`],
    [`src:${A}/xml@1/x//a`],
    [`src:${A}/xml@1/x/a/`],
    [`src:${A}/xml@1/x/a b`],
    [`src:${A}/xml@1/x/a%2f`],
    [`src:${A}/xml@1/x/a%41`],
    [`src:${A}/xml@1/x/a%`],
    [`src:${A}/xml@1/x/a%C3`],
    [`src:${A}/xml@1/x/a:`],
    [`src:${A}/xml@1/x/a:1`],
    [`src:${A}/xml@1/x/a:01-3`],
    [`src:${A}/xml@1/x/a:3-3`],
    [`src:${A}/xml@1/x/a:4-3`],
    [`src:${A}/xml@1/x/a:1-2-3`],
    [`src:${A}/xml@1/x/a:1-99999999999999999`],
    [`src:${A}/xml@1/x/a​`],
    [`src:${A}/xml@1/x/a\u0000`],
    [`src:${A}/xml@1/x/\ud800`],
    [`tree:${B}`],
    [`tree:${B}a`],
    [`tree:${B}//a`],
    [`tree:${B}/a/`],
    [`tree:${B}/a@`],
    [`tree:${B}/a@${C}x`],
    [`tree:${B}/a b`],
    [`entry:${C}/x`],
    [`entry:${C}@${C}`],
    [`rec:${C}#`],
    [`rec:${C}#a`],
    [`rec:${C}#/a~2`],
    [`rec:${C}#/a~`],
    [`rec:${C}#/a b`],
    [`rec:${C}#/a#b`],
    [`rec:${C}/a`],
    [` src:${A}`],
    [`src:${A} `],
  ];
  for (const [text, position] of bad) {
    it(`rejects ${JSON.stringify(text).slice(0, 80)}`, () => {
      rejects(text, position);
    });
  }

  it('rejects over-long references and too many segments', () => {
    rejects(`src:${A}/text@1/${'x'.repeat(MAX_REFERENCE_LENGTH)}`);
    rejects(`src:${A}/text@1/${Array.from({ length: 300 }, () => 'a').join('/')}`);
  });

  it('rejects invalid reference objects', () => {
    const invalid = [
      { scheme: 'src', sha256: A, parser: 'xml@1' },
      { scheme: 'src', sha256: A, selector: 'x/a' },
      { scheme: 'src', sha256: A, range: [0, 1] },
      { scheme: 'src', sha256: A, parser: 'xml@1', selector: 'x/a b' },
      { scheme: 'src', sha256: A, parser: 'xml@1', selector: 'x/a', range: [2, 1] },
      { scheme: 'tree', root: B, path: 'a' },
      { scheme: 'rec', record: C, pointer: '' },
      { scheme: 'nope', sha256: A },
      { scheme: 'entry', entry: 'xyz' },
    ];
    for (const ref of invalid) assert.throws(() => formatReference(ref as Reference), ReferenceSyntaxError, JSON.stringify(ref));
  });

  it('reports the position of the problem', () => {
    const error = rejects(`src:${A}/xml@1/x/ab cd`);
    assert.equal(error.position, `src:${A}/xml@1/x/ab`.length);
    assert.equal(error.input, `src:${A}/xml@1/x/ab cd`);
  });
});

describe('normalization and comparison', () => {
  it('normalizes loose spellings to the canonical text', () => {
    const canonical = `src:${A}/xml@1/x/a%20b/c%2F:3-10`;
    assert.equal(normalizeReference(`  SRC:${A.toUpperCase()}/XML@01/x/a b/c%2f:003-010 \n`), canonical);
    assert.equal(normalizeReference(`src:${A}/xml@1/x/%61%20b/c%2F:3-10`), canonical);
    assert.equal(normalizeReference(`tree:${B.toUpperCase()}/a@b/c d/@${C.toUpperCase()}`), `tree:${B}/a%40b/c%20d@${C}`);
    assert.equal(normalizeReference(`rec:${C}#/a b/#x`), `rec:${C}#/a%20b/%23x`);
    assert.equal(normalizeReference(`src:${A}/text@1/l/100%`), `src:${A}/text@1/l/100%25`);
    assert.equal(normalizeReference({ scheme: 'entry', entry: C }), `entry:${C}`);
    assert.throws(() => normalizeReference(`src:${A}/xml@1/x//a`), ReferenceSyntaxError);
    assert.throws(() => normalizeReference('example:document:42'), ReferenceSyntaxError);
  });

  it('compares targets and sources', () => {
    assert.ok(sameTarget(`src:${A}/xml@1/x/a%20b`, ` src:${A}/xml@1/x/a b`));
    assert.ok(!sameTarget(`src:${A}/xml@1/x/a`, `src:${A}/xml@1/x/a:0-1`));
    assert.ok(!sameTarget(`src:${A}/xml@1/x/a`, 'not a reference'));
    assert.ok(sameSource(`src:${A}/xml@1/x/a`, `src:${A}`));
    assert.ok(!sameSource(`src:${A}`, `rec:${A}`));
    assert.deepEqual(sourceOf(`tree:${B}/a@${C}`), { scheme: 'tree', digest: B });
  });

  it('normalizes hostile loose spellings in linear time', () => {
    // Each case once took polynomial time in a backtracking regular expression; all stay under the length limit.
    const zeros = '0'.repeat(4_000);
    const hostile = [
      `src:${A}/xml@1/x/a:${zeros}-${zeros}x`,
      `src:${A}/xml@1/x/a:${zeros}1-${zeros}2`,
      `src:${A}/text@1/l/1${' '.repeat(8_000)}x`,
      `${' '.repeat(4_000)}src:${A}/text@1/l/1${' '.repeat(4_000)}`,
      `src:${A}/x@${zeros}`,
      `src:${A}/x@${zeros}1/a`,
      `tree:${B}/${'@'.repeat(8_000)}`,
      `src:${A}/xml@1/${':'.repeat(4_000)}${'0-'.repeat(2_000)}`,
    ];
    for (const text of hostile) {
      const outcome = timed(() => {
        for (const run of [() => normalizeReference(text), () => sourceOf(text)]) {
          try {
            run();
          } catch (error) {
            if (!(error instanceof ReferenceSyntaxError)) throw error;
          }
        }
        sameTarget(text, text);
        sameSource(text, `src:${A}`);
      });
      assert.equal(outcome.error, null, String(outcome.error));
      assert.ok(outcome.ms < 250, `${text.slice(0, 40)}... took ${outcome.ms.toFixed(0)} ms`);
    }
    assert.equal(normalizeReference(`src:${A}/xml@1/x/a:${zeros}1-${zeros}2`), `src:${A}/xml@1/x/a:1-2`);
    assert.equal(normalizeReference(`src:${A}/x@${zeros}1/a`), `src:${A}/x@1/a`);
    assert.equal(normalizeReference(`${' '.repeat(4_000)}src:${A}/text@1/l/1${'　'.repeat(4_000)}`), `src:${A}/text@1/l/1`);
    assert.throws(() => normalizeReference(`src:${A}/text@1/l/1${' '.repeat(10_000)}x`), ReferenceSyntaxError, 'over-long input is refused before any work');
  });

  it('returns null from the non-throwing decoder', () => {
    assert.equal(trySelectorSegments('a b'), null);
    assert.equal(trySelectorSegments(''), null);
    assert.deepEqual(trySelectorSegments('a/b'), ['a', 'b']);
  });
});

// Property-style tests over generated references, segments and corrupted strings.
const CHARS = [
  'a', 'b', 'Z', '0', '9', '-', '_', '.', '~', '!', '$', '&', "'", '(', ')', '*', '+', ',', ';', '=', '@', '[', ']', '#', '?', '/', ':', '%',
  ' ', '\t', '\n', '\r', ' ', '　', '​', '‍', '‮', '﻿', '\u0000', '\u007f', '\u0085', '中', '文', 'é', 'Å', '😀', 'Ａ',
];

function randomSegment(r: ReturnType<typeof seeded>): string {
  return Array.from({ length: 1 + r.int(6) }, () => r.pick(CHARS)).join('');
}

function randomDigest(r: ReturnType<typeof seeded>): string {
  return Array.from({ length: 64 }, () => '0123456789abcdef'[r.int(16)]).join('');
}

function randomReference(r: ReturnType<typeof seeded>): Reference {
  const scheme = r.pick(REFERENCE_SCHEME);
  if (scheme === 'entry') return { scheme, entry: randomDigest(r) };
  if (scheme === 'tree') {
    const path = pathOf(Array.from({ length: r.int(4) }, () => randomSegment(r)));
    return r.chance(0.5) ? { scheme, root: randomDigest(r), path, entry: randomDigest(r) } : { scheme, root: randomDigest(r), path };
  }
  if (scheme === 'rec') {
    if (r.chance(0.3)) return { scheme, record: randomDigest(r) };
    const tokens = Array.from({ length: 1 + r.int(4) }, () => (r.chance(0.1) ? '' : randomSegment(r)));
    return { scheme, record: randomDigest(r), pointer: pointerOf(tokens) };
  }
  if (r.chance(0.25)) return { scheme, sha256: randomDigest(r) };
  const name = 'abcxyz'[r.int(6)] + Array.from({ length: r.int(6) }, () => r.pick(['a', 'k', '0', '_', '.', '-'])).join('');
  const parser = `${name}@${r.int(30)}`;
  const selector = selectorOf(Array.from({ length: 1 + r.int(5) }, () => randomSegment(r)));
  if (r.chance(0.4)) {
    const from = r.int(1000);
    return { scheme, sha256: randomDigest(r), parser, selector, range: [from, from + 1 + r.int(1000)] };
  }
  return { scheme, sha256: randomDigest(r), parser, selector };
}

function mutate(text: string, r: ReturnType<typeof seeded>): string {
  const at = r.int(text.length + 1);
  const pool = [...CHARS, 'A', 'F', '%2', '%41', '%2f', '%20', ':1-2', '@' + 'a'.repeat(64), '#/', '/', '//'];
  switch (r.int(3)) {
    case 0:
      return text.slice(0, at) + r.pick(pool) + text.slice(at);
    case 1:
      return text.slice(0, at) + text.slice(at + 1 + r.int(3));
    default:
      return text.slice(0, at) + r.pick(pool) + text.slice(at + 1);
  }
}

describe('property: generated references', () => {
  it('format and parse are inverse on 3000 generated references', () => {
    const r = seeded(17);
    for (let i = 0; i < 3000; i++) {
      const ref = randomReference(r);
      const text = formatReference(ref);
      assert.deepEqual(parseReference(text), ref, text);
      assert.equal(formatReference(parseReference(text)), text);
      assert.equal(normalizeReference(text), text);
      assert.ok(sameTarget(text, ref));
    }
  });

  it('segments survive encoding on 3000 generated segment lists', () => {
    const r = seeded(29);
    for (let i = 0; i < 3000; i++) {
      const segments = Array.from({ length: 1 + r.int(6) }, () => randomSegment(r));
      const selector = selectorOf(segments);
      assert.doesNotMatch(selector, /[\s\u0000-\u001f\u007f​‍‮﻿]/u, 'no white space or invisible characters stay raw');
      assert.deepEqual(selectorSegments(selector), segments);
      assert.deepEqual(pathSegments(pathOf(segments)), segments);
      assert.deepEqual(pointerTokens(pointerOf(segments)), segments);
    }
  });

  it('accepts a corrupted string only when it is canonical, and otherwise raises ReferenceSyntaxError', () => {
    const r = seeded(43);
    let accepted = 0;
    let rejected = 0;
    for (let i = 0; i < 6000; i++) {
      const text = mutate(formatReference(randomReference(r)), r);
      try {
        const ref = parseReference(text);
        assert.equal(formatReference(ref), text, `accepted text must be canonical: ${JSON.stringify(text)}`);
        accepted++;
      } catch (error) {
        assert.ok(error instanceof ReferenceSyntaxError, `unexpected ${String(error)} for ${JSON.stringify(text)}`);
        rejected++;
      }
    }
    assert.ok(accepted > 100 && rejected > 1000, `both outcomes occur (accepted ${accepted}, rejected ${rejected})`);
  });

  it('never fails with anything but ReferenceSyntaxError on random strings', () => {
    const r = seeded(71);
    const heads = ['src:', 'tree:', 'entry:', 'rec:', '', 'SRC:', 'src', 'rec:' + 'f'.repeat(64)];
    for (let i = 0; i < 4000; i++) {
      const text = r.pick(heads) + Array.from({ length: r.int(90) }, () => r.pick([...CHARS, 'a', 'f', '0'])).join('');
      try {
        const ref = parseReference(text);
        assert.equal(formatReference(ref), text);
      } catch (error) {
        assert.ok(error instanceof ReferenceSyntaxError, `unexpected ${String(error)} for ${JSON.stringify(text)}`);
      }
      try {
        normalizeReference(text);
      } catch (error) {
        assert.ok(error instanceof ReferenceSyntaxError, `normalize: unexpected ${String(error)} for ${JSON.stringify(text)}`);
      }
    }
  });

  it('normalizes generated loose variants back to the canonical text', () => {
    const r = seeded(97);
    for (let i = 0; i < 1500; i++) {
      const text = formatReference(randomReference(r));
      const colon = text.indexOf(':');
      let loose = text.slice(0, colon).toUpperCase() + ':' + text.slice(colon + 1, colon + 65).toUpperCase() + text.slice(colon + 65);
      loose = loose.replace(/%[0-9A-F]{2}/g, (escape) => (r.chance(0.5) ? escape.toLowerCase() : escape));
      loose = `${r.pick(['', ' ', '\n', '　'])}${loose}${r.pick(['', ' ', '\t'])}`;
      assert.equal(normalizeReference(loose), text, JSON.stringify(loose));
    }
  });
});
