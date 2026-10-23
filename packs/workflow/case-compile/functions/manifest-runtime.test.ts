import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseManifest } from './manifest.ts';
import { MANIFEST_DOC } from './test-support.ts';
import { parseManifest as parseBed } from '../../test-bed/functions/manifest.ts';
for (const name of ['bed-a', 'bed-a_underscore']) test(`bed name syntax agrees with test-bed: ${name}`, () => {
  const raw = structuredClone(MANIFEST_DOC); raw.beds[0].name = name;
  assert.equal(parseManifest(raw).ok, parseBed(raw).ok);
});
for (const field of ['services', 'reserved']) test(`required manifest field: ${field}`, () => {
  const raw = structuredClone(MANIFEST_DOC) as any; delete raw.beds[0][field];
  assert.equal(parseManifest(raw).ok, false); assert.equal(parseBed(raw).ok, false);
});
test('service addresses compare numerically rather than by IPv6 notation', () => {
  const raw = structuredClone(MANIFEST_DOC); raw.beds[0].services.push({ host: 'dut0', ip: '2001:DB8:1:0:0:0:0:10', proto: 'tcp', port: 80 });
  assert.equal(parseManifest(raw).ok, true); assert.equal(parseBed(raw).ok, true);
});
test('manifest drift sentinels for address syntax, ownership and reserved membership', () => {
  for (const address of ['2001:db8:1:2:3:4:5:6::/64', '192.0.2.10/', '192.0.2.10/+26']) {
    const raw = structuredClone(MANIFEST_DOC); raw.beds[0].devices[0].ipv4 = [address];
    assert.equal(parseManifest(raw).ok, false); assert.equal(parseBed(raw).ok, false);
  }
  const raw = structuredClone(MANIFEST_DOC) as any; raw.beds[0].reserved = ['192.0.2.250-192.0.2.251'];
  assert.equal(parseManifest(raw).ok, false); assert.equal(parseBed(raw).ok, false);
});
