import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProfile } from './profile.ts';
import { PROFILE_DOC, bedsOf, contractOf } from './test-support.ts';
import { extractProbeValues, probeCommand } from './probes.ts';
const buildProbe = { seat: 'widget-seat', object: 'widget-seat', method: 'configure', command: 'show fixture-build', purpose: 'build', extract: { pattern: 'fixture=(?<value>[A-Za-z0-9-]+)', group: 'value' } };
const addressProbe = { ...buildProbe, purpose: 'addresses', command: 'get fixture-addresses', extract: { pattern: 'ip=(?<address>[0-9.:a-f]+)', group: 'address' } };
test('deployment probes validate purposes seat enabled pair command and named capture rules', () => {
  assert.ok(parseProfile({ ...PROFILE_DOC, probes: [buildProbe, addressProbe] }, contractOf(), bedsOf()).ok);
  for (const bad of [{ ...buildProbe, command: 'set fixture' }, { ...buildProbe, purpose: 'unknown' }, { ...buildProbe, seat: 'missing' }, { ...buildProbe, method: 'hidden' }, { ...buildProbe, extract: { pattern: '(fixture)', group: 'value' } }, { ...buildProbe, extract: { pattern: '(?<value>x)(y)', group: 'value' } }, { ...buildProbe, extract: { pattern: '(?<other>x)', group: 'value' } }]) assert.equal(parseProfile({ ...PROFILE_DOC, probes: [bad] }, contractOf(), bedsOf()).ok, false);
  assert.equal(parseProfile({ ...PROFILE_DOC, probes: [buildProbe, buildProbe] }, contractOf(), bedsOf()).ok, false);
});
test('gateway probe command shape rejects control characters shell syntax unpaired quotes and overlength values', () => {
  for (const value of ['show x\n', 'get x; y', 'get $(x)', 'show "x', 'show ' + 'a'.repeat(200), 'show x\\', 'get x\u0085']) assert.equal(probeCommand(value), false, value);
  for (const value of ['show', 'GET fixture/address', 'show "fixture-build"']) assert.ok(probeCommand(value));
});
test('probe extraction returns explicit missing values instead of unknown and retains every captured address', () => {
  assert.deepEqual(extractProbeValues(buildProbe, 'fixture=synthetic-build'), { values: ['synthetic-build'], missing: false });
  assert.deepEqual(extractProbeValues(buildProbe, 'no fixture value'), { values: [], missing: true });
  assert.deepEqual(extractProbeValues(addressProbe, 'ip=192.0.2.10 ip=2001:db8::10'), { values: ['192.0.2.10', '2001:db8::10'], missing: false });
});
