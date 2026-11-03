import { createTestParserRegistry as createDefaultRegistry } from '../testing/parsers.ts';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { RunDetail } from '../ports.ts';
import { formatKnowledgeRetract, knowledgeRetract } from '../knowledge/api.ts';
import { makeWorld, catalogXml, BASE_CATALOG } from '../knowledge/test-support.ts';
import { newId, type Principal, type RecordStore, type StoredRecord } from '../records/api.ts';
import { createRunsService } from '../runs/engine/api.ts';
import { osIsolationAvailable } from '../rules/api.ts';
import { FakeWorkflowStore } from '../runs/engine/testing/workflows.ts';
import { startPostgres } from '../testing/postgres.ts';
import type { CliContext, ServerDeps } from './api.ts';
import { adminCommands, runContributionEntries } from './cli-admin.ts';
import { UsageError } from './errors.ts';
import { callTool } from './tools.ts';

test('knowledge retract rejects a missing reason, a broken reason and no target before opening records', async () => {
  const command = adminCommands().find(item => item.name === 'knowledge');
  assert.ok(command);
  let opened = false;
  const ctx: CliContext = {
    io: { stdout() {}, stderr() {}, env: {}, cwd: tmpdir() },
    config() { opened = true; throw new Error('config'); },
    async records() { opened = true; throw new Error('records'); },
    async deps() { opened = true; throw new Error('deps'); },
    async actingAdmin() { opened = true; throw new Error('admin'); },
  };
  const entry = 'a'.repeat(64);
  const cases = [
    ['retract', '--entry', entry],
    ['retract', '--entry', entry, '--reason', '第一行\n第二行'],
    ['retract', '--reason', '合成撤回'],
    ['retract', '--object', '不是摘要', '--reason', '合成撤回'],
  ];
  for (const args of cases) {
    opened = false;
    await assert.rejects(() => command.run(args, ctx), (error: unknown) => error instanceof UsageError);
    assert.equal(opened, false, args.join(' '));
  }
});

test('knowledge retract --run reads the receipts of every accepted result the run detail names, not only the latest', async () => {
  const run = newId('run'), other = newId('run');
  const admin: Principal = { id: newId('usr'), name: '合成管理员', role: 'admin' };
  const [c1, c2, c3, c4] = ['1', '2', '3', '4'].map(digit => digit.repeat(64));
  const receipt = (records: string[]) => ({ submitted: records.length, stored: records.map((record, i) => ({ item: `item-${i}`, record })), not_stored: [] });
  const records = new Map<string, Pick<StoredRecord, 'kind' | 'body'>>([
    ['a'.repeat(64), { kind: 'validation_result', body: { run, acceptance: 'accepted', contributions: receipt([c1, c2]) } }],
    ['b'.repeat(64), { kind: 'validation_result', body: { run, acceptance: 'accepted', contributions: receipt([c2, c3]) } }],
    // A result of another run and a record that is no validation result are never taken.
    ['e'.repeat(64), { kind: 'validation_result', body: { run: other, acceptance: 'accepted', contributions: receipt([c4]) } }],
    ['f'.repeat(64), { kind: 'claim', body: { run, acceptance: 'accepted', contributions: receipt([c4]) } }],
  ]);
  const store = { get: async (digest: string) => records.get(digest) ?? null } as unknown as Pick<RecordStore, 'get'>;
  // An abandoned run: its latest result is the management projection, which carries no receipt.
  const detail = {
    submissions: [{ result: 'a'.repeat(64) }, { result: null }, { result: 'b'.repeat(64) }, { result: 'e'.repeat(64) }, { result: 'f'.repeat(64) }],
    latest: { record: 'd'.repeat(64), result: { run, acceptance: 'accepted', system_input: `rec:${'9'.repeat(64)}` } },
  } as unknown as RunDetail;
  const asked: string[] = [];
  const runs = { getRun: async (by: Principal, id: string) => { asked.push(`${by.id}:${id}`); return id === run ? detail : null; } };
  assert.deepEqual(await runContributionEntries(runs, store, admin, run), [c1, c2, c3]);
  assert.equal(await runContributionEntries(runs, store, admin, other), null, 'an absent run is left to the retraction screen');
  assert.deepEqual(asked, [`${admin.id}:${run}`, `${admin.id}:${other}`], 'the run is read as the acting administrator');
});

