import {kityminderParser,type KityMinderModel} from "../../../skill/mindmap-format/api.ts";
// Helpers for the tests of the case-location functions (not a pack function): tiny synthetic KityMinder documents parsed by
// the real kityminder@1 parser, bound inputs as the engine hands them to the projection, hostile values and the totality
// check. Every name, id and text here is invented.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import type { BoundInput } from './types.ts';

export const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

/** A node of a synthetic mind map: text, optional data members (priority, resource) and children. */
export type Node = { text: string; id?: string | null; data?: Record<string, unknown>; children?: Node[] };

/** KityMinder JSON of a document: node ids are `<document>n<k>` in pre-order unless a node names its own (null: no id). */
export function mindMapJson(document: string, root: Node): string {
  let k = 0;
  const write = (node: Node): unknown => {
    const id = node.id === undefined ? `${document}n${k}` : node.id;
    k += 1;
    return { data: { ...(id === null ? {} : { id }), created: 1767225600000, text: node.text, ...node.data }, children: (node.children ?? []).map(write) };
  };
  return JSON.stringify({ root: write(root), template: 'default', theme: 'fresh-blue', version: '1.4.43' });
}

export function parseMap(json: string): KityMinderModel {
  return kityminderParser.parse(new TextEncoder().encode(json)).model;
}

/** A small test map: a root (the title), one group and two tagged cases with expected results. */
export function smallMap(document: string, title: string, cases: Array<{ text: string; tags?: string[]; id?: string | null }> = [{ text: '设置参数后查看结果' }, { text: '参数超出范围时报错', tags: ['Negative'] }]): Node {
  return {
    text: title,
    children: [
      {
        text: '基本功能',
        data: { priority: 1 },
        children: cases.map((c) => ({ text: c.text, id: c.id, data: { priority: 2, resource: c.tags ?? ['Function'] }, children: [{ text: '结果符合预期' }] })),
      },
    ],
  };
}

export type TreeMeta = Record<string, unknown> | null;

/** A bound input of the documents slot, as the engine gives it to the projection (the model parsed, the meta as read). */
export function boundDocument(document: string, root: Node, meta: TreeMeta, external: string | null = `agile:mindmap:${document}@1`): BoundInput {
  const json = mindMapJson(document, root);
  return { slot: 'documents', external, sha256: sha256(json), media_type: 'application/json', parser: 'kityminder@1', model: parseMap(json), meta };
}

/** The RunContext of a run bound to a synthetic line named FAMX and FAMY (one product with two names). */
export const BOUND = { product: 'famx', names: ['FAMX', 'FAMY'], line: '10.6.1', build: 'Rel_FAMX_10_6_1_57', root: sha256('root'), parameters: {}, groups: [] };
export const UNBOUND = { product: null, names: [], line: null, build: null, root: null, parameters: {}, groups: [] };

/** Values no function may throw on. */
export function hostileInputs(): unknown[] {
  const cyclic: { [key: string]: unknown } = { text: 'x', children: [] };
  (cyclic.children as unknown[]).push(cyclic);
  const throwing = Object.defineProperty({}, 'inputs', {
    enumerable: true,
    get() {
      throw new Error('getter');
    },
  });
  return [
    undefined,
    null,
    0,
    Number.NaN,
    '',
    'text',
    [],
    [null, 1, 'x'],
    {},
    { inputs: null },
    { inputs: [null, 5, { slot: 'documents' }] },
    { inputs: [{ slot: 'documents', sha256: 'x', parser: 'kityminder@1', model: { nodes: [] } }] },
    { inputs: [{ slot: 'documents', sha256: sha256('a'), parser: 'kityminder@1', model: { nodes: [cyclic] } }] },
    { items: 'x', context: 5 },
    { items: [null, { id: 5 }, { id: 'a', fields: 'x' }], context: { names: [1, null], parameters: [] } },
    { subject: { items: [{ id: 'a', fields: { ancestors: 'x', root: 7, title: [] } }] } },
    { subject: { items: [{ id: 'a', fields: { ancestors: [null, 5, '060：10.6.1'], root: { name: 5 } } }], context: { parameters: { line: 7, product: {}, id_ranges: { story: 'x' } } } } },
    { case_id: 5, root: [], ancestors: [cyclic], names: 'FAMX', declared: 'x' },
    { case_id: 'a', root: 'FAMY', ancestors: ['\ud800', '060：\u0000', '０６０：'], title: '\udfff bug 61001', names: ['FAMY'], product: 'famx' },
    throwing,
    { subject: throwing },
  ];
}

/** Calls `fn` twice and checks totality: no throw, a JSON value back, the same result both times. */
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

/** Deterministic generator (mulberry32), so property tests are reproducible from their seed. */
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
  return { next, int, pick: <T>(items: readonly T[]): T => items[int(items.length)], chance: (p: number): boolean => next() < p };
}
