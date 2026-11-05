// Scheduled rounds keep every effect of a pass over everything while reading only what changed: what arrives between rounds,
// what falls due with no record at all, and what depends on accounts, which leave no record. No pack function runs here,
// except in the one test that guards on the sandbox.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createRequestService, type RequestView } from '../../requests/api.ts';
import type { Principal, StoredRecord, Transaction } from '../../records/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { createTestParserRegistry } from '../../testing/parsers.ts';
import type { RunRecord } from '../../../contracts/src/run.ts';
import { createRunsService } from './service.ts';
import { maintainRuns, FULL_PASS_MS } from './maintenance.ts';
import { newMaintenanceMemory } from './maintenance-memory.ts';
import { actionsOf, putAction, putRun } from './store.ts';
import { openHarness, sandboxSkip } from './testing/harness.ts';
import { engineOn, FAR_AHEAD, quietRun, requestOf, storeQuietRun } from './testing/maintenance.ts';
import { standardDocument, toyMap } from './testing/mindmap.ts';
import { openRetryHarness } from './testing/retry-harness.ts';

let pg: TemporaryPostgres;
const skip = await sandboxSkip();
before(async () => { pg = await startPostgres(); });
after(async () => { await pg?.stop(); });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A harness on a clock that stands still, a memory of its own, and a round that never turns into a pass over everything. */
async function world(t: { after: (fn: () => Promise<void>) => void }) {
  const h = await openHarness(pg);
  t.after(() => h.close());
  let clock = Date.parse('2026-10-22T09:00:00.000Z');
  const now = () => new Date(clock);
  const ctx = engineOn(h, now), memory = newMaintenanceMemory();
  const requests = createRequestService(h.kit, now);
  return {
    h, ctx, memory, requests,
    at: (offset: number) => new Date(clock + offset).toISOString(),
    advance: (ms: number) => { clock += ms; },
    /** One scheduled round; after the first, `fullAt` keeps the half-hourly pass out, so a test sees the round alone. */
    round: async (stop?: () => boolean) => { if (memory.fullAt !== null) memory.fullAt = clock; await maintainRuns(ctx, stop, memory); },
    /** The first round, which visits everything, and those that take in what it wrote. */
    settle: async () => { for (let n = 0; n < 4; n++) { if (memory.fullAt !== null) memory.fullAt = clock; await maintainRuns(ctx, undefined, memory); } },
    position: () => h.kit.store.watermark!(),
  };
}

const escalationsOf = (requests: readonly RequestView[], source: string) => requests.filter((request) => request.source === source);

test('a request that falls due with no new record is escalated by the first round after its deadline', async (t) => {
  const w = await world(t);
  const run = await storeQuietRun(w.h);
  const question = await w.requests.write(requestOf(run, w.h.alice.id, w.at(10 * MINUTE), '合成十分钟后到期'));
  await w.settle();
  const quiet = await w.position();
  w.advance(9 * MINUTE);
  await w.round();
  assert.equal(await w.position(), quiet, 'nothing is written while the deadline is ahead');
  w.advance(2 * MINUTE);
  await w.round();
  const [escalation, ...others] = escalationsOf(await w.requests.all(run.body.run), question.digest);
  assert.ok(escalation, 'the deadline passed and no record said so');
  assert.equal(others.length, 0);
  assert.equal(escalation.audience, w.h.admin.id);
});

test('a request written while the rounds run falls due on time too, as does a run deadline', async (t) => {
  const w = await world(t);
  const run = await storeQuietRun(w.h);
  await w.settle();
  const question = await w.requests.write(requestOf(run, w.h.alice.id, w.at(5 * MINUTE), '合成稍后写入'));
  const later = await storeQuietRun(w.h, { submission_due: w.at(5 * MINUTE) });
  await w.round();
  await w.round();
  assert.equal(escalationsOf(await w.requests.all(run.body.run), question.digest).length, 0);
  w.advance(6 * MINUTE);
  await w.round();
  assert.equal(escalationsOf(await w.requests.all(run.body.run), question.digest).length, 1);
  assert.ok((await w.requests.all(later.body.run)).some((request) => request.kind === 'disposition' && request.audience === w.h.alice.id), 'the run past its submission deadline was delivered as expired');
});

