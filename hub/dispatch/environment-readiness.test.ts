import {EffectBoundaryError} from './boundary.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sha256Hex, type User, type Principal, type RecordsKit } from '../records/api.ts';
import { ExecutorDefinition } from './definition.ts';
import type { ExecutorRegistry, RegisteredExecutor } from './executors.ts';
import { definition } from './testing/definition.ts';
import { readEnvironmentReadiness, createEnvironmentReadiness, type EnvironmentReadinessSources } from './environment-readiness.ts';

const member: Principal = { id: 'usr_' + '0'.repeat(26), role: 'user', name: '合成成员' };
const instant = '2026-11-14T00:00:00.000Z';
const bytes = Buffer.from('synthetic-local-evidence'), hash = sha256Hex(bytes);
function fixture() {
  const reads: string[] = [], baselineReads: string[] = [];
  const input = { ...definition('http://127.0.0.1/mcp'), target: 'synthetic-target', manifest_sha256: hash, premises: { request_journal: { version: 'synthetic-v1', evidence: ['src:' + hash] } } };
  const candidates = [{ id: 'exe_' + '1'.repeat(26), definition: ExecutorDefinition.parse(input) }];
  const sources: EnvironmentReadinessSources = {
    account: async id => ({ ...member, id, disabled: false, deleted_at: null } as User),
    executors: async () => candidates,
    canUse: async () => true,
    source: async (actor, digest) => { assert.equal(actor.role, 'user'); reads.push(digest); return { bytes }; },
    baseline: async (executor, probe) => { baselineReads.push(executor + ':' + probe); return { recorded_at: instant }; },
    leases: { view: async () => ({ entries: [], since: instant }) as unknown as Awaited<ReturnType<EnvironmentReadinessSources['leases']['view']>> },
    now: () => new Date(instant),
  };
  return { sources, candidates, reads, baselineReads };
}
const verdict = (report: Awaited<ReturnType<typeof readEnvironmentReadiness>>, condition: string, row = 0) => report.executors[row].checks.find(check => check.condition === condition)?.satisfied;

test('local readiness verifies actor-readable SHA evidence without probing, secrets, writes or a total permit', async () => {
  const f = fixture();
  const report = await readEnvironmentReadiness(f.sources, { ...member, role: 'admin' }, 'synthetic-target');
  assert.equal(report.observed_at, instant); assert.equal(report.target, 'synthetic-target');
  assert.equal(verdict(report, 'manifest'), true); assert.equal(verdict(report, 'evidence.0.0'), true);
  assert.equal(verdict(report, 'manifest_freshness'), null); assert.equal(verdict(report, 'baseline'), null);
  assert.equal(verdict(report, 'local_leases_clear'), true); assert.deepEqual(report.executors[0].occupancy, []);
  assert.deepEqual(f.reads, [hash, hash]);
  assert.ok(report.limitations.some(line => line.includes('不表示物理环境空闲')));
  assert.equal('ready' in report, false); assert.equal('executor' in report.executors[0], false);
  assert.doesNotMatch(JSON.stringify(report), /exe_|usr_|127\.0\.0\.1|synthetic-v1|synthetic-local-evidence/);
  for (const check of report.executors[0].checks) { assert.equal(check.observed_at, instant); for (const reference of check.references) assert.equal(reference, 'src:' + hash); }
});

test('unassigned and disabled accounts disclose no target details or internal identities', async () => {
  const f = fixture(); f.sources.canUse = async () => false;
  const report = await readEnvironmentReadiness(f.sources, { ...member, role: 'admin' }, 'synthetic-target');
  assert.equal(report.target, null); assert.deepEqual(report.executors, []); assert.deepEqual(f.reads, []);
  assert.doesNotMatch(JSON.stringify(report), /synthetic-target|exe_|usr_/);
  f.sources.account = async () => ({ ...member, disabled: true } as User);
  f.sources.executors = async () => { throw new Error('must not enumerate'); };
  assert.equal((await readEnvironmentReadiness(f.sources, member, 'synthetic-target')).target, null);
});

test('administrator management visibility never substitutes for use assignment', async () => {
  const f = fixture(); f.sources.account = async () => ({ ...member, role: 'admin' } as User);
  f.sources.source = async () => ({ bytes }); f.sources.canUse = async () => false;
  const report = await readEnvironmentReadiness(f.sources, member, 'synthetic-target');
  assert.equal(report.executors[0].executor, f.candidates[0].id);
  assert.equal(verdict(report, 'assignment'), false); assert.equal(verdict(report, 'manifest'), true);
});

