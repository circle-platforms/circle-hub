import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { RunRecord } from '../../contracts/src/run.ts';
import { Database, createPool } from '../records/db.ts';
import { createTestParserRegistry } from '../testing/parsers.ts';
import { startPostgres } from '../testing/postgres.ts';
import { openTestRecords } from '../testing/records.ts';
import { createRunsService } from '../runs/engine/api.ts';
import { manifestDigest } from '../runs/api.ts';
import { FakeWorkflowStore } from '../runs/engine/testing/workflows.ts';
import { createKnowledge } from './api.ts';
import { BASE_CATALOG, FakeExternal, FakePacks, catalogXml, sandboxIsolation, writeProductPack } from './test-support.ts';
import { FROZEN_KNOWLEDGE_CONTRIBUTION } from './testing/frozen/knowledge-contribution.ts';
import { UPGRADE_BUILD, UPGRADE_CALL, restoreRecords, type RecordsDump } from './testing/frozen/upgrade-records.ts';

interface UpgradeFixture extends RecordsDump {
  written_by: { revision: string; pack: string; pack_digest: string };
  principals: { admin: string; user: string };
  product: { digest: string };
  run: string;
  submission: unknown;
  result: unknown;
  receipt: string;
  view: { status: string; contribution: Record<string, unknown> } & Record<string, unknown>;
}

const frozen = new URL('../../tests/fixtures/frozen/', import.meta.url);
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

test('a run and receipt persisted by the frozen Hub replay unchanged after upgrade', async t => {
  // The records were written by the Hub before the operation lease binding (generate-upgrade-records.ts); only the
  // current code reads them here.
  const fixture = JSON.parse(await readFile(new URL('upgrade-records.json', frozen), 'utf8')) as UpgradeFixture;
  const oldManifest = JSON.parse(await readFile(join(FROZEN_KNOWLEDGE_CONTRIBUTION.directory, 'pack.json'), 'utf8'));
  assert.equal(fixture.written_by.pack, FROZEN_KNOWLEDGE_CONTRIBUTION.ref);
  assert.equal(fixture.written_by.pack_digest, FROZEN_KNOWLEDGE_CONTRIBUTION.digest);
  assert.equal(manifestDigest(oldManifest), fixture.written_by.pack_digest);
  assert.equal(fixture.view.status, 'valid');
  assert.ok('statement' in fixture.view.contribution);

  const postgres = await startPostgres();
  t.after(() => postgres.stop());
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const db = new Database(createPool(kit.database, 1));
  try {
    await restoreRecords(db, kit.objects, fixture);
  } finally {
    await db.end();
  }
  const admin = await kit.principals.get(fixture.principals.admin);
  const user = await kit.principals.get(fixture.principals.user);
  assert.ok(admin && user);
  const directory = await mkdtemp(join(tmpdir(), 'operation-hub-upgrade-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const product = writeProductPack(directory);
  assert.equal(product.digest, fixture.product.digest);
  const packs = new FakePacks();
  packs.add(product);
  packs.readers.set(user.id, new Set([product.product.id]));
  const external = new FakeExternal(kit);
  external.set(UPGRADE_BUILD.sources.tree, { bytes: new TextEncoder().encode(catalogXml(BASE_CATALOG)), mediaType: 'application/xml' });
  const digests = async (kind: 'run' | 'validation_result') => (await kit.store.list({ kind, limit: 100 })).items.map((row: { digest: string }) => row.digest);
  const frozenDigests = (kind: 'run' | 'validation_result') => fixture.tables.find(table => table.name === 'records')!.rows.filter(row => row.kind === kind).map(row => row.digest);
  const runsBefore = await digests('run');
  const resultsBefore = await digests('validation_result');
  assert.deepEqual(runsBefore, frozenDigests('run'));
  assert.deepEqual(resultsBefore, frozenDigests('validation_result'));
  assert.equal(runsBefore.length, 1);
  assert.equal(resultsBefore.length, 1);

  const knowledge = createKnowledge({ records: kit, packs, external, parsers: createTestParserRegistry(), sandbox: { requireOsIsolation: await sandboxIsolation() }, admin });
  assert.deepEqual(plain(await knowledge.layers.contributions.readView(fixture.receipt, admin)), fixture.view);
  const upgradedWorkflows = new FakeWorkflowStore();
  await upgradedWorkflows.add(fileURLToPath(new URL('../../packs/workflow/knowledge-contribution/', import.meta.url)));
  const upgraded = createRunsService({ records: kit, packs, knowledge, external, workflows: upgradedWorkflows, parsers: createTestParserRegistry() });
  const reopened = await upgraded.getRun(admin, fixture.run);
  assert.equal(RunRecord.parse(reopened!.run).pack_digest, fixture.written_by.pack_digest);
  const replay = await upgraded.submitResult(admin, fixture.submission as Parameters<typeof upgraded.submitResult>[1], UPGRADE_CALL);
  assert.equal(replay.acceptance, 'accepted', JSON.stringify(replay.errors));
  assert.deepEqual(plain(replay.result), fixture.result);
  assert.deepEqual(plain(await knowledge.layers.contributions.readView(fixture.receipt, admin)), fixture.view);
  assert.deepEqual(await digests('run'), runsBefore);
  assert.deepEqual(await digests('validation_result'), resultsBefore);
});