test('an overdue request that arrives between rounds is escalated by the next one, also one bound to a pack alone', async (t) => {
  const w = await world(t);
  const run = await storeQuietRun(w.h);
  await w.settle();
  const bound = await w.requests.write(requestOf(run, w.h.alice.id, w.at(-MINUTE), '合成已逾期'));
  const { run: _run, ...fields } = requestOf(run, w.h.alice.id, w.at(-MINUTE), '合成只绑定包');
  const packOnly = await w.requests.write({ ...fields, pack_digest: 'a'.repeat(64) });
  await w.round();
  const all = await w.requests.all();
  assert.equal(escalationsOf(all, bound.digest).length, 1);
  const [escalation] = escalationsOf(all, packOnly.digest);
  assert.equal(escalation?.pack_digest, 'a'.repeat(64));
  assert.equal(escalation?.run, undefined);
});

test('an answer that arrives between rounds reaches the escalations of its request, along the whole chain', async (t) => {
  const w = await world(t);
  const run = await storeQuietRun(w.h);
  const question = await w.requests.write(requestOf(run, w.h.alice.id, w.at(-MINUTE), '合成原请求'));
  await w.settle();
  const [first] = escalationsOf(await w.requests.all(), question.digest);
  // The escalation's administrator goes: it advances to the next one.
  await w.h.kit.principals.setRole(w.h.admin, w.h.bob.id, 'admin');
  await w.h.kit.principals.setDisabled(w.h.bob, w.h.admin.id, true);
  w.advance(25 * HOUR);
  await w.round();
  const [second] = escalationsOf(await w.requests.all(), first.record);
  assert.equal(second?.audience, w.h.bob.id);
  await w.requests.answer(question.digest, run.digest);
  await w.round();
  const all = await w.requests.all();
  assert.equal(all.find((request) => request.record === first.record)!.answered_by, run.digest);
  assert.equal(all.find((request) => request.record === second.record)!.answered_by, run.digest);
});

test('an account change leaves no record and still moves the requests that depend on it, in the next round', async (t) => {
  const w = await world(t);
  const run = await storeQuietRun(w.h);
  const question = await w.requests.write(requestOf(run, w.h.alice.id, w.at(-MINUTE), '合成原请求'));
  await w.settle();
  const [escalation] = escalationsOf(await w.requests.all(), question.digest);
  w.advance(25 * HOUR);
  await w.round();
  assert.equal(escalationsOf(await w.requests.all(), escalation.record).length, 0, 'an escalation naming an active administrator stays');
  await w.h.kit.principals.setRole(w.h.admin, w.h.bob.id, 'admin');
  await w.h.kit.principals.setDisabled(w.h.bob, w.h.admin.id, true);
  const before = await w.position();
  await w.round();
  assert.equal(escalationsOf(await w.requests.all(), escalation.record)[0]?.audience, w.h.bob.id);
  assert.ok(await w.position() > before);
  // A new ordinary account changes no request's next step, so it costs no sweep.
  await w.round();
  await w.round();
  let sweeps = 0;
  const { list } = w.h.kit.store;
  w.h.kit.store.list = ((query: { kind: string }, tx?: Transaction) => { if (query.kind === 'request') sweeps++; return list.call(w.h.kit.store, query as never, tx); }) as typeof list;
  t.after(() => { w.h.kit.store.list = list; });
  await w.h.kit.principals.createUser(w.h.bob, '合成新成员');
  await w.round();
  assert.equal(sweeps, 0);
});