test('unreadable sources stay unknown, corrupt bytes fail SHA, and exception text never escapes', async () => {
  for (const answer of [null, { bytes: null }]) {
    const f = fixture(); f.sources.source = async () => answer;
    const report = await readEnvironmentReadiness(f.sources, member, 'synthetic-target');
    assert.equal(verdict(report, 'manifest'), null); assert.equal(verdict(report, 'evidence.0.0'), null);
    assert.ok(report.executors[0].checks.every(check => check.references.length === 0));
  }
  const f = fixture(); f.sources.source = async () => ({ bytes: Buffer.from('different') });
  const report = await readEnvironmentReadiness(f.sources, member, 'synthetic-target');
  assert.equal(verdict(report, 'manifest'), false); assert.equal(verdict(report, 'evidence.0.0'), false);
  f.sources.source = async () => { throw new Error('private://secret-host/password'); };
  assert.doesNotMatch(JSON.stringify(await readEnvironmentReadiness(f.sources, member, 'synthetic-target')), /secret-host|password/);
});

test('all exact-target executors stay separate, unauthorized siblings and other targets remain hidden', async () => {
  const f = fixture(), first = f.candidates[0];
  f.candidates.push({ id: 'exe_' + '2'.repeat(26), definition: { ...first.definition, enabled: false } }, { id: 'exe_' + '3'.repeat(26), definition: { ...first.definition, target: 'other-target' } }, { id: 'exe_' + '4'.repeat(26), definition: first.definition });
  f.sources.canUse = async (_actor, id) => !id.endsWith('4'.repeat(26));
  const report = await readEnvironmentReadiness(f.sources, member, 'synthetic-target');
  assert.equal(report.executors.length, 2); assert.deepEqual(report.executors.map(row => row.ordinal), [1, 2]);
  assert.equal(verdict(report, 'enabled', 0), true); assert.equal(verdict(report, 'enabled', 1), false);
  assert.equal(f.reads.length, 4); assert.doesNotMatch(JSON.stringify(report), /other-target|exe_/);
});

test('local lease occupancy never returns holder identities and a failed read stays unknown', async () => {
  const f = fixture();
  f.sources.leases.view = async () => ({ entries: [{ key: 'synthetic/device/a', user: 'hidden-user', run: 'hidden-run', lease: 'hidden-lease', since: instant, until: null }, { key: 'not-declared', user: 'other-hidden-user', since: instant, until: null }] }) as unknown as Awaited<ReturnType<EnvironmentReadinessSources['leases']['view']>>;
  const report = await readEnvironmentReadiness(f.sources, member, 'synthetic-target');
  assert.equal(verdict(report, 'local_leases_clear'), false);
  assert.deepEqual(report.executors[0].occupancy, [{ mine: false, since: instant, until: null }]);
  assert.doesNotMatch(JSON.stringify(report), /hidden-user|hidden-run|hidden-lease|synthetic\/device|not-declared/);
  f.sources.leases.view = async () => { throw new Error('private details'); };
  const failed = await readEnvironmentReadiness(f.sources, member, 'synthetic-target');
  assert.equal(failed.executors[0].occupancy, null); assert.equal(verdict(failed, 'local_leases_clear'), null);
});

test('baseline registration is metadata-only, absent is false and failed metadata reads are unknown', async () => {
  const f = fixture(), current = f.candidates[0].definition;
  current.bed_state = ExecutorDefinition.parse({ ...current, allowed_tools: [...current.allowed_tools, 'inspect_baseline'], bed_state: { items: [{ id: 'private-probe-name', call: { tool: 'inspect_baseline', arguments: { ticket: { $value: 'lease_id' } } }, parser: { kind: 'address_table', rows: '/rows', address: '/address', manifest_devices: '/devices', manifest_lists: ['/addresses'] }, cleanup: { actor: 'private-owner', command: 'private-cleanup' } }] } }).bed_state;
  f.sources.baseline = async () => ({ recorded_at: instant, get text() { throw new Error('baseline text must never be read'); } });
  const report = await readEnvironmentReadiness(f.sources, member, 'synthetic-target');
  assert.equal(verdict(report, 'baseline.0'), true);
  assert.deepEqual(report.executors[0].baseline_registrations, [{ ordinal: 1, recorded_at: instant }]);
  assert.doesNotMatch(JSON.stringify(report), /private-probe|private-owner|private-cleanup/);
  f.sources.baseline = async () => null;
  assert.equal(verdict(await readEnvironmentReadiness(f.sources, member, 'synthetic-target'), 'baseline.0'), false);
  f.sources.baseline = async () => { throw new Error('private-error'); };
  const unknown = await readEnvironmentReadiness(f.sources, member, 'synthetic-target');
  assert.equal(verdict(unknown, 'baseline.0'), null); assert.doesNotMatch(JSON.stringify(unknown), /private-error/);
});

