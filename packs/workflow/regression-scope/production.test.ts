// A production run end to end: the published pack, the real run engine, and a fake reader serving hand-built impact
// views. start_run computes and stores the validation result. The real knowledge reader waits on the cases index.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { StartRunOutput } from '../../../contracts/src/tools.ts';
import { ValidationResult, partitionCountsOf, type ItemResult } from '../../../contracts/src/validation.ts';
import { osIsolationAvailable } from '../../../hub/rules/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { buildImpact, reviewChanges, reviewOptions } from './functions/test-support.ts';
import { createPacksPort } from '../../../hub/runs/api.ts';
import { callTool } from '../../../hub/server/tools.ts';
import { EmptyKnowledge, call, openHub, type Hub } from './test-hub.ts';

const skip = (await osIsolationAvailable()) ? false : 'no OS network isolation on this machine (sandbox-exec)';
let postgres: TemporaryPostgres;
let hub: Hub;

const REVIEW = 'knowledge:impact:widget:Rel_W_1_0_1..Rel_W_1_0_2?attached_fields=document,node,title,priority,negative';
const SKIPPED = 'knowledge:impact:widget:Rel_W_1_0_1..Rel_W_1_0_3?attached_fields=document,node,title,priority,negative';
const EMPTY = 'knowledge:impact:widget:Rel_W_1_0_0..Rel_W_1_0_2?attached_fields=document,node,title,priority,negative';
const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

