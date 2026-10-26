// parseManifest: the whole manifest's problems in one answer (never throws, everything listed), the normalized
// model on success. Synthetic sample data only: IPv4 192.0.2.0/24 (segments are /26 cuts), IPv6 2001:db8::/32.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LIMITS, parseManifest } from './manifest.ts';

/** A small valid manifest used as the base of the failure cases. */
const valid = {
  schema: 'test-bed-manifest@1',
  beds: [
    {
      name: 'bed-a',
      devices: [
        { name: 'afamx0', type: 'load-balancer', product: 'famx', ipv4: ['192.0.2.10/26', '192.0.2.74/26'], ipv6: ['2001:db8:1::10/64'] },
        { name: 'router0', type: 'router', ipv4: ['192.0.2.1/26'], ipv6: [] },
        { name: 'client0', type: 'client', ipv4: ['192.0.2.80/26'], ipv6: [] },
        { name: 'server0', type: 'server', ipv4: ['192.0.2.90/26'], ipv6: [] },
        { name: 'console0', type: 'console', ipv4: ['192.0.2.140/26'], ipv6: [] },
      ],
      services: [{ host: 'server0', ip: '192.0.2.90', proto: 'tcp', port: 80 }],
      reserved: ['192.0.2.1-192.0.2.9', '192.0.2.65-192.0.2.69'],
    },
  ],
};

const problemsOf = (input: unknown): Array<{ pointer: string; message: string }> => {
  const parsed = parseManifest(input);
  const shown = JSON.stringify(parsed, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));
  assert.ok(!parsed.ok, shown);
  return parsed.ok ? [] : parsed.problems;
};

describe('parseManifest accepts', () => {
  it('normalizes a valid manifest: parsed addresses, computed segments, sorted by name', () => {
    const parsed = parseManifest(valid);
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    assert.equal(parsed.beds.length, 1);
    const bed = parsed.beds[0];
    assert.equal(bed.name, 'bed-a');
    assert.deepEqual(bed.devices.map((d) => d.name), ['afamx0', 'client0', 'console0', 'router0', 'server0'], 'devices sorted by name');
    const afamx0 = bed.devices[0];
    assert.deepEqual(
      afamx0.ipv4.map((a) => a.subnet),
      ['192.0.2.0/26', '192.0.2.64/26'],
    );
    assert.equal(afamx0.ipv4[1].value, 3221226058n);
    assert.deepEqual(afamx0.ipv6.map((a) => a.subnet), ['2001:db8:1::/64']);
    assert.deepEqual(bed.services, [{ host: 'server0', ip: '192.0.2.90', proto: 'tcp', port: 80 }]);
    assert.deepEqual(bed.reserved.map((r) => r.range), ['192.0.2.1-192.0.2.9', '192.0.2.65-192.0.2.69']);
    assert.deepEqual(bed.reserved[0].addresses.length, 9);
    // product is carried through verbatim; a device without product is null
    assert.equal(afamx0.product, 'famx');
    assert.equal(bed.devices.find((d) => d.name === 'router0')?.product, null);
  });
  it('accepts an empty beds list (a manifest with no beds is a fact, not an error)', () => {
    const parsed = parseManifest({ schema: 'test-bed-manifest@1', beds: [] });
    assert.ok(parsed.ok);
  });

  it('installed: build required, base optional, carried as the declared install record', () => {
    const withInstalled = {
      schema: 'test-bed-manifest@1',
      beds: [
        {
          name: 'bed-a',
          devices: [
            { name: 'afamx0', type: 'load-balancer', ipv4: ['192.0.2.10/26'], ipv6: [], installed: { build: 'Rel_FAMX_10_6_1_8', base: 'Rel_FAMX_10_6_1_7' } },
            { name: 'client0', type: 'client', ipv4: ['192.0.2.80/26'], ipv6: [], installed: { build: 'Rel_FAMY_10_6_1_8' } },
            { name: 'router0', type: 'router', ipv4: ['192.0.2.1/26'], ipv6: [] },
          ],
          services: [],
          reserved: [],
        },
      ],
    };
    const parsed = parseManifest(withInstalled);
    assert.ok(parsed.ok, JSON.stringify(parsed.ok ? undefined : parsed.problems));
    if (!parsed.ok) return;
    const bed = parsed.beds[0];
    assert.deepEqual(bed.devices.find((d) => d.name === 'afamx0')?.installed, { build: 'Rel_FAMX_10_6_1_8', base: 'Rel_FAMX_10_6_1_7' });
    assert.deepEqual(bed.devices.find((d) => d.name === 'client0')?.installed, { build: 'Rel_FAMY_10_6_1_8', base: null });
    assert.equal(bed.devices.find((d) => d.name === 'router0')?.installed ?? null, null, 'no installed: no record, never a mismatch');
  });
});

