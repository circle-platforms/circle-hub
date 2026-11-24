import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { RUN_HISTORY_MAX_RUNS, RunHistoryExport, type RunRecord } from '../../../contracts/src/run.ts';
import type { EffectOutcome } from '../../../contracts/generated/vocabulary.ts';
import { readRunJobs, runReservations, type RunJob } from '../../dispatch/api.ts';
import { canonicalBytes, newId, sha256Hex, type ActionBody, type Principal } from '../../records/api.ts';
import { installTraceSink, startTrace, type SpanRow } from '../../telemetry/api.ts';
import { createTestParserRegistry } from '../../testing/parsers.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { createRunsService, type RunsEngine } from './api.ts';
import type { RunsEngineDeps } from './deps.ts';
import { HISTORY_SCAN_BATCH, HISTORY_SCAN_RUNS, historyLimit, mayExport, subjectIdentities } from './run-history.ts';
import { openHarness, type Harness } from './testing/harness.ts';
import { storeQuietRun } from './testing/maintenance.ts';

let pg: TemporaryPostgres;
before(async () => { pg = await startPostgres({ private: true }); });
after(async () => { await pg?.stop(); });

const DOCUMENT = 'toy:mindmap:docq7', OTHER_DOCUMENT = 'toy:mindmap:docq8';
const bound = (external: string | null, bytes = '1'): RunRecord['sources'] => [
  { reference: `src:${bytes.repeat(64)}`, role: 'subject', slot: 'map', ...(external === null ? {} : { external }), media_type: 'application/json' },
  { reference: `src:${'2'.repeat(64)}`, role: 'expected', external: 'toy:story:4021@7' },
];

interface World {
  h: Harness; service: RunsEngine;
  order: string[]; jobs: Map<string, RunJob[]>;
  reservationReads: number; journalReaders: string[]; handed: boolean[];
}
async function world(): Promise<World> {
  const h = await openHarness(pg);
  const w: World = { h, service: undefined as unknown as RunsEngine, order: [], jobs: new Map(), reservationReads: 0, journalReaders: [], handed: [] };
  const dispatch: NonNullable<RunsEngineDeps['dispatch']> = {
    reservations: async () => { w.reservationReads++; return new Map(w.order.map((run) => [run, w.jobs.get(run)!.map((job) => ({ job: job.job, input: { run: job.verification_run, plan_run: job.plan_run } }))])); },
    jobs: async (by, run, reservations) => { w.journalReaders.push(by.role); w.handed.push(reservations !== undefined); return structuredClone(w.jobs.get(run) ?? []); },
    reconcile: async () => { throw new Error('the history export reconciles nothing'); },
  };
  w.service = createRunsService({ parsers: createTestParserRegistry(), records: h.kit, workflows: h.workflows, packs: h.packs, knowledge: h.knowledge, external: h.external, dispatch });
  return w;
}
async function subject(w: Pick<World, 'h'> | Harness, external: string | null, text = '合成文档'): Promise<RunRecord['sources']> {
  const h = 'h' in w ? w.h : w;
  const artifact = await h.kit.artifacts.ingest({ bytes: new TextEncoder().encode(text), mediaType: 'application/json', origin: { upload: { session: 'synthetic' } }, author: { user: h.alice.id }, provenanceType: 'declared', visibility: { readers: [h.alice.id, h.bob.id], admins: true, packs: [], shareable: false } });
  return [{ reference: `src:${artifact.body.sha256}`, role: 'subject', slot: 'map', ...(external === null ? {} : { external }), media_type: 'application/json' }];
}
interface Dispatched { runner?: Principal; sources?: RunRecord['sources']; build?: string; ended?: RunJob['ended']; outcome?: EffectOutcome; ended_at?: string; verdicts?: Record<string, 'pass' | 'fail'>; projection?: 'own' | 'withheld' | 'none' }
async function dispatched(w: World, at: string, options: Dispatched = {}): Promise<{ run: string; plan: string; job: string }> {
  const runner = options.runner ?? w.h.alice;
  const stored = await storeQuietRun(w.h, { runner: runner.id, sources: options.sources ?? await subject(w, `${DOCUMENT}@3`), started_at: at, build: options.build }, at);
  const run = stored.body.run, plan = newId('run'), job = sha256Hex(newId('job')), workbook = sha256Hex(`workbook ${run}`);
  const verdicts = options.verdicts ?? { 'case-1': 'pass' };
  const rows = Object.entries(verdicts).map(([item, dynamic_terminal]) => ({ item, dynamic_terminal, accepted_as_fact: false, qualifier: { nature: 'judgment', marks: ['target_reported'] }, missing_facts: [], evidence: { log: `src:${'9'.repeat(64)}` } }));
  const outcome = options.outcome ?? 'effective', ended = options.ended === undefined ? 'done' : options.ended;
  let result: string | undefined;
  if (outcome === 'effective' && options.projection !== 'none') {
    const artifact = await w.h.kit.artifacts.ingest({ bytes: canonicalBytes({ job, sha256: workbook, rows }), mediaType: 'application/json', origin: { generated: { generator: 'dispatch@1', inputs: [] } }, author: { user: null }, provenanceType: 'projected', visibility: { readers: options.projection === 'withheld' ? [] : [runner.id], admins: true, packs: [], shareable: false } });
    result = `src:${artifact.body.sha256}`;
  }
  w.order.push(run);
  w.jobs.set(run, [{ job, verification_run: run, plan_run: plan, verification_item: Object.keys(verdicts)[0], items: Object.keys(verdicts), sha256: workbook, ended, ...(ended && options.ended_at !== 'none' ? { ended_at: options.ended_at ?? at } : {}), boundary_refused: false,
    status: { job, phase: ended ? 'complete' : 'receipt', outcome, frozen: outcome === 'unknown', events: 3, ...(result ? { result } : {}) } }]);
  return { run, plan, job };
}
const asked = async (w: World, sources?: RunRecord['sources'], runner: Principal = w.h.alice) =>
  (await storeQuietRun(w.h, { runner: runner.id, sources: sources ?? await subject(w, `${DOCUMENT}@5`), started_at: '2026-11-20T00:00:00.000Z' }, '2026-11-20T00:00:00.000Z')).body.run;

