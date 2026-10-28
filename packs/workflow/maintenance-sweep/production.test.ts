import {createTestParserRegistry} from '../../../hub/testing/parsers.ts';
// A production run end to end: the published pack, the real run engine, and a fake reader serving hand-built impact
// views. start_run computes and stores the validation result. The real knowledge reader waits on the cases index.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { StartRunOutput } from '../../../contracts/src/tools.ts';
import { ValidationResult, partitionCountsOf, type ItemResult, type RequirementResult } from '../../../contracts/src/validation.ts';
import { osIsolationAvailable } from '../../../hub/rules/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { buildImpact, reviewSweep, facetInput } from './functions/test-support.ts';
import { createPacksPort } from '../../../hub/runs/api.ts';
import { callTool } from '../../../hub/server/tools.ts';
import { EmptyKnowledge, call, openHub, type Hub } from './test-hub.ts';

const skip = (await osIsolationAvailable()) ? false : 'no OS network isolation on this machine (sandbox-exec)';
let postgres: TemporaryPostgres;
let hub: Hub;

const REVIEW = 'knowledge:impact:widget:Rel_W_1_0_1..Rel_W_1_0_2?catalog=commands@1';
const BOTH = 'knowledge:impact:widget:Rel_W_1_0_1..Rel_W_1_0_3?catalog=commands@1';
const SKIPPED = 'knowledge:impact:widget:Rel_W_1_0_3..Rel_W_1_0_4?catalog=commands@1';
const EMPTY = 'knowledge:impact:widget:Rel_W_1_0_0..Rel_W_1_0_2?catalog=commands@1';
const FACETS = 'knowledge:facets:widget:Rel_W_1_0_1?kind=case&by=commands';
const FACETS_SKIPPED='knowledge:facets:widget:'+SKIPPED.split('knowledge:impact:widget:')[1].split('?')[0].split('..')[0]+'?kind=case&by=commands';
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
  hub = await openHub(postgres, {});
  hub.external.put(FACETS, bytes(facetInput(buildImpact([])).model));
  hub.external.put(REVIEW, bytes(buildImpact(reviewSweep(), { catalog: 'commands@1' })));
  hub.external.put(BOTH, bytes(buildImpact(both, { catalog: 'commands@1' })));
  const skippedView=buildImpact(reviewSweep(), { catalog: 'commands@1', skipped: { from: 3, to: 0 } });
  const selectedBuilds=SKIPPED.split('knowledge:impact:widget:')[1].split('?')[0].split('..');
  (skippedView.from as {build:string}).build=selectedBuilds[0];(skippedView.to as {build:string}).build=selectedBuilds[1];
  hub.external.put(SKIPPED,bytes(skippedView));hub.external.put(FACETS_SKIPPED,bytes(facetInput(skippedView).model));
  hub.external.put(EMPTY, bytes(buildImpact([], { catalog: 'commands@1' })));
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
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'maintenance-sweep', inputs: { impact: { external: REVIEW }, facets: { external: FACETS } } }, call());
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
    assert.equal(result.acceptance,'accepted');assert.equal(result.errors.length,0);
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
    // The field rows are not repeated on the claims; they live once in the run-level detail rows the reasons index.
    const storedForDetails = (await hub.service.getRun(hub.alice, run.run))!;
    const detailRows = (storedForDetails.run.groups?.[0] as { details?: Array<{ path: string; fields: unknown[] }> }).details ?? [];
    assert.deepEqual(detailRows.find((row) => row.path === '/commands/show')?.fields, [{ path: '/args/0/type', before: 'string', after: 'integer' }]);
    assert.equal(requirement(located(result, 'doc-3:n1'), 'command_exists').layers[0].terminal, 'pass');
    const help = requirement(located(result, 'doc-4:n1'), 'command_unchanged');
    assert.deepEqual(detailRows.find((row) => row.path === '/commands/help')?.fields, [{ path: '/help', before: '旧帮助', after: '新帮助' }]);

    // 命令差总结是 command_unchanged 的跨条目结论：事实，依据是影响视图，整个差都列得出（新增路径注明不进范围）。
    const summary = result.cross_item.find((claim) => claim.requirement === 'command_unchanged' && claim.statement.verdict === 'support');
    assert.ok(summary, JSON.stringify(result.cross_item));
    assert.equal(summary.qualifier.nature, 'fact');
    assert.equal(summary.grounds.length, 1);
    assert.ok(summary.grounds[0].startsWith('src:'), '依据是影响视图');
    assert.ok(summary.statement.text.startsWith('命令差共 5 条（路径、变更种类、前一构建用例数）：'), summary.statement.text);
    for (const line of [
      '- /commands/add 新增 1 条（不进范围）',
      '- /commands/drop 删除 2 条',
      '- /commands/help 修改 1 条',
      '- /commands/show 修改 1 条',
      '- /commands/text 修改 1 条',
    ]) {
      assert.ok(summary.statement.text.includes(line), line);
    }
    const unknown = result.cross_item.filter((claim) => claim.statement.verdict === 'unknown');
    assert.equal(unknown.length, 0, JSON.stringify(unknown.map((claim) => claim.statement.text)));
    assert.ok(result.cross_item.every((claim) => !claim.statement.text.includes('个用例没有解析出命令')));
    const stored = (await hub.service.getRun(hub.alice, run.run))!;
    assert.match(String((stored.run.groups?.[0] as { message?: string }).message), /有 4 条用例需要维护/);
  });

  it('keeps both reasons on one case', async () => {
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'maintenance-sweep', inputs: { impact: { external: BOTH }, facets: { external: FACETS } } }, call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    assert.deepEqual(
      detail.answer.run!.items.map((item) => item.id),
      ['doc-1:n1'],
    );
    const reasons = detail.answer.run!.items[0].fields.reasons as Array<{ detail: number; change: string }>;
    const storedForReasons = (await hub.service.getRun(hub.alice, detail.answer.run!.run))!;
    const reasonDetails = (storedForReasons.run.groups?.[0] as { details?: Array<{ path: string }> }).details ?? [];
    assert.deepEqual(
      reasons.map((reason) => [reasonDetails[reason.detail].path, reason.change]),
      [
        ['/commands/drop', 'removed'],
        ['/commands/show', 'modified'],
      ],
    );
    const item = located(detail.production!.result, 'doc-1:n1');
    assert.equal(requirement(item, 'command_exists').layers[0].terminal, 'violation');
    assert.equal(requirement(item, 'command_unchanged').layers[0].terminal, 'violation');
  });

  it('skips help when ignore_fields names it, and still reports a signature change', async () => {
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'maintenance-sweep', inputs: { impact: { external: REVIEW }, facets: { external: FACETS } }, parameters: { ignore_fields: ['help'] } }, call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    assert.deepEqual(
      detail.answer.run!.items.map((item) => item.id),
      ['doc-1:n1', 'doc-2:n2', 'doc-3:n1'],
    );
    const stored = (await hub.service.getRun(hub.alice, detail.answer.run!.run))!;
    assert.deepEqual(stored.run.parameters, { ignore_fields: ['help'] });
  });

  it('says a short earlier index is not proof that nothing is stale', async () => {
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'maintenance-sweep', inputs: { impact: { external: SKIPPED }, facets: { external: FACETS_SKIPPED } } }, call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    const unknown = detail.production!.result.cross_item.find((claim) => claim.statement.reason === 'missing_input')!;
    assert.match(unknown.statement.text, /较早构建的索引缺少 3 份列出的文档/);
    assert.match(unknown.statement.text, /没有维护项并不能证明没有过期的用例/);
  });

  it('starts a clean pair legally and stores an empty result', async () => {
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'maintenance-sweep', inputs: { impact: { external: EMPTY }, facets: { external: FACETS } } }, call());
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
    assert.ok(!read.content[0].text.includes('个用例没有解析出命令'), 'hint counts are not validation claims');
    const content = (read.structuredContent as { content: { text: string; reference: string; readable: boolean } }).content;
    assert.equal(content.reference, detail.answer.result!.reference);
    assert.equal(content.readable, true);
    const parsed = JSON.parse(content.text);
    assert.deepEqual(parsed.partitions, { delivered: [], incomplete: [], quarantined: [], rejected: [] });
    assert.deepEqual(parsed.coverage, { complete: true, examined: 0, total: 0 });
  });

  it('refuses a product on an unbound pack, and keeps the pack from users it is not assigned to', async () => {
    const named = await hub.service.startRun(hub.alice, { pack: 'maintenance-sweep', product: 'widget', inputs: { impact: { external: REVIEW }, facets: { external: FACETS } } }, call());
    assert.ok(named.errors.some((error) => error.message.includes('不能指定产品')), JSON.stringify(named.errors));
    const refused = await hub.service.startRun(hub.bob, { pack: 'maintenance-sweep', inputs: { impact: { external: REVIEW }, facets: { external: FACETS } } }, call());
    assert.deepEqual(
      refused.errors.map((error) => error.code),
      ['SOURCE_UNAVAILABLE'],
    );
  });
});