test('a pack repair answered between rounds reaches the runs of the old version, and a run started on it later', async (t) => {
  const w = await world(t);
  const { h } = w;
  const run = await storeQuietRun(h), other = await storeQuietRun(h, { runner: h.bob.id });
  const repair = await w.requests.write(requestOf(run, h.admin.id, FAR_AHEAD, '合成包缺陷', { kind: 'repair', pack_digest: h.review.pack.digest }));
  await w.settle();
  const published = await h.kit.store.put({ kind: 'pack_version', schema: 'pack-version@1', provenance: 'declared', body: { pack: h.review.pack.id, version: '9.9.9', digest: 'b'.repeat(64) } });
  await w.round();
  assert.equal((await w.requests.all(run.body.run)).filter((request) => request.kind === 'disposition').length, 0, 'publication alone answers nothing');
  await w.requests.answer(repair.digest, published.digest);
  await w.round();
  const told = async (stored: StoredRecord<RunRecord>) => (await w.requests.all(stored.body.run)).filter((request) => request.kind === 'disposition' && request.answer_action === 'rerun' && request.source === published.digest);
  assert.equal((await told(run))[0]?.audience, h.alice.id);
  assert.equal((await told(other))[0]?.audience, h.bob.id);
  await w.round();
  await w.round();
  const late = await storeQuietRun(h);
  await w.round();
  assert.equal((await told(late)).length, 1, 'a run started on the repaired version later hears of it in the next round');
  assert.equal((await told(run)).length, 1, 'and nobody hears twice');
});

test('a request falling due during a round is escalated once, by that round or the next, whichever of its lists held the request', async (t) => {
  const w = await world(t);
  const { h } = w;
  const digest = h.review.pack.digest;
  const run = await storeQuietRun(h), swept = await storeQuietRun(h);
  const due = w.at(5 * MINUTE);
  const repair = await w.requests.write(requestOf(run, h.admin.id, FAR_AHEAD, '合成包缺陷', { kind: 'repair', pack_digest: digest }));
  const bound = await w.requests.write(requestOf(run, h.alice.id, due, '合成绑定运行和包', { pack_digest: digest }));
  const { run: _run, ...fields } = requestOf(run, h.alice.id, due, '合成只绑定包');
  const packOnly = await w.requests.write({ ...fields, pack_digest: digest });
  const inScope = await w.requests.write(requestOf(swept, h.alice.id, due, '合成运行有新记录'));
  await w.requests.answer(repair.digest, run.digest);
  await w.settle();
  // A new run on the repaired version: the repair sweep lists all of that version's requests. The visits outlast the deadline.
  await storeQuietRun(h);
  const at = w.at(0);
  await putAction(h.kit.store, { action: 'validate', run: swept.body.run, inputs: [], startedAt: at, endedAt: at, acceptance: null, codes: [], detail: { synthetic: true } });
  const { rootOfBuild } = h.knowledge;
  h.knowledge.rootOfBuild = async () => { w.advance(6 * MINUTE); return null; };
  t.after(() => { h.knowledge.rootOfBuild = rootOfBuild; });
  await w.round();
  h.knowledge.rootOfBuild = rootOfBuild;
  const first = await w.requests.all();
  assert.equal(escalationsOf(first, inScope.digest).length, 1, 'the sweeps of that round looked at this run');
  assert.equal(escalationsOf(first, bound.digest).length + escalationsOf(first, packOnly.digest).length, 0, 'and not at the other run or at the pack');
  await w.round();
  const next = await w.requests.all();
  assert.equal(escalationsOf(next, bound.digest).length, 1, 'bound to a run');
  assert.equal(escalationsOf(next, packOnly.digest).length, 1, 'bound to a pack alone');
  assert.equal(escalationsOf(next, inScope.digest).length, 1, 'and not again');
  assert.deepEqual([bound, packOnly, inScope].filter((request) => w.memory.due.has(request.digest)), [], 'handled, so no later round is sent to them');
});

/** A run with a source disposition on bytes the Hub read and kept as retain-only, because they hold a credential. */
async function retained(w: Awaited<ReturnType<typeof world>>) {
  const { h } = w;
  const bytes = Buffer.from(`copy ftp://user:Ftp${randomBytes(8).toString('hex')}9@192.0.2.10/image.bin flash:\n`);
  const source = await h.kit.artifacts.ingest({ bytes, mediaType: 'text/plain', origin: { read: { object: 'synthetic:manual:one' } }, author: { user: null }, provenanceType: 'observed', visibility: { readers: [], admins: true, packs: [], shareable: false } });
  const run = await storeQuietRun(h);
  const question = await w.requests.write(requestOf(run, h.admin.id, FAR_AHEAD, '合成来源待接受', { kind: 'disposition', sources: [`src:${source.body.sha256}`] }));
  const observed = async () => (await actionsOf(h.kit.store, run.body.run)).filter((action) => action.body.detail.sources_available === true).length;
  return { run, question, sha: source.body.sha256, observed };
}