test('the subject of a run across runs, the limit and who may export', () => {
  assert.deepEqual(subjectIdentities({ sources: bound(`${DOCUMENT}@3`) }), [DOCUMENT], 'another revision of the same object is the same subject; an expected source names nothing');
  assert.deepEqual(subjectIdentities({ sources: bound(DOCUMENT) }), [DOCUMENT]);
  assert.deepEqual(subjectIdentities({ sources: bound(null) }), [`src:${'1'.repeat(64)}`], 'bytes bound directly are named by their reference');
  assert.deepEqual(subjectIdentities({ sources: [...bound(`${DOCUMENT}@3`), ...bound(`${DOCUMENT}@4`), ...bound(null, '3')] }), [`src:${'3'.repeat(64)}`, DOCUMENT]);
  assert.deepEqual(subjectIdentities({ sources: [] }), []);
  assert.deepEqual([undefined, 0, 1, 3, 8, 9, 2.5, Number.NaN].map(historyLimit), [8, 1, 1, 3, 8, 8, 8, 8]);
  assert.equal(RUN_HISTORY_MAX_RUNS, 8);
  assert.deepEqual([mayExport({ id: 'u1', role: 'user' }, { runner: 'u1' }), mayExport({ id: 'u2', role: 'user' }, { runner: 'u1' }), mayExport({ id: 'u2', role: 'admin' }, { runner: 'u1' }), mayExport({ id: 'u2', role: 'user' }, {})], [true, false, true, false]);
});

