import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertTopology } from './bed-topology.ts';
export function topology() { return { topology: { _bed: { conf: 'Bed-A' }, devices: [{ name: 'Dut0', type: '负载均衡', ipv4: ['192.0.2.10/24'], ipv6: ['2001:db8::10/64'] }, { name: 'Client0', type: '客户端', ipv4: ['192.0.2.11/24'], ipv6: [] }] }, services: [{ host: 'CLIENT0', ip: '192.0.2.11', proto: 'tcp', port: 80 }], observation: { unregistered_neighbours: { eth0: ['192.0.2.20', '192.0.2.21'] } } }; }
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