test('an acceptance recorded between rounds lets a held source request proceed in the next round, and only then', async (t) => {
  const w = await world(t);
  const { sha, observed } = await retained(w);
  await w.settle();
  const quiet = await w.position();
  await w.round();
  await w.round();
  assert.equal(await observed(), 0, 'the source is still retain-only');
  assert.equal(await w.position(), quiet, 'and polling it wrote nothing');
  await w.h.kit.artifacts.acceptFindings(w.h.admin, sha, '合成手册的虚构示例');
  await w.round();
  assert.equal(await observed(), 1, 'the acceptance is what moved it');
});

test('a source request that arrives after its source was accepted proceeds at once, and an account change reaches it', async (t) => {
  const w = await world(t);
  const first = await retained(w);
  await w.h.kit.artifacts.acceptFindings(w.h.admin, first.sha, '合成手册的虚构示例');
  await w.h.kit.principals.setRole(w.h.admin, w.h.bob.id, 'admin');
  await w.h.kit.principals.setDisabled(w.h.admin, w.h.alice.id, true);
  await w.settle();
  assert.equal(await first.observed(), 0, 'the runner cannot act');
  await w.h.kit.principals.setDisabled(w.h.admin, w.h.alice.id, false);
  await w.round();
  assert.equal(await first.observed(), 1, 'nothing but the account changed');
  const run = await storeQuietRun(w.h);
  await w.round();
  const sources = [`src:${first.sha}`];
  await w.requests.write(requestOf(run, w.h.admin.id, FAR_AHEAD, '合成新来源请求', { kind: 'disposition', sources }));
  await w.round();
  assert.equal((await actionsOf(w.h.kit.store, run.body.run)).filter((action) => action.body.detail.sources_available === true).length, 1);
});

test('a held source request is resubmitted by a round once its source is available, and then answered', { skip }, async () => {
  const h = await openRetryHarness(pg, { review: { dynamicFindings: true }, dataQuotes: true });
  try {
    const doc = standardDocument(); doc.groups = [{ ...doc.groups[0], cases: [doc.groups[0].cases[0]] }];
    const source = await h.upload(h.alice, toyMap(doc));
    const run = (await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '10.6.1', build: 'Rel_MEADOW_10_6_1_7', inputs: { map: { reference: source } } }, h.call())).run!;
    const ref = run.sources.find((row) => row.external?.startsWith('toy:story:'))!.reference;
    const sha = ref.slice(4).split('/')[0];
    const original = h.kit.artifacts.source.bind(h.kit.artifacts);
    h.kit.artifacts.source = async (...args) => { const value = await original(...args); return args[1] === sha && value ? { ...value, bytes: null, readTier: 'retain_only' } : value; };
    const submission = { run: run.run, model: 'synthetic-model', items: [{ item: run.items[0].id, handling: 'handled', slots: { findings: [{ text: '合成引文', code: 'edge_case_gap', rank: 'major', quotes: [{ reference: run.items[0].location, text: run.items[0].label }], data: { expected_quote: { reference: ref, text: '分区编号 1 到 8' } } }] } }], cross_item: [{ nature: 'judgment', statement: '一般', grounds: [], code: 'draft_level', rank: 'P4' }] };
    const answer = await h.service.submitResult(h.alice, submission, h.call());
    assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
    const held = () => h.service.listRequests!(h.admin, run.run).then((rows) => rows.filter((r) => r.kind === 'disposition' && r.sources?.includes(ref)));
    assert.ok((await held()).length > 0);
    for (let n = 0; n < 4; n++) await h.service.maintain({ incremental: true });
    assert.ok((await held()).every((r) => r.answered_by === null), 'still retained');
    // What makes a source available in production is a record: this one stands for the acceptance the mock above withholds.
    h.kit.artifacts.source = original;
    await h.kit.authorizations.configureResource(h.admin, 'synthetic-acceptance', 'c'.repeat(64), '合成接受');
    await h.service.maintain({ incremental: true });
    assert.ok((await held()).every((r) => r.answered_by !== null));
  } finally { await h.close(); }
});

