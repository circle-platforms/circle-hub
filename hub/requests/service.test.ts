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

/** An answer appended directly, the way criterion changes append further answers to one request. */
async function appendAnswer(request: string, answer: string, detail: Record<string, unknown> = { request, answer }): Promise<void> {
  const at = NOW.toISOString();
  await kit.store.put({ kind: 'action', schema: 'action@1', provenance: 'observed', created_at: at, body: { action: 'validate', run: null, item: null, inputs: [`rec:${request}`, `rec:${answer}`], component: 'synthetic-answers@1', lease: null, started_at: at, ended_at: at, result: 'completed', error_code: null, acceptance: null, codes: [], detail }, index: [{ key: 'runs.request.answer', value: request }] });
}

/** The record store with its `find` calls counted by index key. */
function countingFinds(): { store: TestRecordsKit['store']; finds: string[] } {
  const finds: string[] = [];
  const store = new Proxy(kit.store, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === 'find') return (query: { key?: string }, tx?: unknown) => { finds.push(query.key ?? ''); return (value as (...args: unknown[]) => unknown).call(target, query, tx); };
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { store, finds };
}

test('a listing reads the answers of a page at once and keeps the newest answer of each request', async () => {
  const { alice } = await once();
  const run = newId('run');
  const made = [];
  for (let i = 0; i < 6; i++) made.push(await createRequestService(kit, clock).write({ ...fields(alice.id, await sourceRecord(`page-${i}`)), run, missing: `合成缺口：第 ${i} 项` }));
  const first = await sourceRecord('answer-first');
  const second = await sourceRecord('answer-second');
  await createRequestService(kit, clock).answer(made[0]!.digest, first);
  await appendAnswer(made[1]!.digest, first);
  await appendAnswer(made[1]!.digest, second);
  const counted = countingFinds();
  const listed = new Map((await createRequestService({ store: counted.store }, clock).all(run)).map((view) => [view.record, view.answered_by]));
  assert.equal(listed.get(made[0]!.digest), first);
  assert.equal(listed.get(made[1]!.digest), second, 'the newest of two answers, as the lookup per request read it');
  for (const request of made.slice(2)) assert.equal(listed.get(request.digest), null);
  assert.equal(counted.finds.filter((key) => key === 'runs.request.answer').length, 0, 'the answers of the page are read at once');
});

test('an answer without its request in the detail is still found, by the lookup per request', async () => {
  const { alice } = await once();
  const run = newId('run');
  const request = await createRequestService(kit, clock).write({ ...fields(alice.id, await sourceRecord('legacy-answer')), run });
  const answer = await sourceRecord('legacy-answer-source');
  await appendAnswer(request.digest, answer, { answer });
  const counted = countingFinds();
  const [view] = await createRequestService({ store: counted.store }, clock).all(run);
  assert.equal(view?.answered_by, answer);
  assert.ok(counted.finds.includes('runs.request.answer'), 'the page fell back to the lookup per request');
});

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

test('a read of a scope gives the requests of those runs and packs and those records, once each, with their answers', async () => {
  const { alice } = await once();
  const writer = createRequestService(kit, clock);
  const [one, two, other] = [newId('run'), newId('run'), newId('run')], pack = 'c'.repeat(64);
  const bound = await writer.write({ ...fields(alice.id, await sourceRecord('scope-one')), run: one });
  const both = await writer.write({ ...fields(alice.id, await sourceRecord('scope-both')), run: two, pack_digest: pack });
  const packOnly = await writer.write({ ...fields(alice.id, await sourceRecord('scope-pack')), pack_digest: pack });
  const outside = await writer.write({ ...fields(alice.id, await sourceRecord('scope-outside')), run: other });
  const answer = await sourceRecord('scope-answer');
  await writer.answer(packOnly.digest, answer);
  const records = (views: Array<{ record: string }>) => views.map((view) => view.record).sort();
  assert.deepEqual(records(await writer.within({ runs: [one, two], packs: [pack] })), [bound.digest, both.digest, packOnly.digest].sort(), 'a request in two parts of the scope comes once');
  assert.deepEqual(records(await writer.within({ records: [outside.digest, answer] })), [outside.digest], 'a named record that is no request is left out');
  assert.equal((await writer.within({ packs: [pack] })).find((view) => view.record === packOnly.digest)?.answered_by, answer);
  assert.deepEqual(await writer.within({}), []);
});
