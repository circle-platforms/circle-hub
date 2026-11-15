// Device observations (decision 111): at a booking the Hub probes the requested seats read-only and records what each
// showed; the newest observation of each seat is what a reader gets; the version probe before a dispatch records one too.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalBytes } from '../records/api.ts';
import { setup } from './testing/context.ts';
import { probes } from './testing/probes.ts';

async function bound(build: (seat: number) => string) {
  const c = await setup({ extraTools: ['inspect_seat'], alter: (name, value) => {
    if (name !== 'inspect_seat') return value;
    const args = c.endpoint.calls.filter((e) => e.params.name === 'inspect_seat').at(-1)!.params.arguments as Record<string, unknown>;
    return { output: args.command === 'inspect version' ? `version: ${build(Number(args.seat))}` : `address: 192.0.2.${Number(args.seat) + 1}` };
  } });
  const manifest = await c.kit.artifacts.ingest({ bytes: canonicalBytes({ id: 'synthetic-bed', devices: [1, 2].map((n) => ({ interfaces: [{ address: `192.0.2.${n}/24` }] })) }), mediaType: 'application/json', origin: { upload: { session: 'synthetic' } }, author: { user: c.admin.id }, provenanceType: 'declared', visibility: { readers: [c.owner.id, c.admin.id], admins: true, packs: [], shareable: false } });
  await c.registry.update(c.admin, c.executor.id, { ...c.executor.definition, manifest_sha256: manifest.body.sha256, allowed_tools: [...c.executor.definition.allowed_tools, 'inspect_seat'], probes });
  c.effectDocument.effects[0].parameters.values.manifest_sha256 = [manifest.body.sha256];
  c.detail.run.sources.find((source) => source.slot === 'synthetic-manifest')!.reference = `src:${manifest.body.sha256}`;
  const result = c.detail.latest!.result.partitions.delivered[0].requirements[0] as any;
  result.claims[0]!.statement.data.bed.manifest_sha256 = manifest.body.sha256;
  await c.freezeExecutor();
  return { c, inventory: manifest.body.sha256 };
}

test('a booking looks at the requested seats only, records each echo, and the newest observation of a seat is what is read', async (t) => {
  let round = 0;
  const { c, inventory } = await bound((seat) => (round === 0 ? `synthetic-build-${seat}` : 'synthetic-build-later'));
  t.after(() => c.close());
  const first = await c.service.observeDevices(c.owner, 'run_synthetic', [{ inventory, device: '/devices/1', label: 'bed/synthetic-1' }]);
  assert.equal(first.missing, null);
  assert.deepEqual(first.observed.map((o) => [o.label, o.build, o.run, o.job]), [['bed/synthetic-1', 'synthetic-build-1', 'run_synthetic', null]]);
  const versionCalls = c.endpoint.calls.filter((e) => e.params.name === 'inspect_seat' && (e.params.arguments as Record<string, unknown>).command === 'inspect version');
  assert.deepEqual(versionCalls.map((e) => (e.params.arguments as Record<string, unknown>).seat), [1], 'only the requested seat is probed');
  assert.ok(!c.calls.includes('send_blob'), 'nothing is dispatched');
  round = 1;
  await c.service.observeDevices(c.owner, 'run_synthetic_2', [{ inventory, device: '/devices/1', label: 'bed/synthetic-1' }]);
  const latest = await c.service.latestDeviceObservations();
  assert.deepEqual(latest.map((o) => [o.device, o.build, o.run]), [['/devices/1', 'synthetic-build-later', 'run_synthetic_2']], 'the newest of the seat; a seat never looked at is absent');
});