test('what a visit writes is swept in the same round, as it is in a pass over everything', async (t) => {
  const w = await world(t);
  const run = await storeQuietRun(w.h, { submission_due: w.at(5 * MINUTE) });
  await w.settle();
  // Nothing but the deadline brings this run back, so nothing but what the visit wrote can bring the request to the sweeps.
  let written = '';
  const { rootOfBuild } = w.h.knowledge;
  w.h.knowledge.rootOfBuild = async () => { written ||= (await w.requests.write(requestOf(run, w.h.alice.id, w.at(-MINUTE), '合成访问写入'))).digest; return null; };
  t.after(() => { w.h.knowledge.rootOfBuild = rootOfBuild; });
  w.advance(6 * MINUTE);
  await w.round();
  assert.ok(written);
  assert.equal(escalationsOf(await w.requests.all(), written).length, 1);
});

test('a record that commits after a newer one was read is not lost', async (t) => {
  const w = await world(t);
  const run = await storeQuietRun(w.h);
  await w.settle();
  let finish!: () => void, wrote!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; }), written = new Promise<void>((resolve) => { wrote = resolve; });
  let question = '';
  const slow = w.h.kit.store.withTransaction(async (tx: Transaction) => {
    const service = createRequestService(w.h.kit, () => new Date(w.at(0)), { transaction: tx });
    question = (await service.write(requestOf(run, w.h.alice.id, w.at(-MINUTE), '合成迟提交'))).digest;
    wrote();
    await gate;
  });
  await written;
  // Whatever happens here the transaction ends, or closing the harness would wait for it.
  try {
    await w.requests.write(requestOf(run, w.h.alice.id, FAR_AHEAD, '合成先提交'));
    await w.round();
    await w.round();
  } finally { finish(); await slow; }
  await w.round();
  assert.equal(escalationsOf(await w.requests.all(), question).length, 1, 'its position is below what the rounds had read');
});

test('a round asked to stop anywhere leaves its work to the next one', async (t) => {
  const w = await world(t);
  const run = await storeQuietRun(w.h);
  await w.settle();
  for (let allowed = 0; allowed < 6; allowed++) {
    const late = await storeQuietRun(w.h);
    const question = await w.requests.write(requestOf(run, w.h.alice.id, w.at(-MINUTE), `合成停止点 ${allowed}`));
    const newcomer = await w.requests.write(requestOf(late, w.h.alice.id, w.at(-MINUTE), `合成新运行 ${allowed}`));
    let asked = 0;
    await w.round(() => asked++ >= allowed);
    await w.round();
    const all = await w.requests.all();
    assert.equal(escalationsOf(all, question.digest).length, 1, `stopped after ${allowed} questions`);
    assert.equal(escalationsOf(all, newcomer.digest).length, 1, `stopped after ${allowed} questions`);
  }
});

test('a lookup that fails loses nothing: the next round takes in what the last one read', async (t) => {
  const w = await world(t);
  const run = await storeQuietRun(w.h);
  const question = await w.requests.write(requestOf(run, w.h.alice.id, w.at(-MINUTE), '合成原请求'));
  await w.settle();
  const [escalation] = escalationsOf(await w.requests.all(), question.digest);
  await w.requests.answer(question.digest, run.digest);
  const { getMany } = w.h.kit.store;
  w.h.kit.store.getMany = (async () => { throw new Error('合成读取故障'); }) as typeof getMany;
  await assert.rejects(w.round(), /合成读取故障/);
  w.h.kit.store.getMany = getMany;
  await w.round();
  assert.equal((await w.requests.all()).find((request) => request.record === escalation.record)!.answered_by, run.digest);
});