test('the runs of the same subject whose job took effect are listed newest first, at the reader\'s own rights', async (t) => {
  const w = await world(); t.after(() => w.h.close());
  const first = await dispatched(w, '2026-11-17T01:00:00.000Z', { build: 'Rel_MEADOW_10_6_1_7', verdicts: { 'case-1': 'pass', 'case-2': 'fail' } });
  const withheld = await dispatched(w, '2026-11-17T02:00:00.000Z', { sources: await subject(w, `${DOCUMENT}@4`), projection: 'withheld' });
  const elsewhere = await dispatched(w, '2026-11-17T03:00:00.000Z', { sources: await subject(w, `${OTHER_DOCUMENT}@3`) });
  const theirs = await dispatched(w, '2026-11-17T04:00:00.000Z', { runner: w.h.bob });
  const running = await dispatched(w, '2026-11-17T05:00:00.000Z', { ended: null, outcome: 'issued' });
  const unsent = await dispatched(w, '2026-11-17T06:00:00.000Z', { outcome: 'not_dispatched' });
  const unresolved = await dispatched(w, '2026-11-17T07:00:00.000Z', { ended: 'unknown', outcome: 'unknown' });
  const latest = await dispatched(w, '2026-11-17T08:00:00.000Z', { sources: await subject(w, DOCUMENT), ended_at: '2026-11-17T01:30:00.000Z', verdicts: { 'case-1': 'pass', 'case-2': 'pass' } });
  const untimed = await dispatched(w, '2026-11-16T00:00:00.000Z', { ended_at: 'none' });
  const run = await asked(w);

  const answer = await w.service.exportHistory!(w.h.alice, run);
  assert.deepEqual(RunHistoryExport.parse(answer), {
    schema: 'run-history@1', run, subjects: [DOCUMENT], limit: 8, complete: true,
    runs: [
      { run: withheld.run, started_at: '2026-11-17T02:00:00.000Z', build: null, jobs: [{ job: withheld.job, plan_run: withheld.plan, ended_at: '2026-11-17T02:00:00.000Z', outcome: 'effective', rows: null }] },
      { run: latest.run, started_at: '2026-11-17T08:00:00.000Z', build: null, jobs: [{ job: latest.job, plan_run: latest.plan, ended_at: '2026-11-17T01:30:00.000Z', outcome: 'effective', rows: [{ item: 'case-1', dynamic_terminal: 'pass' }, { item: 'case-2', dynamic_terminal: 'pass' }] }] },
      { run: first.run, started_at: '2026-11-17T01:00:00.000Z', build: 'Rel_MEADOW_10_6_1_7', jobs: [{ job: first.job, plan_run: first.plan, ended_at: '2026-11-17T01:00:00.000Z', outcome: 'effective', rows: [{ item: 'case-1', dynamic_terminal: 'pass' }, { item: 'case-2', dynamic_terminal: 'fail' }] }] },
      { run: untimed.run, started_at: '2026-11-16T00:00:00.000Z', build: null, jobs: [{ job: untimed.job, plan_run: untimed.plan, ended_at: null, outcome: 'effective', rows: [{ item: 'case-1', dynamic_terminal: 'pass' }] }] },
    ],
  }, 'a row carries its item and verdict only; a projection this reader may not read leaves the rows unknown, never a verdict');
  for (const absent of [elsewhere, theirs, running, unsent, unresolved]) assert.ok(!JSON.stringify(answer).includes(absent.run));
  assert.ok(!JSON.stringify(answer).includes('9'.repeat(64)), 'no evidence reference leaves with the history');
  assert.equal(w.reservationReads, 1, 'one reading of the reservations serves every run looked at');
  assert.ok(w.handed.length > 0 && w.handed.every(Boolean), 'and is handed to each reading of a run\'s jobs');
  assert.deepEqual([...new Set(w.journalReaders)], ['admin'], 'the journal is read as a named administrator; the projection at the reader\'s tier');
  assert.equal(w.journalReaders.length, 7, 'only the runs of the subject that the reader may export have their jobs read');

  const two = (await w.service.exportHistory!(w.h.alice, run, { limit: 2 }))!;
  assert.deepEqual([two.limit, two.complete, two.runs.length], [2, true, 2]);
  assert.deepEqual(two.runs.map((row) => row.run), [latest.run, untimed.run], 'the two dispatched last among those listed: reserved last, and the one before it in the journal');
  assert.equal((await w.service.exportHistory!(w.h.alice, run, { limit: 99 }))!.limit, 8);

  assert.equal(await w.service.exportHistory!(w.h.bob, run), null);
  assert.equal(await w.service.exportHistory!(w.h.alice, 'run_01aaaaaaaaaaaaaaaaaaaaaaaa'), null);
  const own = await asked(w, await subject(w, `${DOCUMENT}@9`), w.h.bob);
  assert.deepEqual((await w.service.exportHistory!(w.h.bob, own))!.runs.map((row) => row.run), [theirs.run]);
  const all = (await w.service.exportHistory!(w.h.admin, run))!;
  assert.deepEqual(all.runs.map((row) => row.run), [theirs.run, withheld.run, latest.run, first.run, untimed.run]);
  assert.deepEqual(all.runs[1].jobs[0].rows, [{ item: 'case-1', dynamic_terminal: 'pass' }]);
});

