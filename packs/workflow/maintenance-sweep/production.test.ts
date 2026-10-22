// A production run end to end: the published pack, the real run engine, and a fake reader serving hand-built impact
// views. start_run computes and stores the validation result. The real knowledge reader waits on the cases index.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { StartRunOutput } from '../../../contracts/src/tools.ts';
import { ValidationResult, partitionCountsOf, type ItemResult, type RequirementResult } from '../../../contracts/src/validation.ts';
import { osIsolationAvailable } from '../../../hub/rules/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { buildImpact, reviewSweep } from './functions/test-support.ts';
import { createPacksPort } from '../../../hub/runs/api.ts';
import { callTool } from '../../../hub/server/tools.ts';
import { EmptyKnowledge, call, openHub, type Hub } from './test-hub.ts';

const skip = (await osIsolationAvailable()) ? false : 'no OS network isolation on this machine (sandbox-exec)';
let postgres: TemporaryPostgres;
let hub: Hub;

const REVIEW = 'knowledge:impact:widget:Rel_W_1_0_1..Rel_W_1_0_2';
const BOTH = 'knowledge:impact:widget:Rel_W_1_0_1..Rel_W_1_0_3';
const SKIPPED = 'knowledge:impact:widget:Rel_W_1_0_1..Rel_W_1_0_4';
const EMPTY = 'knowledge:impact:widget:Rel_W_1_0_0..Rel_W_1_0_2';
const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

const both = [
  {
    path: '/commands/drop',
    change: 'removed' as const,
    before: [{ name: 'drop' }],
    from: [{ document: 'doc-1', node: 'n1', title: '又删又改', priority: 1 }],
  },
  {
    path: '/commands/show',
    change: 'modified' as const,
    before: [{ name: 'show', help: '旧' }],
    after: [{ name: 'show', help: '新' }],
    from: [{ document: 'doc-1', node: 'n1', title: '又删又改', priority: 1 }],
  },
];

