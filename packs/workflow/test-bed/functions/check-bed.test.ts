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
        { name: 'afamx0', type: 'load-balancer', ipv4: ['192.0.2.10/26', '192.0.2.74/26'], ipv6: [] },
        { name: 'router0', type: 'router', ipv4: ['192.0.2.1/26'], ipv6: [] },
        { name: 'client0', type: 'client', ipv4: ['192.0.2.80/26'], ipv6: [] },
        { name: 'server0', type: 'server', ipv4: ['192.0.2.90/26'], ipv6: [] },
      ],
      services: [{ host: 'server0', ip: '192.0.2.90', proto: 'tcp', port: 80 }],
      reserved: [],
    },
  ],
};

function inputOf(parameters: Record<string, unknown>, options: { manifest?: unknown; leases?: Array<{ key: string; until: string; mine?: boolean }> } = {}): unknown {
  return {
    inputs: [{ slot: 'inventory', external: 'doc:doc:bed-topology', sha256: 'a'.repeat(64), media_type: 'application/json', parser: 'json@1', model: options.manifest ?? MANIFEST, meta: null }],
    parameters,
    context: { product: null, names: [], line: null, build: null, root: null, parameters, groups: [], leases: { now: NOW, entries: options.leases ?? [], registrations: [] } },
  };
}

/** The subject the check sees, from a real projection output, optionally edited before freezing. */
function subjectOf(parameters: Record<string, unknown>, options: { manifest?: unknown; leases?: Array<{ key: string; until: string; mine?: boolean }>; edit?: (fields: Record<string, unknown>) => void } = {}): unknown {
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
    const outcomes = bedOutcomes(subjectOf({ need: { devices: [{ type: 'client', count: 1 }] } }));
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
    const outcomes = bedOutcomes(subjectOf({ action: 'acquire', bed: 'bed-a', need: { devices: [{ type: 'load-balancer', count: 1 }, { type: 'client', count: 1 }] } }));
    assert.equal(outcomes[0].verdict, 'support');
    assert.match(outcomes[0].statement, /^预订 bed-a/);
    const data = outcomes[0].data as { keys: string[]; ttl_seconds: number };
    assert.deepEqual(data.keys, ['bed/bed-a/afamx0', 'bed/bed-a/client0']);
    assert.equal(Object.hasOwn(data,'ttl_seconds'),false);
  });

  const HELD = [
    { key: 'bed/bed-a/afamx0', until: LATER, mine: true },
    { key: 'bed/bed-a/client0', until: LATER, mine: true },
    { key: 'bed/bed-a/ip/192.0.2.70', until: LATER, mine: true },
  ];

  it('extend: support with the held keys and the extension length', () => {
    const outcomes = bedOutcomes(subjectOf({ action: 'release', booking: 'run_book1' }, { leases: HELD }));
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].verdict, 'support');
    assert.equal(outcomes[0].statement, '释放 bed-a 的预订 run_book1，设备 afamx0、client0，地址 192.0.2.70');
    const data = outcomes[0].data as { keys: string[]; ttl_seconds: number };
    assert.deepEqual(data.keys, ['bed/bed-a/afamx0', 'bed/bed-a/client0', 'bed/bed-a/ip/192.0.2.70']);
    assert.equal(Object.hasOwn(data,'ttl_seconds'),false);
  });

  it('release: support naming the booking and the keys', () => {
    const outcomes = bedOutcomes(subjectOf({ action: 'release', booking: 'run_book1' }, { leases: HELD }));
    assert.equal(outcomes[0].verdict, 'support');
    assert.equal(outcomes[0].statement, '释放 bed-a 的预订 run_book1，设备 afamx0、client0，地址 192.0.2.70');
  });
});

