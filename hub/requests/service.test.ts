// The request service on its own: validated append-only writes, a deadline fixed on first creation, record-backed
// answers that never overwrite, and listing scoped by role, audience and the injected run-visibility callback.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { ConflictError, newId, type Principal } from '../records/api.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { openTestRecords, type TestRecordsKit } from '../testing/records.ts';
import { createRequestService, type RequestBody } from './api.ts';

let pg: TemporaryPostgres;
let kit: TestRecordsKit;
before(async () => {
  pg = await startPostgres();
  kit = await openTestRecords({ postgres: pg });
});
after(async () => {
  await kit?.close();
  await pg?.stop();
});

const NOW = new Date('2026-10-24T00:00:00.000Z');
const clock = () => NOW;

async function people(): Promise<{ admin: Principal; alice: Principal; bob: Principal }> {
  const admin = (await kit.principals.bootstrapAdmin('合成管理员')).user;
  return { admin, alice: await kit.principals.createUser(admin, '合成甲'), bob: await kit.principals.createUser(admin, '合成乙') };
}

let context: Awaited<ReturnType<typeof people>> | undefined;
const once = async () => (context ??= await people());

async function sourceRecord(label: string): Promise<string> {
  return (await kit.store.put({ kind: 'claim', schema: 'synthetic-source@1', provenance: 'declared', body: { label } })).digest;
}

function fields(audience: string, source: string): Omit<RequestBody, 'run' | 'pack_digest'> {
  return { kind: 'repair', audience, due: '2026-10-26T00:00:00.000Z', missing: '合成缺口：缺少版本号', next_action: '补上版本号后原样重交', source, code: 'missing_input' };
}

test('a write is validated, and the same problem again keeps its first deadline and record', async () => {
  const { alice } = await once();
  const requests = createRequestService(kit, clock);
  const source = await sourceRecord('write');
  const run = newId('run');
  const first = await requests.write({ ...fields(alice.id, source), run });
  assert.equal(first.kind, 'request');
  assert.equal(first.created_at, NOW.toISOString());
  const again = await requests.write({ ...fields(alice.id, source), run, due: '2026-12-31T00:00:00.000Z' });
  assert.equal(again.digest, first.digest, 'resubmitting the same problem returns the original record');
  assert.equal((await requests.inspect(first.digest))?.due, '2026-10-26T00:00:00.000Z', 'the deadline is not extended');
  const other = await requests.write({ ...fields(alice.id, source), run, missing: '合成缺口：缺少构建号' });
  assert.notEqual(other.digest, first.digest, 'a different missing fact is a different request');

  await assert.rejects(requests.write(fields(alice.id, source) as RequestBody), /binds a run or published pack/);
  await assert.rejects(requests.write({ ...fields(alice.id, source), run, missing: '   ' }), /concrete fact or next action/);
  await assert.rejects(requests.write({ ...fields(alice.id, source), run, next_action: '' }), /concrete fact or next action/);
  await assert.rejects(requests.write({ ...fields(alice.id, 'not-a-digest'), run }));
  await assert.rejects(requests.write({ ...fields(alice.id, source), run, extra: 1 } as RequestBody), 'unknown fields are refused');
});

test('an answer must reference a stored record, is idempotent and never overwritten', async () => {
  const { alice } = await once();
  const requests = createRequestService(kit, clock);
  const request = await requests.write({ ...fields(alice.id, await sourceRecord('answer')), pack_digest: 'b'.repeat(64) });
  const answer = await sourceRecord('the answering pack version');
  const later = await sourceRecord('another answer');

  await assert.rejects(requests.answer(request.digest, 'not-a-digest'));
  await assert.rejects(requests.answer(request.digest, 'c'.repeat(64)), /回答来源记录不存在/);
  await assert.rejects(requests.answer(answer, later), /请求记录不存在/, 'only a request record can be answered');
  assert.equal((await requests.inspect(request.digest))?.answered_by, null);

  await requests.answer(request.digest, answer);
  await requests.answer(request.digest, answer);
  const actions = await kit.store.find<{ action: string; component: string; inputs: string[] }>({ kind: 'action', key: 'runs.request.answer', value: request.digest, limit: 10 });
  assert.equal(actions.items.length, 1, 'answering again with the same source writes nothing');
  assert.equal(actions.items[0].body.component, 'requests@1');
  assert.deepEqual(actions.items[0].body.inputs, [`rec:${request.digest}`, `rec:${answer}`]);
  await assert.rejects(requests.answer(request.digest, later), (error: unknown) => error instanceof ConflictError && /不覆盖原回答/.test(error.message));

  const view = await requests.inspect(request.digest);
  assert.equal(view?.answered_by, answer);
  assert.equal(view?.record, request.digest);
  assert.equal(view?.missing, '合成缺口：缺少版本号', 'the request itself is unchanged');
  assert.equal(await requests.inspect('not-a-digest'), null);
  assert.equal(await requests.inspect(answer), null, 'a record of another kind is not a request');
});

test('listing is scoped: administrators see all, run requests follow the callback, pack requests their audience', async () => {
  const { admin, alice, bob } = await once();
  const visibleRun = newId('run');
  const hiddenRun = newId('run');
  const writer = createRequestService(kit, clock);
  const source = await sourceRecord('list');
  const onVisible = await writer.write({ ...fields(alice.id, source), run: visibleRun });
  const onHidden = await writer.write({ ...fields(alice.id, source), run: hiddenRun });
  const forAlice = await writer.write({ ...fields(alice.id, source), pack_digest: 'd'.repeat(64) });
  const ours = new Set([onVisible.digest, onHidden.digest, forAlice.digest]);
  const mine = (views: Array<{ record: string }>) => views.map((view) => view.record).filter((record) => ours.has(record)).sort();

  assert.deepEqual(mine(await writer.list(admin)), [...ours].sort());
  assert.deepEqual(mine(await writer.list(alice)), [forAlice.digest], 'without a run-visibility callback no run-bound request is listed');
  assert.deepEqual(mine(await writer.list(bob)), [], 'a pack-only request is visible only to its audience');

  const seen: Array<[string, string]> = [];
  const scoped = createRequestService(kit, clock, {
    canReadRun: async (by, run) => {
      seen.push([by.id, run]);
      return run === visibleRun;
    },
  });
  assert.deepEqual(mine(await scoped.list(bob)), [onVisible.digest]);
  assert.ok(seen.some(([by, run]) => by === bob.id && run === hiddenRun), 'every run-bound request is checked through the callback');
  assert.deepEqual(mine(await scoped.list(alice)), [onVisible.digest, forAlice.digest].sort());
  assert.deepEqual(mine(await scoped.list(alice, visibleRun)), [onVisible.digest], 'a run filter lists only that run');
  assert.deepEqual(mine(await scoped.all(hiddenRun)), [onHidden.digest], 'all() is the trusted unscoped read');
});
