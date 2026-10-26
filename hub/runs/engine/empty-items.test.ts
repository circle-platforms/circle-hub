// An empty item set is a legal answer (W01 R[3]: a wholesale refusal is only for a source whose own structure yields no
// items, or for ambiguous production input ids): a projection function that succeeds with zero items lets the run start —
// a production run stores its result (every partition empty, coverage complete at 0 of 0, run-level requirements evaluated)
// and the answer says there are no items and carries the projection's notes; a pack that needs a submission starts the same
// way. The pack's own refusal (its PackFailure) still refuses the start.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ValidationResult, partitionCountsOf } from '../../../contracts/src/validation.ts';
import type { ActionBody } from '../../records/api.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { INDEX } from './store.ts';
import { openHarness, sandboxSkip, type Harness } from './testing/harness.ts';
import { toyMap, standardDocument } from './testing/mindmap.ts';
import { writePack, type PackSpec } from './testing/packs.ts';

const skip = await sandboxSkip();
let postgres: TemporaryPostgres;
let h: Harness;
let map: string;
let packRoot: string;

/** The projection of the empty packs: succeeds with an empty item list and a note (a legal answer, not a refusal). */
const EMPTY_PROJECT = `// Synthetic projection: succeeds with an empty item list (an empty set is a legal answer, W01 R[3]).
export default function project(input: unknown): unknown {
  void input;
  return { items: [], groups: [], warnings: [{ code: 'toy-empty.none', message: '两个构建之间没有变更（合成说明）' }] };
}
`;

/** A fact-only pack whose projection gives zero items: a stand-in for regression scope and maintenance sweep. */
function sweepPack(): PackSpec {
  return {
    id: 'toy-sweep',
    version: '1.0.0',
    kind: 'workflow',
    title: '合成维护巡检',
    description: '投影给出空条目集的合成事实包',
    files: {
      'workflow.json': {
        json: {
          schema: 'workflow@1',
          inputs: [{ slot: 'map', role: 'subject', description: '要巡检的脑图', accepts: ['application/json', 'toy:mindmap'], required: true, many: false }],
          parameters: [],
          product: { catalogs: [] },
          subject: 'map',
          projection: { module: 'functions/project.ts' },
        },
      },
      'requirements.json': {
        json: {
          schema: 'requirements@1',
          requirements: [
            { key: 'overview', name: '整份概况', description: '整个运行的概况（合成）', target: 'run', required: true, done_rule: 'bookkeeping', layers: ['static'], accepted_producer: 'fact', checks: ['overview'], error_handling: [] },
          ],
        },
      },
      'checks.json': { json: { schema: 'checks@1', checks: [{ id: 'overview', function: { module: 'functions/overview.ts' }, applies: 'run', judges: 'subject', tier: 'advisory' }] } },
      'slots.schema.json': { json: { schema: 'slots@1', item: {}, run: {} } },
      'SKILL.md': '# 合成维护巡检\n\n没有要维护的用例时，Hub 算出的结果是空的。\n',
      'functions/project.ts': EMPTY_PROJECT,
      'functions/overview.ts': { function: 'locate/overview.ts' },
    },
  };
}

/** A pack whose requirements need a model, with the same empty projection. */
function reviewEmptyPack(): PackSpec {
  return {
    id: 'toy-review-empty',
    version: '1.0.0',
    kind: 'workflow',
    title: '合成空评审',
    description: '投影给出空条目集的合成评审包',
    files: {
      'workflow.json': {
        json: {
          schema: 'workflow@1',
          inputs: [{ slot: 'map', role: 'subject', description: '被评审的脑图', accepts: ['application/json', 'toy:mindmap'], required: true, many: false }],
          parameters: [],
          product: { catalogs: [] },
          subject: 'map',
          projection: { module: 'functions/project.ts' },
        },
      },
      'requirements.json': {
        json: {
          schema: 'requirements@1',
          requirements: [
            { key: 'findings', name: '评审发现', description: '逐条发现（合成）', target: 'item', required: true, done_rule: 'bookkeeping', layers: ['static'], accepted_producer: 'judgment', checks: [], error_handling: [] },
          ],
        },
      },
      'checks.json': { json: { schema: 'checks@1', checks: [] } },
      'slots.schema.json': { json: { schema: 'slots@1', item: { findings: { min: 0 } }, run: {} } },
      'SKILL.md': '# 合成空评审\n\n没有可评审的条目时，回答写明没有。\n',
      'functions/project.ts': EMPTY_PROJECT,
    },
  };
}

before(async () => {
  postgres = await startPostgres();
  if (skip) return;
  h = await openHarness(postgres);
  map = await h.upload(h.alice, toyMap(standardDocument()));
  packRoot = await mkdtemp(join(tmpdir(), 'circle-hub-empty-'));
  for (const spec of [sweepPack(), reviewEmptyPack()]) {
    const loaded = await h.workflows.add(await writePack(packRoot, spec));
    h.workflows.assign(h.alice.id, loaded.pack.id);
  }
});
after(async () => {
  await h?.close();
  if (packRoot !== undefined) await rm(packRoot, { recursive: true, force: true });
  await postgres?.stop();
});