test('permission checks fail with a call error while missing configuration remains an independent unknown', async () => {
  const f = fixture(); f.sources.canUse = async () => { throw new Error('private-permission-error'); };
  for(const role of ['user','admin'] as const) {
    f.sources.account=async()=>({...member,role} as User);
    await assert.rejects(readEnvironmentReadiness(f.sources,member,'synthetic-target'),error=>{
      assert.ok(error instanceof EffectBoundaryError);
      assert.equal(error.failure.code,'ENVIRONMENT_PERMISSION_UNAVAILABLE');
      assert.equal(error.failure.message,'测试环境的权限核对现在不能进行，这次没有执行');
      assert.equal(error.failure.fix,role==='admin'?'请联系维护人员恢复测试环境权限核对':'请联系管理员');
      assert.doesNotMatch(JSON.stringify(error.failure),/private-permission-error|synthetic-target|src:/);
      return true;
    });
  }
  assert.deepEqual(f.reads,[]);
  f.sources.executors = async () => { throw new Error('private-config'); };
  const unknown = await readEnvironmentReadiness(f.sources, member, 'synthetic-target');
  assert.equal(unknown.target, null); assert.deepEqual(unknown.executors, []); assert.ok(unknown.missing_fact);
  assert.doesNotMatch(JSON.stringify(unknown), /private-config/);
});

test('assembly adapter paginates configuration identities and reads only actor-authorized source bytes', async () => {
  const f = fixture(), calls: unknown[][] = [];
  const current = f.candidates[0].definition;
  current.bed_state = ExecutorDefinition.parse({ ...current, allowed_tools: [...current.allowed_tools, 'inspect_baseline'], bed_state: { items: [{ id: 'metadata-only', call: { tool: 'inspect_baseline', arguments: { ticket: { $value: 'lease_id' } } }, parser: { kind: 'address_table', rows: '/rows', address: '/address', manifest_devices: '/devices', manifest_lists: ['/addresses'] }, cleanup: { actor: 'private-owner', command: 'private-cleanup' } }] } }).bed_state;
  Object.defineProperty(current, 'credential', { get() { throw new Error('credential must not be touched'); } });
  Object.defineProperty(current, 'endpoint', { get() { throw new Error('no endpoint or network is needed'); } });
  const records = {
    principals: { get: f.sources.account },
    authorizations: { history: async (query: { cursor: string | null; permission: string }) => {
      calls.push(['history', query]);
      return query.cursor === null ? { items: [{ body: { object: 'executor.exe-b' } }], next: 'second-page' } : { items: [{ body: { object: 'executor.exe-a' } }, { body: { object: 'executor.exe-b' } }, { body: { object: 'unrelated-resource' } }], next: null };
    } },
    artifacts: { source: async (...args: unknown[]) => { calls.push(['source', ...args]); return { bytes }; }, ingest: () => { throw new Error('must not write'); } },
    get objects() { throw new Error('raw objects are forbidden'); },
    get vault() { throw new Error('secret values are forbidden'); },
  } as unknown as RecordsKit;
  const registry: Pick<ExecutorRegistry, 'get'> = { get: async id => { calls.push(['get', id]); return { id, definition: current } as RegisteredExecutor; } };
  const baseline = { getBaseline: async () => ({ created_at: instant, get text() { throw new Error('must not inspect baseline body'); } }) };
  const read = createEnvironmentReadiness(records, registry, baseline, f.sources.leases, async (actor, id) => { calls.push(['permission', actor, id]); assert.equal(actor.role, 'user'); return true; }, f.sources.now);
  const report = await read({ ...member, role: 'admin' }, 'synthetic-target');
  assert.equal(report.executors.length, 2);
  assert.deepEqual(calls.filter(call => call[0] === 'get'), [['get', 'exe-a'], ['get', 'exe-b']]);
  assert.equal(calls.filter(call => call[0] === 'history').length, 2);
  assert.equal(calls.filter(call => call[0] === 'source').length, 4);
  for (const call of calls.filter(call => call[0] === 'source')) assert.deepEqual(call.slice(1), [{ ...member, disabled: false, deleted_at: null }, hash, { consumer: 'function' }]);
  assert.deepEqual(report.executors.map(row => row.baseline_registrations), [[{ ordinal: 1, recorded_at: instant }], [{ ordinal: 1, recorded_at: instant }]]);
  assert.doesNotMatch(JSON.stringify(report), /exe-a|exe-b|private-owner|private-cleanup/);
});

test('assembly adapter never turns an unresolved configuration into an empty successful report', async () => {
  const f = fixture();
  const records = { principals: { get: f.sources.account }, authorizations: { history: async () => ({ items: [{ body: { object: 'executor.exe-a' } }], next: null }) }, artifacts: { source: async () => { throw new Error('must not read sources'); } } } as unknown as RecordsKit;
  const registry: Pick<ExecutorRegistry, 'get'> = { get: async () => { throw new Error('private-variable-name'); } };
  const read = createEnvironmentReadiness(records, registry, { getBaseline: async () => null }, f.sources.leases, async () => true, f.sources.now);
  const report = await read(member, 'synthetic-target');
  assert.equal(report.target, null); assert.deepEqual(report.executors, []); assert.ok(report.missing_fact);
  assert.doesNotMatch(JSON.stringify(report), /private-variable-name/);
});
