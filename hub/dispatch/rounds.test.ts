import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setup } from './testing/context.ts';
import type { Aggregation } from '../../contracts/generated/vocabulary.ts';

type Fixture = Awaited<ReturnType<typeof setup>>;

function policy(count: number, aggregation: Aggregation, extra: { fresh_context?: boolean; baseline_first?: boolean; window_seconds?: number } = {}) {
  return { count, aggregation, basis: 'explicit' as const, declared: { count: true, aggregation: true, k: false }, ...extra };
}

function install(c: Fixture, repetition: ReturnType<typeof policy>) {
  (c.effectDocument.effects[0] as { repetition?: number }).repetition = repetition.count;
  c.detail.run.requirements = [{
    key: 'workbook_verified', name: '合成核验', description: '合成', layers: ['dynamic'], done_rule: 'gating', accepted_producer: 'fact',
    repair_rounds: 0, rules: [], run_interpreters: [], repetition,
  }] as typeof c.detail.run.requirements;
}

async function certify(c: Fixture, certified = true) {
  const proof = await c.kit.artifacts.ingest({ bytes: new TextEncoder().encode('synthetic attribution certification'), mediaType: 'text/plain', origin: { upload: { session: 'synthetic' } }, author: { user: c.admin.id }, provenanceType: 'declared', visibility: { readers: [c.admin.id], admins: true, packs: [], shareable: false } });
  await c.registry.update(c.admin, c.executor.id, { ...c.executor.definition, premises: certified ? { result_ownership: { version: '1', evidence: [`src:${proof.body.sha256}`] } } : {}, result: { ...c.executor.definition.result, ownership: { pointer: '/ownership', value: 'staging_directory', reason: '/ownership_reason' }, request_id: '/request', log: '/log', closing_marker: 'SYNTHETIC_END' } });
  await c.freezeExecutor();
}

async function intents(c: Fixture) {
  const rows = await c.kit.store.findMany<import('../records/api.ts').ActionBody>({ kind: 'action', key: 'dispatch.bytes', values: [c.payload.body.sha256] });
  return rows.filter(row => row.body.detail.phase === 'intent');
}

async function reportOf(c: Fixture, reference: string) {
  const source = await c.kit.artifacts.source(c.owner, reference.slice(4));
  assert.ok(source?.bytes);
  return JSON.parse(new TextDecoder().decode(source.bytes)) as { rounds: Array<{ round: number; terminal: string; reason?: string; early_stop?: boolean; meets?: boolean | null }> };
}

async function openCertified(options: { aggregation?: Aggregation; count?: number; fresh_context?: boolean; baseline_first?: boolean; window_seconds?: number; outcomes?: string[]; failVersion?: number; onSubmit?: () => Promise<void> } = {}) {
  let reads = 0; let versions = 0; let opens = 0;
  let c: Fixture;
  c = await setup({
    onSubmit: options.onSubmit,
    alter: (name, value) => {
      if (name === 'open_slot' && options.fresh_context) { opens += 1; return { ...value, ticket: `synthetic-ticket-${opens}`, token: `synthetic-token-${opens}` }; }
      if (name === 'touch_slot' && options.fresh_context) {
        const args = c.endpoint.calls.filter(call => call.params.name === 'touch_slot').at(-1)?.params.arguments as { ticket?: string; token?: string } | undefined;
        return { ...value, ticket: args?.ticket, token: args?.token };
      }
      if (name === 'inspect_bound_seat' && String((value as { output?: string }).output).startsWith('version:')) {
        versions += 1;
        if (options.failVersion !== undefined && versions === options.failVersion) return { output: 'version: wrong' };
      }
      if (name === 'read_blob') {
        reads += 1;
        const outcome = options.outcomes?.[reads - 1] ?? 'good';
        return { ...value, ownership: 'staging_directory', ownership_reason: null, rows: [{ id: 'synthetic-case', outcome, log: 'SYNTHETIC_END' }] };
      }
      return value;
    },
  });
  install(c, policy(options.count ?? 3, options.aggregation ?? 'all', { fresh_context: options.fresh_context, baseline_first: options.baseline_first, window_seconds: options.window_seconds }));
  await certify(c);
  return c;
}

test('one dispatch runs each frozen round through its own intent', { timeout: 60000 }, async t => {
  const c = await openCertified(); t.after(() => c.close());
  const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(c.calls.filter(name => name === 'send_blob').length, 3);
  assert.equal(state.outcome, 'effective');
  assert.deepEqual(state.rounds?.map(round => round.round), [1, 2, 3]);
  assert.deepEqual(state.rounds?.map(round => round.terminal), ['pass', 'pass', 'pass']);
  const written = await intents(c);
  assert.equal(written.length, 3);
  assert.deepEqual(written.map(row => row.body.detail.round), [1, 2, 3]);
  const keys = new Set(written.map(row => row.body.detail.intent_key));
  assert.equal(keys.size, 3);
  const effects = await c.kit.store.findMany<{ intent_key: string | null }>({ kind: 'effect', key: 'effect.job', values: [state.job] });
  assert.ok(effects.length >= 3);
  assert.ok(effects.every(effect => keys.has(effect.body.intent_key)));
  await assert.rejects(c.service.dispatch(c.admin, c.run, c.executor.id), /已派发成功|已有派发意图/);
});

