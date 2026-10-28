// Helpers for the tests of the product pack functions (not a pack function): fixtures parsed with the real hub/refs parsers,
// a seeded generator, hostile values and the totality check every default export must pass.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { jsonParser, markdownParser, type MarkdownModel } from '../../../../hub/refs/api.ts';
import { xmlParser, type XmlModel, htmlParser, type HtmlModel } from '../../../../hub/testing/parsers.ts';

/** A fixture of the product pack's tests (testing/fixtures: product names may appear only inside packs). */
export function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
}

export function latin1(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'latin1'));
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function html(bytes: Uint8Array | string): HtmlModel {
  return htmlParser.parse(typeof bytes === 'string' ? utf8(bytes) : bytes).model;
}

export function xmlDocument(bytes: Uint8Array | string) {
  return xmlParser.parse(typeof bytes === 'string' ? utf8(bytes) : bytes);
}

export function xml(bytes: Uint8Array | string): XmlModel {
  return xmlDocument(bytes).model;
}

export function markdownDocument(bytes: Uint8Array | string) {
  return markdownParser.parse(typeof bytes === 'string' ? utf8(bytes) : bytes);
}

export function markdown(bytes: Uint8Array | string): MarkdownModel {
  return markdownDocument(bytes).model;
}

export function jsonDocument(bytes: Uint8Array | string) {
  return jsonParser.parse(typeof bytes === 'string' ? utf8(bytes) : bytes);
}

/** UTF-8 slice of a fragment text, as hub/refs applies a reference range. */
export function sliceBytes(text: string, range: [number, number]): string {
  return Buffer.from(text, 'utf8').subarray(range[0], range[1]).toString('utf8');
}

/** Deterministic generator (mulberry32) so property tests are reproducible from their seed. */
export function seeded(seed: number) {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (max: number): number => Math.floor(next() * max);
  return {
    next,
    int,
    pick: <T>(items: readonly T[]): T => items[int(items.length)],
    chance: (p: number): boolean => next() < p,
    shuffle: <T>(items: readonly T[]): T[] => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(i + 1);
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
}

const ALPHABET = ['a', 'Z', '0', '9', '_', '-', '.', ' ', '\t', '\n', '(', ')', '[', ']', '{', '}', '<', '>', '|', '*', '\\', '"', "'", '`', ':', '：', '，', '。', '测', '试', '\u0000', '\u00a0', '\u200b', '\ud800', '😀', '&', '#', '%', '/'];

/** A random string over characters that matter to the functions (brackets, escapes, CJK, NUL, lone surrogates). */
export function randomText(random: ReturnType<typeof seeded>, max = 80): string {
  let out = '';
  const length = random.int(max);
  for (let i = 0; i < length; i++) out += random.pick(ALPHABET);
  return out;
}

/** A random JSON-like value of bounded depth. */
export function randomValue(random: ReturnType<typeof seeded>, depth = 0): unknown {
  const choice = random.int(depth > 3 ? 5 : 8);
  switch (choice) {
    case 0:
      return null;
    case 1:
      return random.chance(0.5);
    case 2:
      return random.pick([0, -1, 1.5, 1e308, Number.NaN, 2 ** 53]);
    case 3:
    case 4:
      return randomText(random);
    case 5:
      return Array.from({ length: random.int(4) }, () => randomValue(random, depth + 1));
    default: {
      const keys = ['blocks', 'links', 'runs', 'text', 'href', 'root', 'name', 'children', 'attributes', 'sections', 'signatures', 'model', 'labels', 'title', 'heads', 'candidates', 'line', 'builds', 'index'];
      const out: { [key: string]: unknown } = {};
      for (let k = random.int(5); k > 0; k--) out[random.pick(keys)] = randomValue(random, depth + 1);
      return out;
    }
  }
}

/** Values no function may throw on. */
export function hostileInputs(): unknown[] {
  const cyclic: { [key: string]: unknown } = { name: 'commands', attributes: {}, children: [] };
  (cyclic.children as unknown[]).push(cyclic);
  const throwing = Object.defineProperty({}, 'blocks', {
    enumerable: true,
    get() {
      throw new Error('getter');
    },
  });
  return [
    undefined,
    null,
    0,
    -1,
    Number.NaN,
    '',
    'text',
    [],
    [null, 1, 'x'],
    {},
    { blocks: null, links: 'x' },
    { blocks: [null, 1, { text: 5, runs: 'x' }], links: [{ href: 7 }] },
    { root: null },
    { root: cyclic },
    { model: { root: cyclic } },
    { sections: 'x', blocks: [] },
    { sections: [], blocks: [{ kind: 'paragraph', section: 99, text: '**x**', selector: 'b/0' }] },
    { schema: 'ist.manual-command-catalog', signatures: [null, { head_tokens: 'x' }] },
    { candidates: [{ name: 5 }, null], line: 10 },
    { builds: 'x', existingRoots: [5, null, { build: 7 }] },
    { index: [null, { links: null }] },
    { text: 5, heads: 'show' },
    { labels: [null, 5, {}] },
    { title: ['x'] },
    throwing,
    { model: throwing },
  ];
}

/** Calls `fn` on the input and checks totality: no throw, a JSON value back, the same result twice. */
export function assertTotal(fn: (input: unknown) => unknown, input: unknown, label = ''): unknown {
  let first: unknown;
  let second: unknown;
  assert.doesNotThrow(() => {
    first = fn(input);
    second = fn(input);
  }, `throws on ${label}`);
  const text = JSON.stringify(first);
  assert.equal(typeof text, 'string', `not JSON on ${label}`);
  assert.deepEqual(JSON.parse(text), first, `result is not plain JSON on ${label}`);
  assert.equal(JSON.stringify(second), text, `not deterministic on ${label}`);
  return first;
}

/** Warnings that report an internal failure: a test fails on them, so code faults stay visible. */
export function internalWarnings(result: unknown): string[] {
  const out: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string' && value.startsWith('内部错误')) out.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(result);
  return out;
}