test('an escalation that fails to write is tried again by the next round, though its deadline is gone from the schedule', async (t) => {
  const w = await world(t);
  const run = await storeQuietRun(w.h);
  const question = await w.requests.write(requestOf(run, w.h.alice.id, w.at(5 * MINUTE), '合成写入失败'));
  await w.settle();
  w.advance(6 * MINUTE);
  const { put } = w.h.kit.store;
  w.h.kit.store.put = (async () => { throw new Error('合成写入故障'); }) as typeof put;
  await assert.rejects(w.round(), /合成写入故障/);
  w.h.kit.store.put = put;
  await w.round();
  assert.equal(escalationsOf(await w.requests.all(), question.digest).length, 1);
});

test('a job event brings back only the runs of that job, and an idle round asks dispatch nothing', async (t) => {
  const h = await openHarness(pg);
  t.after(() => h.close());
  const bound = await storeQuietRun(h), plan = await storeQuietRun(h), other = await storeQuietRun(h);
  const job = 'a'.repeat(64), asked: string[][] = [], visited: string[] = [];
  const service = createRunsService({
    parsers: createTestParserRegistry(), records: h.kit, workflows: h.workflows, packs: h.packs, knowledge: h.knowledge, external: h.external,
    dispatch: {
      jobs: async (_by: Principal, run: string) => { visited.push(run); return []; },
      reconcile: async () => { throw new Error('合成：不对账'); },
      runs: async (jobs: readonly string[]) => { asked.push([...jobs]); return new Map([[bound.body.run, [job]], [plan.body.run, [job]], [other.body.run, ['c'.repeat(64)]]]); },
    },
  });
  for (let n = 0; n < 3; n++) await service.maintain({ incremental: true });
  visited.length = 0;
  await service.maintain({ incremental: true });
  assert.deepEqual([asked, visited], [[], []], 'no job moved: dispatch is not asked and no run is visited');
  const at = new Date().toISOString();
  await h.kit.store.put({ kind: 'action', schema: 'action@1', provenance: 'observed', created_at: at, body: { action: 'read_back', run: bound.body.run, item: null, inputs: [], component: 'dispatch@1', lease: null, started_at: at, ended_at: at, result: 'completed', error_code: null, acceptance: null, codes: [], detail: { job, phase: 'result' } }, index: [{ key: 'dispatch.job', value: job }] });
  await service.maintain({ incremental: true });
  assert.deepEqual(asked, [[job]]);
  assert.deepEqual([...visited].sort(), [bound.body.run, plan.body.run].sort());
});

test('a record of a run brings back its successors, not its predecessors, and a new successor brings back the run it continues', async (t) => {
  const w = await world(t);
  const { h } = w;
  const first = await storeQuietRun(h);
  const successor = await storeQuietRun(h, { predecessor: first.body.run });
  const unrelated = await storeQuietRun(h);
  await w.settle();
  const runs = new Set<string>();
  const { find } = h.kit.store;
  h.kit.store.find = ((query: { key?: string; value?: string }, tx?: Transaction) => { if (query.key === 'runs.action.run' && query.value) runs.add(query.value); return find.call(h.kit.store, query as never, tx); }) as typeof find;
  t.after(() => { h.kit.store.find = find; });
  const at = w.at(0);
  await putAction(h.kit.store, { action: 'validate', run: first.body.run, inputs: [], startedAt: at, endedAt: at, acceptance: null, codes: [], detail: { synthetic: 1 } });
  await w.round();
  assert.deepEqual([...runs].sort(), [first.body.run, successor.body.run].sort());
  runs.clear();
  await w.round();
  await w.round();
  runs.clear();
  await putAction(h.kit.store, { action: 'validate', run: successor.body.run, inputs: [], startedAt: at, endedAt: at, acceptance: null, codes: [], detail: { synthetic: 2 } });
  await w.round();
  assert.deepEqual([...runs], [successor.body.run]);
  runs.clear();
  await w.round();
  await w.round();
  runs.clear();
  const third = await storeQuietRun(h, { predecessor: first.body.run });
  await w.round();
  assert.deepEqual([...runs].sort(), [first.body.run, successor.body.run, third.body.run].sort());
  assert.ok(!runs.has(unrelated.body.run));
});

