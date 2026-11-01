// The bed-install projection and checks on synthetic inventories and requests: one item per dispatch-target device with the
// declared upgrade case, the request rules of InfoTest's upgrade case, the whole-bed booking, the locked build, and the
// dispatch parameters bound from the checked fact.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import TABLE from '../policies/install.json' with { type: 'json' };
import { imageVersion, versionOfBuild } from './common.ts';
import project from './project.ts';
import { buildSubject } from './subject.ts';
import install from './install.ts';
import dispatchPolicy from './dispatch-policy.ts';

const MANIFEST = 'a'.repeat(64), REQUEST = 'b'.repeat(64);
const inventory = {
  schema: 'test-bed-manifest@1',
  beds: [
    { name: 'bed-x', devices: [{ name: 'lbx', type: 'load-balancer', ipv4: ['192.0.2.20/26'], ipv6: [] }], services: [], reserved: [] },
    {
      name: 'bed-a',
      devices: [
        { name: 'client1', type: 'client', ipv4: ['192.0.2.10/26'], ipv6: [] },
        { name: 'lb0', type: 'load-balancer', ipv4: ['192.0.2.11/26'], ipv6: [] },
        { name: 'lb1', type: 'load-balancer', ipv4: ['192.0.2.12/26'], ipv6: [] },
      ],
      services: [],
      reserved: [],
    },
  ],
};
const request = { schema: 'bed-install@1', build: 'Beta_SYN-K_1_2_0_7', image: 'brandOS-Beta_SYN-K_1_2_0_7.click' };
const projectionInput = (overrides: { bed?: string; request?: unknown } = {}) => ({
  inputs: [
    { slot: 'inventory', external: 'doc:doc:bed-topology', sha256: MANIFEST, media_type: 'application/json', parser: 'json@1', model: inventory, meta: null },
    { slot: 'request', external: null, sha256: REQUEST, media_type: 'application/json', parser: 'json@1', model: overrides.request ?? request, meta: null },
  ],
  parameters: { bed: overrides.bed ?? 'bed-a' },
  context: { product: 'SYN', names: ['SYN'], line: null, build: 'Beta.SYN-K.1.2.0.5', root: null, parameters: {}, groups: [] },
});
const booked = (devices: string[], run = 'run_booking') => devices.map((name) => ({ key: `bed/bed-a/${name}`, since: '2026-01-01T00:00:00.000Z', until: null, run, mine: false, jobs: [] }));

function subjectFor(item: string, options: { claimed?: string; predecessor?: string | null; build?: string | null; leases?: unknown[]; request?: unknown } = {}) {
  const projected = project(projectionInput({ request: options.request }));
  assert.ok('items' in projected, JSON.stringify(projected));
  const entry = projected.items.find((candidate) => candidate.id === item)!;
  return buildSubject({
    applies: 'item',
    item: { id: entry.id, label: entry.label, location: `src:${MANIFEST}/json@1/${entry.location.selector}`, fields: entry.fields },
    slots: options.claimed === undefined ? { reason: [{ data: { build: request.build } }] } : { reason: [{ data: { build: options.claimed } }] },
    evidence: [],
    context: {
      product: 'SYN', names: ['SYN'], line: null, root: null, parameters: {}, groups: projected.groups,
      predecessor: options.predecessor === undefined ? 'run_booking' : options.predecessor,
      build: options.build === undefined ? 'Beta.SYN-K.1.2.0.5' : options.build,
      leases: { now: '2026-01-01T00:00:00.000Z', registrations: [], entries: options.leases ?? booked(['client1', 'lb0', 'lb1']) },
    },
  });
}

describe('InfoTest image reading', () => {
  it('reads the build after the first dash up to the last dot, underscores as dots, for the declared extensions', () => {
    assert.equal(imageVersion('brandOS-Beta_SYN-K_1_2_0_7.click', TABLE.image_extensions), 'Beta.SYN-K.1.2.0.7');
    assert.equal(imageVersion('brandOS-Beta_SYN-K_1_2_0_7.array', TABLE.image_extensions), 'Beta.SYN-K.1.2.0.7');
    assert.equal(versionOfBuild('Beta_SYN-K_1_2_0_7'), 'Beta.SYN-K.1.2.0.7');
    for (const name of ['Beta_SYN-K_1_2_0_7.click'.replace('-', '_'), 'brandOS-Beta_SYN-K_1_2_0_7.iso', '../brandOS-Beta_SYN-K_1_2_0_7.click', 'brandOS-Beta SYN.click']) {
      assert.equal(imageVersion(name, TABLE.image_extensions), null, name);
    }
  });
});

