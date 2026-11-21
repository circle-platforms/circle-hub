import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bedOutcomes } from './check-bed.ts';
import { readParameters } from './conclude.ts';
import project from './project.ts';

const NOW = '2026-10-22T02:00:00.000Z';
const INVENTORY = 'a'.repeat(64);

const MANIFEST = {
  schema: 'test-bed-manifest@1',
  beds: [
    { name: 'bed-a', devices: [{ name: 'afamx0', type: 'load-balancer', ipv4: ['192.0.2.10/26'], ipv6: [] }, { name: 'client0', type: 'client', ipv4: ['192.0.2.80/26'], ipv6: [] }], services: [], reserved: [] },
    { name: 'bed-b', devices: [{ name: 'afamx0', type: 'load-balancer', ipv4: ['192.0.2.150/26'], ipv6: [] }], services: [], reserved: [] },
  ],
};

type Row = { key: string; until: string | null; mine: boolean };
const mine = (key: string): Row => ({ key, until: null, mine: true });
const theirs = (key: string): Row => ({ key, until: null, mine: false });

function input(parameters: Record<string, unknown>, entries: Row[]): unknown {
  return {
    inputs: [{ slot: 'inventory', external: 'doc:doc:bed-topology', sha256: INVENTORY, media_type: 'application/json', parser: 'json@1', model: MANIFEST, meta: null }],
    parameters,
    context: { product: null, names: [], line: null, build: null, root: null, parameters, groups: [], leases: { now: NOW, entries, registrations: [] } },
  };
}

const READ = { action: 'read', booking: 'run_book1', bed: 'bed-a', device: 'afamx0', line: 'widget show demo' };

describe('read parameters', () => {
  it('needs the booking, the device and the line, and takes no level', () => {
    const read = readParameters(READ);
    assert.ok(!('code' in read), JSON.stringify(read));
    assert.deepEqual([read.action, read.booking, read.device, read.line, read.mode], ['read', 'run_book1', 'afamx0', 'widget show demo', null]);
    for (const [name, code, pointer] of [['booking', 'test-bed.bad_booking', undefined], ['device', 'test-bed.bad_read', '/parameters/device'], ['line', 'test-bed.bad_read', '/parameters/line']] as const) {
      const given: Record<string, unknown> = { ...READ };
      delete given[name];
      const refused = readParameters(given);
      assert.ok('code' in refused, name);
      assert.equal(refused.code, code);
      assert.equal(refused.pointer, pointer);
    }
    assert.ok('code' in readParameters({ ...READ, line: '   ' }), 'a blank line is no command');
    const levelled = readParameters({ ...READ, mode: 'level-b' });
    assert.ok('code' in levelled, 'a level is refused, not dropped: what was asked for is not what would be done');
    assert.deepEqual([levelled.code, levelled.pointer], ['test-bed.bad_read', '/parameters/mode']);
  });

  it('is a known action, and a help question keeps its own parameters', () => {
    const unknown = readParameters({ action: 'peek' });
    assert.ok('code' in unknown);
    assert.match(unknown.fix, /read/);
    const help = readParameters({ ...READ, action: 'help', mode: 'level-b' });
    assert.ok(!('code' in help));
    assert.equal(help.mode, 'level-b');
  });
});