before(async () => {
  postgres = await startPostgres();
  if (skip) return;
  hub = await openHub(postgres, {});
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
    assert.equal(first.summary, '优先级 1；文档 doc-1；2 条命令有变更；/commands/add 新增命令');
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

  it('starts an empty scope legally and stores an empty result', async () => {
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'regression-scope', inputs: { impact: { external: EMPTY } } }, call());
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
      gapText.some((g) => g.includes('regression-scope.empty_scope') && g.includes('两个构建之间没有纳入范围的变更路径，回归范围是空的。')),
      `the answer carries the pack's explanation: ${gapText.join('; ')}`,
    );

    const stored = (await hub.service.getRun(hub.alice, detail.answer.run!.run))!;
    assert.deepEqual(stored.latest, { record: production.record, result: production.result });

    const toolCall = {
      principal: hub.alice,
      traceId: '4bf92f3577b34da6a3ce929d0e1e0099',
      sessionId: 'sess-regression',
      context: { traceId: '4bf92f3577b34da6a3ce929d0e1e0099', sessionId: 'sess-regression', adminNote: () => {} },
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
    assert.match(read.content[0].text, /两个构建之间没有纳入范围的变更路径，回归范围是空的。/);
    const content = (read.structuredContent as { content: { text: string; reference: string; readable: boolean } }).content;
    assert.equal(content.reference, detail.answer.result!.reference);
    assert.equal(content.readable, true);
    const parsed = JSON.parse(content.text);
    assert.deepEqual(parsed.partitions, { delivered: [], incomplete: [], quarantined: [], rejected: [] });
    assert.deepEqual(parsed.coverage, { complete: true, examined: 0, total: 0 });
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
  it('runs regression-scope against the real knowledge reader: a synthetic product pack, two builds, real impact view', async () => {
    const { makeWorld, mindMap, BASE_CATALOG, catalogXml, DEFAULT_PRODUCERS } = await import('../../../hub/knowledge/test-support.ts');
    const { createKnowledgeReader } = await import('../../../hub/knowledge/api.ts');
    const XML = 'application/xml';
    const JSON_TYPE = 'application/json';
    // The default product pack runs the commands producer; the world's shape adds the cases producer beside it.
    const CASES_WITH_NODE = `export default function produce(input: any): unknown {
  const entries: any[] = [];
  for (const doc of input.lists?.cases ?? []) {
    const model = doc.model;
    const root = model.nodes[0].data;
    model.nodes.forEach((node: any) => {
      const data = node.data;
      if (!Array.isArray(data.resource) || data.resource.length === 0 || data.priority === undefined) return;
      const m = /\\[cmd: ([a-z][a-z0-9]*) ([a-z][a-z0-9]*)\\]/.exec(node.text);
      const expected = node.children.map((c: number) => model.nodes[c].text);
      entries.push({
        kind: 'case',
        path: m === null ? null : '/commands/' + m[1] + '/' + m[2],
        statement: node.text,
        data: { document: String(root.id), node: String(data.id), title: node.text, priority: data.priority },
        fragments: [{ slot: 'cases', source: doc.sha256, parser: 'kityminder@1', selector: node.selector }],
        applicability: null,
      });
    });
  }
  return { entries, warnings: [] };
}
`;
    const w = await makeWorld(postgres, {
      pack: {
        functions: { 'cases-node.ts': CASES_WITH_NODE },
        declaration: {
          producers: [...DEFAULT_PRODUCERS, { id: 'cases', title: '用例', function: { module: 'functions/cases-node.ts' }, inputs: { cases: { source: 'cases', many: true } } }],
        },
      },
    });
    // Build A's command tree: reboot and show. Build B adds a parameter to show (a definition change) and a net arp
    // command (a new definition), keeping the manual text untouched on the unchanged paths.
    const treeOf = (arp: boolean): Uint8Array =>
      new TextEncoder().encode(catalogXml(arp ? { ...BASE_CATALOG, net: [...BASE_CATALOG.net, { name: 'arp', params: [] }] } : BASE_CATALOG));
    w.external.set('site:tree:Rel_WDG_7_7_7', { bytes: treeOf(false), mediaType: XML });

    w.external.set('site:tree:Rel_WDG_7_7_8', { bytes: treeOf(true), mediaType: XML });
    // The case rides the command the later build adds (/commands/net/arp), so it lands in the scope.
    const cases = (id: string): string => {
      w.external.set(`store:mindmap:${id}`, { bytes: mindMap({ id, module: 'M1' }, [{ id: `${id}-c1`, text: '[cmd: net arp] 解析地址', expected: ['解析成功'], priority: 2 }]), mediaType: JSON_TYPE });
      return `store:mindmap:${id}`;
    };
    const build = (name: string, source: string) => ({ name, family: 'WDG', line: '7.7', base: name, platform: null, built_at: '2026-01-02T10:00:00.000Z', released_at: '2026-01-05T00:00:00.000Z', sources: { tree: `site:tree:${name}`, cases: source }, root: null });
    const first = await w.knowledge.produceTree({ product: w.product, build: build('Rel_WDG_7_7_7', cases('d1')) });
    assert.equal(first.ok, true, first.reason ?? '');
    const second = await w.knowledge.produceTree({ product: w.product, build: build('Rel_WDG_7_7_8', cases('d2')) });
    assert.equal(second.ok, true, second.reason ?? '');

    // The run hub reads knowledge views through the real reader routed beside the fake external.
    const runHub = await openHub(postgres, { knowledge: createKnowledgeReader(w.knowledge), kit: { kit: w.kit, admin: { id: w.admin.id, name: w.admin.name, role: 'admin' }, alice: { id: w.user.id, name: w.user.name, role: 'user' }, bob: { id: w.outsider.id, name: w.outsider.name, role: 'user' } } });
    // The world's reader user runs the pack (the admin of the same database assigns it).

    const reference = 'knowledge:impact:acme:Rel_WDG_7_7_7..Rel_WDG_7_7_8?changed=definition&attached=case&attached_fields=document,node,title,priority,negative';
    // The knowledge reader names the reader of the product's pack: the world's reader user (same database).
    const detail = await runHub.service.startRunDetailed(runHub.alice, { pack: 'regression-scope', inputs: { impact: { external: reference } } }, call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    const run = detail.answer.run!;
    // The later build's arp case lands in the scope through the real reader's definition-only view.
    assert.ok(run.items.length > 0, 'the real reader answers an impact view the projection accepts');
    void makeWorld; void DEFAULT_PRODUCERS;
    await runHub.close();
    await w.close();
  });
});
