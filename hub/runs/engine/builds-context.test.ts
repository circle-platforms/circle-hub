// The builds run context (capability 3): a workflow that opts in (`context: ['builds']` in workflow.json) and is bound to a
// product gets the knowledge base's builds of that product in the run context — both name families, an alias carrying its
// base, sorted deterministically — frozen in the run record, so an evaluation after a restart sees the same list. A workflow
// that did not ask gets nothing and stores nothing; a run bound to no product gets none. The contract shapes are pinned
// here too (contracts/src is another package's path, so its tests live in this file).
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { RunContext, WorkflowFile } from '../../../contracts/src/pack.ts';
import { runRecord as runRecordFixture } from '../../../contracts/src/fixtures.ts';
import { RunRecord } from '../../../contracts/src/run.ts';
import type { KnownBuild } from '../../../contracts/src/product.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { runContextOf } from './evaluate.ts';
import { INDEX } from './store.ts';
import { openHarness, sandboxSkip, type Harness } from './testing/harness.ts';
import { BUILDS } from './testing/knowledge.ts';
import { toyMap, standardDocument } from './testing/mindmap.ts';
import { writePack, type PackSpec } from './testing/packs.ts';

const skip = await sandboxSkip();
let postgres: TemporaryPostgres;
let h: Harness;
let map: string;
let packRoot: string;

/** A probe check: one run-level support outcome whose data echoes the builds the subject builder saw in the context. */
const ECHO = `// Synthetic check: echo the context's builds, so a test can see exactly what the check received.
export default function echo(input: unknown): unknown {
  const subject = (input as { subject?: { context?: { builds?: unknown } } }).subject;
  const builds = subject?.context?.builds;
  return [
    {
      verdict: 'support',
      statement: '探针（合成）',
      grounds: [],
      tier: 'advisory',
      data: { builds: builds ?? null },
    },
  ];
}
`;
const SUBJECT = `// Synthetic subject builder: pass the run context's builds through.
export default function subject(input: unknown): unknown {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as { context?: { builds?: unknown } };
  return { items: [], context: { builds: raw.context?.builds } };
}
`;

function buildsPack(id: string, opts: { ask: boolean; productId?: string }): PackSpec {
  const workflow = {
    schema: 'workflow@1',
    inputs: [{ slot: 'map', role: 'subject', description: '被评审的脑图', accepts: ['application/json', 'toy:mindmap'], required: true, many: false }],
    parameters: [],
    product: opts.productId === undefined ? { catalogs: [] } : { id: opts.productId, catalogs: [] },
    subject: 'map',
    projection: { module: 'functions/project.ts' },
    ...(opts.ask ? { context: ['builds'] } : {}),
  };
  return {
    id,
    version: '1.0.0',
    kind: 'workflow',
    title: `合成构建上下文包 ${id}`,
    description: '探测运行上下文里的构建列表',
    files: {
      'workflow.json': { json: workflow },
      'requirements.json': {
        json: {
          schema: 'requirements@1',
          requirements: [
            { key: 'probe', name: '探针', description: '回显构建列表（合成）', target: 'run', required: true, done_rule: 'bookkeeping', layers: ['static'], accepted_producer: 'fact', checks: ['probe'], error_handling: [] },
          ],
        },
      },
      'checks.json': {
        json: { schema: 'checks@1', checks: [{ id: 'probe', function: { module: 'functions/echo.ts' }, applies: 'run', subject: { module: 'functions/subject.ts' }, judges: 'subject', tier: 'advisory' }] },
      },
      'slots.schema.json': { json: { schema: 'slots@1', item: {}, run: {} } },
      'SKILL.md': '# 合成构建上下文\n\n探测用。\n',
      'functions/project.ts': { function: 'review/project.ts' },
      'functions/echo.ts': ECHO,
      'functions/subject.ts': SUBJECT,
    },
  };
}

