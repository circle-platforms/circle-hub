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
import { HISTORICAL_CAPTURE_TIME } from './contributions.ts';
import { packSchema } from '../runs/engine/slots.ts';
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
// The plain-text upload the frozen Hub noted ("合成旧回显：状态正常").
const TEXT_UPLOAD = '53e0ef88f65189cdc6e03b0ef5f4bec73b403cf21a632aa1c9dcd7a44bb34d7f';
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

/** Whether a pack's slot schema admits a value as its fed-note entry. */
async function noteSchema(slots: URL | string): Promise<(value: unknown) => boolean> {
  const file = JSON.parse(await readFile(slots, 'utf8')) as { item: { contribution: { data: { properties: { feeding: { anyOf: Array<{ properties?: { schema?: { const?: string } } }> } } } } } };
  const entry = file.item.contribution.data.properties.feeding.anyOf.find(row => row.properties?.schema?.const === 'fed-note@1');
  assert.ok(entry);
  const compiled = packSchema(entry as Record<string, unknown>);
  assert.ok(compiled.ok);
  return (value: unknown) => compiled.schema.safeParse(value).success;
}

test('a run and receipt persisted by the frozen Hub replay unchanged after upgrade', async t => {
  // The records were written by the Hub before the operation device fields (generate-upgrade-records.ts); only the
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
  // The stored record is unchanged; only its derived view now says the source of its `at` is unknown (round-five review, item 8).
  assert.equal('captured_at_declared' in (fixture.view.contribution as { feeding: object }).feeding, false);
  const upgradedView = { ...fixture.view, note: HISTORICAL_CAPTURE_TIME };
  assert.deepEqual(plain(await knowledge.layers.contributions.readView(fixture.receipt, admin)), upgradedView);
  // A note the frozen Hub wrote for an upload keeps its `at` and can still be annotated exactly as written (round five, item 5).
  const legacyNote = fixture.tables.find(table => table.name === 'records')!.rows.flatMap(row => {
    const body = (typeof row.body === 'string' ? JSON.parse(row.body) : row.body) as { statement?: { data?: { feeding?: Record<string, unknown> } } };
    const feeding = body.statement?.data?.feeding;
    return feeding?.schema === 'fed-note@1' && (feeding.source as { bytes: string }).bytes === TEXT_UPLOAD ? [feeding] : [];
  })[0];
  assert.ok(legacyNote && 'at' in legacyNote && !('captured_at_declared' in legacyNote));
  const annotated = { ...legacyNote, classification: [{ value: 'ticket', quote: { reference: `src:${TEXT_UPLOAD}/text@1/l/1`, text: '合成旧回显' } }] };
  assert.ok(await knowledge.feeding!.prepare(admin, annotated as never, {}), 'the uploader annotates the note as written');
  await assert.rejects(() => knowledge.feeding!.prepare(admin, { ...annotated, at: '2026-10-28T22:53:09.000Z' } as never, {}), /上传原件|改写/);
  const upgradedWorkflows = new FakeWorkflowStore();
  await upgradedWorkflows.add(fileURLToPath(new URL('../../packs/workflow/knowledge-contribution/', import.meta.url)));
  const upgraded = createRunsService({ records: kit, packs, knowledge, external, workflows: upgradedWorkflows, parsers: createTestParserRegistry() });
  const reopened = await upgraded.getRun(admin, fixture.run);
  assert.equal(RunRecord.parse(reopened!.run).pack_digest, fixture.written_by.pack_digest);
  const replay = await upgraded.submitResult(admin, fixture.submission as Parameters<typeof upgraded.submitResult>[1], UPGRADE_CALL);
  assert.equal(replay.acceptance, 'accepted', JSON.stringify(replay.errors));
  assert.deepEqual(plain(replay.result), fixture.result);
  assert.deepEqual(plain(await knowledge.layers.contributions.readView(fixture.receipt, admin)), upgradedView);
  assert.deepEqual(await digests('run'), runsBefore);
  assert.deepEqual(await digests('validation_result'), resultsBefore);

  // The run stays locked to the frozen pack, which stays loadable as a published version does: a note in the new shape is
  // refused at that pack's own slot schema, and the current pack's schema is not used for it (round-six review, item 5).
  await upgradedWorkflows.add(FROZEN_KNOWLEDGE_CONTRIBUTION.directory);
  type Contribution = { code: string; text: string; data: Record<string, unknown> };
  const submitted = fixture.submission as { run: string; model: string; items: Array<{ item: string; handling: string; slots: { contribution: Contribution[] } }> };
  const item = submitted.items[0]!;
  const contribution = item.slots.contribution[0]!;
  // The note the current Hub writes for a new upload, carried into a proposal as written (round-seven review, item 5).
  const fresh = await kit.artifacts.ingest({ bytes: new TextEncoder().encode('合成新回显\n'), mediaType: 'text/plain', origin: { upload: { session: 'synthetic-upgrade-fresh', message: null } }, author: { user: admin.id }, provenanceType: 'declared', visibility: { readers: [admin.id], admins: true, packs: [], shareable: true }, readTier: 'model_readable' });
  await knowledge.feeding!.upload(admin, fresh);
  const written = (await knowledge.feeding!.entries(admin, admin.id)).map(row => row.body as Record<string, unknown>).find(body => (body.source as { artifact?: unknown }).artifact === fresh.digest);
  assert.ok(written && 'received_at' in written && !('at' in written), JSON.stringify(written));
  assert.equal((await noteSchema(new URL('../../packs/workflow/knowledge-contribution/slots.schema.json', import.meta.url)))(written), true, 'the current pack carries it');
  assert.equal((await noteSchema(join(FROZEN_KNOWLEDGE_CONTRIBUTION.directory, 'slots.schema.json')))(written), false, 'the frozen pack does not');
  const newShape = { ...written, classification: [{ value: 'ticket', quote: { reference: `src:${fresh.body.sha256}/text@1/l/1`, text: '合成新回显' } }] };
  const refused = await upgraded.submitResult(admin, { ...submitted, items: [{ ...item, slots: { contribution: [{ ...contribution, text: '新结构说明', data: { ...contribution.data, feeding: newShape } }] } }] } as Parameters<typeof upgraded.submitResult>[1], UPGRADE_CALL);
  assert.notEqual(refused.acceptance, 'accepted', JSON.stringify(refused));
  const violation = refused.errors.find(error => error.code === 'SUBMISSION_SCHEMA_VIOLATION' && error.path === '/items/0/slots/contribution/0/data/feeding');
  assert.ok(violation, JSON.stringify(refused.errors));
  assert.deepEqual(await digests('run'), runsBefore);
});

