import { labelOf } from '../../contracts/generated/vocabulary.ts';
// The index view's `fields` parameter: entries carry only the named data fields with an empty statement; entry, kind and
// reference are unchanged; truncation is judged by the slimmed size; a view of 150,000 entries does not truncate with
// fields. And what the "未归位" note counts: entries (each once, even a document with several), not documents or rows.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it, test } from 'node:test';
import { IndexView } from '../../contracts/src/views.ts';
import type { ExternalRead, ExternalReadContext } from '../ports.ts';
import type { Principal } from '../records/api.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { createKnowledgeReader } from './api.ts';
import { catalogXml, DEFAULT_PRODUCERS, extraProducer, makeWorld, type World } from './test-support.ts';
import { parseViewId } from './views.ts';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres();
});
after(() => postgres?.stop());

const A = 'Rel_ACME_1_2_15';
const FRAGMENT = [{ parser: 'xml@1', selector: 'x/catalog/group[1]' }];

/** A case entry spec of the extra producer: placed under the reboot command, or unplaced with path null. */
function caseEntry(n: number, options: { placed?: boolean; document?: string; defects?: string[] } = {}): Record<string, unknown> {
  const placed = options.placed !== false;
  return {
    kind: 'case',
    path: placed ? '/commands/system/reboot' : null,
    statement: `用例 ${n}：设置参数后查看结果（完整陈述，含故障现象和修复说明的逐字段描述，凑足真实条目的尺寸）`,
    data: {
      document: options.document ?? `d${n}`,
      node: `d${n}n${n}`,
      title: `用例 ${n} 的标题`,
      defects: options.defects ?? [`${100000 + n}`],
      module: 'M1',
      // The bulk that makes a full entry cost much more than a slim one.
      extra: 'x'.repeat(400),
    },
    fragments: FRAGMENT,
    applicability: null,
  };
}

interface Fixture {
  w: World;
  root: string;
  read(id: string): Promise<ExternalRead>;
  json(read: ExternalRead): Promise<{ bytes: Uint8Array; value: unknown }>;
  bytes(id: string): Promise<number>;
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }, entries: unknown[], limits?: { maxViewBytes: number }): Promise<Fixture> {
  const w = await makeWorld(postgres, {
    ...(limits !== undefined ? { knowledge: { limits } } : {}),
    pack: { declaration: { producers: [DEFAULT_PRODUCERS[0], extraProducer('extra', { entries })] } },
  });
  t.after(() => w.close());
  w.external.set(`site:tree:${A}`, { bytes: catalogXml({ system: [{ name: 'reboot', params: [] }] }), mediaType: 'application/xml' });
  const produced = await w.knowledge.produceTree({ product: w.product, build: { name: A, family: 'ACME', line: '1.2', base: A, platform: null, built_at: '2026-01-02T10:00:00.000Z', released_at: '2026-01-05T00:00:00.000Z', sources: { tree: `site:tree:${A}` }, root: null } });
  assert.equal(produced.ok, true, produced.reason ?? '');
  const reader = createKnowledgeReader(w.knowledge);
  const context = (principal: Principal): ExternalReadContext => ({ principal, run: null, purpose: '视图测试' });
  const read = (id: string): Promise<ExternalRead> => reader.read(id, context(w.admin));
  const json = async (read0: ExternalRead): Promise<{ bytes: Uint8Array; value: unknown }> => {
    assert.ok(read0.ok, 'the read fails');
    const source = await w.kit.artifacts.source(w.admin, read0.artifacts[0].artifact.body.sha256, { consumer: 'function' });
    assert.ok(source?.bytes);
    return { bytes: source.bytes, value: JSON.parse(new TextDecoder().decode(source.bytes)) };
  };
  return { w, root: produced.root as string, read, json, bytes: async (id) => (await json(await read(id))).bytes.byteLength };
}

