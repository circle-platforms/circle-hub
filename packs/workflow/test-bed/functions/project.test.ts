// The test-bed projection on synthetic inventories: search items in matchNeed order with the exact "Hub 记录里"
// wording, facts items, the acquire plan and its lease_requests, the invalid-manifest whole-call refusal, and the
// frozen groups the check reads. Addresses only 192.0.2.0/24 and 2001:db8::/32.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import project from './project.ts';

const NOW = '2026-10-22T02:00:00.000Z';
const LATER = '2026-10-22T05:00:00.000Z';

/** bed-a: afamx0 + router0 + client0 + server0(+service) + console0; bed-b: only a client. */
const MANIFEST = {
  schema: 'test-bed-manifest@1',
  beds: [
    {
      name: 'bed-a',
      devices: [
        { name: 'afamx0', type: 'load-balancer', product: 'famx', ipv4: ['192.0.2.10/26', '192.0.2.74/26'], ipv6: [] },
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
    context: { product: null, names: [], line: null, build: null, root: null, parameters, groups: [], leases: { now: NOW, entries: options.leases ?? [], registrations: [] } },
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
    const out = project(input({ need: { devices: [{ type: 'client', count: 1 }] } }));
    assert.ok(!('error' in Object(out)), JSON.stringify(out).slice(0, 300));
    const a = fieldsOf(out, 'bed-a');
    assert.equal(a.devices_ok, true);
    assert.equal(a.earliest_free, null);
    assert.match(String(a.conclusion), /Hub 记录里空闲（未排除本地操作）$/);
    const b = fieldsOf(out, 'bed-b');
    assert.equal(b.devices_ok, true, 'one client is enough');
    // bed-b cannot give a load balancer and a client.
    const out2 = project(input({ need: { devices: [{ type: 'load-balancer', count: 1 }, { type: 'client', count: 1 }] } }));
    const b2 = fieldsOf(out2, 'bed-b');
    assert.equal(b2.devices_ok, false);
    assert.deepEqual(b2.missing, ['需要 1 台负载均衡，台架里有 0 台']);
    const leased = project(input({ need: { devices: [{ type: 'client', count: 1 }] } }, { leases: [{ key: 'bed/bed-a/client0', until: LATER }] }));
    const a3 = fieldsOf(leased, 'bed-a');
    assert.equal(a3.earliest_free, LATER);
    assert.match(String(a3.conclusion), new RegExp(`Hub 记录里最早 ${LATER.replaceAll('.', '\\.')} 空闲（未排除本地操作）`));
    const group = (leased as { groups?: Array<Record<string, unknown>> }).groups?.[0];
    assert.ok(group);
    assert.equal(group.action, 'search');
    assert.deepEqual(group.manifest, MANIFEST);
    assert.deepEqual(group.leases, { now: NOW, entries: [{ key: 'bed/bed-a/client0', until: LATER }], registrations: [] });
  });

  it('build verdicts stay unknown with no install records (bed-version is not built)', () => {
    const out = project(input({ need: { devices: [{ type: 'client', count: 1 }], build: 'Rel_FAMX_10_6_1_57' } }));
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
        ['afamx0', '192.0.2.10'],
        ['afamx0', '192.0.2.74'],
      ],
      'both afamx0 addresses share a segment with router0 or client0',
    );
    assert.deepEqual(a.blind, [], 'no blind address on bed-a');
    const blindManifest = {
      schema: 'test-bed-manifest@1',
      beds: [
        {
          name: 'bed-c',
          devices: [
            { name: 'afamx1', type: 'load-balancer', ipv4: ['192.0.2.10/26', '192.0.2.74/26'], ipv6: [] },
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
      input({ action: 'acquire', bed: 'bed-a', need: { devices: [{ type: 'load-balancer', count: 1 }, { type: 'client', count: 1 }] }, addresses: { segment: '192.0.2.64/26', count: 2 } }),
    ) as { items?: unknown[]; lease_requests?: Array<{ keys: string[]; ttl_seconds: number }>; groups?: Array<Record<string, unknown>> };
    assert.deepEqual(out.lease_requests, [
      {
        keys: ['bed/bed-a/afamx0', 'bed/bed-a/client0', 'bed/bed-a/ip/192.0.2.70', 'bed/bed-a/ip/192.0.2.71'],
      },
    ]);
    const fields = fieldsOf(out, 'bed-a');
    assert.deepEqual(fields.devices, ['afamx0', 'client0']);
    assert.deepEqual(fields.addresses, ['192.0.2.70', '192.0.2.71']);
    assert.match(String(fields.conclusion), /^预订 bed-a/);
    const group = out.groups?.[0] as { lease_requests?: Array<{ keys: string[] }> };
    assert.deepEqual(group.lease_requests, out.lease_requests, 'the frozen groups carry the same request');
  });

  it('picks the best match when bed is not given, and refuses a taken or missing bed with its reason', () => {
    const best = project(input({ action: 'acquire', need: { devices: [{ type: 'client', count: 1 }] } })) as { lease_requests?: Array<{ keys: string[] }> };
    assert.deepEqual(best.lease_requests?.[0]?.keys, ['bed/bed-a/client0'], 'bed-a wins over bed-b (name order, both fit)');
    const taken = project(input({ action: 'acquire', bed: 'bed-a', need: { devices: [{ type: 'client', count: 1 }] } }, { leases: [{ key: 'bed/bed-a/client0', until: LATER }] })) as { lease_requests?: Array<{ keys: string[] }> };
    assert.deepEqual(taken.lease_requests?.[0]?.keys, ['bed/bed-a/client0'], 'a taken device still yields a request: the Hub refuses it with LEASE_UNAVAILABLE and the earliest free moment');
    const missingBed = project(input({ action: 'acquire', bed: 'bed-z', need: { devices: [{ type: 'client', count: 1 }] } })) as { error?: { code: string } };
    assert.equal(missingBed.error?.code, 'test-bed.unknown_bed');
    const nothing = project(input({ action: 'acquire', bed: 'bed-a' })) as { error?: { code: string } };
    assert.equal(nothing.error?.code, 'test-bed.nothing_to_lease');
    const short = project(input({ action: 'acquire', need: { devices: [{ type: 'client', count: 1 }] }, addresses: { segment: '192.0.2.64/26', count: 60 } })) as { error?: { code: string } };
    assert.equal(short.error?.code, 'test-bed.not_enough_addresses');
  });
});

describe('project action extend and release', () => {
  const HELD = [
    { key: 'bed/bed-a/afamx0', until: LATER, mine: true },
    { key: 'bed/bed-a/client0', until: LATER, mine: true },
    { key: 'bed/bed-a/ip/192.0.2.70', until: LATER, mine: true },
    { key: 'bed/bed-b/client1', until: LATER, mine: false },
  ];

  it("reject retired extend: the lineage-held keys with the extension TTL, devices and addresses named",()=>{const out=project(input({action:'extend',booking:'run_book1',hours:3})) as {error?:{code:string;fix:string}};assert.equal(out.error?.code,'test-bed.duration_removed');assert.match(out.error!.fix,/台架预订不限时长/);});

  it("reject retired extend: hours falls back to need.hours",()=>{const out=project(input({action:'acquire',need:{hours:5}})) as {error?:{code:string;fix:string}};assert.equal(out.error?.code,'test-bed.duration_removed');assert.match(out.error!.fix,/台架预订不限时长/);});

  it('release: the lineage-held keys without a TTL', () => {
    const out = project(input({ action: 'release', booking: 'run_book1' }, { leases: HELD })) as { lease_requests?: unknown[]; items?: Array<{ fields: Record<string, unknown> }> };
    assert.deepEqual(out.lease_requests, [{ op: 'release', keys: ['bed/bed-a/afamx0', 'bed/bed-a/client0', 'bed/bed-a/ip/192.0.2.70'] }]);
    assert.match(String(out.items?.[0]?.fields.conclusion), /^释放 bed-a 的预订 run_book1，设备 afamx0、client0，地址 192.0.2.70$/);
  });

  it('refuses honestly when the lineage holds nothing (rows without mine are someone else’s)', () => {
    const out = project(input({ action: 'release', booking: 'run_book1' }, { leases: HELD.map((row) => ({ key: row.key, until: row.until })) })) as { error?: { code: string; message: string } };
    assert.equal(out.error?.code, 'test-bed.not_holder');
    assert.match(String(out.error?.message), /^你没有持有这个预订/);
    const released = project(input({ action: 'release', booking: 'run_book1' })) as { error?: { code: string } };
    assert.equal(released.error?.code, 'test-bed.not_holder');
  });

  it('requires the booking run id for extend and release', () => {
    const out = project(input({ action: 'release' }, { leases: HELD })) as { error?: { code: string } };
    assert.equal(out.error?.code, 'test-bed.bad_booking');
    const rel = project(input({ action: 'release' }, { leases: HELD })) as { error?: { code: string } };
    assert.equal(rel.error?.code, 'test-bed.bad_booking');
  });
});

describe('project with declared installs in the manifest', () => {
  const DECLARED = {
    schema: 'test-bed-manifest@1',
    beds: [
      {
        name: 'bed-a',
        devices: [
          { name: 'afamx0', type: 'load-balancer', ipv4: ['192.0.2.10/26'], ipv6: [], installed: { build: 'Rel_FAMX_10_6_1_8' } },
          { name: 'router0', type: 'router', ipv4: ['192.0.2.1/26'], ipv6: [] },
        ],
        services: [],
        reserved: [],
      },
      {
        name: 'bed-b',
        devices: [{ name: 'afamx1', type: 'load-balancer', ipv4: ['192.0.2.130/26'], ipv6: [], installed: { build: 'Rel_FAMY_10_6_1_8', base: 'Rel_FAMX_10_6_1_8' } }],
        services: [],
        reserved: [],
      },
      {
        name: 'bed-c',
        devices: [{ name: 'afamx2', type: 'load-balancer', ipv4: ['192.0.2.140/26'], ipv6: [] }],
        services: [],
        reserved: [],
      },
    ],
  };
  const needBuild = { devices: [{ type: 'load-balancer', count: 1 }], build: 'Rel_FAMX_10_6_1_8' };

  it('search: the declared install answers 声明，未核对; an FAMY name based on the FAMX build is the same build; no record stays unknown', () => {
    const out = project(input({ need: needBuild }, { manifest: DECLARED }));
    assert.ok(!('error' in Object(out)), JSON.stringify(out).slice(0, 300));
    const a = fieldsOf(out, 'bed-a');
    assert.equal(a.build_ok, 'match');
    assert.equal(a.build_source, 'declared');
    assert.match(String(a.conclusion), /构建一致（Rel_FAMX_10_6_1_8，声明，未核对）/);
    const b = fieldsOf(out, 'bed-b');
    assert.equal(b.build_ok, 'match', 'the FAMY name maps to its base build before comparing');
    assert.match(String(b.conclusion), /构建一致（Rel_FAMX_10_6_1_8，声明，未核对）/);
    const c = fieldsOf(out, 'bed-c');
    assert.equal(c.build_ok, 'unknown', 'no installed: no record, never a mismatch');
    assert.match(String(c.conclusion), /没有记录（未知）/);
  });

  it('search: a declared mismatch says 需要升级, still 声明，未核对', () => {
    const out = project(input({ need: { ...needBuild, build: 'Rel_FAMX_10_6_1_9' } }, { manifest: DECLARED }));
    const a = fieldsOf(out, 'bed-a');
    assert.equal(a.build_ok, 'mismatch');
    assert.match(String(a.conclusion), /构建不一致（装的是 Rel_FAMX_10_6_1_8，需要升级到 Rel_FAMX_10_6_1_9，声明，未核对）/);
  });

  it('search: no matching build adds one unknown exit and does not rewrite the per-bed fields', () => {
    const out = project(input({ need: { ...needBuild, build: 'Rel_FAMX_10_6_1_9' } }, { manifest: DECLARED })) as { warnings?: Array<{ code: string; message: string }> };
    const warning = out.warnings?.find((row) => row.code === 'test-bed.no_matching_build');
    assert.ok(warning);
    assert.match(warning.message, /没有任何台架的在装构建匹配版本线 Rel_FAMX_10_6_1_9/);
    assert.match(warning.message, /管理员在清单登记在装构建，或把某台升级到该构建后重试/);
    assert.equal(fieldsOf(out, 'bed-a').build_ok, 'mismatch');
    assert.match(String(fieldsOf(out, 'bed-a').conclusion), /需要升级到 Rel_FAMX_10_6_1_9/);
    const matched = project(input({ need: needBuild }, { manifest: DECLARED })) as { warnings?: Array<{ code: string }> };
    assert.equal(matched.warnings?.some((row) => row.code === 'test-bed.no_matching_build'), false);
  });

  it('facts: the declared installs ride the item with 声明，未核对 in the summary', () => {
    const out = project(input({ action: 'facts' }, { manifest: DECLARED }));
    const a = fieldsOf(out, 'bed-a');
    assert.deepEqual(a.installed, [{ device: 'afamx0', build: 'Rel_FAMX_10_6_1_8', base: null }]);
    const items = (out as { items?: Array<{ fields: Record<string, unknown>; summary?: string }> }).items ?? [];
    const itemA = items.find((item) => item.fields.bed === 'bed-a');
    assert.match(String(itemA?.summary), /声明，未核对/);
    const c = fieldsOf(out, 'bed-c');
    assert.deepEqual(c.installed, [], 'no installs: an empty list, not unknown');
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
            { name: 'afamx0', type: 'load-balancer', ipv4: ['192.0.2.10/26'], ipv6: [] },
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

it('rejects removed duration inputs and projects owner registration without a TTL', () => {
  for(const parameters of [{action:'extend'}, {action:'acquire',hours:1}, {need:{hours:1}}]){
    const out=project(input(parameters)) as {error?:{fix:string}};
    assert.match(out.error?.fix??'',/台架预订不限时长，用完由运行释放/);
  }
  const registered=project(input({action:'register',bed:'bed-a'})) as {lease_requests?:unknown[]};
  assert.deepEqual(registered.lease_requests,[{op:'register',prefix:'bed/bed-a/'}]);
});
