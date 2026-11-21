import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bedFacts } from './bed.ts';
import { renderBedFactsLines } from './authoring-brief.ts';

const bed = { name: 'synthetic', devices: [
  { name: 'dut0', type: 'load-balancer', ipv4: [{ address: '192.0.2.70', subnet: '192.0.2.0/24', family: 'ipv4' }, { address: '198.51.100.70', subnet: '198.51.100.0/24', family: 'ipv4' }], ipv6: [] },
  { name: 'client1', type: 'client', ipv4: [{ address: '192.0.2.11', subnet: '192.0.2.0/24', family: 'ipv4' }], ipv6: [] },
  { name: 'router1', type: 'router', ipv4: [{ address: '192.0.2.12', subnet: '192.0.2.0/24', family: 'ipv4' }], ipv6: [] },
], services: [] } as unknown as Parameters<typeof bedFacts>[0];

test('each listener candidate is shown with the hosts of its own segment that can reach it', () => {
  const facts = bedFacts(bed);
  const lines = renderBedFactsLines({ facts_status: 'ok', bed_name: 'synthetic', segments: facts.segments, listeners: facts.listeners, blind: facts.blind, backends: facts.backends, unknowns: facts.unknowns, trigger_types: ['client', 'router'], forbidden_combinations: [], execution_failure_markers: [] } as unknown as Parameters<typeof renderBedFactsLines>[0]).join('\n');
  assert.match(lines, /监听候选（listeners；括号里是同网段能直接向它发起访问的主机）/);
  assert.match(lines.replace(/\n\s*/g, ''), /dut0@192\.0\.2\.70（client1@192\.0\.2\.11、router1@192\.0\.2\.12）/);
  assert.match(lines.replace(/\n\s*/g, ''), /盲区禁用[^·]*dut0@198\.51\.100\.70/, 'an address no host shares a segment with stays a blind spot');
});
