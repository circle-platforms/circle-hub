// A production run end to end: the published pack, the real run engine, and a fake reader serving hand-built impact
// views. start_run computes and stores the validation result. The real knowledge reader waits on the cases index.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { StartRunOutput } from '../../../contracts/src/tools.ts';
import { ValidationResult, partitionCountsOf, type ItemResult } from '../../../contracts/src/validation.ts';
import { osIsolationAvailable } from '../../../hub/rules/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { buildImpact, reviewChanges, reviewOptions } from './functions/test-support.ts';
import { call, openHub, type Hub } from './test-hub.ts';

const skip = (await osIsolationAvailable()) ? false : 'no OS network isolation on this machine (sandbox-exec)';
let postgres: TemporaryPostgres;
let hub: Hub;

const REVIEW = 'knowledge:impact:widget:Rel_W_1_0_1..Rel_W_1_0_2';
const SKIPPED = 'knowledge:impact:widget:Rel_W_1_0_1..Rel_W_1_0_3';
const EMPTY = 'knowledge:impact:widget:Rel_W_1_0_0..Rel_W_1_0_2';
const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

before(async () => {
  postgres = await startPostgres();
  if (skip) return;
  hub = await openHub(postgres);
  hub.external.put(REVIEW, bytes(buildImpact(reviewChanges(), reviewOptions())));
  hub.external.put(SKIPPED, bytes(buildImpact(reviewChanges(), { ...reviewOptions(), skipped: { from: 0, to: 4 } })));
  hub.external.put(EMPTY, bytes(buildImpact([])));
});
after(async () => {
  await hub?.close();
  await postgres?.stop();
});

const located = (result: ValidationResult, id: string): ItemResult => {
  for (const items of Object.values(result.partitions)) {
    const item = (items as ItemResult[]).find((i) => i.item === id);
    if (item) return item;
  }
  throw new Error(`item ${id} is in no partition`);
};

