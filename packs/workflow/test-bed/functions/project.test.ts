// The test-bed projection on synthetic inventories: search items in matchNeed order with the exact "Hub 记录里"
// wording, facts items, the acquire plan and its lease_requests, the invalid-manifest whole-call refusal, and the
// frozen groups the check reads. Addresses only 192.0.2.0/24 and 2001:db8::/32.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import project from './project.ts';

const NOW = '2026-10-22T02:00:00.000Z';
const LATER = '2026-10-22T05:00:00.000Z';

/** bed-a: apv0 + router0 + client0 + server0(+service) + console0; bed-b: only a client. */
const MANIFEST = {
  schema: 'test-bed-manifest@1',
  beds: [
    {
      name: 'bed-a',
      devices: [
        { name: 'apv0', type: 'load-balancer', product: 'apv', ipv4: ['192.0.2.10/26', '192.0.2.74/26'], ipv6: [] },
        { name: 'router0', type: 'router', ipv4: ['192.0.2.1/26'], ipv6: [] },
        { name: 'client0', type: 'client', ipv4: ['192.0.2.80/26'], ipv6: [] },
        { name: 'server0', type: 'server', ipv4: ['192.0.2.90/26'], ipv6: [] },
        { name: 'console0', type: 'console', ipv4: ['192.0.2.140/26'], ipv6: [] },
      ],
      services: [{ host: 'server0', ip: '192.0.2.90', proto: 'tcp', port: 80 }],
      reserved: ['192.0.2.1-192.0.2.9', '192.0.2.65-192.0.2.69'],
    },
    {
      name: 'bed-b',
      devices: [{ name: 'client1', type: 'client', ipv4: ['192.0.2.150/26'], ipv6: [] }],
      services: [],
      reserved: [],
    },
  ],
};

function input(parameters: Record<string, unknown>, options: { manifest?: unknown; leases?: Array<{ key: string; until: string; mine?: boolean }> } = {}): unknown {
  return {
    inputs: [{ slot: 'inventory', external: 'doc:doc:bed-topology', sha256: 'a'.repeat(64), media_type: 'application/json', parser: 'json@1', model: options.manifest ?? MANIFEST, meta: null }],
    parameters,
    context: { product: null, names: [], line: null, build: null, root: null, parameters, groups: [], leases: { now: NOW, entries: options.leases ?? [] } },
  };
}

const fieldsOf = (out: unknown, bed: string): Record<string, unknown> => {
  const items = (out as { items?: Array<{ fields: Record<string, unknown> }> }).items ?? [];
  const fields = items.find((item) => (item.fields as { bed?: unknown }).bed === bed)?.fields;
  assert.ok(fields, `an item for ${bed}`);
  return fields;
};

describe('project action search', () => {
  it('lists every bed with the exact idle wording; a short bed says what it lacks; a leased bed names its earliest free moment', () => {
    const out = project(input({ need: { devices: [{ type: 'client', count: 1 }], hours: 2 } }));
    assert.ok(!('error' in Object(out)), JSON.stringify(out).slice(0, 300));
    const a = fieldsOf(out, 'bed-a');
    assert.equal(a.devices_ok, true);
    assert.equal(a.earliest_free, null);
    assert.match(String(a.conclusion), /Hub 记录里空闲（未排除本地操作）$/);
    const b = fieldsOf(out, 'bed-b');
    assert.equal(b.devices_ok, true, 'one client is enough');
    // bed-b cannot give a load balancer and a client.
    const out2 = project(input({ need: { devices: [{ type: 'load-balancer', count: 1 }, { type: 'client', count: 1 }], hours: 2 } }));
    const b2 = fieldsOf(out2, 'bed-b');
    assert.equal(b2.devices_ok, false);
    assert.deepEqual(b2.missing, ['需要 1 台负载均衡，台架里有 0 台']);
    const leased = project(input({ need: { devices: [{ type: 'client', count: 1 }], hours: 2 } }, { leases: [{ key: 'bed/bed-a/client0', until: LATER }] }));
    const a3 = fieldsOf(leased, 'bed-a');
    assert.equal(a3.earliest_free, LATER);
    assert.match(String(a3.conclusion), new RegExp(`Hub 记录里最早 ${LATER.replaceAll('.', '\\.')} 空闲（未排除本地操作）`));
    const group = (leased as { groups?: Array<Record<string, unknown>> }).groups?.[0];
    assert.ok(group);
    assert.equal(group.action, 'search');
    assert.deepEqual(group.manifest, MANIFEST);
    assert.deepEqual(group.leases, { now: NOW, entries: [{ key: 'bed/bed-a/client0', until: LATER }] });
  });

  it('build verdicts stay unknown with no install records (bed-version is not built)', () => {
    const out = project(input({ need: { devices: [{ type: 'client', count: 1 }], build: 'Rel_APV_10_6_1_57', hours: 2 } }));
    const a = fieldsOf(out, 'bed-a');
    assert.equal(a.build_ok, 'unknown');
    assert.match(String(a.conclusion), /设备上装的构建没有记录（未知）/);
  });
});

