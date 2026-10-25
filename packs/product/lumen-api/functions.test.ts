// The functions of the second product against the product@1 shapes: the sync plan over the release list, the build choice and
// the endpoint producer, on good, malformed and hostile input, in process and in the Hub sandbox.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { CatalogEntry } from '../../../contracts/src/tables.ts';
import { ProducerOutput, ProductDeclaration, SelectBuildOutput, SyncPlanOutput } from '../../../contracts/src/product.ts';
import { markdownParser } from '../../../hub/refs/api.ts';
import { callPackFunction, osIsolationAvailable } from '../../../hub/rules/api.ts';
import { FUNCTIONS, PACK_DIR } from './api.ts';
import produce, { endpointPath, paramOf, produceEndpoints } from './functions/endpoints.ts';
import choose, { selectBuild } from './functions/select.ts';
import plan, { FAMILY, RELEASES, planBuilds } from './functions/sync.ts';
import { lumenFiles } from './testing/store.ts';

const markdown = (text: string) => markdownParser.parse(new TextEncoder().encode(text)).model;
const files = lumenFiles();
const page = (text: string) => ({ ok: true, media_type: 'text/markdown', parser: 'markdown@1', model: markdown(text), reason: null });
const syncInput = (read: Record<string, unknown>) => ({ round: 1, options: {}, read, known: [] });

describe('the product profile', () => {
  it('is product@1 with one name, a catalog of endpoints from its own producer', () => {
    const profile = ProductDeclaration.parse(JSON.parse(readFileSync(new URL('./product.json', import.meta.url), 'utf8')));
    assert.deepEqual(profile.names, ['Lumen API']);
    assert.deepEqual(profile.catalogs, [{ id: 'commands@1', entry_kind: 'definition', producer: 'endpoints', complete: true, case_sensitive: false }]);
    assert.deepEqual(profile.sync?.start, [RELEASES]);
  });
});

describe('the sync plan', () => {
  it('asks for the release list first, then lists every build of the table with its endpoint reference', () => {
    assert.deepEqual(planBuilds(syncInput({}) as never), { fetch: [RELEASES], builds: [], done: false });
    const out = planBuilds(syncInput({ [RELEASES]: page(files['/lumen/releases.md']) }) as never);
    assert.ok(SyncPlanOutput.safeParse(out).success);
    assert.deepEqual(
      out.builds.map((b) => [b.name, b.line, b.released_at, b.sources.spec]),
      [
        ['lumen-2.1.0-b7', '2.1', '2026-05-03T00:00:00Z', 'manual:file:lumen/2.1.0/endpoints.md'],
        ['lumen-2.1.1-b2', '2.1', null, 'manual:file:lumen/2.1.1/endpoints.md'],
        ['lumen-2.0.4-b30', '2.0', '2026-02-12T00:00:00Z', 'manual:file:lumen/2.0.4/endpoints.md'],
      ],
    );
    assert.ok(out.builds.every((b) => b.family === FAMILY && b.base === b.name && b.platform === null));
    assert.match(out.note ?? '', /1 行读不出/, 'the row that leaves the store is skipped');
    assert.equal(out.done, true);
  });

  it('plans nothing for an unreadable or malformed page, and never throws', () => {
    const unreadable = planBuilds(syncInput({ [RELEASES]: { ok: false, media_type: null, parser: null, model: null, reason: '404' } }) as never);
    assert.deepEqual([unreadable.builds, unreadable.done], [[], true]);
    assert.match(unreadable.note ?? '', /404/);
    assert.deepEqual(planBuilds(syncInput({ [RELEASES]: page('# 没有表格') }) as never).builds, []);
    for (const hostile of [null, 7, { read: [] }, { read: { [RELEASES]: { ok: true, parser: 'markdown@1', model: { blocks: [{ kind: 'table', text: '|'.repeat(5000) }] } } } }]) {
      assert.ok(SyncPlanOutput.safeParse(plan(hostile)).success);
    }
  });
});

describe('the build choice', () => {
  const candidate = (name: string, line: string, released: string | null, built = '2026-01-01T00:00:00Z') => ({ name, family: FAMILY, line, base: name, platform: null, built_at: built, released_at: released, sources: {}, root: 'a'.repeat(64) });

  it('takes the newest released build of the line, else of the newest released line, listing the others', () => {
    const candidates = [candidate('lumen-2.1.0-b7', '2.1', '2026-05-03T00:00:00Z'), candidate('lumen-2.1.1-b2', '2.1', null, '2026-05-20T00:00:00Z'), candidate('lumen-2.0.4-b30', '2.0', '2026-02-12T00:00:00Z')];
    const asked = selectBuild({ line: '2.0', candidates, request: {} });
    assert.ok(SelectBuildOutput.safeParse(asked).success);
    assert.equal(asked.build, 'lumen-2.0.4-b30');
    const free = selectBuild({ line: null, candidates, request: {} });
    assert.deepEqual([free.build, free.alternatives], ['lumen-2.1.0-b7', ['lumen-2.1.1-b2']]);
    const unreleased = selectBuild({ line: '2.2', candidates: [candidate('lumen-2.2.0-b1', '2.2', null)], request: {} });
    assert.equal(unreleased.build, 'lumen-2.2.0-b1');
    assert.match(unreleased.basis, /未发布/);
    assert.ok(SelectBuildOutput.safeParse(choose({ line: '9.9', candidates: [], request: {} })).success);
    assert.ok(SelectBuildOutput.safeParse(choose(null)).success);
  });
});

