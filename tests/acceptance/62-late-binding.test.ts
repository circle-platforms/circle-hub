// Acceptance 62 (decision 179; model 83: W06 R[6] exception and R[7], B03 R[0], W08): a run input bound after the start,
// through the real Hub, its pack registry and the MCP client. A synthetic stage workflow (incremental submissions) records
// each case; a synthetic consumer workflow binds a stage run after the start and, at every validation, refreshes each item
// from that run's latest accepted result. The consumer run starts before the stage run accepted anything. With case 1
// accepted upstream, the consumer's submission is checked on case 1 and leaves case 2 unknown (awaiting_step) without a
// repair round; once the stage run accepts case 2, the same submission sent again is checked again and both cases are
// satisfied; GET /run-export/<run>/late shows both. Temporary PostgreSQL, synthetic packs and data only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { ValidationResult } from '../../contracts/src/validation.ts';
import { RunLateExport } from '../../contracts/src/run.ts';
import { actionsOf } from '../../hub/runs/engine/store.ts';
import { sandboxSkip } from '../../hub/runs/engine/testing/harness.ts';
import { ITEM, casesBytes, consumePack, consumeSubmission, stagePack, stageSubmission } from '../../hub/runs/engine/testing/late-packs.ts';
import { writePack } from '../../hub/runs/engine/testing/packs.ts';
import { createTestHub, type TestHub, type TestUser } from '../../hub/server/testing-real.ts';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { connect, type McpClient } from './support/mcp.ts';

const skip = await sandboxSkip();
let postgres: TemporaryPostgres;
let hub: TestHub;
let writer: TestUser;
let client: McpClient;
let packRoot: string;

before(async () => {
  if (skip) return;
  postgres = await startPostgres();
  packRoot = await mkdtemp(join(tmpdir(), 'circle-hub-accept-late-'));
  const packs = [await writePack(packRoot, stagePack()), await writePack(packRoot, consumePack())];
  hub = await createTestHub({ postgres, repositoryPacks: false, stubs: false, packs });
  writer = await hub.createUser('合成编写者');
  for (const pack of ['toy-stage', 'toy-consume']) await hub.assignPack(writer.principal, pack);
  client = await connect(hub, writer.token, 'sess-late-62');
});
after(async () => {
  await client?.close().catch(() => undefined);
  await hub?.close();
  await postgres?.stop();
  if (packRoot) await rm(packRoot, { recursive: true, force: true });
});

const plan = (result: ValidationResult, id: string) => Object.values(result.partitions).flat().find((row) => row.item === id)!.requirements.find((row) => row.requirement === 'plan')!;

test('a consumer run binds a stage run after the start and follows its accepted results case by case', { skip }, async () => {
  const cases = await client.upload(casesBytes(), 'synthetic-cases.json');
  const stage = await client.call('start_run', { pack: 'toy-stage', inputs: { cases: { reference: cases } } });
  assert.equal(stage.out.call_result, 'ok', stage.text);
  const stageRun = stage.out.run!.run;

  // The consumer run starts while the stage run has accepted nothing: only the run is frozen.
  const consume = await client.call('start_run', { pack: 'toy-consume', inputs: { cases: { reference: cases }, stage: { run: stageRun } } });
  assert.equal(consume.out.call_result, 'ok', consume.text);
  const run = consume.out.run!;
  assert.deepEqual(run.late_inputs, [{ slot: 'stage', run: stageRun }]);
  assert.equal(run.sources.some((source) => source.slot === 'stage'), false);

  // Upstream accepts case 1 only.
  const first = await client.call('submit_result', stageSubmission(stageRun, [ITEM.one]));
  assert.equal(first.out.acceptance, 'accepted', first.text);
  const firstRecord = (await hub.hub.runs.getResult(writer.principal, stageRun))!.record;

  // The consumer's submission is checked on case 1 and waits on case 2, with no repair round charged.
  const submission = consumeSubmission(run.run);
  const checked = await client.call('submit_result', submission);
  assert.equal(checked.out.acceptance, 'accepted', checked.text);
  const one = checked.out.result!;
  assert.deepEqual(one.locks.late?.inputs, [{ slot: 'stage', run: stageRun, reference: 'rec:' + firstRecord }]);
  assert.equal(plan(one, ITEM.one).status, 'satisfied');
  assert.equal(plan(one, ITEM.two).status, 'pending');
  assert.equal(plan(one, ITEM.two).layers[0].terminal, 'incomplete');
  assert.equal(plan(one, ITEM.two).layers[0].reason, 'awaiting_step');
  const waiting = one.errors.find((error) => error.item === ITEM.two && error.requirement === 'plan');
  assert.equal(waiting?.code, 'awaiting_step');
  assert.equal(waiting?.rounds_left, 2);
  const validations = (await actionsOf(hub.records.store, run.run)).filter((action) => action.body.action === 'validate' && (action.body.detail as { submission?: string }).submission === one.submission);
  assert.deepEqual(validations.map((action) => (action.body.detail as { repair?: string[] }).repair), [[]], 'waiting on the stage run is not a repair round');

  // Upstream accepts case 2; the same submission, sent again as it was, is checked again against the new stage result.
  const second = await client.call('submit_result', stageSubmission(stageRun, [ITEM.one, ITEM.two]));
  assert.equal(second.out.acceptance, 'accepted', second.text);
  const secondRecord = (await hub.hub.runs.getResult(writer.principal, stageRun))!.record;
  assert.notEqual(secondRecord, firstRecord);
  const again = await client.call('submit_result', submission);
  assert.equal(again.out.acceptance, 'accepted', again.text);
  const two = again.out.result!;
  assert.equal(two.submission, one.submission, 'the same submission');
  assert.deepEqual(two.locks.late?.inputs, [{ slot: 'stage', run: stageRun, reference: 'rec:' + secondRecord }]);
  assert.equal(plan(two, ITEM.one).status, 'satisfied');
  assert.equal(plan(two, ITEM.two).status, 'satisfied');
  assert.equal(two.rounds.used, 0);

  // The late export shows both cases as the stage run's latest accepted result says them.
  const answer = await fetch(`${hub.url}/run-export/${run.run}/late`, { headers: { authorization: `Bearer ${writer.token}` } });
  assert.equal(answer.status, 200, await answer.clone().text());
  const bytes = Buffer.from(await answer.arrayBuffer());
  assert.equal(answer.headers.get('content-digest'), `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`);
  const late = RunLateExport.parse(JSON.parse(bytes.toString('utf8')));
  assert.equal(late.run, run.run);
  assert.deepEqual(late.late, two.locks.late, 'the export resolves exactly what the last validation resolved');
  assert.deepEqual(late.items.map((row) => row.id), [ITEM.one, ITEM.two]);
  for (const row of late.items) assert.equal((row.late as { stage?: { status?: string } }).stage?.status, 'satisfied');

  // A run that binds nothing after the start has no late export.
  const none = await fetch(`${hub.url}/run-export/${stageRun}/late`, { headers: { authorization: `Bearer ${writer.token}` } });
  assert.equal(none.status, 404);
  assert.match(await none.text(), /运行没有开运行后再绑定的输入/);
});