test('bytes bound directly are the same subject only as the same bytes, and a run with nothing earlier answers an empty list', async (t) => {
  const w = await world(); t.after(() => w.h.close());
  const same = await dispatched(w, '2026-11-17T01:00:00.000Z', { sources: await subject(w, null, '合成字节 5') });
  await dispatched(w, '2026-11-17T02:00:00.000Z', { sources: await subject(w, null, '合成字节 6') });
  await dispatched(w, '2026-11-17T03:00:00.000Z', { sources: await subject(w, `${DOCUMENT}@3`, '合成字节 5') });
  const bytes = await subject(w, null, '合成字节 5');
  const run = await asked(w, bytes);
  const answer = (await w.service.exportHistory!(w.h.alice, run))!;
  assert.deepEqual([answer.subjects, answer.runs.map((row) => row.run)], [[bytes[0].reference], [same.run]]);
  const lonely = await asked(w, await subject(w, `${OTHER_DOCUMENT}@1`));
  assert.deepEqual(await w.service.exportHistory!(w.h.alice, lonely), { schema: 'run-history@1', run: lonely, subjects: [OTHER_DOCUMENT], limit: 8, complete: true, runs: [] });
  const unsubjected = await asked(w, []);
  const reads = w.reservationReads;
  assert.deepEqual(await w.service.exportHistory!(w.h.alice, unsubjected), { schema: 'run-history@1', run: unsubjected, subjects: [], limit: 8, complete: true, runs: [] });
  assert.equal(w.reservationReads, reads, 'without a subject the journal is not read');
  assert.deepEqual((await w.service.exportHistory!(w.h.alice, same.run))!.runs, []);
  const bare = createRunsService({ parsers: createTestParserRegistry(), records: w.h.kit, workflows: w.h.workflows, packs: w.h.packs, knowledge: w.h.knowledge, external: w.h.external });
  assert.deepEqual((await bare.exportHistory!(w.h.alice, run))!.runs, []);
});

test('the scan looks at a bounded number of dispatched runs and says when that was not all of them', async (t) => {
  const w = await world(); t.after(() => w.h.close());
  const old = await dispatched(w, '2026-11-10T00:00:00.000Z'), elsewhere = await subject(w, `${OTHER_DOCUMENT}@1`);
  for (let at = 0; at < HISTORY_SCAN_RUNS - 1; at++) await dispatched(w, '2026-11-11T00:00:00.000Z', { sources: elsewhere, projection: 'none' });
  const run = await asked(w);
  const within = (await w.service.exportHistory!(w.h.alice, run))!;
  assert.deepEqual([within.complete, within.runs.map((row) => row.run)], [true, [old.run]], `the oldest of ${HISTORY_SCAN_RUNS} dispatched runs is still looked at`);
  await dispatched(w, '2026-11-12T00:00:00.000Z', { sources: elsewhere, projection: 'none' });
  const beyond = (await w.service.exportHistory!(w.h.alice, run))!;
  assert.deepEqual([beyond.complete, beyond.runs], [false, []], 'one more and it is not: the answer says older verifications may exist');
  const recent = await dispatched(w, '2026-11-13T00:00:00.000Z');
  const found = (await w.service.exportHistory!(w.h.alice, run, { limit: 1 }))!;
  assert.deepEqual([found.complete, found.runs.map((row) => row.run)], [true, [recent.run]], 'an answer that reached its limit is the newest, whatever lies beyond the scan');
});