describe('bedOutcomes refute and unknown', () => {
  it('refutes a search item whose frozen conclusion contradicts the frozen lease view', () => {
    const outcomes = bedOutcomes(subjectOf({ need: { devices: [{ type: 'client', count: 1 }] } }, { leases: [{ key: 'bed/bed-a/client0', until: LATER }], edit: (fields) => void (fields.earliest_free = null) }));
    assert.equal(outcomes[0].verdict, 'refute');
    assert.equal(outcomes[0].code, 'test-bed.search_mismatch');
    assert.match(outcomes[0].statement, /earliest_free/);
  });

  it('refutes a facts item with a tampered blind list', () => {
    const outcomes = bedOutcomes(subjectOf({ action: 'facts' }, { edit: (fields) => void (fields.blind = [{ device: 'afamx0', address: '192.0.2.74', subnet: '192.0.2.64/26' }]) }));
    assert.equal(outcomes[0].verdict, 'refute');
    assert.equal(outcomes[0].code, 'test-bed.facts_mismatch');
    assert.match(outcomes[0].statement, /blind/);
  });

  it('refutes an acquire item with tampered keys and a recomputed plan beside it', () => {
    const outcomes = bedOutcomes(subjectOf({ action: 'acquire', bed: 'bed-a', need: { devices: [{ type: 'load-balancer', count: 1 }, { type: 'client', count: 1 }] } }, { edit: (fields) => void (fields.keys = ['bed/bed-a/afamx0']) }));
    assert.equal(outcomes[0].verdict, 'refute');
    assert.equal(outcomes[0].code, 'test-bed.acquire_mismatch');
    assert.match(outcomes[0].statement, /keys/);
    const data = outcomes[0].data as { actual_keys: string[] };
    assert.deepEqual(data.actual_keys, ['bed/bed-a/afamx0', 'bed/bed-a/client0']);
  });

  it('is unknown (check_error) when the frozen groups are missing', () => {
    const outcomes = bedOutcomes({ items: [{ id: 'bed-a', fields: { action: 'search' } }], context: { groups: [] } });
    assert.equal(outcomes[0].verdict, 'unknown');
    assert.equal(outcomes[0].reason, 'check_error');
  });

  const HELD = [
    { key: 'bed/bed-a/afamx0', until: LATER, mine: true },
    { key: 'bed/bed-a/client0', until: LATER, mine: true },
  ];

  it('refutes an extend item with tampered keys', () => {
    const outcomes = bedOutcomes(subjectOf({ action: 'release', booking: 'run_book1' }, { leases: HELD, edit: (fields) => void (fields.keys = ['bed/bed-a/afamx0']) }));
    assert.equal(outcomes[0].verdict, 'refute');
    assert.equal(outcomes[0].code, 'test-bed.release_mismatch');
    assert.match(outcomes[0].statement, /keys/);
  });

  it('refutes a release item with a tampered booking', () => {
    const outcomes = bedOutcomes(subjectOf({ action: 'release', booking: 'run_book1' }, { leases: HELD, edit: (fields) => void (fields.booking = 'run_other') }));
    assert.equal(outcomes[0].verdict, 'refute');
    assert.equal(outcomes[0].code, 'test-bed.release_mismatch');
    assert.match(outcomes[0].statement, /booking/);
  });

  it('refutes an extend item when the frozen view holds nothing any more', () => {
    const outcomes = bedOutcomes(subjectOf({ action: 'release', booking: 'run_book1' }, { leases: HELD, edit: (fields) => void (fields.conclusion = fields.conclusion) }));
    assert.equal(outcomes[0].verdict, 'support', 'the unchanged item supports');
    const tampered = subjectOf({ action: 'release', booking: 'run_book1' }, { leases: HELD }) as { items: unknown[]; context: { groups: Array<{ leases: { entries: unknown[] } }> } };
    tampered.context.groups[0].leases.entries = [];
    const after = bedOutcomes(tampered);
    assert.equal(after[0].verdict, 'refute');
    assert.equal(after[0].code, 'test-bed.release_mismatch');
    assert.match(after[0].statement, /没有持有/);
  });

  const DECLARED = {
    schema: 'test-bed-manifest@1',
    beds: [
      {
        name: 'bed-a',
        devices: [{ name: 'afamx0', type: 'load-balancer', ipv4: ['192.0.2.10/26', '192.0.2.74/26'], ipv6: [], installed: { build: 'Rel_FAMY_10_6_1_8', base: 'Rel_FAMX_10_6_1_8' } }],
        services: [],
        reserved: [],
      },
    ],
  };

  it('search with a build requirement: support naming 声明，未核对, refute on a tampered build verdict', () => {
    const parameters = { need: { devices: [{ type: 'load-balancer', count: 1 }], build: 'Rel_FAMX_10_6_1_8' } };
    const good = bedOutcomes(subjectOf(parameters, { manifest: DECLARED }));
    assert.equal(good[0].verdict, 'support');
    assert.match(good[0].statement, /声明，未核对/);
    const bad = bedOutcomes(subjectOf(parameters, { manifest: DECLARED, edit: (fields) => void (fields.build_ok = 'unknown') }));
    assert.equal(bad[0].verdict, 'refute');
    assert.equal(bad[0].code, 'test-bed.search_mismatch');
    assert.match(bad[0].statement, /build_ok/);
  });

  it('refutes a facts item with a tampered installed list', () => {
    const outcomes = bedOutcomes(subjectOf({ action: 'facts' }, { manifest: DECLARED, edit: (fields) => void (fields.installed = []) }));
    assert.equal(outcomes[0].verdict, 'refute');
    assert.equal(outcomes[0].code, 'test-bed.facts_mismatch');
    assert.match(outcomes[0].statement, /installed/);
  });
});
