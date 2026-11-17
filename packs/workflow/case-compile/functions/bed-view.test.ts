// The bed as the model is shown it and as the refusals name it: listeners with the open hosts that share their segment, the
// blind addresses, the declared services. One computation serves the item field and the refusal text. Synthetic bed only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_TRIGGER_TYPES, bedView, hostsReaching, pairsText, triggerTypesOf } from './bed.ts';
import { PROFILE_DOC, bedsOf } from './test-support.ts';

const bed = bedsOf()[0], profile = PROFILE_DOC as unknown as Parameters<typeof bedView>[1];

test('the default trigger types are routers and clients; a profile declares any subset of the closed set', () => {
  assert.deepEqual([...DEFAULT_TRIGGER_TYPES].sort(), ['client', 'router']);
  assert.equal(triggerTypesOf(undefined), DEFAULT_TRIGGER_TYPES);
  assert.deepEqual([...triggerTypesOf(['server'])], ['server']);
  assert.equal(triggerTypesOf([]).size, 0);
});

test('the view lists each listener with the open hosts on its segment, the blind addresses and the declared services', () => {
  const view = bedView(bed, profile);
  assert.deepEqual(view, {
    bed: 'bed-a', trigger_types: ['client', 'router'],
    listeners: [
      { address: '192.0.2.10', device: 'dut0', hosts: [] },
      { address: '192.0.2.74', device: 'dut0', hosts: [{ object: 'widget-host', method: 'shell', device: 'client0' }] },
      { address: '2001:db8:1::10', device: 'dut0', hosts: [] },
    ],
    blind: ['192.0.2.130'],
    services: [{ address: '192.0.2.80', service: 'client0:9000/tcp' }, { address: '192.0.2.90', service: 'server0:80/tcp' }],
  });
  assert.equal(pairsText(view), 'widget-host.shell（设备 client0） → 192.0.2.74；没有已开放的主机够得着：192.0.2.10、2001:db8:1::10');
});

test('a host reaches a target by the numeric prefix of its interfaces, whatever the notation', () => {
  const hosts = [{ object: 'widget-router', method: 'shell', device: 'router0' }];
  assert.deepEqual(hostsReaching(bed, hosts, '192.0.2.10').map((row) => row.device), ['router0']);
  assert.deepEqual(hostsReaching(bed, hosts, '2001:DB8:1:0:0:0:0:10').map((row) => row.device), ['router0'], 'full and compressed forms are one address');
  assert.deepEqual(hostsReaching(bed, hosts, '192.0.2.74'), [], 'another segment');
  assert.deepEqual(hostsReaching(bed, hosts, 'not-an-address'), []);
});

test('with no trigger type there is no listener and the pairing table says so', () => {
  const view = bedView(bed, { ...profile, trigger_types: [] });
  assert.deepEqual(view.listeners, []); assert.equal(view.blind.length, 4, 'every interface of the devices under test is blind');
  assert.equal(pairsText(view), '这张床没有监听候选');
});