describe('the real knowledge reader', () => {
  it('runs maintenance-sweep against the real knowledge reader: a synthetic product pack, two builds, real impact view', async () => {
    const { makeWorld, mindMap, BASE_CATALOG, catalogXml, DEFAULT_PRODUCERS } = await import('../../../hub/knowledge/test-support.ts');
    const { createKnowledgeReader } = await import('../../../hub/knowledge/api.ts');
    const XML = 'application/xml';
    const JSON_TYPE = 'application/json';
    const CASES_WITH_NODE = `export default function produce(input: any): unknown {
  const entries: any[] = [];
  for (const doc of input.lists?.cases ?? []) {
    const model = doc.model;
    const root = model.nodes[0].data;
    model.nodes.forEach((node: any) => {
      const data = node.data;
      if (!Array.isArray(data.resource) || data.resource.length === 0 || data.priority === undefined) return;
      const m = /\\[cmd: ([a-z][a-z0-9]*) ([a-z][a-z0-9]*)\\]/.exec(node.text);
      entries.push({
        kind: 'case',
        path: m === null ? null : '/commands/' + m[1] + '/' + m[2],
        statement: node.text,
        data: { document: String(root.id), node: String(data.id), title: node.text, priority: data.priority, commands: m === null ? [] : ['/commands/' + m[1] + '/' + m[2]] },
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
          catalogs: [{ id: 'commands@1', entry_kind: 'definition', producer: 'commands', complete: true, case_sensitive: false }],
          producers: [...DEFAULT_PRODUCERS, { id: 'cases', title: '用例', function: { module: 'functions/cases-node.ts' }, inputs: { cases: { source: 'cases', many: true } } }],
        },
      },
    });
    // The later build narrows ping's parameter range (a definition change); the earlier build's case rides ping, so
    // the sweep lists it for maintenance.
    const treeOf = (later: boolean): Uint8Array =>
      new TextEncoder().encode(catalogXml(later
        ? { ...BASE_CATALOG, net: BASE_CATALOG.net.map((c: { name: string }) => (c.name === 'ping' ? { ...c, params: [{ name: 'host', type: 'string' as const }, { name: 'count', type: 'int' as const, min: 1, max: 16 }] } : c)) }
        : BASE_CATALOG));
    w.external.set('site:tree:Rel_WDG_7_7_7', { bytes: treeOf(false), mediaType: XML });
    w.external.set('site:tree:Rel_WDG_7_7_8', { bytes: treeOf(true), mediaType: XML });
    const cases = (id: string, cmd: string): string => {
      w.external.set(`store:mindmap:${id}`, { bytes: mindMap({ id, module: 'M1' }, [{ id: `${id}-c1`, text: `[cmd: net ${cmd}] 连通检查`, priority: 2 }, ...(id === 'd1' ? [{ id: 'unplaced', text: '未归位的合成用例', priority: 2 }] : [])]), mediaType: JSON_TYPE });
      return `store:mindmap:${id}`;
    };
    const build = (name: string, source: string) => ({ name, family: 'WDG', line: '7.7', base: name, platform: null, built_at: '2026-01-02T10:00:00.000Z', released_at: '2026-01-05T00:00:00.000Z', sources: { tree: `site:tree:${name}`, cases: source }, root: null });
    const first = await w.knowledge.produceTree({ product: w.product, build: build('Rel_WDG_7_7_7', cases('d1', 'ping')) });
    assert.equal(first.ok, true, first.reason ?? '');
    const second = await w.knowledge.produceTree({ product: w.product, build: build('Rel_WDG_7_7_8', cases('d2', 'trace')) });
    assert.equal(second.ok, true, second.reason ?? '');

    const runHub = await openHub(postgres, { knowledge: createKnowledgeReader(w.knowledge), kit: { kit: w.kit, admin: { id: w.admin.id, name: w.admin.name, role: 'admin' }, alice: { id: w.user.id, name: w.user.name, role: 'user' }, bob: { id: w.outsider.id, name: w.outsider.name, role: 'user' } } });
    const reference = 'knowledge:impact:acme:Rel_WDG_7_7_7..Rel_WDG_7_7_8?changed=definition&attached=case&attached_fields=document,node,title&catalog=commands@1';
    const detail = await runHub.service.startRunDetailed(runHub.alice, { pack: 'maintenance-sweep', inputs: { impact: { external: reference }, facets: { external: 'knowledge:facets:acme:Rel_WDG_7_7_7?kind=case&by=commands' } } }, call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    assert.ok(detail.answer.run!.items.length > 0, 'the real reader answers an impact view the sweep projects');
    const storedRun = (await runHub.service.getRun(runHub.alice, detail.answer.run!.run))!;
    assert.equal(storedRun.run.groups?.[0].unplaced, 1);
    // Read the already-bound hint over the same MCP tool boundary used by the scripted client.
    const facetSource = detail.answer.run!.sources.find((source) => source.slot === 'facets')!;
    const context = call('synthetic-facet-client');
    const response = await callTool({ parsers:createTestParserRegistry(),records: runHub.kit, runs: runHub.service, packs: createPacksPort(runHub.registry), knowledge: w.knowledge, now: () => new Date() } as unknown as Parameters<typeof callTool>[0], {
      principal: runHub.alice, traceId: context.traceId, sessionId: context.sessionId,
      context: { ...context, adminNote: () => {} }, state: {},
    } as unknown as Parameters<typeof callTool>[1], 'get_nodes', { reference: facetSource.reference });
    assert.equal(response.isError, false);
    const content = response.structuredContent.content as { reference: string; read_tier: string; text: string };
    assert.equal(content.reference, facetSource.reference);
    assert.equal(content.read_tier, 'model_readable');
    assert.equal(typeof content.text, 'string');
    const facet = JSON.parse(content.text) as { schema: string; kind: string; by: string[]; truncated: boolean; skipped: number; rows: Array<{ values: { commands: unknown }; count: number }> };
    assert.deepEqual([facet.schema, facet.kind, facet.by, facet.truncated, facet.skipped], ['facet-view@1', 'case', ['commands'], false, 0]);
    assert.ok(Array.isArray(facet.rows));
    const unplaced = facet.rows.filter((row) => row.values.commands === null);
    assert.equal(unplaced.length, 1);
    assert.equal(unplaced[0].count, 1);

    assert.match(String(storedRun.run.groups?.[0].message), /1 个用例没有解析出命令/);
    assert.ok(detail.production!.result.cross_item.every((claim) => !claim.statement.text.includes('个用例没有解析出命令')));
    await runHub.close();
    await w.close();
  });
});
