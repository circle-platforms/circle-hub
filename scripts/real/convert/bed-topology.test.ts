import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertTopology, topologyReport } from './bed-topology.ts';
import { topology } from './testing.ts';

test('topology preserves interface addresses and services and derives only observed singleton reservations', () => {
  const result = convertTopology(topology()).beds[0]!;
  assert.equal(result.name, 'bed-a'); assert.equal(result.devices[0]!.name, 'dut0');
  assert.deepEqual(result.reserved, ['192.0.2.20-192.0.2.20', '192.0.2.21-192.0.2.21']);
  assert.equal(result.services[0]!.host, 'client0');
  const empty = topology(); empty.observation.unregistered_neighbours = { eth0: [] }; assert.deepEqual(convertTopology(empty).beds[0]!.reserved, []);
});
for (const [name, mutate] of Object.entries({
  collision: (v: ReturnType<typeof topology>) => { v.topology.devices[1]!.name = 'DUT0'; },
  label: (v: ReturnType<typeof topology>) => { v.topology.devices[0]!.type = 'unknown'; },
  prefix: (v: ReturnType<typeof topology>) => { v.topology.devices[0]!.ipv4 = ['192.0.2.10']; },
  assumed: (v: ReturnType<typeof topology>) => { Object.assign(v.topology.devices[0]!, { _mask_assumed: true }); },
  duplicate: (v: ReturnType<typeof topology>) => { v.topology.devices[1]!.ipv4 = ['192.0.2.10/24']; },
  services: (v: ReturnType<typeof topology>) => { Reflect.deleteProperty(v, 'services'); },
  observation: (v: ReturnType<typeof topology>) => { Reflect.deleteProperty(v, 'observation'); },
})) test(`topology refuses ${name} without guessing`, () => { const raw = topology(); mutate(raw); assert.throws(() => convertTopology(raw)); });

test('outside-subnet neighbours are excluded while both in-subnet observations remain', () => {
  const raw = topology(); raw.topology.devices[0].ipv4 = ['192.0.2.10/26']; raw.topology.devices[1].ipv4 = ['192.0.2.11/26'];
  raw.observation.unregistered_neighbours.eth0.push('192.0.2.200');
  assert.deepEqual(convertTopology(raw).beds[0].reserved, ['192.0.2.20-192.0.2.20', '192.0.2.21-192.0.2.21']);
});
test('service protocol translation accepts only the declared source table', () => {
  const raw = topology(); raw.services[0].proto = 'http'; assert.equal(convertTopology(raw).beds[0].services[0].proto, 'tcp');
  raw.services[0].proto = 'https'; assert.equal(convertTopology(raw).beds[0].services[0].proto, 'tcp');
  raw.services[0].proto = 'dns'; assert.equal(convertTopology(raw).beds[0].services[0].proto, 'udp');
  raw.services[0].proto = 'synthetic-unknown'; assert.throws(() => convertTopology(raw), /services\/0\/proto/);
});

test('invalid source bed identifiers disclose the exact safe pointer and accept explicit mapping only', () => {
  const raw = topology(); raw.topology._bed.conf = 'Synthetic_Bed.conf';
  assert.throws(() => convertTopology(raw), error => error instanceof Error && /\/beds\/0\/name.*清单字段约束.*--bed-name/.test(error.message) && !error.message.includes('Synthetic_Bed.conf'));
  const converted = topologyReport(raw, 'bed-mapped'); assert.equal(converted.manifest.beds[0].name, 'bed-mapped');
  assert.deepEqual(converted.name_mapping, { source: 'Synthetic_Bed.conf', manifest: 'bed-mapped', explicit: true });
  assert.throws(() => convertTopology(raw, 'INVALID_Name'), /\/beds\/0\/name/);
});
test('manifest refusals keep each parser pointer without printing source values', () => {
  const raw = topology(); raw.topology.devices[1].name = 'dut0';
  assert.throws(() => convertTopology(raw), error => error instanceof Error && /test-bed.*\/beds\/0\/devices\/1\/name/.test(error.message) && /case-compile/.test(error.message) && !error.message.includes('dut0'));
});