describe('read projection', () => {
  it('reads the device the lineage holds: one item, one read with the inventory, the device pointer, the line and the key, nothing leased, asked or observed', () => {
    const out = project(input(READ, [mine('bed/bed-a/afamx0'), mine('bed/bed-a/client0')])) as { items: Array<{ id: string; fields: Record<string, unknown> }>; read?: unknown[]; ask?: unknown; lease_requests?: unknown; observe?: unknown; groups: Array<Record<string, unknown>> };
    assert.ok(!('error' in out), JSON.stringify(out).slice(0, 300));
    assert.deepEqual(out.items.map((item) => item.id), ['bed-a/afamx0']);
    assert.equal(out.items[0]!.fields.action, 'read');
    assert.equal(out.items[0]!.fields.key, 'bed/bed-a/afamx0');
    assert.equal(out.items[0]!.fields.mode, undefined, 'a read has no level');
    assert.deepEqual(out.read, [{ inventory: INVENTORY, device: '/beds/0/devices/0', label: 'bed-a/afamx0', line: 'widget show demo', keys: ['bed/bed-a/afamx0'] }]);
    assert.equal(out.lease_requests, undefined, 'reading takes and gives no lease');
    assert.equal(out.ask, undefined);
    assert.equal(out.observe, undefined);
    assert.equal(out.groups[0]!.line, 'widget show demo');
  });

  it('hands the line on as it was written: the pack compares it with nothing', () => {
    for (const line of ['frobnicate widget', 'wipe-all now', 'ZORP "a b"']) {
      const out = project(input({ ...READ, line }, [mine('bed/bed-a/afamx0')])) as { read: Array<{ line: string }> };
      assert.equal(out.read[0]!.line, line);
    }
  });

  it('finds the bed from the held key when none is named', () => {
    const out = project(input({ ...READ, bed: undefined }, [mine('bed/bed-b/afamx0')])) as { read: Array<Record<string, unknown>> };
    assert.deepEqual(out.read, [{ inventory: INVENTORY, device: '/beds/1/devices/0', label: 'bed-b/afamx0', line: 'widget show demo', keys: ['bed/bed-b/afamx0'] }]);
  });

  it('refuses a device the lineage does not hold: somebody else\'s booking, no booking, a device that is not there', () => {
    for (const entries of [[theirs('bed/bed-a/afamx0')], [], [mine('bed/bed-a/client0')]]) {
      const out = project(input(READ, entries)) as { error?: { code: string; fix: string; pointer?: string }; read?: unknown };
      assert.equal(out.error?.code, 'test-bed.not_holder', JSON.stringify(entries));
      assert.equal(out.error?.pointer, '/parameters/device');
      assert.match(out.error?.fix ?? '', /predecessor/);
      assert.match(out.error?.fix ?? '', /不能读/);
      assert.equal(out.read, undefined);
    }
    const unknown = project(input({ ...READ, device: 'nobody' }, [mine('bed/bed-a/afamx0')])) as { error?: { code: string } };
    assert.equal(unknown.error?.code, 'test-bed.not_holder');
  });

  it('asks for the bed when the same device name is held in two beds', () => {
    const entries = [mine('bed/bed-a/afamx0'), mine('bed/bed-b/afamx0')];
    const out = project(input({ ...READ, bed: undefined }, entries)) as { error?: { code: string; pointer?: string } };
    assert.equal(out.error?.code, 'test-bed.bad_read');
    assert.equal(out.error?.pointer, '/parameters/bed');
    const named = project(input({ ...READ, bed: 'bed-b' }, entries)) as { read: Array<{ device: string; keys: string[] }> };
    assert.deepEqual([named.read[0]!.device, named.read[0]!.keys], ['/beds/1/devices/0', ['bed/bed-b/afamx0']]);
  });
});

describe('read check', () => {
  const subjectOf = (out: { items: unknown[]; groups: unknown[] }) => ({ items: out.items, context: { groups: out.groups } });

  it('supports the item the projection made, from the frozen group alone', () => {
    const out = project(input(READ, [mine('bed/bed-a/afamx0')])) as { items: Array<Record<string, unknown>>; groups: unknown[] };
    const outcomes = bedOutcomes(subjectOf(out));
    assert.deepEqual(outcomes.map((o) => o.verdict), ['support']);
  });

  it('refutes an item whose line, key or device is not the frozen request', () => {
    const out = project(input(READ, [mine('bed/bed-a/afamx0')])) as { items: Array<{ fields: Record<string, unknown> }>; groups: unknown[] };
    for (const [field, value] of [['line', 'widget show other'], ['key', 'bed/bed-a/client0'], ['device', 'client0'], ['booking', 'run_other']] as const) {
      const tampered = { items: [{ ...out.items[0], fields: { ...out.items[0]!.fields, [field]: value } }], context: { groups: out.groups } };
      const outcomes = bedOutcomes(tampered);
      assert.equal(outcomes[0]!.verdict, 'refute', field);
      assert.equal(outcomes[0]!.code, 'test-bed.read_mismatch', field);
    }
  });

  it('refutes when the frozen lease view no longer marks the device mine', () => {
    const out = project(input(READ, [mine('bed/bed-a/afamx0')])) as unknown as { items: unknown[]; groups: Array<{ leases: { entries: Row[] } }> };
    out.groups[0]!.leases.entries = [theirs('bed/bed-a/afamx0')];
    const outcomes = bedOutcomes(subjectOf(out));
    assert.equal(outcomes[0]!.verdict, 'refute');
    assert.equal(outcomes[0]!.code, 'test-bed.read_mismatch');
  });
});