describe('parseManifest rejects, listing every problem at once', () => {
  it('schema must be test-bed-manifest@1', () => {
    const problems = problemsOf({ ...valid, schema: 'other@1' });
    assert.equal(problems.length, 1);
    assert.equal(problems[0].pointer, '/schema');
  });
  it('bed names: repeated within the manifest, or not [a-z0-9-]{1,64}', () => {
    const two = { schema: 'test-bed-manifest@1', beds: [valid.beds[0], { ...valid.beds[0] }] };
    const direct = parseManifest(two);
    if (direct.ok) assert.fail('expected the duplicate bed name to be refused');
    assert.ok(direct.problems.some((p) => p.pointer === '/beds/1/name' && /重复/.test(p.message)), JSON.stringify(direct.problems.map((p) => [p.pointer, p.message])));
    const bad = { schema: 'test-bed-manifest@1', beds: [{ ...valid.beds[0], name: 'Bed A' }] };
    assert.ok(problemsOf(bad).some((p) => p.pointer === '/beds/0/name'));
    const bad2 = { schema: 'test-bed-manifest@1', beds: [{ ...valid.beds[0], name: 'x'.repeat(65) }] };
    assert.ok(problemsOf(bad2).some((p) => p.pointer === '/beds/0/name'));
  });
  it('device names repeated within one bed, unknown types, unknown fields shape', () => {
    const twin = structuredClone(valid);
    twin.beds[0].devices.push({ ...twin.beds[0].devices[1] });
    assert.ok(problemsOf(twin).some((p) => /devices\/5\/name/.test(p.pointer) && /重复/.test(p.message)));
    const typed = structuredClone(valid);
    (typed.beds[0].devices[0] as { type: string }).type = 'switch';
    assert.ok(problemsOf(typed).some((p) => p.pointer === '/beds/0/devices/0/type' && /负载均衡|五种/.test(p.message)));
  });
  it('bad address or prefix writing, and the same address on two devices of one bed (or twice on one)', () => {
    const badAddr = structuredClone(valid);
    (badAddr.beds[0].devices[0] as { ipv4: string[] }).ipv4[0] = '192.0.02.10/26';
    assert.ok(problemsOf(badAddr).some((p) => p.pointer === '/beds/0/devices/0/ipv4/0'));
    const badPrefix = structuredClone(valid);
    (badPrefix.beds[0].devices[0] as { ipv4: string[] }).ipv4[0] = '192.0.2.10/33';
    assert.ok(problemsOf(badPrefix).some((p) => p.pointer === '/beds/0/devices/0/ipv4/0'));
    // An interface address with host bits set is the normal case (the device's own address in a segment): accepted.
    const hostBitsSet = structuredClone(valid);
    (hostBitsSet.beds[0].devices[1] as { ipv4: string[] }).ipv4[0] = '192.0.2.3/26';
    const accepted = parseManifest(hostBitsSet);
    assert.ok(accepted.ok, accepted.ok ? '' : JSON.stringify(accepted.problems));
    const clash = structuredClone(valid);
    (clash.beds[0].devices[2] as { ipv4: string[] }).ipv4[0] = '192.0.2.74/26'; // same as afamx0's second
    assert.ok(problemsOf(clash).some((p) => /同时属于|重复/.test(p.message) && p.pointer !== '/beds/0/devices/0/ipv4/1'));
    const twice = structuredClone(valid);
    (twice.beds[0].devices[0] as { ipv4: string[] }).ipv4 = ['192.0.2.10/26', '192.0.2.10/26'];
    assert.ok(problemsOf(twice).some((p) => /写了两次|重复/.test(p.message)));
  });
  it('services: host not a device of this bed, ip not one of that device\'s interface addresses, bad port or proto', () => {
    const host = structuredClone(valid);
    (host.beds[0].services[0] as { host: string }).host = 'ghost';
    assert.ok(problemsOf(host).some((p) => p.pointer === '/beds/0/services/0/host'));
    const ip = structuredClone(valid);
    (ip.beds[0].services[0] as { ip: string }).ip = '192.0.2.91';
    assert.ok(problemsOf(ip).some((p) => p.pointer === '/beds/0/services/0/ip' && /接口地址/.test(p.message)));
    const port = structuredClone(valid);
    (port.beds[0].services[0] as { port: number }).port = 70000;
    assert.ok(problemsOf(port).some((p) => p.pointer === '/beds/0/services/0/port'));
    const proto = structuredClone(valid);
    (proto.beds[0].services[0] as { proto: string }).proto = 'sctp';
    assert.ok(problemsOf(proto).some((p) => p.pointer === '/beds/0/services/0/proto'));
  });
  it('reserved: bad writing, start above end, outside every segment of the bed', () => {
    const bad = structuredClone(valid);
    bad.beds[0].reserved = ['192.0.2.9-192.0.2.1'];
    assert.ok(problemsOf(bad).some((p) => p.pointer === '/beds/0/reserved/0' && /起点/.test(p.message)));
    const outside = structuredClone(valid);
    outside.beds[0].reserved = ['198.51.100.1-198.51.100.5'];
    assert.ok(problemsOf(outside).some((p) => p.pointer === '/beds/0/reserved/0' && /网段/.test(p.message)));
    const malformed = structuredClone(valid);
    malformed.beds[0].reserved = ['192.0.2.1'];
    assert.ok(problemsOf(malformed).some((p) => p.pointer === '/beds/0/reserved/0'));
  });
  it('installed: not an object, missing or empty build, bad base — every problem listed with its pointer', () => {
    const bad = {
      schema: 'test-bed-manifest@1',
      beds: [
        {
          name: 'bed-a',
          devices: [
            { name: 'afamx0', type: 'load-balancer', ipv4: ['192.0.2.10/26'], ipv6: [], installed: 'Rel_FAMX_10_6_1_8' },
            { name: 'client0', type: 'client', ipv4: ['192.0.2.80/26'], ipv6: [], installed: { base: 'Rel_FAMX_10_6_1_7' } },
            { name: 'router0', type: 'router', ipv4: ['192.0.2.1/26'], ipv6: [], installed: { build: '' } },
            { name: 'server0', type: 'server', ipv4: ['192.0.2.90/26'], ipv6: [], installed: { build: 'Rel_FAMX_10_6_1_8', base: 7 } },
          ],
          services: [],
          reserved: [],
        },
      ],
    };
    const problems = problemsOf(bad);
    const pointers = problems.map((p) => p.pointer);
    assert.ok(pointers.includes('/beds/0/devices/0/installed'), JSON.stringify(pointers));
    assert.ok(pointers.includes('/beds/0/devices/1/installed/build'), 'installed without build');
    assert.ok(pointers.includes('/beds/0/devices/2/installed/build'), 'empty build');
    assert.ok(pointers.includes('/beds/0/devices/3/installed/base'), 'base not a string');
  });

  it('several problems at once, each with its own pointer', () => {
    const messy = structuredClone(valid);
    (messy.beds[0].devices[0] as { type: string }).type = 'switch';
    (messy.beds[0].devices[0] as { ipv4: string[] }).ipv4[0] = '300.1.1.1/26';
    messy.beds[0].reserved = ['192.0.2.9-192.0.2.1'];
    const problems = problemsOf(messy);
    assert.equal(problems.length, 3);
    assert.deepEqual(problems.map((p) => p.pointer).sort(), ['/beds/0/devices/0/ipv4/0', '/beds/0/devices/0/type', '/beds/0/reserved/0']);
  });
  it('the limits: 200 beds, 100 devices a bed, 16 addresses a device, 2 MiB overall', () => {
    assert.equal(LIMITS.maxBeds, 200);
    assert.equal(LIMITS.maxDevicesPerBed, 100);
    assert.equal(LIMITS.maxAddressesPerDevice, 16);
    assert.equal(LIMITS.maxBytes, 2 * 1024 * 1024);
    const tooManyBeds = { schema: 'test-bed-manifest@1', beds: Array.from({ length: 201 }, () => structuredClone(valid.beds[0])) };
    assert.ok(problemsOf(tooManyBeds).some((p) => p.pointer === '/beds' && /200/.test(p.message)));
    const tooManyDevices = { schema: 'test-bed-manifest@1', beds: [{ name: 'bed-a', devices: Array.from({ length: 101 }, (_v, i) => ({ name: `d${i}`, type: 'client', ipv4: [], ipv6: [] })), services: [], reserved: [] }] };
    assert.ok(problemsOf(tooManyDevices).some((p) => p.pointer === '/beds/0/devices' && /100/.test(p.message)));
    const tooManyAddresses = { schema: 'test-bed-manifest@1', beds: [{ name: 'bed-a', devices: [{ name: 'd0', type: 'client', ipv4: Array.from({ length: 17 }, (_v, i) => `192.0.2.${i}/26`), ipv6: [] }], services: [], reserved: [] }] };
    assert.ok(problemsOf(tooManyAddresses).some((p) => p.pointer === '/beds/0/devices/0/ipv4' && /16/.test(p.message)));
    const huge = { schema: 'test-bed-manifest@1', beds: [{ name: 'bed-a', devices: [{ name: 'd0', type: 'client', product: 'x'.repeat(3 * 1024 * 1024), ipv4: [], ipv6: [] }], services: [], reserved: [] }] };
    assert.ok(problemsOf(huge).some((p) => p.pointer === '' && /2 MiB|2097152/.test(p.message)));
  });
});

