// The linear-time matcher agrees with ECMAScript RegExp on its subset, refuses what it does not support, and stays fast on
// inputs that make a backtracking engine explode.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compilePattern, MAX_STATES } from './regex.ts';

const PATTERNS = [
  'abc',
  'a|b|cd',
  'a*',
  'a+b?',
  '(ab)*c',
  '(?:ab|a)*b',
  '[a-z]+-[0-9]{2,4}',
  '[^0-9]*',
  '\\d{3}\\s?\\w+',
  '\\D\\W\\S',
  '^ab$',
  'a$|^b',
  '\\bword\\b',
  'x\\By',
  '.+',
  'a.c',
  '[\\]\\\\-]+',
  'é+',
  '\\u00e9|\\u{1F600}',
  '\\p{Script=Han}+',
  '[\\p{L}_][\\p{L}\\p{N}_]*',
  '(a|b){1,3}c{2}',
  'a{0}b',
  'a{2,}',
  'colou?r',
  '\\.\\*\\+\\?\\(\\)\\[\\]\\{\\}\\|\\^\\$\\/',
  '\\x41\\t\\n',
  'a*?b+?c??',
  '(a*)*b',
  '(a|a?)+c',
  '',
];
const INPUTS = ['', 'a', 'b', 'ab', 'abc', 'aab', 'aaab', 'abab', 'ababc', 'cd', 'xyz-1234', 'xyz-1', '123 w', '1234word', 'a.c', 'abc\n', 'é', 'ééé', 'é', '\u{1F600}', '中文字', '中_1', 'word', 'a word here', 'xy', 'x y', 'color', 'colour', 'colouur', 'A\t\n', 'aacc', 'abbcc', 'acc', 'b', 'aaaaaaab', 'ac', ']-\\', '.*+?()[]{}|^$/'];

describe('agreement with ECMAScript RegExp', () => {
  for (const ignoreCase of [false, true]) {
    for (const mode of ['full', 'search'] as const) {
      it(`${mode} match, ignoreCase ${ignoreCase}`, () => {
        for (const source of PATTERNS) {
          const compiled = compilePattern(source, { ignoreCase, mode });
          assert.ok(compiled.ok, `${source}: ${compiled.ok ? '' : compiled.error}`);
          const flags = ignoreCase ? 'iu' : 'u';
          const reference = mode === 'full' ? new RegExp(`^(?:${source})$`, flags) : new RegExp(source, flags);
          for (const input of [...INPUTS, ...INPUTS.map((i) => i.toUpperCase())]) {
            assert.equal(compiled.pattern.test(input), reference.test(input), `/${source}/${flags} ${mode} on ${JSON.stringify(input)}`);
          }
        }
      });
    }
  }

  it('random patterns from a small grammar agree too', () => {
    let seed = 7;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const atoms = ['a', 'b', '.', '[ab]', '[^a]', '\\w', '\\d', '(a|b)', '(?:ab)', '^', '$', '\\b'];
    const quants = ['', '', '*', '+', '?', '{0,2}', '{2}'];
    for (let n = 0; n < 400; n++) {
      let source = '';
      const length = 1 + rand(5);
      for (let i = 0; i < length; i++) {
        const atom = atoms[rand(atoms.length)];
        source += atom + (['^', '$', '\\b'].includes(atom) ? '' : quants[rand(quants.length)]);
      }
      if (rand(4) === 0) source += `|${atoms[rand(3)]}`;
      const compiled = compilePattern(source, { mode: 'search' });
      assert.ok(compiled.ok, source);
      const reference = new RegExp(source, 'u');
      for (const input of ['', 'a', 'b', 'ab', 'ba', 'aab', 'a b', '1a', 'bbb', 'abba', 'a1b2', '__']) {
        assert.equal(compiled.pattern.test(input), reference.test(input), `/${source}/u on ${JSON.stringify(input)}`);
      }
    }
  });
});

describe('what the language refuses', () => {
  for (const [source, why] of [
    ['(a)\\1', 'backreference'],
    ['(?<n>a)\\k<n>', 'named group'],
    ['(?=a)a', 'lookahead'],
    ['(?!a)b', 'negative lookahead'],
    ['(?<=a)b', 'lookbehind'],
    ['a{101}', 'bound above 100'],
    ['a{3,2}', 'inverted bounds'],
    ['(', 'unbalanced'],
    ['a**', 'nothing to repeat (invalid in JavaScript)'],
    ['\\q', 'unknown escape in Unicode mode'],
    ['((a{50}){50}){50}', 'too many states'],
  ] as const) {
    it(`${why}: ${source}`, () => {
      const compiled = compilePattern(source);
      assert.equal(compiled.ok, false);
      if (!compiled.ok) assert.ok(compiled.error.length > 0);
    });
  }

  it('state count stays under the limit for accepted patterns', () => {
    const compiled = compilePattern('(a{10}){10}');
    assert.ok(compiled.ok && compiled.pattern.states <= MAX_STATES);
  });
});

describe('linear time', () => {
  it('inputs that are catastrophic for backtracking finish quickly', () => {
    const cases: [string, string, 'full' | 'search'][] = [
      ['(a+)+$', `${'a'.repeat(20_000)}b`, 'search'],
      ['(a|aa)*c', 'a'.repeat(20_000), 'search'],
      ['(a*)*b', 'a'.repeat(20_000), 'search'],
      // Full mode: the whole value must match, as in /^(\w+\s?)*$/.
      ['(\\w+\\s?)*', `${'word '.repeat(4000)}!`, 'full'],
    ];
    for (const [source, input, mode] of cases) {
      const compiled = compilePattern(source, { mode });
      assert.ok(compiled.ok, source);
      const started = performance.now();
      assert.equal(compiled.pattern.test(input), false);
      assert.ok(performance.now() - started < 2000, `${source} took ${Math.round(performance.now() - started)} ms`);
    }
  });
});