describe('the endpoint producer', () => {
  const model = markdown(files['/lumen/2.1.0/endpoints.md']);
  const build = { name: 'lumen-2.1.0-b7', family: FAMILY, line: '2.1', base: 'lumen-2.1.0-b7', platform: null, built_at: null, released_at: null, sources: {}, root: null };
  const input = (spec: unknown) => ({ build, slots: { spec }, params: {} });

  it('defines only structurally complete endpoints and reports an incomplete parameter grammar', () => {
    const out = produceEndpoints(input({ sha256: 'a'.repeat(64), media_type: 'text/markdown', parser: 'markdown@1', model }));
    assert.ok(ProducerOutput.safeParse(out).success);
    assert.deepEqual(out.warnings, ['GET /v1/health：缺显式参数表（零参数也须声明空表）；下一步由来源作者补完整参数结构后重产']);
    assert.deepEqual(out.entries.map((e) => e.path), ['/endpoints/GET/v1/pools', '/endpoints/POST/v1/pools', '/endpoints/DELETE/v1/pools/{id}']);
    const pools = out.entries[0].data;
    assert.deepEqual(pools.words, ['GET', '/v1/pools']);
    assert.deepEqual(pools.signatures, [{ id: '1', params: [{ name: 'limit', type: 'int', optional: true, minimum: 1, maximum: 100 }] }]);
    assert.deepEqual((out.entries[1].data.signatures as Array<{ params: unknown[] }>)[0].params, [{ name: 'name', type: 'string', optional: false, minLength: 1, maxLength: 32 }, { name: 'mode', type: 'enum', optional: true, values: ['rr', 'lc', 'hash'] }]);
    for (const entry of out.entries) {
      assert.equal(entry.kind, 'definition');
      assert.ok(CatalogEntry.safeParse({ words: entry.data.words, signatures: entry.data.signatures, reference: `tree:${'a'.repeat(64)}/x` }).success, entry.path ?? '');
      const selectors = new Set([...model.sections.map((s) => s.selector), ...model.blocks.map((b) => b.selector)]);
      for (const f of entry.fragments) assert.ok(selectors.has(f.selector), f.selector);
      assert.deepEqual(entry.applicability, { builds: ['lumen-2.1.0-b7'] });
    }
  });

  it('reports what it cannot read: bad rows, duplicate endpoints, a reference without endpoints, a wrong parser', () => {
    const text = '## GET /v1/a\n\n| name | type | optional | minimum | maximum | minLength | maxLength | values |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| Bad | int | false | 1 | 2 | | | |\n| x | float | false | | | | | |\n| e | enum | false | | | | | [] |\n\n## GET /v1/a\n\n重复\n';
    const out = produceEndpoints(input({ parser: 'markdown@1', model: markdown(text) }));
    assert.equal(out.entries.length, 0);
    assert.equal(out.warnings.length, 5);
    assert.match(produceEndpoints(input({ parser: 'markdown@1', model: markdown('# 只有标题') })).warnings[0], /没有/);
    assert.match(produceEndpoints(input({ parser: 'json@1', model: {} })).warnings[0], /不是 Markdown/);
    assert.deepEqual(produceEndpoints(input(null)).entries, []);
    assert.equal(typeof paramOf(['limit','int','false','1','100','','','']), 'object');
    assert.equal(typeof paramOf(['limit','整数','1-100']), 'string');
    assert.equal(endpointPath('GET', '/v1//pools/'), '/endpoints/GET/v1/pools');
  });

  it('is total on hostile input', () => {
    for (const hostile of [null, 'x', { slots: { spec: { parser: 'markdown@1', model: { sections: [{ title: 'GET /a', selector: 's', blocks: [99, -1, 'x'] }], blocks: 'no' } } } }]) {
      assert.ok(ProducerOutput.safeParse(produce(hostile)).success);
    }
  });
});

describe('the declared functions in the Hub sandbox', () => {
  it('give the same answers as the direct calls', async (t) => {
    if (!(await osIsolationAvailable())) return t.skip('sandbox-exec is not available on this machine');
    const calls: Array<[{ module: string; export: string }, unknown, (input: unknown) => unknown]> = [
      [FUNCTIONS.syncPlan, syncInput({ [RELEASES]: page(files['/lumen/releases.md']) }), plan],
      [FUNCTIONS.selectBuildRule, { line: null, candidates: [], request: {} }, choose],
      [FUNCTIONS.endpointsProducer, { build: { name: 'b' }, slots: { spec: { parser: 'markdown@1', model: markdown(files['/lumen/2.1.0/endpoints.md']) } }, params: {} }, produce],
    ];
    for (const [fn, value, direct] of calls) {
      const result = await callPackFunction({ packDir: PACK_DIR, module: fn.module, export: fn.export }, value);
      assert.equal(result.osIsolation, true);
      assert.deepEqual(result.output, JSON.parse(JSON.stringify(direct(value))), fn.module);
    }
  });
});
