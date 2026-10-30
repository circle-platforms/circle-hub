// completeKnowledgeView with the slot opt-in for unknown entries (WorkflowInput.unknown_entries): which truncations it binds.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { FacetView, ImpactView, IndexView } from '../../contracts/src/views.ts';
import type { ExternalRead, ExternalReadContext, ExternalReaderPort } from '../ports.ts';
import { completeKnowledgeView } from './complete-view.ts';

const ROOT = 'a'.repeat(64);
const ENTRY = 'b'.repeat(64);
const context = { principal: { id: 'usr_synthetic', name: 'synthetic', role: 'user' }, run: null, purpose: 'synthetic binding' } as unknown as ExternalReadContext;

const facet = (over: Record<string, unknown> = {}) => ({ schema: 'facet-view@1', next: null, product: 'acme', build: { build: 'Rel_ACME_1', root: ROOT }, kind: 'case', by: ['commands'], rows: [], total: 0, totals: { empty: { commands: 0 } }, truncated: false, skipped: 0, notes: [], ...over });
const index = (key: string, over: Record<string, unknown> = {}) => ({ schema: 'index-view@1', next: null, product: 'acme', build: { build: 'Rel_ACME_1', root: ROOT }, kind: 'case', key, keys: {}, entries: {}, cut_keys: [], total_keys: 0, total_entries: 0, truncated: false, skipped: 0, notes: [], ...over });
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** A reader that answers each page id with the given view, and the records that store what the guard binds. */
function world(pages: Record<string, unknown>) {
  const bytes = new Map<string, Uint8Array>();
  let bound: any = null;
  const external = {
    read: async (id: string): Promise<ExternalRead> => {
      const page = pages[id];
      if (page === undefined) return { ok: false, id, reason: `no synthetic page ${id}` } as ExternalRead;
      const body = new TextEncoder().encode(JSON.stringify(page));
      const hash = sha(id);
      bytes.set(hash, body);
      return { ok: true, id, revision: 'r1', artifacts: [{ name: 'content', artifact: { digest: `d${hash}`, body: { sha256: hash } } }] } as unknown as ExternalRead;
    },
  } as unknown as ExternalReaderPort;
  const records = {
    artifacts: {
      source: async (_principal: unknown, hash: string) => ({ bytes: bytes.get(hash), sha256: hash }),
      prepareDerived: async () => ({}),
      ingest: async (input: { bytes: Uint8Array }) => { bound = JSON.parse(new TextDecoder().decode(input.bytes)); return { digest: 'merged', body: { sha256: sha('merged'), read_tier: 'model_readable' } }; },
    },
    store: { put: async () => ({ digest: 'manifest' }) },
  } as any;
  const bind = async (id: string, options?: { unknownEntries?: 'disclose' }) => {
    const read = await completeKnowledgeView(id, context, external, records, options);
    if (!read.ok) return { read, view: null };
    const chosen = read.artifacts.find(row => row.name === 'content') ?? read.artifacts.find(row => row.name === 'original')!;
    const hash = chosen.artifact.body.sha256;
    return { read, view: bound !== null && chosen.artifact.digest === 'merged' ? bound : JSON.parse(new TextDecoder().decode(bytes.get(hash)!)) };
  };
  return { bind };
}

const FACET_ID = 'knowledge:facets:acme:Rel_ACME_1?kind=case&by=commands';
const UNKNOWN = { truncated: true, unknown_entries: 40, unknown_only: true, notes: ['40 个用例缺完整命令身份，未计入命令分面；下一步核对锁定命令树或补完整命令后重读'] };

test('a truncated last page is refused unless the slot opted in to unknown entries', async () => {
  const w = world({ [FACET_ID]: facet(UNKNOWN) });
  const refused = await w.bind(FACET_ID);
  assert.equal(refused.read.ok, false);
  assert.match((refused.read as { reason: string }).reason, /未交付/);
  const explicitlyAbsent = await w.bind(FACET_ID, {});
  assert.equal(explicitlyAbsent.read.ok, false);
});

test('an opted-in slot binds a last page truncated only by unknown entries, still truncated and carrying the count', async () => {
  const w = world({ [FACET_ID]: facet(UNKNOWN) });
  const bound = await w.bind(FACET_ID, { unknownEntries: 'disclose' });
  assert.equal(bound.read.ok, true, JSON.stringify(bound.read));
  const view = FacetView.parse(bound.view);
  assert.equal(view.truncated, true);
  assert.equal(view.unknown_entries, 40);
  assert.equal(view.unknown_only, true);
});

