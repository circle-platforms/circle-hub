import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalBytes } from '../records/api.ts';
import type { DeviceHelpTarget } from '../../contracts/src/pack.ts';
import { setup } from './testing/context.ts';
import { probes } from './testing/probes.ts';

const HELP = {
  line_pattern: '^[A-Za-z0-9 ._:/"\'-]{1,500}$',
  call: { tool: 'ask_position', arguments: { seat: { $value: 'seat_index' }, line: { $value: 'line' }, ticket: { $value: 'lease_id' } } },
  text: '/help', caret_only: '/caret', entered: '/entered', cleared: '/cleared',
};
const scripted = (line: string): Record<string, unknown> => (line === 'widget set demo' ? { help: '<1-9>   a number', caret: false, entered: false, cleared: true } : { help: '', caret: true, entered: false, cleared: true });

async function ready() {
  const asked: string[] = [];
  const c = await setup({ extraTools: ['inspect_seat', 'ask_position'], alter: (name, value) => {
    if (name !== 'ask_position') return value;
    const args = c.endpoint.calls.filter((e) => e.params.name === 'ask_position').at(-1)!.params.arguments as Record<string, unknown>;
    asked.push(String(args.line));
    return scripted(String(args.line));
  } });
  const manifest = await c.kit.artifacts.ingest({ bytes: canonicalBytes({ id: 'synthetic-bed', devices: [1, 2].map((n) => ({ interfaces: [{ address: `192.0.2.${n}/24` }] })) }), mediaType: 'application/json', origin: { upload: { session: 'synthetic' } }, author: { user: c.admin.id }, provenanceType: 'declared', visibility: { readers: [c.owner.id, c.admin.id], admins: true, packs: [], shareable: false } });
  const proof = await c.kit.artifacts.ingest({ bytes: new TextEncoder().encode('synthetic audit of the help tool'), mediaType: 'text/plain', origin: { upload: { session: 'synthetic' } }, author: { user: c.admin.id }, provenanceType: 'declared', visibility: { readers: [c.admin.id], admins: true, packs: [], shareable: false } });
  await c.registry.update(c.admin, c.executor.id, { ...c.executor.definition, manifest_sha256: manifest.body.sha256, allowed_tools: [...c.executor.definition.allowed_tools, 'inspect_seat', 'ask_position'], probes: { ...probes, help: HELP }, premises: { read_only: { version: '1', evidence: [`src:${proof.body.sha256}`] } } });
  const logs: Array<{ what: string; detail: string }> = [];
  c.service.options.adminLog = (entry) => { logs.push({ what: entry.what, detail: entry.detail }); };
  const target = (line: string): DeviceHelpTarget => ({ inventory: manifest.body.sha256, device: '/devices/1', label: 'bed/synthetic-1', line, keys: ['synthetic/device/b'] });
  return { c, asked, logs, target };
}

test('an answer as received that cannot be stored is not shown: the line was typed once and nothing shorter is', async (t) => {
  const { c, asked, logs, target } = await ready();
  t.after(() => c.close());
  const ingest = c.kit.artifacts.ingest.bind(c.kit.artifacts);
  c.kit.artifacts.ingest = (async (input: Parameters<typeof ingest>[0]) => {
    if (JSON.stringify(input.origin).includes(':help.')) throw new Error('synthetic storage failure');
    return ingest(input);
  }) as typeof c.kit.artifacts.ingest;
  const [result] = await c.service.askDevices(c.owner, 'run_synthetic', [target('widget set demo 5')]);
  assert.deepEqual(asked, ['widget set demo 5']);
  assert.deepEqual(result!.positions, [], 'nothing of what the device said is shown');
  assert.match(result!.missing!.fact, /这一问没有完成.*不再往下问/);
  assert.ok(logs.some((l) => l.what === 'device_help' && /storage|保存|存/.test(l.detail)), 'the administrator\'s log has the cause');
  assert.ok(c.calls.includes('close_slot'), 'the gateway lease is released');
});

test('a description that cannot be stored as readable text is not shown, and the questioning ends on it', async (t) => {
  const { c, asked, logs, target } = await ready();
  t.after(() => c.close());
  const ingest = c.kit.artifacts.ingest.bind(c.kit.artifacts);
  c.kit.artifacts.ingest = (async (input: Parameters<typeof ingest>[0]) => {
    if (input.name === 'device-help.txt') throw new Error('synthetic storage failure');
    return ingest(input);
  }) as typeof c.kit.artifacts.ingest;
  const [result] = await c.service.askDevices(c.owner, 'run_synthetic', [target('widget set demo 5')]);
  assert.deepEqual(asked, ['widget set demo 5', 'widget set demo']);
  const described = result!.positions[1]!;
  assert.equal(described.described, true);
  assert.equal(described.text, null, 'not quoted');
  assert.equal(described.text_reference, null);
  assert.equal(described.withheld, false, 'not the credential scan\'s doing');
  assert.equal(described.anomaly, '设备说明的文本原件没有存下来');
  assert.match(result!.missing!.fact, /没能存成原件，所以不呈现，也不再往下问/);
  assert.ok(logs.some((l) => l.what === 'device_help' && /could not be stored/.test(l.detail)));
});