test('what no record shows waits for the half-hourly pass, which still visits every run and sweeps every request', async (t) => {
  const w = await world(t);
  const run = await storeQuietRun(w.h);
  await w.settle();
  const { rootOfBuild } = w.h.knowledge;
  w.h.knowledge.rootOfBuild = (async () => ({ root: 'b'.repeat(64) })) as unknown as typeof rootOfBuild;
  t.after(() => { w.h.knowledge.rootOfBuild = rootOfBuild; });
  const told = async () => (await w.requests.all(run.body.run)).filter((request) => request.kind === 'disposition' && request.audience === w.h.alice.id);
  await w.round();
  await w.round();
  assert.equal((await told()).length, 0, 'no record says the knowledge root moved, so a round does not visit the run');
  const now = Date.parse(w.at(0));
  w.memory.fullAt = now - FULL_PASS_MS;
  await maintainRuns(w.ctx, undefined, w.memory);
  assert.equal((await told()).length, 1, 'half an hour on, a scheduled round visits every run');
  assert.equal(w.memory.fullAt, now);
  assert.equal(w.memory.requests.all, false, 'and its sweep of every request finished');
});

// ---------------------------------------------------------------- a pass over everything as the oracle

/** Deterministic pseudo-random numbers, so a failure names a seed that repeats it. */
function random(seed: number) {
  return (below: number): number => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) % below);
  };
}

/** One Hub of the comparison: the same events, in the same order, as the other. */
async function side(t: { after: (fn: () => Promise<void>) => void }, clock: { now: number }) {
  const h = await openHarness(pg);
  t.after(() => h.close());
  const now = () => new Date(clock.now);
  const runs: StoredRecord<RunRecord>[] = [];
  for (let n = 0; n < 3; n++) runs.push(await storeQuietRun(h));
  return { h, ctx: engineOn(h, now), requests: createRequestService(h.kit, now), runs, secrets: [] as string[], admins: [h.admin] as Principal[] };
}
type Side = Awaited<ReturnType<typeof side>>;

/** Each request under a name that is the same on both Hubs: digests, ids and times differ between two databases. */
async function named(s: Side): Promise<Array<{ request: RequestView; name: string }>> {
  const all = await s.requests.all(), byId = new Map(all.map((request) => [request.record, request]));
  const names = new Map((await s.h.kit.principals.list()).map((user) => [user.id, user.name]));
  const run = (id?: string) => id === undefined ? '-' : s.runs.findIndex((stored) => stored.body.run === id);
  const name = (request: RequestView): string => {
    const parent = byId.get(request.source);
    if (parent) return `${name(parent)} > ${names.get(request.audience)}`;
    return request.missing.startsWith('合成') ? request.missing : `${request.kind}/${request.code}/run ${run(request.run)}/${names.get(request.audience)}`;
  };
  return all.map((request) => ({ request, name: name(request) })).sort((a, b) => a.name.localeCompare(b.name));
}

/** What the rounds did, as a comparable outcome: what happened must not differ. */
async function outcome(s: Side): Promise<string[]> {
  const observed = [];
  for (const [n, stored] of s.runs.entries()) observed.push(`run ${n} observed ${(await actionsOf(s.h.kit.store, stored.body.run)).filter((action) => action.body.detail.sources_available === true).length}`);
  return [...(await named(s)).map(({ request, name }) => `${name}: ${request.answered_by === null ? 'open' : 'answered'}`), ...observed].sort();
}

