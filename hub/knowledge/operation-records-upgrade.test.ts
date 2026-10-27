import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RunRecord } from '../../contracts/src/run.ts';
import { createTestParserRegistry } from '../testing/parsers.ts';
import { startPostgres } from '../testing/postgres.ts';
import { createRunsService } from '../runs/engine/api.ts';
import { manifestDigest } from '../runs/api.ts';
import { FakeWorkflowStore } from '../runs/engine/testing/workflows.ts';
import { createKnowledge } from './api.ts';

const call = { traceId: '4bf92f3577b34da6a3ce929d0e0e4736', sessionId: 'operation-upgrade-replay' };

test('a run and receipt persisted by the frozen Hub replay unchanged after upgrade', async t => {
  const revision = '886d9f4c8a04630fcb70257becbec0589684500c';
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'operation-hub-upgrade-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  execFileSync('tar', ['-x', '-C', directory], { input: execFileSync('git', ['archive', revision], { cwd: repository, maxBuffer: 64 * 1024 * 1024 }) });
  await symlink(join(repository, 'node_modules'), join(directory, 'node_modules'), 'dir');
  const load = (path: string) => import(pathToFileURL(join(directory, path)).href);
  const support = await load('hub/knowledge/test-support.ts');
  const engine = await load('hub/runs/engine/api.ts');
  const workflowsModule = await load('hub/runs/engine/testing/workflows.ts');
  const parsers = await load('hub/testing/parsers.ts');
  const postgres = await startPostgres();
  t.after(() => postgres.stop());
  const w = await support.makeWorld(postgres);
  t.after(() => w.close());
  const build = { name: 'Rel_ACME_1_2_15', family: 'ACME', line: '1.2', base: 'Rel_ACME_1_2_15', platform: null, built_at: '2026-01-02T10:00:00.000Z', released_at: '2026-01-03T10:00:00.000Z', sources: { tree: 'site:tree:Rel_ACME_1_2_15' }, root: null };
  w.external.set(build.sources.tree, { bytes: new TextEncoder().encode(support.catalogXml(support.BASE_CATALOG)), mediaType: 'application/xml' });
  const produced = await w.knowledge.produceTree({ product: w.product, build });
  assert.ok(produced.ok, produced.reason ?? '');
  const workflows = new workflowsModule.FakeWorkflowStore();
  const oldPack = join(directory, 'packs/workflow/knowledge-contribution');
  const oldManifest = JSON.parse(await readFile(join(oldPack, 'pack.json'), 'utf8'));
  await workflows.add(oldPack);
  const oldService = engine.createRunsService({ records: w.kit, packs: w.packs, knowledge: w.knowledge, external: w.external, workflows, parsers: parsers.createTestParserRegistry() });
  const manifest = await w.kit.artifacts.ingest({ bytes: new TextEncoder().encode(JSON.stringify({ items: [{ id: 'assertion', title: 'assertion' }] })), mediaType: 'application/json', origin: { upload: { session: 'operation-upgrade-replay', message: null } }, author: { user: w.admin.id }, provenanceType: 'declared', visibility: { readers: [w.admin.id], admins: true, packs: [], shareable: false } });
  const echo = '合成旧回显：状态正常\n';
  const captured = await w.kit.artifacts.ingest({ bytes: new TextEncoder().encode(echo), mediaType: 'text/plain', origin: { upload: { session: 'operation-upgrade-replay', message: null } }, author: { user: w.admin.id }, provenanceType: 'client_captured', visibility: { readers: [w.admin.id], admins: true, packs: [], shareable: false } });
  const composition = await w.knowledge.store.composition(produced.composition!);
  const tree = composition!.sources[0].sha256;
  const started = await oldService.startRun(w.admin, { pack: 'knowledge-contribution', product: 'Acme', build: build.name, inputs: { subject: { reference: `src:${manifest.body.sha256}` }, originals: [{ reference: `src:${tree}` }, { reference: `src:${captured.body.sha256}` }] } }, call);
  assert.equal(started.call_result, 'ok', JSON.stringify(started.errors));
  const run = RunRecord.parse((await oldService.getRun(w.admin, started.run!.run))!.run);
  assert.equal(run.pack_digest, manifestDigest(oldManifest));
  const submission = {
    run: run.run, model: 'integration-synthetic@1',
    items: [{ item: 'assertion', handling: 'handled', slots: { contribution: [{ code: 'assertion', text: '冻结旧记录', data: {
      root: produced.root!, path: '/commands/system/show',
      source: { reference: `src:${captured.body.sha256}/text@1/l/1`, quote: '合成旧回显' },
      feeding: { schema: 'fed-observation@1', product: run.product, root: produced.root!, path: '/commands/system/show', source: { system: 'upload', bytes: captured.body.sha256 }, action: '冻结旧操作', result: { reference: `src:${captured.body.sha256}/text@1/l/1`, text: '合成旧回显' } },
    } }] } }],
  };
  const accepted = await oldService.submitResult(w.admin, submission, call);
  assert.equal(accepted.acceptance, 'accepted', JSON.stringify(accepted.errors));
  const receipt = accepted.result!.contributions!.stored[0]!;
  const oldView = await w.knowledge.layers.contributions.readView(receipt.record, w.admin);
  assert.ok(oldView && 'statement' in oldView.contribution);
  assert.equal(oldView.status, 'valid');
  const runsBefore = (await w.kit.store.list({ kind: 'run', limit: 100 })).items.map((row: {digest:string}) => row.digest);
  const resultsBefore = (await w.kit.store.list({ kind: 'validation_result', limit: 100 })).items.map((row: {digest:string}) => row.digest);

  const knowledge = createKnowledge({ records: w.kit, packs: w.packs, external: w.external, parsers: createTestParserRegistry(), sandbox: w.knowledge.__context.sandbox, admin: w.admin });
  const upgradedWorkflows = new FakeWorkflowStore();
  await upgradedWorkflows.add(fileURLToPath(new URL('../../packs/workflow/knowledge-contribution/', import.meta.url)));
  const upgraded = createRunsService({ records: w.kit, packs: w.packs, knowledge, external: w.external, workflows: upgradedWorkflows, parsers: createTestParserRegistry() });
  const reopened = await upgraded.getRun(w.admin, run.run);
  assert.equal(RunRecord.parse(reopened!.run).pack_digest, run.pack_digest);
  const replay = await upgraded.submitResult(w.admin, submission, call);
  assert.equal(replay.acceptance, 'accepted', JSON.stringify(replay.errors));
  assert.deepEqual(replay.result, accepted.result);
  assert.deepEqual(await knowledge.layers.contributions.readView(receipt.record, w.admin), oldView);
  assert.deepEqual((await w.kit.store.list({ kind: 'run', limit: 100 })).items.map((row: {digest:string}) => row.digest), runsBefore);
  assert.deepEqual((await w.kit.store.list({ kind: 'validation_result', limit: 100 })).items.map((row: {digest:string}) => row.digest), resultsBefore);
});