interface Cost { queries: number; rows: number; bytes: number }
async function costOf<T>(work: () => Promise<T>): Promise<{ cost: Cost; value: T }> {
  const spans: SpanRow[] = [];
  const uninstall = installTraceSink({ push: (row) => spans.push(row) });
  let value: T;
  try { value = await startTrace({ name: 'run-export', origin: 'mcp' }, work); } finally { uninstall(); }
  const usage = spans.find((row) => row.is_root)!.usage;
  return { value, cost: { queries: usage['db.queries'] ?? 0, rows: usage['db.rows'] ?? 0, bytes: usage['db.bytes'] ?? 0 } };
}
async function journalled(h: Harness, at: string, sources: RunRecord['sources']): Promise<string> {
  const stored = await storeQuietRun(h, { sources, started_at: at, instructions: '合成规程。'.repeat(12_000) }, at);
  const run = stored.body.run, job = sha256Hex(newId('job')), workbook = sha256Hex(`workbook ${run}`);
  const artifact = await h.kit.artifacts.ingest({ bytes: canonicalBytes({ job, sha256: workbook, rows: [{ item: 'case-1', dynamic_terminal: 'pass', accepted_as_fact: false, qualifier: { nature: 'judgment', marks: ['target_reported'] }, missing_facts: [] }] }), mediaType: 'application/json', origin: { generated: { generator: 'dispatch@1', inputs: [] } }, author: { user: null }, provenanceType: 'projected', visibility: { readers: [h.alice.id], admins: true, packs: [], shareable: false } });
  const event = (phase: string, detail: Record<string, unknown>) => h.kit.store.put<ActionBody>({ kind: 'action', schema: 'action@1', provenance: 'observed', created_at: at,
    body: { action: 'validate', run, item: 'case-1', inputs: [], component: 'dispatch@1', lease: null, started_at: at, ended_at: at, result: 'completed', error_code: null, acceptance: null, codes: [], detail: { job, phase, event: newId('evt'), ...detail } },
    index: [{ key: 'dispatch.job', value: job }, { key: 'dispatch.phase', value: phase }] });
  await event('reservation', { binding: { job, input: { run, plan_run: newId('run'), item: 'case-1', items: ['case-1'], sha256: workbook } } });
  await event('result', { reference: `src:${artifact.body.sha256}` });
  await event('complete', { done: true, outcome: 'effective' });
  return run;
}
async function measured(dispatchedRuns: number, ofSubject: number) {
  const h = await openHarness(pg);
  try {
    const status = async (_by: Principal, job: string) => {
      const events = await h.kit.store.findMany<ActionBody>({ kind: 'action', key: 'dispatch.job', values: [job] });
      const result = events.find((event) => event.body.detail.phase === 'result')?.body.detail.reference;
      return { job, phase: 'complete', outcome: 'effective' as const, frozen: false, events: events.length, ...(typeof result === 'string' ? { result } : {}) };
    };
    const service = createRunsService({ parsers: createTestParserRegistry(), records: h.kit, workflows: h.workflows, packs: h.packs, knowledge: h.knowledge, external: h.external,
      dispatch: { reservations: () => runReservations(h.kit), jobs: (by, run, reservations) => readRunJobs(h.kit, { status }, by, run, reservations ? { reservations } : {}), reconcile: async () => { throw new Error('unexpected'); } } });
    const same = await subject(h, `${DOCUMENT}@3`), other = await subject(h, `${OTHER_DOCUMENT}@1`);
    for (let at = 0; at < ofSubject; at++) await journalled(h, `2026-11-1${at % 10}T00:00:00.000Z`, same);
    for (let at = ofSubject; at < dispatchedRuns; at++) await journalled(h, '2026-11-19T00:00:00.000Z', other);
    const run = (await storeQuietRun(h, { sources: await subject(h, `${DOCUMENT}@5`) })).body.run;
    const lonely = (await storeQuietRun(h, { sources: await subject(h, 'toy:mindmap:docq9@1') })).body.run;
    const found = await costOf(() => service.exportHistory!(h.alice, run));
    const none = await costOf(() => service.exportHistory!(h.alice, lonely));
    assert.equal(found.value!.runs.length, Math.min(ofSubject, RUN_HISTORY_MAX_RUNS));
    assert.ok(found.value!.runs.every((row) => row.jobs[0].ended_at !== null && row.jobs[0].rows?.length === 1));
    assert.deepEqual(none.value!.runs, []);
    return { found: found.cost, none: none.cost };
  } finally { await h.close(); }
}

test('an answer reads the reservations once and the run records in batches; what it reads per run found does not grow with the history', { timeout: 300_000 }, async () => {
  const small = await measured(100, 8), large = await measured(300, 8);
  const batches = (runs: number) => Math.ceil(runs / HISTORY_SCAN_BATCH);
  assert.ok(large.none.queries - small.none.queries <= batches(300) - batches(100) + 1, `${small.none.queries} -> ${large.none.queries} queries for a subject nothing verified`);
  assert.ok(large.found.queries - small.found.queries <= batches(300) - batches(100) + 1, `${small.found.queries} -> ${large.found.queries} queries for eight runs found`);
  assert.equal(large.found.queries - large.none.queries, small.found.queries - small.none.queries);
  assert.ok(large.none.queries <= batches(300) + 8, `${large.none.queries} queries to look at 300 dispatched runs`);
});