/** One event, applied the same way to a Hub; `pick` is drawn once, so that both sides see the same numbers. */
async function apply(event: { kind: string; n: number; offset: number; pick: number; packed: boolean }, s: Side, clock: { now: number }): Promise<void> {
  const { h } = s;
  const runAt = s.runs[event.pick % s.runs.length];
  const due = new Date(clock.now + event.offset).toISOString();
  const open = (await named(s)).map(({ request }) => request).filter((request) => request.answered_by === null);
  switch (event.kind) {
    case 'request': await s.requests.write(requestOf(runAt, h.alice.id, due, `合成请求 ${event.n}`, { kind: (['clarification', 'disposition', 'judgment'] as const)[event.pick % 3], ...(event.packed ? { pack_digest: h.review.pack.digest } : {}) })); break;
    case 'pack-request': { const { run: _run, ...fields } = requestOf(runAt, h.alice.id, due, `合成包请求 ${event.n}`); await s.requests.write({ ...fields, pack_digest: 'd'.repeat(64) }); break; }
    case 'repair': await s.requests.write(requestOf(runAt, h.admin.id, due, `合成修复 ${event.n}`, { kind: 'repair', pack_digest: h.review.pack.digest })); break;
    case 'answer': { const target = open[event.pick % Math.max(1, open.length)]; if (target) await s.requests.answer(target.record, runAt.digest); break; }
    case 'publish': {
      const repairs = open.filter((request) => request.kind === 'repair' && request.pack_digest && request.audience === h.admin.id);
      const published = await h.kit.store.put({ kind: 'pack_version', schema: 'pack-version@1', provenance: 'declared', body: { pack: h.review.pack.id, version: `9.9.${event.n}`, digest: 'e'.repeat(63) + (event.n % 10) } });
      const target = repairs[event.pick % Math.max(1, repairs.length)];
      if (target) await s.requests.answer(target.record, published.digest);
      break;
    }
    case 'run': s.runs.push(await putRun(h.kit.store, quietRun(h), new Date(clock.now).toISOString())); break;
    case 'held': {
      const bytes = Buffer.from(`copy ftp://user:Ftp${event.n.toString(16).padStart(16, '0')}9@192.0.2.10/image.bin flash:\n`);
      const source = await h.kit.artifacts.ingest({ bytes, mediaType: 'text/plain', origin: { read: { object: `synthetic:manual:${event.n}` } }, author: { user: null }, provenanceType: 'observed', visibility: { readers: [], admins: true, packs: [], shareable: false } });
      s.secrets.push(source.body.sha256);
      await s.requests.write(requestOf(runAt, h.admin.id, FAR_AHEAD, `合成来源 ${event.n}`, { kind: 'disposition', sources: [`src:${source.body.sha256}`] }));
      break;
    }
    case 'accept': { const sha = s.secrets.shift(); if (sha) await h.kit.artifacts.acceptFindings(s.admins[0], sha, '合成手册的虚构示例'); break; }
    case 'admins': {
      // Bob comes in as the second administrator, or the two change places; there is always an active one.
      if (s.admins.length === 1) { await h.kit.principals.setRole(h.admin, h.bob.id, 'admin'); s.admins.push(h.bob); } else {
        const [active, next] = s.admins;
        await h.kit.principals.setDisabled(active, next.id, false);
        await h.kit.principals.setDisabled(next, active.id, true);
        s.admins.reverse();
      }
      break;
    }
    case 'advance': clock.now += event.offset > 0 ? event.offset : 25 * HOUR; break;
  }
}

const EVENTS = ['request', 'request', 'request', 'pack-request', 'repair', 'answer', 'answer', 'publish', 'run', 'held', 'accept', 'admins', 'advance', 'advance', 'advance'];

for (const seed of [1, 2, 3, 4]) test(`after every round, what the incremental rounds did is what a pass over everything does (seed ${seed})`, async (t) => {
  const draw = random(seed);
  const fullClock = { now: Date.parse('2026-10-22T09:00:00.000Z') }, roundClock = { now: fullClock.now };
  const full = await side(t, fullClock), incremental = await side(t, roundClock);
  const memory = newMaintenanceMemory();
  const round = async () => {
    // Rounds are a minute apart: a clock that stood still would give a repeated action the digest of the last one.
    fullClock.now += MINUTE;
    roundClock.now += MINUTE;
    await maintainRuns(full.ctx);
    if (memory.fullAt !== null) memory.fullAt = roundClock.now;
    await maintainRuns(incremental.ctx, undefined, memory);
  };
  await round();
  for (let step = 0; step < 40; step++) {
    const event = { kind: EVENTS[draw(EVENTS.length)], n: step, offset: (draw(61) - 20) * MINUTE, pick: draw(1000), packed: draw(4) === 0 };
    await apply(event, full, fullClock);
    await apply(event, incremental, roundClock);
    await round();
    assert.deepEqual(await outcome(incremental), await outcome(full), `seed ${seed}, step ${step}: ${JSON.stringify(event)}`);
  }
});
