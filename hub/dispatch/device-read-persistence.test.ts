import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalBytes } from '../records/api.ts';
import type { DeviceReadTarget } from '../../contracts/src/pack.ts';
import { setup } from './testing/context.ts';
import { probes } from './testing/probes.ts';

async function ready() {
  const sent: string[] = [];
  const c = await setup({ extraTools: ['inspect_seat'], alter: (name, value) => {
    if (name !== 'inspect_seat') return value;
    const args = c.endpoint.calls.filter((e) => e.params.name === 'inspect_seat').at(-1)!.params.arguments as Record<string, unknown>;
    sent.push(String(args.command));
    return { output: 'peers:\npeer-1    192.0.2.7\n' };
  } });
  const manifest = await c.kit.artifacts.ingest({ bytes: canonicalBytes({ id: 'synthetic-bed', devices: [1, 2].map((n) => ({ interfaces: [{ address: `192.0.2.${n}/24` }] })) }), mediaType: 'application/json', origin: { upload: { session: 'synthetic' } }, author: { user: c.admin.id }, provenanceType: 'declared', visibility: { readers: [c.owner.id, c.admin.id], admins: true, packs: [], shareable: false } });
  await c.registry.update(c.admin, c.executor.id, { ...c.executor.definition, manifest_sha256: manifest.body.sha256, allowed_tools: [...c.executor.definition.allowed_tools, 'inspect_seat'], probes: { ...probes, command_pattern: '^inspect [a-z]{1,40}$', read: {} } });
  const logs: Array<{ what: string; detail: string }> = [];
  c.service.options.adminLog = (entry) => { logs.push({ what: entry.what, detail: entry.detail }); };
  const target = (line: string): DeviceReadTarget => ({ inventory: manifest.body.sha256, device: '/devices/1', label: 'bed/synthetic-1', line, keys: ['synthetic/device/b'] });
  return { c, sent, logs, target };
}

test('an answer as received that cannot be stored is not shown: the line was sent once and nothing of the device is presented', async (t) => {
  const { c, sent, logs, target } = await ready();
  t.after(() => c.close());
  const ingest = c.kit.artifacts.ingest.bind(c.kit.artifacts);
  c.kit.artifacts.ingest = (async (input: Parameters<typeof ingest>[0]) => {
    if (JSON.stringify(input.origin).includes(':device_read.')) throw new Error('synthetic storage failure');
    return ingest(input);
  }) as typeof c.kit.artifacts.ingest;
  const [result] = await c.service.readDevices(c.owner, 'run_synthetic', [target('inspect peers')]);
  assert.deepEqual(sent, ['inspect peers'], 'not sent a second time');
  assert.equal(result!.answer, null, 'nothing of what the device said is shown');
  assert.equal(result!.sent, true);
  assert.match(result!.missing!.fact, /这一读没有完成/);
  assert.ok(logs.some((l) => l.what === 'device_read' && /storage|保存|存/.test(l.detail)), 'the administrator\'s log has the cause');
  assert.ok(c.calls.includes('close_slot'), 'the gateway lease is released');
});

test('an output that cannot be stored as readable text is not shown', async (t) => {
  const { c, sent, logs, target } = await ready();
  t.after(() => c.close());
  const ingest = c.kit.artifacts.ingest.bind(c.kit.artifacts);
  c.kit.artifacts.ingest = (async (input: Parameters<typeof ingest>[0]) => {
    if (input.name === 'device-read.txt') throw new Error('synthetic storage failure');
    return ingest(input);
  }) as typeof c.kit.artifacts.ingest;
  const [result] = await c.service.readDevices(c.owner, 'run_synthetic', [target('inspect peers')]);
  assert.deepEqual(sent, ['inspect peers']);
  const answer = result!.answer!;
  assert.equal(answer.has_output, true);
  assert.equal(answer.output, null, 'not quoted');
  assert.equal(answer.text_reference, null);
  assert.equal(answer.withheld, false, 'not the credential scan\'s doing');
  assert.equal(answer.anomaly, '设备输出的文本原件没有存下来');
  assert.match(result!.missing!.fact, /没能存成原件，所以不呈现/);
  assert.ok(logs.some((l) => l.what === 'device_read' && /could not be stored/.test(l.detail)));
});