test('a device no executor seat points at, or of another inventory, is named as missing and nothing is probed for it', async (t) => {
  const { c, inventory } = await bound(() => 'synthetic-build');
  t.after(() => c.close());
  const result = await c.service.observeDevices(c.owner, 'run_synthetic', [{ inventory: 'c'.repeat(64), device: '/devices/0', label: 'bed/other' }, { inventory, device: '/devices/9', label: 'bed/absent' }]);
  assert.deepEqual(result.observed, []);
  assert.match(result.missing ?? '', /bed\/other：没有绑定同一份清单、指向这台设备的执行器版本探针；bed\/absent：/);
  assert.equal(c.endpoint.calls.filter((e) => e.params.name === 'inspect_seat').length, 0);
});

test('an echo with no single build is an observation with a null build and the reason', async (t) => {
  const { c, inventory } = await bound(() => '');
  t.after(() => c.close());
  const result = await c.service.observeDevices(c.owner, 'run_synthetic', [{ inventory, device: '/devices/0', label: 'bed/synthetic-0' }]);
  assert.equal(result.observed[0]?.build, null);
  assert.equal(result.observed[0]?.note, '版本探针的回显里没有抽到构建');
});


test('a complete booking observation serves every probe round without another device call or a freshened timestamp', async (t) => {
  const { c, inventory } = await bound(() => 'synthetic-build');
  t.after(() => c.close());
  const booking = c.detail.run.predecessor!;
  await c.service.observeDevices(c.owner, booking, [
    { inventory, device: '/devices/0', label: 'bed/synthetic-0' },
    { inventory, device: '/devices/1', label: 'bed/synthetic-1' },
  ]);
  const before = (await c.service.latestDeviceObservations()).map((row) => row.observed_at);
  c.detail.run.requirements = [{ key: 'workbook_verified', name: '合成核验', description: '合成', layers: ['static', 'dynamic'], done_rule: 'gating', accepted_producer: 'fact', repair_rounds: 0, rules: [], run_interpreters: [], repetition: { count: 2, aggregation: 'all', basis: 'explicit', declared: { count: true, aggregation: true, k: false }, fresh_context: true } }];
  (c.effectDocument.effects[0] as { repetition?: number }).repetition = 2;
  c.calls.length = 0;
  const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(state.outcome, 'effective', JSON.stringify(state));
  assert.deepEqual(state.rounds?.map((row) => row.round), [1, 2]);
  assert.equal(c.calls.filter((name) => name === 'inspect_seat').length, 0, 'both rounds replay the complete booking responses');
  assert.equal(c.calls.filter((name) => name === 'send_blob').length, 2, 'only the actual effects are sent');
  const probes = (await c.service.journal.events(state.job)).filter((event) => event.body.detail.phase === 'device_probe');
  assert.equal(probes.length, 8, 'four replayed assessments per round');
  assert.ok(probes.every((event) => event.body.detail.reused_booking_run === booking));
  assert.deepEqual((await c.service.latestDeviceObservations()).map((row) => row.observed_at), before, 'a replay never pretends the device was read again');
});

test('a changed executor definition invalidates the booking replay and probes every seat again', async (t) => {
  const { c, inventory } = await bound(() => 'synthetic-build');
  t.after(() => c.close());
  await c.service.observeDevices(c.owner, c.detail.run.predecessor!, [
    { inventory, device: '/devices/0', label: 'bed/synthetic-0' },
    { inventory, device: '/devices/1', label: 'bed/synthetic-1' },
  ]);
  const current = (await c.registry.get(c.executor.id))!.definition;
  await c.registry.update(c.admin, c.executor.id, { ...current, poll_ms: current.poll_ms + 1 });
  await c.freezeExecutor();
  c.calls.length = 0;
  const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(state.outcome, 'effective', JSON.stringify(state));
  assert.equal(c.calls.filter((name) => name === 'inspect_seat').length, 4, 'version and interface reads happen on both seats');
  const probes = (await c.service.journal.events(state.job)).filter((event) => event.body.detail.phase === 'device_probe');
  assert.ok(probes.every((event) => event.body.detail.reused_booking_run === undefined));
});