test('knowledge retract --run turns the contributions its run stored into entries the read side marks, and a repeat appends nothing', async t => {
  const postgres = await startPostgres(); t.after(() => postgres.stop());
  const w = await makeWorld(postgres); t.after(() => w.close());
  const call = { traceId: '4bf92f3577b34da6a3ce929d0e0e4736', sessionId: 'retraction-session' }, at = '2026-10-31T09:00:00.000Z';
  const build = { name: 'Rel_ACME_1_2_15', family: 'ACME', line: '1.2', base: 'Rel_ACME_1_2_15', platform: null, built_at: '2026-01-02T10:00:00.000Z', released_at: '2026-01-03T10:00:00.000Z', sources: { tree: 'site:tree:Rel_ACME_1_2_15' }, root: null };
  w.external.set(build.sources.tree, { bytes: new TextEncoder().encode(catalogXml(BASE_CATALOG)), mediaType: 'application/xml' });
  const produced = await w.knowledge.produceTree({ product: w.product, build });
  assert.ok(produced.ok, produced.reason ?? '');
  const root = produced.root!;
  const original = (await w.knowledge.store.composition(produced.composition!))!.sources[0].sha256;
  const workflows = new FakeWorkflowStore();
  await workflows.add(fileURLToPath(new URL('../../packs/workflow/knowledge-contribution/', import.meta.url)));
  // Isolated where the operating system offers it (macOS, the Linux isolation jobs); the unisolated synthetic path elsewhere.
  const service = createRunsService({ sandbox: { requireOsIsolation: await osIsolationAvailable() }, records: w.kit, packs: w.packs, knowledge: w.knowledge, external: w.external, workflows, parsers: createDefaultRegistry() });
  const manifest = await w.kit.artifacts.ingest({ bytes: new TextEncoder().encode(JSON.stringify({ items: [{ id: 'relation', title: 'relation' }] })), mediaType: 'application/json', origin: { upload: { session: call.sessionId, message: null } }, author: { user: w.admin.id }, provenanceType: 'declared', visibility: { readers: [w.admin.id], admins: true, packs: [], shareable: false } });
  const started = await service.startRun(w.admin, { pack: 'knowledge-contribution', product: 'Acme', build: build.name, inputs: { subject: { reference: `src:${manifest.body.sha256}` }, originals: { reference: `src:${original}` } } }, call);
  assert.equal(started.call_result, 'ok', JSON.stringify(started.errors));
  const run = started.run!.run;
  const answer = await service.submitResult(w.admin, { run, model: 'integration-synthetic@1', items: [{ item: 'relation', handling: 'handled', slots: { contribution: [{ code: 'relation', text: '合成显示与合成探测的说法相互矛盾', data: { root, path: '/commands/system/show', source: { reference: `tree:${root}/commands/system/show`, quote: 'show' }, relation: { kind: 'contradicts', other: { reference: `tree:${root}/commands/net/ping`, quote: 'ping' } } } }] } }] }, call);
  assert.equal(answer.result?.contributions?.stored.length, 1, JSON.stringify(answer.errors));
  const relation = answer.result!.contributions!.stored[0].record;
  const feeding = w.knowledge.feeding!, layer = w.knowledge.layers.contributions;

  // What the command adds to the entries: the receipt of the run, read through the runs service as the administrator.
  const entries = await runContributionEntries(service, w.kit.store, w.admin, run);
  assert.deepEqual(entries, [relation]);
  assert.equal(await runContributionEntries(service, w.kit.store, w.admin, newId('run')), null);

  const before = await w.kit.store.get(relation);
  const report = await knowledgeRetract(feeding, w.admin, { entries: entries!, runs: [run], objects: [], reason: '合成撤回运行', at });
  assert.deepEqual(report.appended.map(row => [row.kind, row.count]), [['entries', 1], ['runs', 1]]);
  assert.deepEqual(await w.kit.store.get(relation), before);
  const view = await layer.readView(relation, w.admin);
  assert.equal(view?.status, 'grounds_withdrawn');
  assert.equal(view?.note, '这条回注本身已被管理员撤回；历史引文仍保留');

  // The rec: read of get_nodes shows the same note as the node view.
  const deps = { records: w.kit, runs: service, knowledge: w.knowledge, parsers: createDefaultRegistry() } as unknown as ServerDeps;
  const read = await callTool(deps, { principal: w.admin, context: { traceId: call.traceId, sessionId: null, adminNote: () => {} }, state: { method: 'tools/call', tool: 'get_nodes', args: {}, started: 0, runId: null, callResult: null, acceptance: null, errorCode: null, notes: [] } }, 'get_nodes', { reference: `rec:${relation}` });
  const content = read.structuredContent.content as { note?: string };
  assert.match(content.note ?? '', /这条回注本身已被管理员撤回；历史引文仍保留/);

  const again = await knowledgeRetract(feeding, w.admin, { entries: (await runContributionEntries(service, w.kit.store, w.admin, run))!, runs: [run], objects: [], reason: '合成撤回运行', at });
  assert.deepEqual(again.appended, []);
  assert.match(formatKnowledgeRetract(again)[0], /^这些目标已撤回（撤回记录 [0-9a-f]{12}、[0-9a-f]{12}），没有追加$/);
});