test('first pass stops at the second round and keeps the unrun round in the denominator', { timeout: 60000 }, async t => {
  const c = await openCertified({ aggregation: 'first_pass', outcomes: ['bad', 'good'] }); t.after(() => c.close());
  const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(c.calls.filter(name => name === 'send_blob').length, 2);
  assert.deepEqual(state.rounds?.map(round => [round.round, round.terminal]), [[1, 'fail'], [2, 'pass'], [3, 'not_run']]);
  assert.match(state.reason ?? '', /第 2 轮通过，按策略提前停，剩 1 轮未跑/);
  const report = await reportOf(c, state.result!);
  assert.equal(report.rounds.filter(round => round.early_stop).length, 1);
  const written = await intents(c);
  assert.equal(written.some(row => row.body.detail.round === 3), false);
  const keys = new Set(written.map(row => row.body.detail.intent_key));
  const effects = await c.kit.store.findMany<{ intent_key: string | null }>({ kind: 'effect', key: 'effect.job', values: [state.job] });
  assert.ok(effects.every(effect => keys.has(effect.body.intent_key)));
});

test('fresh context takes a distinct lease for each round', { timeout: 60000 }, async t => {
  const c = await openCertified({ fresh_context: true }); t.after(() => c.close());
  await c.service.dispatch(c.admin, c.run, c.executor.id);
  const leases = (await intents(c)).map(row => String((row.body.detail.remote_lease as { id: string }).id));
  assert.equal(leases.length, 3);
  assert.equal(new Set(leases).size, 3);
  assert.equal(c.endpoint.calls.filter(call => call.method === 'initialize').length, 3);
});

test('a failed baseline round is not_run and does not count as a failure', { timeout: 60000 }, async t => {
  const c = await openCertified({ baseline_first: true, failVersion: 3 }); t.after(() => c.close());
  const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
  const rounds = state.rounds ?? [];
  assert.deepEqual(rounds.map(round => round.terminal), ['pass', 'not_run', 'pass']);
  assert.equal(rounds[1]?.reason, 'integrity_unproven');
  assert.equal((await intents(c)).some(row => row.body.detail.round === 2), false);
  assert.equal(c.calls.filter(name => name === 'send_blob').length, 2);
});

test('a round outside the window stays in the denominator as budget_exhausted', { timeout: 60000 }, async t => {
  let c: Fixture;
  c = await openCertified({ window_seconds: 2, onSubmit: async () => { c.clock.ms += 5000; } });
  t.after(() => c.close());
  const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(c.calls.filter(name => name === 'send_blob').length, 1);
  assert.deepEqual(state.rounds?.map(round => [round.round, round.terminal, round.reason ?? null]), [[1, 'pass', null], [2, 'not_run', 'budget_exhausted'], [3, 'not_run', 'budget_exhausted']]);
  const report = await reportOf(c, state.result!);
  assert.equal(report.rounds.length, 3);
});

test('an ended round with a pending report pauses readback without starting another submission', { timeout: 60000 }, async t => {
  const c = await setup({ alter: (name, value) => name === 'read_blob' ? { ...value, complete: false, ownership: 'staging_directory', ownership_reason: null, rows: [{ id: 'synthetic-case', outcome: 'good', log: 'SYNTHETIC_END' }] } : value });
  t.after(() => c.close());
  install(c, policy(2, 'all'));
  await certify(c);
  const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(state.report_pending,true);assert.deepEqual(state.rounds?.map(round=>round.terminal),['no_verdict']);assert.equal(c.calls.filter(name=>name==='send_blob').length,1);
  const report = await reportOf(c, state.result!);
  assert.ok(report.rounds.every(round => round.terminal === 'no_verdict' && (round as { lost?: boolean }).lost === true));
});

test('an uncertified result ownership premise makes every round no_verdict', { timeout: 60000 }, async t => {
  const c = await openCertified(); t.after(() => c.close());
  await certify(c, false);
  const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.deepEqual(state.rounds?.map(round => round.terminal), ['no_verdict', 'no_verdict', 'no_verdict']);
});

test('resume reconciles the started round and a new dispatch continues at the next one', { timeout: 60000 }, async t => {
  const c = await setup(); t.after(() => c.close());
  install(c, policy(3, 'all'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./testing/worker.ts', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  let output = ''; child.stdout!.on('data', chunk => { output += chunk; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const ready = new Promise<void>(resolve => child.once('message', () => resolve()));
  child.stdin!.end(JSON.stringify({ config: { ...c.kit.config, database: c.kit.database }, now: c.now().toISOString(), detail: c.detail, admin: c.admin, executor: c.executor.id, repetition: 3, haltBeforeRound: 2 }));
  await Promise.race([ready, exited.then(exit => { throw new Error(`worker exited before ready: ${exit.code} ${output}`); })]);
  t.after(() => child.kill('SIGKILL'));
  child.send('go');
  const exit = await exited;
  assert.equal(exit.code, 86, output);
  assert.equal(c.calls.filter(name => name === 'send_blob').length, 1);
  const first = (await intents(c)).find(row => row.body.detail.round === 1);
  assert.ok(first);
  assert.equal((await intents(c)).some(row => row.body.detail.round === 2), false);
  const resumed = await c.service.resume(c.admin, String(first.body.detail.job));
  assert.equal(c.calls.filter(name => name === 'send_blob').length, 1);
  assert.equal((await c.service.journal.events(String(first.body.detail.job))).some(event => event.body.detail.phase === 'intent' && event.body.detail.round === 2), false);
  assert.equal(resumed.outcome, 'effective');
  const continued = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(c.calls.filter(name => name === 'send_blob').length, 3);
  assert.deepEqual((await intents(c)).map(row => row.body.detail.round).sort(), [1, 2, 3]);
  assert.notEqual(continued.job, first.body.detail.job);
});
