import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newId } from '../records/api.ts';
import { leaseGeneration, leasesLive } from './probe-replay.ts';
import { setup } from './testing/context.ts';

type C = Awaited<ReturnType<typeof setup>>;

test('the leases of the resources are one value that changes with any other lease, and a lease released or expired is not live', () => {
  const rows = [{ key: 'b', lease: 'l2' }, { key: 'a', lease: 'l1' }];
  assert.equal(leaseGeneration(rows), leaseGeneration([...rows].reverse()), 'the order the rows come in does not matter');
  assert.notEqual(leaseGeneration(rows), leaseGeneration([{ key: 'b', lease: 'l2' }, { key: 'a', lease: 'l3' }]));
  assert.notEqual(leaseGeneration(rows), leaseGeneration(rows.slice(1)));
  const now = Date.parse('2026-11-16T00:00:00.000Z');
  assert.equal(leasesLive([{ released: false, expires_at: null }, { released: false, expires_at: '2026-11-16T01:00:00.000Z' }], now), true);
  assert.equal(leasesLive([{ released: true, expires_at: null }], now), false);
  assert.equal(leasesLive([{ released: false, expires_at: '2026-11-15T23:59:59.000Z' }], now), false);
  assert.equal(leasesLive([], now), false, 'no lease is no booking');
});

const reads = (c: C, command: 'inspect version' | 'inspect interfaces') => c.endpoint.calls.filter((call) => call.params.name === 'inspect_bound_seat' && (call.params.arguments as Record<string, unknown>).command === command).length;
const inventoryOf = (c: C): string => c.executor.definition.manifest_sha256!;
const seatsOf = (c: C) => [0, 1].map((n) => ({ inventory: inventoryOf(c), device: `/devices/${n}`, label: `bed/synthetic-${n}` }));

async function dispatched(c: C) {
  c.endpoint.calls.length = 0; c.calls.length = 0;
  c.clock.ms += 60_000;
  const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(state.outcome, 'effective', JSON.stringify(state));
  const probes = (await c.service.journal.events(state.job)).filter((event) => event.body.detail.phase === 'device_probe');
  const marked = (check: string) => probes.filter((event) => event.body.detail.check === check && event.body.detail.reused_booking_run !== undefined);
  return { state, versions: reads(c, 'inspect version'), interfaces: reads(c, 'inspect interfaces'), sent: c.calls.filter((name) => name === 'send_blob').length, probes, marked };
}

test('a job under its booking reads the version answers the booking kept instead of asking the devices again, and reads the interfaces itself', async (t) => {
  const c = await setup(); t.after(() => c.close());
  assert.equal((await c.service.observeDevices(c.owner, c.run, seatsOf(c))).missing, null);
  const seen = (await c.service.latestDeviceObservations()).map((row) => row.observed_at);
  const job = await dispatched(c);
  assert.equal(job.versions, 0, 'no version read: the booking has them');
  assert.equal(job.interfaces, 2, 'one interface read for each seat: a job may have changed them');
  assert.equal(job.sent, 1, 'the effect itself is sent as ever');
  assert.equal(job.marked('version').length, 2);
  assert.ok(job.marked('version').every((event) => event.body.detail.reused_booking_run === c.run && event.body.detail.matched === true && typeof event.body.detail.reused_observed_at === 'string'));
  assert.equal(job.marked('interfaces').length, 0);
  assert.deepEqual((await c.service.latestDeviceObservations()).map((row) => row.observed_at), seen, 'a replay never pretends the device was read again');
});

const unchanged = (job: Awaited<ReturnType<typeof dispatched>>) => {
  assert.equal(job.versions, 2, 'every seat is read as it always was');
  assert.equal(job.interfaces, 2);
  assert.equal(job.marked('version').length, 0, 'nothing is marked as reused');
};

test('a changed executor definition, other leases, another booking or a booking that did not see every seat are no reason to trust the kept answers', async (t) => {
  const definition = async (c: C) => { const current = (await c.registry.get(c.executor.id))!.definition; await c.registry.update(c.admin, c.executor.id, { ...current, poll_ms: current.poll_ms + 1 }); await c.freezeExecutor(); };
  const leases = async (c: C) => {
    const keys = c.executor.definition.resources;
    await c.leases.forceRelease({ keys, by: c.admin.id, reason: '合成：换成另一次预订' });
    await c.leases.acquire({ keys, prefix: 'synthetic/', ttlSeconds: 3600, maxTtlSeconds: 3600, holder: { user: c.owner.id, run: c.run } });
  };
  const rows: [string, (c: C) => Promise<void>][] = [
    ['executor definition changed after the booking', async (c) => { await c.service.observeDevices(c.owner, c.run, seatsOf(c)); await definition(c); }],
    ['leases released and booked again after the booking was observed', async (c) => { await c.service.observeDevices(c.owner, c.run, seatsOf(c)); await leases(c); }],
    ['a booking of a run this one does not continue', async (c) => { await c.service.observeDevices(c.owner, newId('run'), seatsOf(c)); }],
    ['a booking that observed one seat only', async (c) => { await c.service.observeDevices(c.owner, c.run, seatsOf(c).slice(0, 1)); }],
    ['no booking observed at all', async () => {}],
  ];
  for (const [why, prepare] of rows) {
    const c = await setup(); t.after(() => c.close());
    await prepare(c);
    const job = await dispatched(c);
    assert.doesNotThrow(() => unchanged(job), why);
  }
});

test('a kept answer that does not match the build is not what a job rests on: the device is read, which may have been put right since', async (t) => {
  let stale = true;
  const c = await setup({ alter: (name, value) => (stale && name === 'inspect_bound_seat' && String(value.output).startsWith('version:') ? { output: 'version: stale-build' } : value) });
  t.after(() => c.close());
  const booking = await c.service.observeDevices(c.owner, c.run, seatsOf(c));
  assert.deepEqual(booking.observed.map((row) => row.build), ['stale-build', 'stale-build'], 'the booking saw the wrong build');
  stale = false;
  const job = await dispatched(c);
  unchanged(job);
  assert.ok(job.probes.filter((event) => event.body.detail.check === 'version').every((event) => event.body.detail.matched === true), 'the job judged what the devices say now');
});