describe('parseViewId: the fields parameter of the index view', () => {
  it('accepts fields on the index view, deduped and sorted; rejects it on the other views', () => {
    const parsed = parseViewId(`knowledge:index:acme:${A}?kind=case&key=defects&fields=title,document,node`);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.ok && parsed.value.type === 'index' ? parsed.value.fields : null, ['document', 'node', 'title']);
    const deduped = parseViewId(`knowledge:index:acme:${A}?kind=case&key=defects&fields=title,document,title`);
    assert.ok(deduped.ok && deduped.value.type === 'index');
    assert.deepEqual(deduped.ok && deduped.value.type === 'index' ? deduped.value.fields : null, ['document', 'title']);
    const without = parseViewId(`knowledge:index:acme:${A}?kind=case&key=defects`);
    assert.ok(without.ok && without.value.type === 'index' && without.value.fields === null);
    const withOnly = parseViewId(`knowledge:index:acme:${A}?kind=case&key=defects&only=100,200&fields=document`);
    assert.ok(withOnly.ok && withOnly.value.type === 'index');
    assert.deepEqual(withOnly.ok && withOnly.value.type === 'index' ? [withOnly.value.only, withOnly.value.fields] : null, [['100', '200'], ['document']]);
    assert.equal(parseViewId(`knowledge:facets:acme:${A}?kind=case&by=line&fields=document`).ok, false);
    assert.equal(parseViewId(`knowledge:impact:acme:${A}..${A}?fields=document`).ok, false);
  });

  it('rejects an invalid field name and an empty value', () => {
    assert.equal(parseViewId(`knowledge:index:acme:${A}?kind=case&key=defects&fields=Document`).ok, false);
    assert.equal(parseViewId(`knowledge:index:acme:${A}?kind=case&key=defects&fields=document,`).ok, false);
    assert.equal(parseViewId(`knowledge:index:acme:${A}?kind=case&key=defects&fields=`).ok, false);
    assert.equal(parseViewId(`knowledge:index:acme:${A}?kind=case&key=defects&fields=has space`).ok, false);
  });
});