describe('the projection', () => {
  it('gives one item per dispatch-target device of the named bed, in inventory order, with the declared upgrade case', () => {
    const out = project(projectionInput());
    assert.ok('items' in out, JSON.stringify(out));
    assert.deepEqual(out.items.map((item) => [item.id, item.fields.device, item.location.selector]), [
      ['999999990', 'lb0', 'p/beds/1/devices/1'],
      ['999999991', 'lb1', 'p/beds/1/devices/2'],
    ]);
    assert.deepEqual(out.groups[0], { kind: 'bed-install', bed: 'bed-a', devices: ['client1', 'lb0', 'lb1'], targets: ['lb0', 'lb1'], manifest_sha256: MANIFEST, bed_pointer: 'p/beds/1', request_sha256: REQUEST, request });
  });

  it('refuses an unknown bed with the names the inventory has, at the parameter', () => {
    const out = project(projectionInput({ bed: 'bed-z' }));
    assert.ok('error' in out);
    assert.equal(out.error.code, 'bed-install.bed_unknown');
    assert.equal(out.error.pointer, '/parameters/bed');
    assert.match(out.error.fix, /bed-x、bed-a/);
  });
});

describe('the install check', () => {
  it('supports a request whose image names its build, with the whole bed booked by the predecessor and a locked build', () => {
    const [outcome] = install({ subject: subjectFor('999999991'), table: TABLE });
    assert.equal(outcome.verdict, 'support', outcome.statement);
    assert.deepEqual(outcome.data, {
      sha256: REQUEST, autoids: ['999999990', '999999991'], bed: { id: 'bed-a', manifest_sha256: MANIFEST }, build: 'Beta.SYN-K.1.2.0.5',
      generator: 'bed-install.request@1', plan_run: 'run_booking', install: { build: request.build, image: request.image, version: 'Beta.SYN-K.1.2.0.7', targets: ['lb0', 'lb1'] },
    });
  });

  it('refutes an image that installs another build, naming what the upgrade case would install', () => {
    const [outcome] = install({ subject: subjectFor('999999990', { request: { ...request, image: 'brandOS-Beta_SYN-K_1_2_0_8.click' } }), table: TABLE });
    assert.deepEqual([outcome.verdict, outcome.code], ['refute', 'bed-install.request_invalid']);
    assert.match(outcome.statement, /装的是 Beta\.SYN-K\.1\.2\.0\.8/);
  });

  it('refutes a booking that misses a device of the bed, a different claimed build and a run without a locked build', () => {
    assert.equal(install({ subject: subjectFor('999999990', { leases: booked(['lb0', 'lb1']) }), table: TABLE })[0].code, 'bed-install.booking_missing');
    assert.equal(install({ subject: subjectFor('999999990', { leases: booked(['client1', 'lb0', 'lb1'], 'run_other') }), table: TABLE })[0].code, 'bed-install.booking_missing');
    assert.equal(install({ subject: subjectFor('999999990', { predecessor: null }), table: TABLE })[0].code, 'bed-install.booking_missing');
    assert.equal(install({ subject: subjectFor('999999990', { claimed: 'Beta_SYN-K_1_2_0_6' }), table: TABLE })[0].code, 'bed-install.claim_mismatch');
    assert.equal(install({ subject: subjectFor('999999990', { build: null }), table: TABLE })[0].code, 'bed-install.build_unlocked');
  });

  it('the dispatch policy adds the six dispatch parameters from the checked fact and passes refutations on', () => {
    const [outcome] = dispatchPolicy({ subject: subjectFor('999999990'), table: TABLE });
    assert.equal(outcome.verdict, 'support');
    assert.deepEqual(outcome.data?.parameters, { target: 'bed-a', manifest_sha256: MANIFEST, build: 'Beta.SYN-K.1.2.0.5', sha256: REQUEST, items: ['999999990', '999999991'], generator: 'bed-install.request@1' });
    assert.equal(dispatchPolicy({ subject: subjectFor('999999990', { claimed: 'Beta_SYN-K_1_2_0_6' }), table: TABLE })[0].code, 'bed-install.claim_mismatch');
  });
});