/** The context form of the meadow builds, sorted by (line, built_at, name) as the engine freezes them. */
const expectedMeadowBuilds = BUILDS.meadow
  .map((b) => ({ name: b.name, family: b.family, line: b.line, base: b.base, platform: b.platform, built_at: b.built_at, released_at: b.released_at, has_root: b.root !== null }))
  .sort((a, b) => (a.line < b.line ? -1 : a.line > b.line ? 1 : (a.built_at ?? '') < (b.built_at ?? '') ? -1 : (a.built_at ?? '') > (b.built_at ?? '') ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

/** The builds the probe check received at start_run (from the production result's cross-item claim). */
function seenBuilds(detail: Awaited<ReturnType<Harness['service']['startRunDetailed']>>): unknown {
  const claim = detail.production!.result.cross_item.find((c) => c.requirement === 'probe');
  assert.ok(claim, 'the probe claim');
  return (claim!.statement.data as { builds: unknown }).builds;
}

before(async () => {
  postgres = await startPostgres();
  if (skip) return;
  h = await openHarness(postgres);
  map = await h.upload(h.alice, toyMap(standardDocument()));
  packRoot = await mkdtemp(join(tmpdir(), 'circle-hub-builds-'));
  for (const spec of [buildsPack('toy-builds', { ask: true, productId: 'meadow' }), buildsPack('toy-no-builds', { ask: false, productId: 'meadow' }), buildsPack('toy-builds-noprod', { ask: true })]) {
    const loaded = await h.workflows.add(await writePack(packRoot, spec));
    h.workflows.assign(h.alice.id, loaded.pack.id);
  }
});
after(async () => {
  await h?.close();
  if (packRoot !== undefined) await rm(packRoot, { recursive: true, force: true });
  await postgres?.stop();
});

describe('the contract shapes (pinned here: contracts/src is not this package’s path)', () => {
  it('the workflow declaration validates the opt-in and refuses unknown or repeated context keys', () => {
    const base = {
      schema: 'workflow@1',
      inputs: [{ slot: 'subject', role: 'subject', description: 'd', accepts: ['application/json'], required: true, many: false }],
      parameters: [],
      product: { catalogs: [] },
      subject: 'subject',
      projection: { module: 'functions/project.ts' },
    };
    assert.ok(WorkflowFile.safeParse(base).success, 'absent: the workflow did not ask');
    assert.ok(WorkflowFile.safeParse({ ...base, context: ['builds'] }).success, 'the builds opt-in');
    assert.ok(!WorkflowFile.safeParse({ ...base, context: ['bogus'] }).success, 'an unknown context key');
    assert.ok(!WorkflowFile.safeParse({ ...base, context: ['builds', 'builds'] }).success, 'a repeated context key');
    assert.ok(!WorkflowFile.safeParse({ ...base, context: 'builds' }).success, 'not an array');
  });

  it('the run context takes an optional builds list and stays a strict object', () => {
    const context = { product: 'meadow', names: ['Meadow', 'Pasture'], line: null, build: null, root: null, parameters: {}, groups: [] };
    assert.ok(RunContext.safeParse(context).success, 'absent: the workflow did not ask');
    const withBuilds = { ...context, builds: [{ name: 'Rel_MEADOW_3_3_1', family: 'Meadow', line: '3.3', base: 'Rel_MEADOW_3_3_1', platform: null, built_at: null, released_at: null, has_root: true }] };
    assert.ok(RunContext.safeParse(withBuilds).success);
    assert.ok(!RunContext.safeParse({ ...context, builds: [{ name: 'x' }] }).success, 'a build without the rest of the fields');
    assert.ok(!RunContext.safeParse({ ...context, surprise: true }).success, 'an unknown key is still rejected');
  });

  it('the run record takes an optional frozen builds list and stays a strict object', () => {
    assert.ok(RunRecord.safeParse(runRecordFixture).success, 'without builds, as before');
    const builds = [{ name: 'Rel_MEADOW_3_3_1', family: 'Meadow', line: '3.3', base: 'Rel_MEADOW_3_3_1', platform: null, built_at: null, released_at: null, has_root: true }];
    assert.ok(RunRecord.safeParse({ ...runRecordFixture, builds }).success);
    assert.ok(!RunRecord.safeParse({ ...runRecordFixture, builds, surprise: true }).success, 'an unknown key is still rejected');
  });
});

describe('the builds run context', { skip }, () => {
  it('a workflow that asked and is bound to a product: the check sees the knowledge builds, frozen in the run record', async () => {
    const detail = await h.service.startRunDetailed(h.alice, { pack: 'toy-builds', inputs: { map: { reference: map } } }, h.call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    // Both name families, the alias carrying its base, the deterministic order.
    assert.deepEqual(seenBuilds(detail), expectedMeadowBuilds);
    const alias = expectedMeadowBuilds.find((b) => b.name === 'Rel_PASTURE_3_2_9')!;
    assert.deepEqual([alias.family, alias.base, alias.has_root], ['Pasture', 'Rel_MEADOW_3_2_9', true]);
    // Frozen in the run record; the summary does not show it.
    assert.equal((detail.answer.run as Record<string, unknown>).builds, undefined, 'the start_run summary and answer text do not show the builds');
    const stored = await h.kit.store.find({ key: INDEX.runId, value: detail.answer.run!.run, kind: 'run' });
    assert.deepEqual((stored.items[0].body as { builds?: unknown }).builds, expectedMeadowBuilds, 'frozen in the run record');
    // An evaluation after a restart reads the same list: runContextOf derives it from the record alone.
    assert.deepEqual(runContextOf(stored.items[0].body as never).builds, expectedMeadowBuilds);
  });

  it('the frozen list does not depend on the order the knowledge base answers in', async () => {
    h.knowledge.reversedBuilds = true;
    try {
      const detail = await h.service.startRunDetailed(h.alice, { pack: 'toy-builds', inputs: { map: { reference: map } } }, h.call());
      assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
      assert.deepEqual(seenBuilds(detail), expectedMeadowBuilds);
    } finally {
      h.knowledge.reversedBuilds = false;
    }
  });

  it('a workflow that did not ask gets no builds and stores none', async () => {
    const detail = await h.service.startRunDetailed(h.alice, { pack: 'toy-no-builds', inputs: { map: { reference: map } } }, h.call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    assert.equal(seenBuilds(detail), null, 'the check saw no builds field');
    const stored = await h.kit.store.find({ key: INDEX.runId, value: detail.answer.run!.run, kind: 'run' });
    assert.equal(Object.hasOwn(stored.items[0].body as object, 'builds'), false, 'nothing stored, not even an empty list');
    assert.equal(runContextOf(stored.items[0].body as never).builds, undefined);
  });

  it('a run bound to no product gets no builds though the workflow asked', async () => {
    const detail = await h.service.startRunDetailed(h.alice, { pack: 'toy-builds-noprod', inputs: { map: { reference: map } } }, h.call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    assert.equal(detail.answer.run!.product, undefined);
    assert.equal(seenBuilds(detail), null);
    const stored = await h.kit.store.find({ key: INDEX.runId, value: detail.answer.run!.run, kind: 'run' });
    assert.equal(Object.hasOwn(stored.items[0].body as object, 'builds'), false);
  });
});