describe('project action facts', () => {
  it('computes listeners on segments with a trigger device and blind addresses on segments without one', () => {
    const out = project(input({ action: 'facts' }));
    const a = fieldsOf(out, 'bed-a');
    assert.deepEqual(
      (a.listeners as Array<{ device: string; address: string }>).map((l) => [l.device, l.address]),
      [
        ['apv0', '192.0.2.10'],
        ['apv0', '192.0.2.74'],
      ],
      'both apv0 addresses share a segment with router0 or client0',
    );
    assert.deepEqual(a.blind, [], 'no blind address on bed-a');
    const blindManifest = {
      schema: 'test-bed-manifest@1',
      beds: [
        {
          name: 'bed-c',
          devices: [
            { name: 'apv1', type: 'load-balancer', ipv4: ['192.0.2.10/26', '192.0.2.74/26'], ipv6: [] },
            { name: 'router1', type: 'router', ipv4: ['192.0.2.1/26'], ipv6: [] },
          ],
          services: [],
          reserved: [],
        },
      ],
    };
    const c = fieldsOf(project(input({ action: 'facts' }, { manifest: blindManifest })), 'bed-c');
    assert.deepEqual((c.listeners as Array<{ address: string }>).map((l) => l.address), ['192.0.2.10'], 'the address beside router1 listens');
    assert.deepEqual((c.blind as Array<{ address: string; subnet: string }>).map((b) => [b.address, b.subnet]), [['192.0.2.74', '192.0.2.64/26']], 'the other segment has no trigger');
  });
});

describe('project action acquire', () => {
  it('plans the chosen bed with lease keys for the picked devices, the TTL, and ip keys for addresses', () => {
    const out = project(
      input({ action: 'acquire', bed: 'bed-a', need: { devices: [{ type: 'load-balancer', count: 1 }, { type: 'client', count: 1 }], hours: 3 }, addresses: { segment: '192.0.2.64/26', count: 2 } }),
    ) as { items?: unknown[]; lease_requests?: Array<{ keys: string[]; ttl_seconds: number }>; groups?: Array<Record<string, unknown>> };
    assert.deepEqual(out.lease_requests, [
      {
        keys: ['bed/bed-a/apv0', 'bed/bed-a/client0', 'bed/bed-a/ip/192.0.2.70', 'bed/bed-a/ip/192.0.2.71'],
        ttl_seconds: 3 * 3600,
      },
    ]);
    const fields = fieldsOf(out, 'bed-a');
    assert.deepEqual(fields.devices, ['apv0', 'client0']);
    assert.deepEqual(fields.addresses, ['192.0.2.70', '192.0.2.71']);
    assert.match(String(fields.conclusion), /^预订 bed-a/);
    const group = out.groups?.[0] as { lease_requests?: Array<{ keys: string[] }> };
    assert.deepEqual(group.lease_requests, out.lease_requests, 'the frozen groups carry the same request');
  });

  it('picks the best match when bed is not given, and refuses a taken or missing bed with its reason', () => {
    const best = project(input({ action: 'acquire', need: { devices: [{ type: 'client', count: 1 }], hours: 1 } })) as { lease_requests?: Array<{ keys: string[] }> };
    assert.deepEqual(best.lease_requests?.[0]?.keys, ['bed/bed-a/client0'], 'bed-a wins over bed-b (name order, both fit)');
    const taken = project(input({ action: 'acquire', bed: 'bed-a', need: { devices: [{ type: 'client', count: 1 }], hours: 1 } }, { leases: [{ key: 'bed/bed-a/client0', until: LATER }] })) as { lease_requests?: Array<{ keys: string[] }> };
    assert.deepEqual(taken.lease_requests?.[0]?.keys, ['bed/bed-a/client0'], 'a taken device still yields a request: the Hub refuses it with LEASE_UNAVAILABLE and the earliest free moment');
    const missingBed = project(input({ action: 'acquire', bed: 'bed-z', need: { devices: [{ type: 'client', count: 1 }], hours: 1 } })) as { error?: { code: string } };
    assert.equal(missingBed.error?.code, 'test-bed.unknown_bed');
    const nothing = project(input({ action: 'acquire', bed: 'bed-a', hours: 1 })) as { error?: { code: string } };
    assert.equal(nothing.error?.code, 'test-bed.nothing_to_lease');
    const short = project(input({ action: 'acquire', need: { devices: [{ type: 'client', count: 1 }], hours: 1 }, addresses: { segment: '192.0.2.64/26', count: 60 } })) as { error?: { code: string } };
    assert.equal(short.error?.code, 'test-bed.not_enough_addresses');
  });
});

