// The bed-install projection and checks on synthetic inventories, install profiles and requests: one item per dispatch-target
// device with the profile's upgrade case, the request rules of the upgrade case, the whole-bed booking, the locked build, and
// the dispatch parameters bound from the checked fact.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import TABLE from '../policies/install.json' with { type: 'json' };
import PROFILE from '../examples/bed-install-profile.json' with { type: 'json' };
import { imageVersion, versionOfBuild } from './common.ts';
import project from './project.ts';
import { buildSubject } from './subject.ts';
import install from './install.ts';
import dispatchPolicy from './dispatch-policy.ts';

const MANIFEST = 'a'.repeat(64), REQUEST = 'b'.repeat(64), PROFILE_SHA = 'c'.repeat(64);
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
const request = { schema: 'bed-install@1', build: 'Rel_FAMX_9_2_1_8', image: 'FAMXOS-Rel_FAMX_9_2_1_8.img' };
const projectionInput = (overrides: { bed?: string; request?: unknown; profile?: unknown | null } = {}) => ({
  inputs: [
    { slot: 'inventory', external: 'doc:doc:bed-topology', sha256: MANIFEST, media_type: 'application/json', parser: 'json@1', model: inventory, meta: null },
    ...(overrides.profile === null ? [] : [{ slot: 'profile', external: `doc:doc:bed-install-profile@${PROFILE_SHA}`, sha256: PROFILE_SHA, media_type: 'application/json', parser: 'json@1', model: overrides.profile ?? PROFILE, meta: null }]),
    { slot: 'request', external: null, sha256: REQUEST, media_type: 'application/json', parser: 'json@1', model: overrides.request ?? request, meta: null },
  ],
  parameters: { bed: overrides.bed ?? 'bed-a' },
  context: { product: 'SYN', names: ['SYN'], line: null, build: 'Rel_FAMX_9_2_1_6', root: null, parameters: {}, groups: [] },
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
      build: options.build === undefined ? 'Rel_FAMX_9_2_1_6' : options.build,
      leases: { now: '2026-01-01T00:00:00.000Z', registrations: [], entries: options.leases ?? booked(['client1', 'lb0', 'lb1']) },
    },
  });
}

describe('the upgrade case\'s image reading', () => {
  it('reads the build after the first dash up to the last dot, underscores as dots, for the declared extensions', () => {
    const extensions = ['img', 'qcow2'];
    assert.equal(imageVersion('FAMXOS-Rel_FAMX_9_2_1_8.img', extensions), 'Rel.FAMX.9.2.1.8');
    assert.equal(imageVersion('FAMXOS-Rel_FAMX_9_2_1_8.qcow2', extensions), 'Rel.FAMX.9.2.1.8');
    assert.equal(versionOfBuild('Rel_FAMX_9_2_1_8'), 'Rel.FAMX.9.2.1.8');
    for (const name of ['Rel_FAMX_9_2_1_8.img', 'FAMXOS-Rel_FAMX_9_2_1_8.iso', '../FAMXOS-Rel_FAMX_9_2_1_8.img', 'FAMXOS-Rel FAMX.img']) {
      assert.equal(imageVersion(name, extensions), null, name);
    }
  });
});