describe('parseManifest is total', () => {
  it('never throws on non-objects, arrays, cycles, depth or nonsense', () => {
    const cycle: unknown[] = [];
    cycle.push(cycle);
    const deep: unknown = { a: deep0() };
    function deep0(): unknown {
      let value: unknown = 1;
      for (let i = 0; i < 20000; i++) value = { a: value };
      return value;
    }
    for (const input of [null, undefined, 1, true, 'text', [], [1, 2], cycle, deep, { schema: 'test-bed-manifest@1' }, { schema: 'test-bed-manifest@1', beds: 'yes' }, { schema: 'test-bed-manifest@1', beds: [null] }, { schema: 'test-bed-manifest@1', beds: [{ name: 5 }] }]) {
      const parsed = parseManifest(input);
      assert.ok(parsed !== null && typeof parsed === 'object', `an answer for ${JSON.stringify(String(input).slice(0, 20))}`);
      assert.ok('ok' in (parsed as object));
    }
  });
  it('a randomly mangled manifest never throws and answers within a bounded time', () => {
    let seed = 12345;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const manglers: ((value: unknown) => void)[] = [
      (v) => { (v as { schema?: unknown }).schema = 'x'.repeat(10_000); },
      (v) => { (v as { beds?: unknown }).beds = 'nope'; },
      (v) => { (v as { beds?: unknown[] }).beds = [null, 5, 'x', []]; },
      (v) => { (v as { beds?: { devices?: unknown[] }[] }).beds?.forEach?.((b) => { if (b !== null && typeof b === 'object') (b as { devices?: unknown[] }).devices = [undefined, {}, { name: [], type: {}, ipv4: 'x' }]; }); },
      (v) => { (v as { beds?: { devices?: { ipv4?: unknown[] }[] }[] }).beds?.forEach?.((b) => { if (b === null || typeof b !== 'object') return; (b as { devices?: { ipv4?: unknown[] }[] }).devices?.forEach?.((d) => { if (d !== null && typeof d === 'object') (d as { ipv4?: unknown[] }).ipv4 = ['not-an-ip/99', '', 5, null]; }); }); },
      (v) => { (v as { beds?: { reserved?: unknown[] }[] }).beds?.forEach?.((b) => { if (b !== null && typeof b === 'object') (b as { reserved?: unknown[] }).reserved = ['-', 'a-b', '192.0.2.1-', []]; }); },
      (v) => { (v as { beds?: { services?: unknown[] }[] }).beds?.forEach?.((b) => { if (b !== null && typeof b === 'object') (b as { services?: unknown[] }).services = [{}, { host: [], ip: {}, port: 'x', proto: [] }]; }); },
    ];
    const started = performance.now();
    for (let round = 0; round < 500; round++) {
      const value: unknown = structuredClone(valid);
      for (let k = 0; k < 3; k++) manglers[Math.floor(random() * manglers.length)](value);
      const parsed = parseManifest(value);
      assert.ok(parsed !== null && 'ok' in (parsed as object), 'an answer');
    }
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 5000, `${elapsed.toFixed(0)} ms for 500 mangled manifests`);
  });
});