test('a run locked to the frozen pack carries notes as the frozen Hub wrote them, and refuses a note in the new shape (round-five review, item 5)', async () => {
  const frozenNote = await noteSchema(join(FROZEN_KNOWLEDGE_CONTRIBUTION.directory, 'slots.schema.json'));
  const currentNote = await noteSchema(new URL('../../packs/workflow/knowledge-contribution/slots.schema.json', import.meta.url));
  const base = { schema: 'fed-note@1', object: TEXT_UPLOAD, product: null, root: null, path: null, source: { system: 'upload', bytes: TEXT_UPLOAD }, by: 'usr_01m62bf7k7fvab10tqtrydw0qp', run: null };
  const written = { ...base, at: '2026-10-28T22:53:08.801Z' };
  const undeclared = { ...base, source: { ...base.source, artifact: 'a'.repeat(64) }, captured_at_declared: false, received_at: '2026-10-28T22:53:08.808Z' };
  assert.equal(frozenNote(written), true, 'a note the frozen Hub wrote');
  assert.equal(currentNote(written), true);
  // A run started before the upgrade keeps its pack: it is refused at its slot schema rather than given a note it cannot
  // carry. Its remedy is a new run under the current pack (the 1.3.14 notes of packs/workflow/knowledge-contribution/README.md).
  assert.equal(frozenNote(undeclared), false, 'the frozen pack requires `at` and allows no other time field');
  assert.equal(currentNote(undeclared), true);
});