describe('the projection', () => {
  it('gives one item per dispatch-target device of the named bed, in inventory order, with the profile\'s upgrade case', () => {
    const out = project(projectionInput());
    assert.ok('items' in out, JSON.stringify(out));
    assert.deepEqual(out.items.map((item) => [item.id, item.fields.device, item.location.selector]), [
      ['syn-upgrade-0', 'lb0', 'p/beds/1/devices/1'],
      ['syn-upgrade-1', 'lb1', 'p/beds/1/devices/2'],
    ]);
    assert.deepEqual(out.groups[0], { kind: 'bed-install', bed: 'bed-a', devices: ['client1', 'lb0', 'lb1'], targets: ['lb0', 'lb1'], manifest_sha256: MANIFEST, bed_pointer: 'p/beds/1', profile_sha256: PROFILE_SHA, upgrade_cases: ['syn-upgrade-0', 'syn-upgrade-1'], image_extensions: ['img'], request_sha256: REQUEST, request });
  });

  it('refuses without an install profile, naming the document and the administrator\'s command', () => {
    const out = project(projectionInput({ profile: null }));
    assert.ok('error' in out);
    assert.deepEqual([out.error.code, out.error.pointer], ['bed-install.no_profile', '/inputs/profile']);
    assert.match(out.error.message, /升级用例号和升级用例认的镜像扩展名是部署数据/);
    assert.match(out.error.fix, /circle-hub doc put bed-install-profile <文件>/);
  });

  it('refuses a profile of the wrong shape, listing every problem and the way to republish it', () => {
    const out = project(projectionInput({ profile: { schema: 'bed-install-profile@1', upgrade_cases: ['syn-upgrade-0', 'syn-upgrade-0', 'bad id'], extensions: ['img'] } }));
    assert.ok('error' in out);
    assert.equal(out.error.code, 'bed-install.profile_invalid');
    assert.deepEqual(out.error.grounds, [`src:${PROFILE_SHA}`]);
    for (const problem of [/多了 extensions/, /upgrade_cases 里有 1 项不是升级用例号/, /upgrade_cases 里有重复项/, /缺 image_extensions/]) assert.match(out.error.message, problem);
    assert.match(out.error.fix, /重新发布后重开运行/);
    for (const profile of ['upgrade_cases', [], { ...PROFILE, schema: 'bed-install-profile@2' }, { ...PROFILE, image_extensions: ['.img'] }, { ...PROFILE, upgrade_cases: [] }]) {
      const refused = project(projectionInput({ profile }));
      assert.ok('error' in refused && refused.error.code === 'bed-install.profile_invalid', JSON.stringify(profile));
    }
  });

  it('refuses a bed with more dispatch targets than the profile has upgrade cases, saying how many are missing', () => {
    const out = project(projectionInput({ profile: { ...PROFILE, upgrade_cases: ['syn-upgrade-0'] } }));
    assert.ok('error' in out);
    assert.deepEqual([out.error.code, out.error.pointer], ['bed-install.too_many_targets', '/inputs/profile']);
    assert.match(out.error.message, /有 2 台要装构建的设备，装构建档案 bed-install-profile 只写了 1 个升级用例/);
    assert.match(out.error.fix, /补齐到 2 个/);
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
    const [outcome] = install({ subject: subjectFor('syn-upgrade-1'), table: TABLE });
    assert.equal(outcome.verdict, 'support', outcome.statement);
    assert.deepEqual(outcome.data, {
      sha256: REQUEST, autoids: ['syn-upgrade-0', 'syn-upgrade-1'], bed: { id: 'bed-a', manifest_sha256: MANIFEST }, build: 'Rel_FAMX_9_2_1_6',
      generator: 'bed-install.request@1', plan_run: 'run_booking', install: { build: request.build, image: request.image, version: 'Rel.FAMX.9.2.1.8', targets: ['lb0', 'lb1'] },
    });
  });

  it('refutes an image that installs another build, naming what the upgrade case would install', () => {
    const [outcome] = install({ subject: subjectFor('syn-upgrade-0', { request: { ...request, image: 'FAMXOS-Rel_FAMX_9_2_1_9.img' } }), table: TABLE });
    assert.deepEqual([outcome.verdict, outcome.code], ['refute', 'bed-install.request_invalid']);
    assert.match(outcome.statement, /装的是 Rel\.FAMX\.9\.2\.1\.9/);
  });

  it('refutes an image whose extension the frozen profile does not list, naming the ones it does', () => {
    const [outcome] = install({ subject: subjectFor('syn-upgrade-0', { request: { ...request, image: 'FAMXOS-Rel_FAMX_9_2_1_8.iso' } }), table: TABLE });
    assert.deepEqual([outcome.verdict, outcome.code], ['refute', 'bed-install.request_invalid']);
    assert.match(outcome.statement, /以装构建档案写的 \.img 结尾/);
    assert.ok(outcome.grounds.includes(`src:${PROFILE_SHA}`), JSON.stringify(outcome.grounds));
  });

  it('gives a frozen group without the profile (a run opened before 1.0.4) the missing fact and the way on, not a verdict', () => {
    const subject = subjectFor('syn-upgrade-0');
    const { profile_sha256: _sha, upgrade_cases: _cases, image_extensions: _extensions, ...older } = subject.group!;
    const [outcome] = install({ subject: { ...subject, group: older }, table: TABLE });
    assert.deepEqual([outcome.verdict, outcome.reason], ['unknown', 'missing_input']);
    assert.match(outcome.missing ?? '', /用本包重新开运行/);
  });

  it('refutes a booking that misses a device of the bed, a different claimed build and a run without a locked build', () => {
    assert.equal(install({ subject: subjectFor('syn-upgrade-0', { leases: booked(['lb0', 'lb1']) }), table: TABLE })[0].code, 'bed-install.booking_missing');
    assert.equal(install({ subject: subjectFor('syn-upgrade-0', { leases: booked(['client1', 'lb0', 'lb1'], 'run_other') }), table: TABLE })[0].code, 'bed-install.booking_missing');
    assert.equal(install({ subject: subjectFor('syn-upgrade-0', { predecessor: null }), table: TABLE })[0].code, 'bed-install.booking_missing');
    assert.equal(install({ subject: subjectFor('syn-upgrade-0', { claimed: 'Rel_FAMX_9_2_1_7' }), table: TABLE })[0].code, 'bed-install.claim_mismatch');
    assert.equal(install({ subject: subjectFor('syn-upgrade-0', { build: null }), table: TABLE })[0].code, 'bed-install.build_unlocked');
  });

  it('takes an attempt so a retry is a new request, and refuses one that is not a whole number from 1 to 1000', () => {
    const [retry] = install({ subject: subjectFor('syn-upgrade-0', { request: { ...request, attempt: 2 } }), table: TABLE });
    assert.equal(retry.verdict, 'support', retry.statement);
    assert.match(retry.statement, /上第 2 次装/);
    assert.equal((retry.data?.install as { attempt?: number }).attempt, 2);
    for (const attempt of [0, 1.5, '2', 1001]) {
      const [outcome] = install({ subject: subjectFor('syn-upgrade-0', { request: { ...request, attempt } }), table: TABLE });
      assert.equal(outcome.code, 'bed-install.request_invalid', String(attempt));
    }
  });

  it('the dispatch policy adds the six dispatch parameters from the checked fact and passes refutations on', () => {
    const [outcome] = dispatchPolicy({ subject: subjectFor('syn-upgrade-0'), table: TABLE });
    assert.equal(outcome.verdict, 'support');
    assert.deepEqual(outcome.data?.parameters, { target: 'bed-a', manifest_sha256: MANIFEST, build: 'Rel_FAMX_9_2_1_6', sha256: REQUEST, items: ['syn-upgrade-0', 'syn-upgrade-1'], generator: 'bed-install.request@1' });
    assert.equal(dispatchPolicy({ subject: subjectFor('syn-upgrade-0', { claimed: 'Rel_FAMX_9_2_1_7' }), table: TABLE })[0].code, 'bed-install.claim_mismatch');
  });
});