test('the opt-in never binds other truncation: cut or withheld content next to unknown entries, or a flag with no unknown entries', async () => {
  for (const over of [
    { truncated: true, unknown_entries: 3 },
    { truncated: true },
    { truncated: true, notes: ['2 种取值组合的文字有凭据扫描命中，没有列出'] },
  ]) {
    const w = world({ [FACET_ID]: facet(over) });
    const refused = await w.bind(FACET_ID, { unknownEntries: 'disclose' });
    assert.equal(refused.read.ok, false, JSON.stringify(over));
  }
});

test('a complete view binds as before with or without the opt-in', async () => {
  const w = world({ [FACET_ID]: facet() });
  for (const options of [undefined, { unknownEntries: 'disclose' as const }]) {
    const bound = await w.bind(FACET_ID, options);
    assert.equal(bound.read.ok, true);
    assert.equal(FacetView.parse(bound.view).truncated, false);
  }
});

test('pages of one index are collated and only the last page decides what is left unknown', async () => {
  const id = 'knowledge:index:acme:Rel_ACME_1?kind=case&key=document';
  const next = `${id}&after=doc-1`;
  const first = index('document', { next, keys: { 'doc-0': [ENTRY], 'doc-1': ['c'.repeat(64)] }, total_keys: 3, total_entries: 3, truncated: true, entries: {} });
  const last = (over: Record<string, unknown>) => index('document', { keys: { 'doc-2': ['d'.repeat(64)] }, total_keys: 3, total_entries: 3, ...over });

  const unknownOnly = world({ [id]: first, [next]: last({ truncated: true, unknown_entries: 5, unknown_only: true }) });
  const refused = await unknownOnly.bind(id);
  assert.equal(refused.read.ok, false, 'without the opt-in the unknown-only last page is refused');
  const bound = await unknownOnly.bind(id, { unknownEntries: 'disclose' });
  assert.equal(bound.read.ok, true, JSON.stringify(bound.read));
  const view = IndexView.parse(bound.view);
  assert.deepEqual(Object.keys(view.keys).sort(), ['doc-0', 'doc-1', 'doc-2']);
  assert.equal(view.truncated, true);
  assert.equal(view.unknown_entries, 5);
  assert.equal(view.unknown_only, true, 'the first page truncation (rows left for the next page) is spent once the sequence is exhausted');
  assert.equal(view.next ?? null, null);

  const cutLast = world({ [id]: first, [next]: last({ truncated: true, unknown_entries: 5 }) });
  assert.equal((await cutLast.bind(id, { unknownEntries: 'disclose' })).read.ok, false);

  const complete = world({ [id]: first, [next]: last({}) });
  for (const options of [undefined, { unknownEntries: 'disclose' as const }]) {
    const done = await complete.bind(id, options);
    assert.equal(done.read.ok, true);
    const merged = IndexView.parse(done.view);
    assert.equal(merged.truncated, false);
    assert.equal(Object.hasOwn(merged, 'unknown_entries'), false);
    assert.equal(Object.hasOwn(merged, 'unknown_only'), false);
  }
});

test('only the facet and index views can carry unknown entries; an impact view cannot', () => {
  assert.equal(Object.hasOwn(ImpactView.shape, 'unknown_entries'), false);
  assert.equal(Object.hasOwn(ImpactView.shape, 'unknown_only'), false);
  assert.equal(Object.hasOwn(FacetView.shape, 'unknown_entries'), true);
  assert.equal(Object.hasOwn(IndexView.shape, 'unknown_only'), true);
  // The producer's own consistency: a view with unknown entries is truncated, and unknown_only needs the count.
  assert.equal(FacetView.safeParse(facet({ truncated: false, unknown_entries: 2 })).success, false);
  assert.equal(FacetView.safeParse(facet({ truncated: true, unknown_only: true })).success, false);
  assert.equal(FacetView.safeParse(facet({ truncated: true, unknown_entries: 2 })).success, true);
  assert.equal(FacetView.safeParse(facet({ truncated: true, unknown_entries: 2, unknown_only: true })).success, true);
  assert.equal(FacetView.safeParse(facet({ truncated: true, unknown_entries: 0 })).success, false, 'zero is written as absent');
  assert.equal(FacetView.safeParse(facet({ truncated: true, unknown_entries: 2, unknown_only: false })).success, false, 'false is written as absent');
});