describe('a production run of regression-scope', { skip }, () => {
  it('lists every later-build case on an added or modified path, and reports a bare path as unknown', async () => {
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'regression-scope', inputs: { impact: { external: REVIEW } } }, call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    assert.ok(StartRunOutput.safeParse({ ...detail.answer, trace: '4bf92f3577b34da6a3ce929d0e0e4736' }).success);
    const run = detail.answer.run!;
    assert.equal(run.product, undefined);
    assert.equal(run.version, undefined);
    assert.equal(run.build, undefined);
    assert.equal(run.root, undefined);
    assert.equal(run.slots, undefined);
    assert.deepEqual(
      run.requirements.map((r) => [r.key, r.accepted_producer]),
      [
        ['in_scope', 'fact'],
        ['uncovered_changes', 'fact'],
      ],
    );
    assert.deepEqual(
      run.items.map((item) => item.id),
      ['doc-1:n1', 'doc-2:n2', 'doc-5:n1', 'doc-6:n1'],
    );
    assert.ok(!run.items.some((item) => item.id === 'doc-3:n9' || item.id === 'doc-4:n1' || item.id === 'doc-8:n1' || item.id === 'doc-9:old'));
    const first = run.items[0];
    assert.equal(first.label, '查看部件状态');
    assert.equal(first.summary, '优先级 1；文档 doc-1；2 条命令有变更；/commands/add 新增');
    const reasons = first.fields.reasons as Array<{ path: string; change: string }>;
    assert.deepEqual(
      reasons.map((reason) => [reason.path, reason.change]),
      [
        ['/commands/add', 'added'],
        ['/commands/show', 'modified'],
      ],
    );
    assert.deepEqual([first.fields.priority, first.fields.negative], [1, true]);
    assert.deepEqual(
      run.sources.map((s) => s.external),
      [`${REVIEW}@1`],
    );

    const production = detail.production!;
    const result = production.result;
    assert.ok(ValidationResult.safeParse(result).success);
    assert.deepEqual([result.acceptance, result.errors], ['accepted', []]);
    assert.deepEqual(production.counts, { delivered: 4, rejected: 0, quarantined: 0, incomplete: 0, unknown: 0 });
    assert.deepEqual(production.counts, partitionCountsOf(result.partitions));
    for (const id of ['doc-1:n1', 'doc-2:n2', 'doc-5:n1', 'doc-6:n1']) {
      const item = located(result, id);
      assert.equal(item.requirements[0].requirement, 'in_scope');
      assert.deepEqual(item.requirements[0].layers, [{ layer: 'static', terminal: 'pass' }]);
      const claim = item.requirements[0].claims[0];
      assert.equal(claim.statement.verdict, 'support');
      assert.equal(claim.qualifier.nature, 'fact');
      assert.ok(claim.grounds.length > 0, id);
      assert.ok(claim.grounds.every((ground) => ground.startsWith('tree:')), id);
    }
    const doc1 = located(result, 'doc-1:n1').requirements[0].claims[0];
    const behaviour = (first.fields.reasons as Array<{ before: Array<{ kind: string; reference: string }>; after: Array<{ kind: string; reference: string }> }>).flatMap((reason) =>
      [...reason.before, ...reason.after].filter((entry) => entry.kind === 'behaviour').map((entry) => entry.reference),
    );
    assert.ok(behaviour.length > 0);
    assert.ok(behaviour.every((ref) => !doc1.grounds.includes(ref)));
    const unknown = result.cross_item.filter((claim) => claim.requirement === 'uncovered_changes');
    assert.equal(unknown.length, 1);
    assert.equal(unknown[0].statement.verdict, 'unknown');
    assert.equal(unknown[0].statement.reason, 'missing_input');
    assert.equal(unknown[0].qualifier.nature, 'unknown');
    assert.match(unknown[0].statement.text, /\/commands\/bare（新增）/);
    assert.match(unknown[0].statement.text, /不是失败/);
    assert.ok(result.cross_item.every((claim) => claim.statement.verdict !== 'refute'));
    const stored = (await hub.service.getRun(hub.alice, run.run))!;
    assert.equal(stored.latest?.result.acceptance, 'accepted');
    const note = stored.run.groups?.[0] as { uncovered?: unknown; message?: string };
    assert.deepEqual(note.uncovered, [{ path: '/commands/bare', change: 'added' }]);
    assert.match(note.message ?? '', /回归范围共 4 条用例/);
  });

  it('drops added paths when include_added is false and still keeps a case that also sits on a modified path', async () => {
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'regression-scope', inputs: { impact: { external: REVIEW } }, parameters: { include_added: false } }, call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    assert.deepEqual(
      detail.answer.run!.items.map((item) => item.id),
      ['doc-1:n1', 'doc-2:n2', 'doc-5:n1'],
    );
    const reasons = detail.answer.run!.items[0].fields.reasons as Array<{ path: string }>;
    assert.deepEqual(reasons.map((reason) => reason.path), ['/commands/show']);
    const stored = (await hub.service.getRun(hub.alice, detail.answer.run!.run))!;
    assert.deepEqual(stored.run.parameters, { include_added: false });
    assert.deepEqual((stored.run.groups?.[0] as { uncovered: unknown }).uncovered, []);
    const cross = detail.production!.result.cross_item;
    assert.equal(cross.length, 1);
    assert.equal(cross[0].statement.verdict, 'support');
    assert.match(cross[0].statement.text, /都有用例/);
  });

  it('filters by priority without reporting the filtered path as uncovered', async () => {
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'regression-scope', inputs: { impact: { external: REVIEW } }, parameters: { priorities: [1] } }, call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    assert.deepEqual(
      detail.answer.run!.items.map((item) => item.id),
      ['doc-1:n1', 'doc-5:n1'],
    );
    const unknown = detail.production!.result.cross_item.filter((claim) => claim.statement.verdict === 'unknown');
    assert.equal(unknown.length, 1);
    assert.match(unknown[0].statement.text, /\/commands\/bare/);
    assert.ok(!unknown.some((claim) => claim.statement.text.includes('/commands/extra')));
  });

  it('says the later build index is short when the view skipped listed documents', async () => {
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'regression-scope', inputs: { impact: { external: SKIPPED } } }, call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    const unknown = detail.production!.result.cross_item.find((claim) => claim.statement.reason === 'missing_input')!;
    assert.match(unknown.statement.text, /缺少 4 份列出的文档/);
    assert.match(unknown.statement.text, /不是失败/);
    const stored = (await hub.service.getRun(hub.alice, detail.answer.run!.run))!;
    assert.match(String((stored.run.groups?.[0] as { message?: string }).message), /缺少 4 份列出的文档/);
  });

  it('refuses an empty scope instead of storing a made-up item', async () => {
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'regression-scope', inputs: { impact: { external: EMPTY } } }, call());
    assert.equal(detail.answer.call_result, 'error');
    assert.equal(detail.production, null);
    assert.ok(detail.answer.errors.some((error) => error.code === 'SUBMISSION_SCHEMA_VIOLATION' && error.message.includes('投影没有给出任何条目')), JSON.stringify(detail.answer.errors));
  });

  it('refuses a product on an unbound pack, and keeps the pack from users it is not assigned to', async () => {
    const named = await hub.service.startRun(hub.alice, { pack: 'regression-scope', product: 'widget', inputs: { impact: { external: REVIEW } } }, call());
    assert.ok(named.errors.some((error) => error.message.includes('不能指定产品')), JSON.stringify(named.errors));
    const refused = await hub.service.startRun(hub.bob, { pack: 'regression-scope', inputs: { impact: { external: REVIEW } } }, call());
    assert.deepEqual(
      refused.errors.map((error) => error.code),
      ['SOURCE_UNAVAILABLE'],
    );
  });
});

describe('the real knowledge reader', () => {
  it.todo('runs regression-scope against the real knowledge reader once the product pack cases index is committed');
});