describe('an empty item set is a legal answer (W01 R[3])', { skip }, () => {
  it('a production run starts with zero items and stores its result: empty partitions, coverage 0 of 0, run-level facts evaluated', async () => {
    const detail = await h.service.startRunDetailed(h.alice, { pack: 'toy-sweep', inputs: { map: { reference: map } } }, h.call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    const run = detail.answer.run!;
    assert.deepEqual(run.items, []);
    assert.equal(detail.production !== null, true, 'a fact-only pack still gets its production result');
    const production = detail.production!;
    assert.ok(ValidationResult.safeParse(production.result).success);
    assert.deepEqual(production.counts, { delivered: 0, rejected: 0, quarantined: 0, incomplete: 0, unknown: 0 });
    assert.deepEqual(production.counts, partitionCountsOf(production.result.partitions));
    assert.deepEqual(production.result.coverage, { complete: true, examined: 0, total: 0 });
    assert.deepEqual([production.result.acceptance, production.result.errors], ['accepted', []]);
    // The run-level fact was computed: zero cases.
    assert.deepEqual(
      production.result.cross_item.map((c) => [c.requirement, c.statement.data?.cases]),
      [['overview', 0]],
    );
    // The answer says there are no items and carries the projection's note.
    const gapText = (detail.gaps ?? []).map((g) => `${g.code}：${g.message}`);
    assert.ok(gapText.some((g) => g.includes('没有条目')), `the answer notes the empty item set: ${gapText.join('; ')}`);
    assert.ok(gapText.some((g) => g.includes('toy-empty.none')), `the projection's note is carried: ${gapText.join('; ')}`);
    // The result is stored under the run and its record digest is the one the reference names.
    const stored = await h.kit.store.find({ key: INDEX.resultRun, value: run.run, kind: 'validation_result' });
    assert.equal(stored.items.length, 1, 'the validation result record is stored');
    assert.equal(stored.items[0].digest, production.record, 'readable by its rec: reference');
    assert.deepEqual(stored.items[0].body, production.result as object);
    const view = (await h.service.getRun(h.alice, run.run))!;
    assert.deepEqual(view.latest, { record: production.record, result: production.result });
    // The parse action records zero items and the projection's warnings.
    const actions = await h.kit.store.find<ActionBody>({ key: INDEX.actionRun, value: run.run, kind: 'action' });
    const parse = actions.items.find((a) => a.body.action === 'parse')!;
    assert.deepEqual([parse.body.detail.items, (parse.body.detail.warnings as unknown[]).length], [0, 1]);
  });

  it('a repeated client key answers the same empty production run, notes included', async () => {
    const input = { pack: 'toy-sweep', inputs: { map: { reference: map } }, client_key: 'empty-sweep-1' };
    const first = await h.service.startRunDetailed(h.alice, input, h.call());
    assert.equal(first.answer.call_result, 'ok');
    const second = await h.service.startRunDetailed(h.alice, input, h.call());
    assert.equal(second.answer.call_result, 'ok');
    assert.equal(second.answer.run!.run, first.answer.run!.run);
    assert.equal(second.production!.record, first.production!.record);
    assert.deepEqual(second.gaps, first.gaps);
  });

  it('a pack that needs a model still starts with zero items, and the answer says there is nothing to review', async () => {
    const detail = await h.service.startRunDetailed(h.alice, { pack: 'toy-review-empty', inputs: { map: { reference: map } } }, h.call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    assert.deepEqual(detail.answer.run!.items, []);
    assert.equal(detail.production, null, 'not a production run: no result at start');
    const gapText = (detail.gaps ?? []).map((g) => `${g.code}：${g.message}`);
    assert.ok(gapText.some((g) => g.includes('没有条目')), `the answer notes the empty item set: ${gapText.join('; ')}`);
    // The run record is stored with an empty item list.
    const record = await h.kit.store.find({ key: INDEX.runId, value: detail.answer.run!.run, kind: 'run' });
    assert.deepEqual((record.items[0].body as { items: unknown[] }).items, []);
  });

  it('the pack’s own refusal still refuses the start (a source that yields no items by its structure)', async () => {
    const detail = await h.service.startRunDetailed(h.alice, { pack: 'toy-review', product: 'Meadow', inputs: { map: { reference: map } } }, h.call());
    // toy-review's projection refuses a document without case nodes — but this document HAS case nodes; use a bare map.
    assert.equal(detail.answer.call_result, 'ok');
    const bare = await h.upload(h.alice, toyMap({ id: 'docbare', title: '没有用例的文档', groups: [] }));
    const refused = await h.service.startRunDetailed(h.alice, { pack: 'toy-review', product: 'Meadow', inputs: { map: { reference: bare } } }, h.call());
    assert.equal(refused.answer.call_result, 'error');
    assert.deepEqual(
      refused.answer.errors.map((e) => e.code),
      ['toy-review.no_case'],
    );
    assert.equal(refused.answer.run, undefined);
  });
});
