// The readers of a frozen booking are pinned to the writers of this pack: the keys installsOf writes and the pointers
// devicePointer names are the ones bookedInstalls and bookedBedLease read back. Synthetic data only (192.0.2.0/24).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { bedDeviceKey, parseBedDeviceKey } from './bed-key.ts';
import { bookedBedLease, bookedInstalls, frozenBeds } from './booking.ts';
import { devicePointer, installsOf, manifestBeds, type Observation } from './conclude.ts';

const manifest = {
  schema: 'test-bed-manifest@1',
  beds: [
    { name: 'bed-a', devices: [
      { name: 'afamx0', type: 'load-balancer', product: 'famx', ipv4: ['192.0.2.10/26'], ipv6: [] },
      { name: 'router0', type: 'router', ipv4: ['192.0.2.1/26'], ipv6: [] },
      { name: 'client0', type: 'client', ipv4: ['192.0.2.80/26'], ipv6: [] },
    ], services: [], reserved: [] },
    { name: 'bed-b', devices: [{ name: 'afamx0', type: 'load-balancer', product: 'famx', ipv4: ['192.0.2.130/26'], ipv6: [] }], services: [], reserved: [] },
  ],
};
const INVENTORY = 'f'.repeat(64);

/** What the Hub gives a projection (the flat observation) and what start_run freezes into the run (a claim per device). */
function observed(bed: string, device: string, build: string): { flat: Observation; claim: unknown } {
  const pointer = devicePointer(manifest, bed, device)!;
  return {
    flat: { inventory: INVENTORY, device: pointer, label: device, build, base: null, observed_at: '2026-11-01T00:00:00.000Z' },
    claim: { statement: { data: { inventory: INVENTORY, device: pointer, build } }, qualifier: { provenance: 'observed' } },
  };
}

describe('the device lease key', () => {
  it('reads back what it writes, and reads no other key as a device', () => {
    assert.deepEqual(parseBedDeviceKey(bedDeviceKey('bed-a', 'afamx0')), { bed: 'bed-a', device: 'afamx0' });
    assert.equal(parseBedDeviceKey('bed-a/afamx0'), null);
    assert.equal(parseBedDeviceKey('bed/bed-a/ip/192.0.2.10'), null, 'an address key has four parts');
    assert.equal(parseBedDeviceKey('bed//afamx0'), null);
    assert.equal(parseBedDeviceKey('lease/bed-a/afamx0'), null);
  });

  it('is written through bedDeviceKey by every writer of this pack, not by a template of its own', () => {
    for (const file of ['conclude.ts', 'match.ts']) {
      const text = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      assert.doesNotMatch(text, /`bed\/\$\{[^}]+\}\/\$\{[^}]+\}`/, `${file} writes a device key by hand`);
      assert.doesNotMatch(text, /'bed\/'\s*\+/, `${file} writes a device key by hand`);
    }
  });
});

describe('a frozen booking is read back as the pack wrote it', () => {
  const parsed = manifestBeds(manifest);
  assert.ok(parsed.ok);
  const afamx = observed('bed-a', 'afamx0', 'Build.One'), router = observed('bed-a', 'router0', 'Build.Two'), other = observed('bed-b', 'afamx0', 'Build.Three');
  const installs = installsOf(manifest, parsed.ok ? parsed.beds : [], INVENTORY, [afamx.flat, router.flat, other.flat]);
  const body = (keys: string[], claims = [afamx.claim, router.claim, other.claim]) => ({
    groups: [{ manifest, inventory: INVENTORY }],
    device_observations: claims,
    leases: [{ op: 'acquire', lease: 'lease_synthetic', keys, until: null }],
  });

  it('gives the builds of the devices the keys installsOf wrote, and only of the booked ones', () => {
    assert.deepEqual(Object.keys(installs.installed).sort(), [bedDeviceKey('bed-a', 'afamx0'), bedDeviceKey('bed-a', 'router0'), bedDeviceKey('bed-b', 'afamx0')]);
    assert.deepEqual(bookedInstalls(body(Object.keys(installs.installed))).sort(), ['Build.One', 'Build.Three', 'Build.Two']);
    assert.deepEqual(bookedInstalls(body([bedDeviceKey('bed-a', 'afamx0')])), ['Build.One'], 'a device nobody booked adds none, and a same-named device of another bed is another device');
    assert.deepEqual(bookedInstalls(body([bedDeviceKey('bed-b', 'afamx0')])), ['Build.Three']);
  });

  it('adds nothing for a booked device nobody looked at, a probe of another inventory, or a claim that was not observed', () => {
    assert.deepEqual(bookedInstalls(body([bedDeviceKey('bed-a', 'client0')])), []);
    const foreign = { statement: { data: { inventory: 'e'.repeat(64), device: devicePointer(manifest, 'bed-a', 'afamx0'), build: 'Build.Old' } }, qualifier: { provenance: 'observed' } };
    assert.deepEqual(bookedInstalls(body([bedDeviceKey('bed-a', 'afamx0')], [foreign])), []);
    const declared = { statement: { data: { inventory: INVENTORY, device: devicePointer(manifest, 'bed-a', 'afamx0'), build: 'Build.Said' } }, qualifier: { provenance: 'declared' } };
    assert.deepEqual(bookedInstalls(body([bedDeviceKey('bed-a', 'afamx0')], [declared])), []);
    assert.deepEqual(bookedInstalls({ ...body([bedDeviceKey('bed-a', 'afamx0')]), groups: [{ manifest }] }), [], 'no inventory digest, no installs');
    assert.deepEqual(bookedInstalls(null), []);
  });

  it('names the lease that holds a device of a bed, not one that holds only addresses', () => {
    assert.equal(bookedBedLease(body([bedDeviceKey('bed-a', 'afamx0')])), 'lease_synthetic');
    assert.equal(bookedBedLease(body(['bed/bed-a/ip/192.0.2.10'])), null);
    assert.equal(bookedBedLease({}), null);
    assert.equal(bookedBedLease(undefined), null);
  });

  it('gives the beds and devices of the manifest, nothing when none was frozen, and a problem when it cannot be read', () => {
    const beds = frozenBeds(body([]));
    assert.ok(beds?.ok);
    assert.deepEqual(beds && beds.ok ? [...beds.beds] : null, [['bed-a', ['afamx0', 'router0', 'client0']], ['bed-b', ['afamx0']]]);
    assert.equal(frozenBeds({}), null);
    assert.equal(frozenBeds({ groups: [] }), null);
    assert.equal(frozenBeds({ groups: [{ inventory: INVENTORY }] }), null);
    const unreadable = frozenBeds({ groups: [{ manifest: { schema: 'test-bed-manifest@2', sites: [] } }] });
    assert.ok(unreadable && !unreadable.ok, 'a manifest without beds is a problem, never an empty list');
    assert.ok(frozenBeds({ groups: [{ manifest: 'text' }] } as never) && !(frozenBeds({ groups: [{ manifest: 'text' }] } as never) as { ok: boolean }).ok);
  });
});