describe('the fields parameter of the index view', () => {
  test('entries carry only the named fields with an empty statement; entry, kind and reference are unchanged', async (t) => {
    const entries = [caseEntry(1), caseEntry(2)];
    const f = await fixture(t, entries);
    const full = IndexView.parse((await f.json(await f.read(`knowledge:index:acme:${A}?kind=case&key=defects`))).value);
    const slim = IndexView.parse((await f.json(await f.read(`knowledge:index:acme:${A}?kind=case&key=defects&fields=document,node,title`))).value);
    assert.equal(slim.fields?.join(','), 'document,node,title', 'the view records the fields it carries');
    assert.deepEqual([slim.total_keys, slim.total_entries, slim.truncated], [full.total_keys, full.total_entries, full.truncated]);
    assert.deepEqual(slim.keys, full.keys, 'the key mapping is unchanged');
    for (const [digest, entry] of Object.entries(slim.entries)) {
      const whole = full.entries[digest];
      assert.ok(whole !== undefined);
      assert.deepEqual([entry.entry, entry.kind, entry.reference], [whole.entry, whole.kind, whole.reference], 'entry, kind and reference unchanged');
      assert.equal(entry.statement, '', 'the statement is empty');
      assert.deepEqual(Object.keys(entry.data).sort(), ['document', 'node', 'title']);
      assert.deepEqual(entry.data, { document: whole.data.document, node: whole.data.node, title: whole.data.title });
    }
    assert.ok(slim.notes.some((note) => /fields/.test(note) && /document、node、title|document, node, title|document，node，title/.test(note)), slim.notes.join('\n'));
    assert.ok(full.notes.every((note) => !/fields/.test(note)), 'the full view does not mention fields');
    assert.ok((await f.bytes(`knowledge:index:acme:${A}?kind=case&key=defects&fields=document,node,title`)) < (await f.bytes(`knowledge:index:acme:${A}?kind=case&key=defects`)), 'the slim answer is smaller');
  });

  test('truncation is judged by the slimmed size: a budget between the two cuts the full view and not the slim one', async (t) => {
    const entries = Array.from({ length: 40 }, (_, i) => caseEntry(i));
    // Measure both, then set the budget between them.
    const measured = await fixture(t, entries);
    const fullBytes = await measured.bytes(`knowledge:index:acme:${A}?kind=case&key=defects`);
    const slimBytes = await measured.bytes(`knowledge:index:acme:${A}?kind=case&key=defects&fields=document,node,title`);
    assert.ok(slimBytes < fullBytes);
    const budget = slimBytes + 64 * 1024 + 1024;
    assert.ok(fullBytes + 64 * 1024 > budget, 'the fixture must be big enough for the contrast');
    const f = await fixture(t, entries, { maxViewBytes: budget });
    const full = IndexView.parse((await f.json(await f.read(`knowledge:index:acme:${A}?kind=case&key=defects`))).value);
    const slim = IndexView.parse((await f.json(await f.read(`knowledge:index:acme:${A}?kind=case&key=defects&fields=document,node,title`))).value);
    assert.equal(full.truncated, true, 'the full view truncates on bytes at this budget');
    assert.equal(slim.truncated, false, 'the slim view fits');
    assert.deepEqual([slim.total_keys, slim.total_entries], [40, 40]);
    assert.deepEqual(Object.keys(slim.entries).length, 40);
  });

  test('a view of 30,000 entries stores and serves untruncated with fields (the full one truncates on bytes)', { timeout: 600_000 }, async (t) => {
    // The stored-answer boundary: the records' object store caps a file at 32 MiB; the injected budget (28 MiB) sits under it
    // and between the slim and the full view of this corpus.
    const producers = [DEFAULT_PRODUCERS[0], extraProducer('extra', { entries: Array.from({ length: 30_000 }, (_, i) => caseEntry(i, { placed: false })) })];
    const w = await makeWorld(postgres, {
      knowledge: { limits: { maxViewBytes: 28 * 1024 * 1024 } },
      pack: { declaration: { producers } },
    });
    t.after(() => w.close());
    w.external.set(`site:tree:${A}`, { bytes: catalogXml({ system: [{ name: 'reboot', params: [] }] }), mediaType: 'application/xml' });
    const produced = await w.knowledge.produceTree({ product: w.product, build: { name: A, family: 'ACME', line: '1.2', base: A, platform: null, built_at: '2026-01-02T10:00:00.000Z', released_at: '2026-01-05T00:00:00.000Z', sources: { tree: `site:tree:${A}` }, root: null } });
    assert.equal(produced.ok, true, produced.reason ?? '');
    const reader = createKnowledgeReader(w.knowledge);
    const readJson = async (id: string) => {
      const read = await reader.read(id, { principal: w.admin, run: null, purpose: '视图测试' });
      assert.ok(read.ok, read.ok ? '' : `the read fails: ${read.reason}`);
      const source = await w.kit.artifacts.source(w.admin, read.artifacts[0].artifact.body.sha256, { consumer: 'function' });
      assert.ok(source?.bytes);
      return IndexView.parse(JSON.parse(new TextDecoder().decode(source.bytes)));
    };
    const slim = await readJson(`knowledge:index:acme:${A}?kind=case&key=defects&fields=document,node,title`);
    assert.equal(slim.truncated, false, slim.notes.join('\n'));
    assert.deepEqual([slim.total_keys, slim.total_entries], [30_000, 30_000]);
    assert.equal(Object.keys(slim.entries).length, 30_000);
    const full = await readJson(`knowledge:index:acme:${A}?kind=case&key=defects`);
    assert.equal(full.truncated, true, 'the same 30,000 entries without fields do not fit the budget');
    assert.ok(Object.keys(full.entries).length < 30_000);
  });

  test('a view of 150,000 entries computes untruncated with fields at the index level (past the byte budget of the default deployment such an answer is not servable anyway: the object store caps a file at 32 MiB)', { timeout: 600_000 }, async () => {
    // The computation itself, without the storage boundary: a synthetic composition of 150,000 unplaced case entries and a
    // store that answers their content by digest.
    const { CompositionView } = await import('./composition.ts');
    const { KnowledgeViews } = await import('./views.ts');
    const root = 'a'.repeat(64);
    const rows = [];
    const contents = new Map<string, { kind: string; statement: string; data: Record<string, unknown>; applicability: null }>();
    for (let i = 0; i < 150_000; i++) {
      const digest = createHash('sha256').update(`case ${i}`).digest('hex');
      rows.push({ entry: digest, kind: 'case', producers: ['extra'], section: 's', fragments: [`src:${'b'.repeat(64)}`], basis: 'release_record', decided_by: 'acme@1.0.0', stopped_at: '/', candidate: null, judgments: [], note: '合成' });
      contents.set(digest, {
        kind: 'case',
        statement: `用例 ${i}：完整陈述，含故障现象与修复说明的逐字段描述，凑足真实条目的尺寸`,
        data: { document: `d${i}`, node: `d${i}n${i}`, title: `用例 ${i} 的标题`, defects: [`${100000 + i}`], module: 'M1', extra: 'x'.repeat(400) },
        applicability: null,
      });
    }
    const store = { entries: async (digests: readonly string[]) => new Map(digests.flatMap(d => contents.has(d) ? [[d, contents.get(d)!] as const] : [])) };
    const body = {
      product: 'acme',
      version: { line: '1.2', build: A, family: 'ACME', platform: null },
      build: { name: A, family: 'ACME', line: '1.2', base: A, platform: null, built_at: null, released_at: null, sources: {} },
      root,
      producer: { pack: 'acme', version: '1.0.0', digest: root, id: 'acme@1.0.0', producers: [{ id: 'extra', function: { module: 'functions/extra.ts' } }] },
      sources: [],
      composition: [],
      unplaced: rows,
      refused: [],
      refused_count: 0,
      catalogs: [],
    };
    const composition = new CompositionView(store as never, 'rcd_00000000000000000000000000', body as never);
    const views = new KnowledgeViews({ limits: { maxViewBytes: 96 * 1024 * 1024 } } as never, {rootOfBuild:async()=>null} as never, { compositionOf: async () => composition, compositionsOf:async()=>[composition] } as never);
    const slim = await views.index('acme', { build: A, root }, 'case', 'defects', null, ['document', 'node', 'title']);
    assert.equal(slim.truncated, false, slim.notes.join('\n'));
    assert.deepEqual([slim.total_keys, slim.total_entries], [150_000, 150_000]);
    assert.equal(Object.keys(slim.entries).length, 150_000);
    const full = await views.index('acme', { build: A, root }, 'case', 'defects', null, null);
    assert.equal(full.truncated, true, 'the same 150,000 entries without fields do not fit the budget');
    assert.ok(Object.keys(full.entries).length < 150_000);
  });

  test('the 未归位 note counts entries (each once), not documents or rows', async (t) => {
    // Two unplaced entries of ONE document count as two (the count is per entry); an entry that is also placed keeps its
    // place and is not counted as unplaced.
    const entries = [
      caseEntry(1, { placed: false, document: 'd1' }),
      caseEntry(2, { placed: false, document: 'd1' }),
      caseEntry(3, { placed: true, document: 'd2' }),
    ];
    const f = await fixture(t, entries);
    const view = IndexView.parse((await f.json(await f.read(`knowledge:index:acme:${A}?kind=case&key=defects`))).value);
    assert.ok(view.notes.includes(labelOf('knowledge_count', 'tree_unplaced_entries') + ' 2 个，标在根下'), view.notes.join('\n'));
    // The facets view says the same and counts them in the totals.
    const facets = await f.json(await f.read(`knowledge:facets:acme:${A}?kind=case&by=module`));
    assert.ok((facets.value as { notes: string[] }).notes.includes(labelOf('knowledge_count', 'tree_unplaced_entries') + ' 2 个，标在根下，计入合计'));
  });
});
