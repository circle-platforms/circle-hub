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

const ASK = { action: 'help', booking: 'run_book1', bed: 'bed-a', device: 'afamx0', line: 'widget set demo 1' };

describe('help parameters', () => {
  it('needs the booking, the device and the line, and carries the level when one is given', () => {
    const read = readParameters(ASK);
    assert.ok(!('code' in read), JSON.stringify(read));
    assert.deepEqual([read.action, read.booking, read.device, read.line, read.mode], ['help', 'run_book1', 'afamx0', 'widget set demo 1', null]);
    const levelled = readParameters({ ...ASK, mode: 'level-b' });
    assert.ok(!('code' in levelled));
    assert.equal(levelled.mode, 'level-b');
    for (const [name, code, pointer] of [['booking', 'test-bed.bad_booking', undefined], ['device', 'test-bed.bad_help', '/parameters/device'], ['line', 'test-bed.bad_help', '/parameters/line']] as const) {
      const given: Record<string, unknown> = { ...ASK };
      delete given[name];
      const refused = readParameters(given);
      assert.ok('code' in refused, name);
      assert.equal(refused.code, code);
      assert.equal(refused.pointer, pointer);
    }
    assert.ok('code' in readParameters({ ...ASK, line: '   ' }), 'a blank line is no question');
  });

  it('other actions ignore the help parameters', () => {
    const read = readParameters({ action: 'search', device: 'afamx0', line: 'x', mode: 'y' });
    assert.ok(!('code' in read));
    assert.deepEqual([read.device, read.line, read.mode], [null, null, null]);
  });
});

describe('help projection', () => {
  it('asks the device the lineage holds: one item, one ask with the inventory, the device pointer, the line and the key, nothing leased', () => {
    const out = project(input(ASK, [mine('bed/bed-a/afamx0'), mine('bed/bed-a/client0')])) as { items: Array<{ id: string; fields: Record<string, unknown> }>; ask?: unknown[]; lease_requests?: unknown; observe?: unknown; groups: Array<Record<string, unknown>> };
    assert.ok(!('error' in out), JSON.stringify(out).slice(0, 300));
    assert.deepEqual(out.items.map((item) => item.id), ['bed-a/afamx0']);
    assert.equal(out.items[0]!.fields.action, 'help');
    assert.equal(out.items[0]!.fields.key, 'bed/bed-a/afamx0');
    assert.deepEqual(out.ask, [{ inventory: INVENTORY, device: '/beds/0/devices/0', label: 'bed-a/afamx0', line: 'widget set demo 1', keys: ['bed/bed-a/afamx0'] }]);
    assert.equal(out.lease_requests, undefined, 'asking takes and gives no lease');
    assert.equal(out.observe, undefined);
    assert.equal(out.groups[0]!.line, 'widget set demo 1');
  });

  it('passes the level on, and finds the bed from the held key when none is named', () => {
    const out = project(input({ ...ASK, bed: undefined, mode: 'level-b' }, [mine('bed/bed-b/afamx0')])) as { ask: Array<Record<string, unknown>> };
    assert.deepEqual(out.ask, [{ inventory: INVENTORY, device: '/beds/1/devices/0', label: 'bed-b/afamx0', line: 'widget set demo 1', mode: 'level-b', keys: ['bed/bed-b/afamx0'] }]);
  });

  it('refuses a device the lineage does not hold: nobody else\'s booking, no booking, a device that is not there', () => {
    for (const entries of [[theirs('bed/bed-a/afamx0')], [], [mine('bed/bed-a/client0')]]) {
      const out = project(input(ASK, entries)) as { error?: { code: string; fix: string; pointer?: string } };
      assert.equal(out.error?.code, 'test-bed.not_holder', JSON.stringify(entries));
      assert.equal(out.error?.pointer, '/parameters/device');
      assert.match(out.error?.fix ?? '', /predecessor/);
    }
    const unknown = project(input({ ...ASK, device: 'nobody' }, [mine('bed/bed-a/afamx0')])) as { error?: { code: string } };
    assert.equal(unknown.error?.code, 'test-bed.not_holder');
  });

  it('asks for the bed when the same device name is held in two beds', () => {
    const entries = [mine('bed/bed-a/afamx0'), mine('bed/bed-b/afamx0')];
    const out = project(input({ ...ASK, bed: undefined }, entries)) as { error?: { code: string; pointer?: string } };
    assert.equal(out.error?.code, 'test-bed.bad_help');
    assert.equal(out.error?.pointer, '/parameters/bed');
    const named = project(input({ ...ASK, bed: 'bed-b' }, entries)) as { ask: Array<{ device: string; keys: string[] }> };
    assert.deepEqual([named.ask[0]!.device, named.ask[0]!.keys], ['/beds/1/devices/0', ['bed/bed-b/afamx0']]);
  });
});

describe('help check', () => {
  const subjectOf = (out: { items: unknown[]; groups: unknown[] }) => ({ items: out.items, context: { groups: out.groups } });

  it('supports the item the projection made, from the frozen group alone', () => {
    const out = project(input({ ...ASK, mode: 'level-b' }, [mine('bed/bed-a/afamx0')])) as { items: Array<Record<string, unknown>>; groups: unknown[] };
    const outcomes = bedOutcomes(subjectOf(out));
    assert.deepEqual(outcomes.map((o) => o.verdict), ['support']);
  });

  it('refutes an item whose line, key or level is not the frozen question', () => {
    const out = project(input(ASK, [mine('bed/bed-a/afamx0')])) as { items: Array<{ fields: Record<string, unknown> }>; groups: unknown[] };
    for (const [field, value] of [['line', 'widget set demo 2'], ['key', 'bed/bed-a/client0'], ['mode', 'level-b'], ['device', 'client0']] as const) {
      const tampered = { items: [{ ...out.items[0], fields: { ...out.items[0]!.fields, [field]: value } }], context: { groups: out.groups } };
      const outcomes = bedOutcomes(tampered);
      assert.equal(outcomes[0]!.verdict, 'refute', field);
      assert.equal(outcomes[0]!.code, 'test-bed.help_mismatch', field);
    }
  });

  it('refutes when the frozen lease view no longer marks the device mine', () => {
    const out = project(input(ASK, [mine('bed/bed-a/afamx0')])) as unknown as { items: unknown[]; groups: Array<{ leases: { entries: Row[] } }> };
    out.groups[0]!.leases.entries = [theirs('bed/bed-a/afamx0')];
    const outcomes = bedOutcomes(subjectOf(out));
    assert.equal(outcomes[0]!.verdict, 'refute');
    assert.equal(outcomes[0]!.code, 'test-bed.help_mismatch');
  });
});