before(async () => {
  postgres = await startPostgres();
  if (skip) return;
  hub = await openHub(postgres);
  hub.external.put(REVIEW, bytes(buildImpact(reviewSweep())));
  hub.external.put(BOTH, bytes(buildImpact(both)));
  hub.external.put(SKIPPED, bytes(buildImpact(reviewSweep(), { skipped: { from: 3, to: 0 } })));
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
const requirement = (item: ItemResult, key: string): RequirementResult => {
  const found = item.requirements.find((r) => r.requirement === key);
  if (!found) throw new Error(`${item.item} has no ${key}`);
  return found;
};

describe('a production run of maintenance-sweep', { skip }, () => {
  it('reports removed commands as blocking and definition changes field by field', async () => {
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'maintenance-sweep', inputs: { impact: { external: REVIEW } } }, call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    assert.ok(StartRunOutput.safeParse({ ...detail.answer, trace: '4bf92f3577b34da6a3ce929d0e0e4736' }).success);
    const run = detail.answer.run!;
    assert.equal(run.product, undefined);
    assert.deepEqual(
      run.items.map((item) => item.id),
      ['doc-1:n1', 'doc-2:n2', 'doc-3:n1', 'doc-4:n1'],
    );
    assert.ok(!run.items.some((item) => item.id === 'doc-5:n1' || item.id === 'doc-6:n1' || item.id === 'doc-9:n9'));
    assert.equal(run.items[0].summary, '优先级 1；文档 doc-1；1 处需要维护；/commands/drop 删除');
    assert.equal(run.items[2].summary, '优先级 1；文档 doc-3；1 处需要维护；/commands/show 修改');

    const production = detail.production!;
    const result = production.result;
    assert.ok(ValidationResult.safeParse(result).success);
    assert.deepEqual([result.acceptance, result.errors], ['accepted', []]);
    assert.deepEqual(production.counts, { delivered: 4, rejected: 0, quarantined: 0, incomplete: 0, unknown: 0 });
    assert.deepEqual(production.counts, partitionCountsOf(result.partitions));

    for (const id of ['doc-1:n1', 'doc-2:n2']) {
      const removed = requirement(located(result, id), 'command_exists');
      assert.deepEqual(removed.layers, [{ layer: 'static', terminal: 'violation', code: 'maintenance-sweep.case.command_removed', tier: 'blocking', attribution: 'author_input' }]);
      assert.deepEqual([removed.status, removed.unsatisfied_reason], ['unsatisfied', 'outcome_mismatch']);
      assert.equal((removed.claims[0].statement.data as { fix: string }).fix, '按替代命令改写这条用例，或者停用它');
      assert.equal(requirement(located(result, id), 'command_unchanged').layers[0].terminal, 'pass');
    }
    const changed = requirement(located(result, 'doc-3:n1'), 'command_unchanged');
    assert.deepEqual(changed.layers, [{ layer: 'static', terminal: 'violation', code: 'maintenance-sweep.case.command_changed', tier: 'advisory', attribution: 'author_input' }]);
    assert.deepEqual((changed.claims[0].statement.data as { fields: unknown[] }).fields, [{ command: '/commands/show', path: '/args/0/type', before: 'string', after: 'integer' }]);
    assert.equal(requirement(located(result, 'doc-3:n1'), 'command_exists').layers[0].terminal, 'pass');
    const help = requirement(located(result, 'doc-4:n1'), 'command_unchanged');
    assert.deepEqual((help.claims[0].statement.data as { fields: unknown[] }).fields, [{ command: '/commands/help', path: '/help', before: '旧帮助', after: '新帮助' }]);

    const unknown = result.cross_item.filter((claim) => claim.statement.verdict === 'unknown');
    assert.equal(unknown.length, 1);
    assert.equal(unknown[0].requirement, 'command_exists');
    assert.equal(unknown[0].statement.reason, 'missing_input');
    assert.equal(unknown[0].qualifier.nature, 'unknown');
    assert.match(unknown[0].statement.text, /索引没有收录的用例，这里不作结论/);
    const stored = (await hub.service.getRun(hub.alice, run.run))!;
    assert.match(String((stored.run.groups?.[0] as { message?: string }).message), /有 4 条用例需要维护/);
  });

  it('keeps both reasons on one case', async () => {
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'maintenance-sweep', inputs: { impact: { external: BOTH } } }, call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    assert.deepEqual(
      detail.answer.run!.items.map((item) => item.id),
      ['doc-1:n1'],
    );
    const reasons = detail.answer.run!.items[0].fields.reasons as Array<{ code: string }>;
    assert.deepEqual(
      reasons.map((reason) => reason.code),
      ['maintenance-sweep.case.command_removed', 'maintenance-sweep.case.command_changed'],
    );
    const item = located(detail.production!.result, 'doc-1:n1');
    assert.equal(requirement(item, 'command_exists').layers[0].terminal, 'violation');
    assert.equal(requirement(item, 'command_unchanged').layers[0].terminal, 'violation');
  });

  it('skips help when ignore_fields names it, and still reports a signature change', async () => {
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'maintenance-sweep', inputs: { impact: { external: REVIEW } }, parameters: { ignore_fields: ['help'] } }, call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    assert.deepEqual(
      detail.answer.run!.items.map((item) => item.id),
      ['doc-1:n1', 'doc-2:n2', 'doc-3:n1'],
    );
    const stored = (await hub.service.getRun(hub.alice, detail.answer.run!.run))!;
    assert.deepEqual(stored.run.parameters, { ignore_fields: ['help'] });
  });

  it('says a short earlier index is not proof that nothing is stale', async () => {
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'maintenance-sweep', inputs: { impact: { external: SKIPPED } } }, call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    const unknown = detail.production!.result.cross_item.find((claim) => claim.statement.reason === 'missing_input')!;
    assert.match(unknown.statement.text, /较早构建的索引缺少 3 份列出的文档/);
    assert.match(unknown.statement.text, /没有维护项并不能证明没有过期的用例/);
  });

  it('starts a clean pair legally and stores an empty result', async () => {
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'maintenance-sweep', inputs: { impact: { external: EMPTY } } }, call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    assert.equal(detail.answer.run!.items.length, 0);
    assert.notEqual(detail.production, null);
    const production = detail.production!;
    assert.deepEqual(production.counts, { delivered: 0, rejected: 0, quarantined: 0, incomplete: 0, unknown: 0 });
    assert.deepEqual(production.result.partitions, { delivered: [], incomplete: [], quarantined: [], rejected: [] });
    assert.deepEqual(production.result.coverage, { complete: true, examined: 0, total: 0 });

    const gapText = (detail.gaps ?? []).map((g) => `${g.code}：${g.message}`);
    assert.ok(gapText.some((g) => g.includes('没有条目')), `the answer notes no items: ${gapText.join('; ')}`);
    assert.ok(
      gapText.some((g) => g.includes('maintenance-sweep.clean') && g.includes('没有需要维护的用例')),
      `the answer carries the pack's explanation: ${gapText.join('; ')}`,
    );

    const stored = (await hub.service.getRun(hub.alice, detail.answer.run!.run))!;
    assert.deepEqual(stored.latest, { record: production.record, result: production.result });

    const toolCall = {
      principal: hub.alice,
      traceId: '4bf92f3577b34da6a3ce929d0e1e0099',
      sessionId: 'sess-maintenance',
      context: { traceId: '4bf92f3577b34da6a3ce929d0e1e0099', sessionId: 'sess-maintenance', adminNote: () => {} },
      state: {},
    };
    const deps = {
      records: hub.kit,
      runs: hub.service,
      packs: createPacksPort(hub.registry),
      knowledge: new EmptyKnowledge(),
      now: () => new Date(),
    };
    const read = await callTool(deps as unknown as Parameters<typeof callTool>[0], toolCall as unknown as Parameters<typeof callTool>[1], 'get_nodes', { reference: detail.answer.result!.reference });
    assert.equal(read.isError, false);
    assert.match(read.content[0].text, /覆盖：完整：已查 0，共 0/);
    assert.match(read.content[0].text, /条目明细：没有条目/);
    assert.match(read.content[0].text, /索引没有收录的用例，这里不作结论。/);
    const content = (read.structuredContent as { content: { text: string; reference: string; readable: boolean } }).content;
    assert.equal(content.reference, detail.answer.result!.reference);
    assert.equal(content.readable, true);
    const parsed = JSON.parse(content.text);
    assert.deepEqual(parsed.partitions, { delivered: [], incomplete: [], quarantined: [], rejected: [] });
    assert.deepEqual(parsed.coverage, { complete: true, examined: 0, total: 0 });
  });

  it('refuses a product on an unbound pack, and keeps the pack from users it is not assigned to', async () => {
    const named = await hub.service.startRun(hub.alice, { pack: 'maintenance-sweep', product: 'widget', inputs: { impact: { external: REVIEW } } }, call());
    assert.ok(named.errors.some((error) => error.message.includes('不能指定产品')), JSON.stringify(named.errors));
    const refused = await hub.service.startRun(hub.bob, { pack: 'maintenance-sweep', inputs: { impact: { external: REVIEW } } }, call());
    assert.deepEqual(
      refused.errors.map((error) => error.code),
      ['SOURCE_UNAVAILABLE'],
    );
  });
});

describe('the real knowledge reader', () => {
  it.todo('runs maintenance-sweep against the real knowledge reader once the product pack cases index is committed');
});