describe('declared baseline config', () => {
  it('keeps an omitted baseline as an empty list and a declared one by id', () => {
    const plain = parseManifest(valid);
    assert.ok(plain.ok);
    if (!plain.ok) return;
    assert.deepEqual(plain.beds[0].baseline, []);
    const parsed = parseManifest({ ...valid, beds: [{ ...valid.beds[0], baseline: [{ id: 'pool', values: { mode: 'off' } }, { id: 'acl', values: { state: 'empty' } }] }] });
    assert.ok(parsed.ok, JSON.stringify(parsed.ok ? null : parsed.problems));
    if (!parsed.ok) return;
    assert.deepEqual(parsed.beds[0].baseline.map((entry) => entry.id), ['acl', 'pool']);
    assert.equal(parsed.beds[0].baseline.find((entry) => entry.id === 'pool')?.values.mode, 'off');
  });

  it('rejects a baseline entry whose id or values are not the declared shape', () => {
    const problems = problemsOf({ ...valid, beds: [{ ...valid.beds[0], baseline: [{ id: 'Pool', values: { Mode: 1 } }] }] });
    assert.ok(problems.some((problem) => problem.pointer === '/beds/0/baseline/0/id'));
    assert.ok(problems.some((problem) => problem.pointer === '/beds/0/baseline/0/values/Mode'));
  });
});

describe('a device without any interface address', () => {
  it('is refused at import with a pointer at the device', () => {
    const input = { ...valid, beds: [{ ...valid.beds[0], devices: [...valid.beds[0].devices, { name: 'bare0', type: 'client', ipv4: [], ipv6: [] }] }] };
    const problems = problemsOf(input);
    const problem = problems.find((p) => p.pointer === '/beds/0/devices/5');
    assert.ok(problem, JSON.stringify(problems));
    assert.match(problem.message, /bare0/);
    assert.match(problem.message, /没有接口地址/);
  });

  it('a device with an address on either family is not refused', () => {
    const parsed = parseManifest({ ...valid, beds: [{ ...valid.beds[0], devices: [...valid.beds[0].devices, { name: 'v6only0', type: 'client', ipv4: [], ipv6: ['2001:db8:1::99/64'] }] }] });
    assert.ok(parsed.ok, JSON.stringify(parsed.ok ? null : parsed.problems));
  });
});