describe('project action extend and release', () => {
  const HELD = [
    { key: 'bed/bed-a/apv0', until: LATER, mine: true },
    { key: 'bed/bed-a/client0', until: LATER, mine: true },
    { key: 'bed/bed-a/ip/192.0.2.70', until: LATER, mine: true },
    { key: 'bed/bed-b/client1', until: LATER, mine: false },
  ];

  it('extend: the lineage-held keys with the extension TTL, devices and addresses named', () => {
    const out = project(input({ action: 'extend', booking: 'run_book1', hours: 3 }, { leases: HELD })) as { lease_requests?: unknown[]; groups?: Array<Record<string, unknown>>; items?: Array<{ fields: Record<string, unknown> }> };
    assert.deepEqual(out.lease_requests, [{ op: 'extend', keys: ['bed/bed-a/apv0', 'bed/bed-a/client0', 'bed/bed-a/ip/192.0.2.70'], ttl_seconds: 10800 }]);
    assert.equal(out.items?.length, 1);
    assert.equal(out.items?.[0]?.fields.conclusion, '续期 bed-a 的预订 run_book1，设备 apv0、client0，地址 192.0.2.70，延长 3 小时');
    const group = out.groups?.[0] as { booking?: string; lease_requests?: unknown[] };
    assert.equal(group.booking, 'run_book1');
    assert.deepEqual(group.lease_requests, out.lease_requests, 'the frozen groups carry the same request');
  });

  it('extend: hours falls back to need.hours', () => {
    const out = project(input({ action: 'extend', booking: 'run_book1', need: { hours: 5 } }, { leases: HELD })) as { lease_requests?: Array<{ ttl_seconds?: number }> };
    assert.equal(out.lease_requests?.[0]?.ttl_seconds, 5 * 3600);
  });

  it('release: the lineage-held keys without a TTL', () => {
    const out = project(input({ action: 'release', booking: 'run_book1' }, { leases: HELD })) as { lease_requests?: unknown[]; items?: Array<{ fields: Record<string, unknown> }> };
    assert.deepEqual(out.lease_requests, [{ op: 'release', keys: ['bed/bed-a/apv0', 'bed/bed-a/client0', 'bed/bed-a/ip/192.0.2.70'] }]);
    assert.match(String(out.items?.[0]?.fields.conclusion), /^释放 bed-a 的预订 run_book1，设备 apv0、client0，地址 192.0.2.70$/);
  });

  it('refuses honestly when the lineage holds nothing (rows without mine are someone else’s)', () => {
    const out = project(input({ action: 'extend', booking: 'run_book1', hours: 2 }, { leases: HELD.map((row) => ({ key: row.key, until: row.until })) })) as { error?: { code: string; message: string } };
    assert.equal(out.error?.code, 'test-bed.not_holder');
    assert.match(String(out.error?.message), /^你没有持有这个预订/);
    const released = project(input({ action: 'release', booking: 'run_book1' })) as { error?: { code: string } };
    assert.equal(released.error?.code, 'test-bed.not_holder');
  });

  it('requires the booking run id for extend and release', () => {
    const out = project(input({ action: 'extend', hours: 2 }, { leases: HELD })) as { error?: { code: string } };
    assert.equal(out.error?.code, 'test-bed.bad_booking');
    const rel = project(input({ action: 'release' }, { leases: HELD })) as { error?: { code: string } };
    assert.equal(rel.error?.code, 'test-bed.bad_booking');
  });
});

describe('project on a bad inventory', () => {
  it('refuses the whole call with every problem and its pointer when the manifest is invalid', () => {
    const dup = {
      schema: 'test-bed-manifest@1',
      beds: [
        {
          name: 'bed-a',
          devices: [
            { name: 'apv0', type: 'load-balancer', ipv4: ['192.0.2.10/26'], ipv6: [] },
            { name: 'router0', type: 'router', ipv4: ['192.0.2.10/26'], ipv6: [] },
          ],
          services: [],
          reserved: [],
        },
      ],
    };
    const out = project(input({}, { manifest: dup })) as { error?: { code: string; message: string }; warnings?: Array<{ message: string }> };
    assert.equal(out.error?.code, 'test-bed.manifest_invalid');
    assert.ok((out.warnings ?? []).some((w) => w.message.includes('/beds/0/devices/1/ipv4/0')), JSON.stringify(out.warnings).slice(0, 300));
  });
});
