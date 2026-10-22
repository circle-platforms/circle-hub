// The bed check over frozen subjects: support when the frozen fields equal the recomputation of the same code the
// projection used, refute (test-bed.<action>_mismatch) with the differing fields, unknown when the frozen groups are
// missing. Subjects are assembled from the real projection output, as the engine freezes them.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bedOutcomes } from './check-bed.ts';
import project from './project.ts';

const NOW = '2026-10-22T02:00:00.000Z';
const LATER = '2026-10-22T05:00:00.000Z';

const MANIFEST = {
  schema: 'test-bed-manifest@1',
  beds: [
    {
      name: 'bed-a',
      devices: [
        { name: 'apv0', type: 'load-balancer', ipv4: ['192.0.2.10/26', '192.0.2.74/26'], ipv6: [] },
        { name: 'router0', type: 'router', ipv4: ['192.0.2.1/26'], ipv6: [] },
        { name: 'client0', type: 'client', ipv4: ['192.0.2.80/26'], ipv6: [] },
        { name: 'server0', type: 'server', ipv4: ['192.0.2.90/26'], ipv6: [] },
      ],
      services: [{ host: 'server0', ip: '192.0.2.90', proto: 'tcp', port: 80 }],
      reserved: [],
    },
  ],
};

function inputOf(parameters: Record<string, unknown>, options: { leases?: Array<{ key: string; until: string }> } = {}): unknown {
  return {
    inputs: [{ slot: 'inventory', external: 'doc:doc:bed-topology', sha256: 'a'.repeat(64), media_type: 'application/json', parser: 'json@1', model: MANIFEST, meta: null }],
    parameters,
    context: { product: null, names: [], line: null, build: null, root: null, parameters, groups: [], leases: { now: NOW, entries: options.leases ?? [] } },
  };
}

/** The subject the check sees, from a real projection output, optionally edited before freezing. */
function subjectOf(parameters: Record<string, unknown>, options: { leases?: Array<{ key: string; until: string }>; edit?: (fields: Record<string, unknown>) => void } = {}): unknown {
  const out = project(inputOf(parameters, options)) as { items: Array<{ id: string; label: string; location: { parser: string; selector: string }; fields: Record<string, unknown> }>; groups: Array<Record<string, unknown>> };
  assert.ok(Array.isArray(out.items), JSON.stringify(out).slice(0, 300));
  const items = out.items.map((item, at) => {
    const fields = { ...item.fields };
    if (at === 0) options.edit?.(fields);
    return { id: item.id, label: item.label, location: `src:${'b'.repeat(64)}/json@1/${item.location.selector}`, fields };
  });
  return { items, context: { product: null, names: [], line: null, build: null, root: null, parameters: {}, groups: out.groups ?? [] } };
}

describe('bedOutcomes support', () => {
  it('search: every item supports with its conclusion', () => {
    const outcomes = bedOutcomes(subjectOf({ need: { devices: [{ type: 'client', count: 1 }], hours: 2 } }));
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].verdict, 'support');
    assert.equal(outcomes[0].item, 'bed-a');
    assert.match(outcomes[0].statement, /Hub 记录里空闲（未排除本地操作）/);
    assert.deepEqual(outcomes[0].grounds, [`src:${'b'.repeat(64)}/json@1/p/beds/0`]);
  });

  it('facts: support with the listener and blind lists', () => {
    const outcomes = bedOutcomes(subjectOf({ action: 'facts' }));
    assert.equal(outcomes[0].verdict, 'support');
    const data = outcomes[0].data as { listeners: unknown[]; blind: unknown[] };
    assert.equal(data.listeners.length, 2);
    assert.equal(data.blind.length, 0);
  });

  it('acquire: support with the plan, the keys sorted by the projection', () => {
    const outcomes = bedOutcomes(subjectOf({ action: 'acquire', bed: 'bed-a', need: { devices: [{ type: 'load-balancer', count: 1 }, { type: 'client', count: 1 }], hours: 2 } }));
    assert.equal(outcomes[0].verdict, 'support');
    assert.match(outcomes[0].statement, /^预订 bed-a/);
    const data = outcomes[0].data as { keys: string[]; ttl_seconds: number };
    assert.deepEqual(data.keys, ['bed/bed-a/apv0', 'bed/bed-a/client0']);
    assert.equal(data.ttl_seconds, 7200);
  });
});

describe('bedOutcomes refute and unknown', () => {
  it('refutes a search item whose frozen conclusion contradicts the frozen lease view', () => {
    const outcomes = bedOutcomes(subjectOf({ need: { devices: [{ type: 'client', count: 1 }], hours: 2 } }, { leases: [{ key: 'bed/bed-a/client0', until: LATER }], edit: (fields) => void (fields.earliest_free = null) }));
    assert.equal(outcomes[0].verdict, 'refute');
    assert.equal(outcomes[0].code, 'test-bed.search_mismatch');
    assert.match(outcomes[0].statement, /earliest_free/);
  });

  it('refutes a facts item with a tampered blind list', () => {
    const outcomes = bedOutcomes(subjectOf({ action: 'facts' }, { edit: (fields) => void (fields.blind = [{ device: 'apv0', address: '192.0.2.74', subnet: '192.0.2.64/26' }]) }));
    assert.equal(outcomes[0].verdict, 'refute');
    assert.equal(outcomes[0].code, 'test-bed.facts_mismatch');
    assert.match(outcomes[0].statement, /blind/);
  });

  it('refutes an acquire item with tampered keys and a recomputed plan beside it', () => {
    const outcomes = bedOutcomes(subjectOf({ action: 'acquire', bed: 'bed-a', need: { devices: [{ type: 'load-balancer', count: 1 }, { type: 'client', count: 1 }], hours: 2 } }, { edit: (fields) => void (fields.keys = ['bed/bed-a/apv0']) }));
    assert.equal(outcomes[0].verdict, 'refute');
    assert.equal(outcomes[0].code, 'test-bed.acquire_mismatch');
    assert.match(outcomes[0].statement, /keys/);
    const data = outcomes[0].data as { actual_keys: string[] };
    assert.deepEqual(data.actual_keys, ['bed/bed-a/apv0', 'bed/bed-a/client0']);
  });

  it('is unknown (check_error) when the frozen groups are missing', () => {
    const outcomes = bedOutcomes({ items: [{ id: 'bed-a', fields: { action: 'search' } }], context: { groups: [] } });
    assert.equal(outcomes[0].verdict, 'unknown');
    assert.equal(outcomes[0].reason, 'check_error');
  });
});
