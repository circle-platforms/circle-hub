import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { ExecutorDefinition } from '../../hub/dispatch/api.ts';
import { addSyntheticExecutor } from '../../hub/dispatch/testing/credentials.ts';
import { definition } from '../../hub/dispatch/testing/definition.ts';
import { probes } from '../../hub/dispatch/testing/probes.ts';
import { startEndpoint } from '../../hub/dispatch/testing/server.ts';
import { INDEX } from '../../hub/runs/engine/store.ts';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { openBed, type Bed } from './support/hub.ts';
import type { McpClient } from './support/mcp.ts';

const INVENTORY = {
  schema: 'test-bed-manifest@1',
  beds: [{
    name: 'bed-a',
    devices: [
      { name: 'afamx0', type: 'load-balancer', ipv4: ['192.0.2.10/26'], ipv6: [] },
      { name: 'client0', type: 'client', ipv4: ['192.0.2.80/26'], ipv6: [] },
    ],
    services: [],
    reserved: [],
  }],
};
const KNOWN: Record<string, string> = {
  'inspect peers': 'peers:\nname      address\npeer-1    192.0.2.7',
};

describe('scenario 61: a writer reads what a booked device prints for a read-only command', () => {
  let postgres: TemporaryPostgres;
  let bed: Bed;
  let client: McpClient;
  let gateway: Awaited<ReturnType<typeof startEndpoint>>;
  let executor: string;
  const called: Array<{ name: string; args: Record<string, unknown> }> = [];

  before(async () => {
    postgres = await startPostgres();
    bed = await openBed({ postgres });
    gateway = await startEndpoint([...definition('x').allowed_tools, 'inspect_seat'], (name, args) => {
      called.push({ name, args });
      if (name === 'open_slot' || name === 'touch_slot') return { ok: true, ticket: 'synthetic-ticket', token: 'synthetic-token', ttl: 30000 };
      if (name === 'inspect_seat') {
        const command = String(args.command);
        return { output: command === 'inspect version' ? 'version: synthetic-build' : Object.hasOwn(KNOWN, command) ? KNOWN[command] : '' };
      }
      return { ok: true };
    });
    await bed.hub.hub.docs.put(bed.hub.admin.principal, 'bed-topology', new TextEncoder().encode(JSON.stringify(INVENTORY)), { fileName: 'bed-topology.json' });
    const sha = (await bed.hub.hub.docs.show('bed-topology'))!.sha256;
    const raw = definition(gateway.endpoint);
    const seats = [{ ...probes.seats[0]!, seat: 'afamx0', manifest: { ...probes.seats[0]!.manifest, device: '/beds/0/devices/0' } }];
    const declared = ExecutorDefinition.parse({
      ...raw, target: 'bed-a', resources: ['bed/bed-a/afamx0', 'bed/bed-a/client0'], manifest_sha256: sha,
      allowed_tools: [...raw.allowed_tools, 'inspect_seat'],
      probes: { ...probes, seats, command_pattern: '^inspect [a-z0-9 ._:/-]{1,200}$' },
    });
    const registered = await addSyntheticExecutor(bed.hub.records, bed.hub.hub.dispatch!.registry, bed.hub.admin.principal, declared, 'synthetic-read-key');
    executor = registered.id;
    const user = await bed.user('读设备的写手', ['test-bed']);
    await bed.hub.records.authorizations.assignResource(bed.hub.admin.principal, executor, user.user.id);
    client = await bed.connect(user, 'sess-s61');
  });

  after(async () => {
    await gateway?.close();
    await bed?.close();
    await postgres?.stop();
  });

  const inputs = { inventory: { external: 'doc:doc:bed-topology' } };
  type ReadRun = { run: string; device_reads: Array<{ statement: { text: string; verdict?: string; data?: Record<string, unknown> }; qualifier: { nature: string; marks: string[]; provenance: string }; grounds: string[]; warrant: { id: string } }>; sources: Array<{ reference: string }> };
  let booking: string;

  test('an executor that did not opt in reads nothing: the answer is an unknown with the next step, and the device is left alone', async () => {
    const booked = await client.call('start_run', { pack: 'test-bed', inputs, parameters: { action: 'acquire', bed: 'bed-a', need: { devices: [{ type: 'load-balancer', count: 1 }] } } });
    assert.equal(booked.isError, false, booked.text.slice(0, 800));
    booking = (booked.out as { run: { run: string } }).run.run;
    called.length = 0;
    const asked = await client.call('start_run', { pack: 'test-bed', inputs, predecessor: booking, parameters: { action: 'read', booking, device: 'afamx0', line: 'inspect peers' } });
    assert.equal(asked.isError, false, asked.text.slice(0, 1200));
    const run = (asked.out as { run: ReadRun }).run;
    assert.equal(run.device_reads.length, 1);
    assert.deepEqual([run.device_reads[0]!.qualifier.nature, run.device_reads[0]!.statement.verdict], ['unknown', 'unknown']);
    assert.match(run.device_reads[0]!.statement.text, /这台执行器没有声明可以按请求读设备。下一步：管理员用 executor update .*probes\.read/);
    assert.match(asked.text, /这台执行器没有声明可以按请求读设备/);
    assert.deepEqual(called, [], 'not one request reached the gateway');
  });

  test('once the administrator opts in, one line goes through the per-seat read and the device words come back as received', async () => {
    const registry = bed.hub.hub.dispatch!.registry;
    const registered = (await registry.get(executor))!.definition;
    await registry.update(bed.hub.admin.principal, executor, { ...registered, probes: { ...registered.probes!, read: { max_chars: 16000, max_reads: 1 } } });
    called.length = 0;
    const asked = await client.call('start_run', { pack: 'test-bed', inputs, predecessor: booking, parameters: { action: 'read', booking, device: 'afamx0', line: 'inspect peers' } });
    assert.equal(asked.isError, false, asked.text.slice(0, 1200));
    assert.deepEqual(called.filter((c) => c.name === 'inspect_seat').map((c) => c.args), [{ seat: 0, command: 'inspect peers', ticket: 'synthetic-ticket' }], 'one call: the seat of the device and the line');
    assert.ok(called.every((c) => c.name !== 'send_blob'), 'nothing is dispatched');
    assert.ok(called.some((c) => c.name === 'close_slot'), 'the gateway lease of the read is released');
    assert.match(asked.text, /设备输出仅供参考，不能作为原始用例的期望依据。/);
    assert.match(asked.text, /在 bed-a\/afamx0 上读“inspect peers”：设备输出 3 行/);
    assert.match(asked.text, /设备输出\npeers:\nname      address\npeer-1    192\.0\.2\.7(?:\n|$)/);
    const run = (asked.out as { run: ReadRun }).run;
    assert.equal(run.device_reads.length, 1, 'one observation per request');
    const [claim] = run.device_reads;
    assert.deepEqual([claim!.statement.data?.line, claim!.statement.data?.device, claim!.statement.data?.output], ['inspect peers', '/beds/0/devices/0', KNOWN['inspect peers']]);
    assert.deepEqual([claim!.qualifier.nature, claim!.qualifier.provenance, claim!.warrant.id], ['fact', 'observed', 'dispatch.device_read@1']);
    assert.ok(claim!.qualifier.marks.includes('target_reported') && claim!.qualifier.marks.includes('local_ops_not_excluded'));
    assert.ok(claim!.grounds.length === 2 && run.sources.every((source) => !claim!.grounds.includes(source.reference)), 'the stored answer and text are grounds of the claim; neither is a source bound to the run');
    const stored = (await bed.hub.records.store.find({ key: INDEX.runId, value: run.run, kind: 'run', limit: 1 })).items[0]!.body as { device_reads?: unknown[]; leases?: unknown[] };
    assert.equal(stored.device_reads?.length, 1, 'the record keeps the claim');
    assert.equal(stored.leases, undefined, 'reading takes and gives no lease');
    const view = await bed.hub.leases.view('bed/');
    assert.ok(view.entries.some((e) => e.key === 'bed/bed-a/afamx0'), 'the booking still holds the device');
  });

  test('a line outside the declared shape is not sent, and whoever does not hold the device is refused before the gateway is reached', async () => {
    called.length = 0;
    const shaped = await client.call('start_run', { pack: 'test-bed', inputs, predecessor: booking, parameters: { action: 'read', booking, device: 'afamx0', line: 'inspect peers; frobnicate' } });
    assert.equal(shaped.isError, false, shaped.text.slice(0, 1200));
    const [unknown] = (shaped.out as { run: ReadRun }).run.device_reads;
    assert.equal(unknown!.qualifier.nature, 'unknown');
    assert.match(unknown!.statement.text, /没有读设备：bed-a\/afamx0：这一行不符合执行器声明的只读命令形状/);
    const levelled = await client.call('start_run', { pack: 'test-bed', inputs, predecessor: booking, parameters: { action: 'read', booking, device: 'afamx0', line: 'inspect peers', mode: 'level-a' } });
    assert.equal(levelled.isError, true, 'a read has no level');
    const other = await client.call('start_run', { pack: 'test-bed', inputs, parameters: { action: 'acquire', bed: 'bed-a', need: { devices: [{ type: 'client', count: 1 }] } } });
    assert.equal(other.isError, false, other.text.slice(0, 800));
    const second = (other.out as { run: { run: string } }).run.run;
    const notHeld = await client.call('start_run', { pack: 'test-bed', inputs, predecessor: second, parameters: { action: 'read', booking: second, device: 'afamx0', line: 'inspect peers' } });
    assert.equal(notHeld.isError, true);
    assert.match(JSON.stringify(notHeld.out), /你没有持有设备 afamx0 的预订/);
    const noPredecessor = await client.call('start_run', { pack: 'test-bed', inputs, parameters: { action: 'read', booking: second, device: 'client0', line: 'inspect peers' } });
    assert.equal(noPredecessor.isError, true);
    assert.match(JSON.stringify(noPredecessor.out), /predecessor/);
    const stranger = await bed.user('别的写手', ['test-bed']);
    const strangers = await (await bed.connect(stranger, 'sess-s61-b')).call('start_run', { pack: 'test-bed', inputs, parameters: { action: 'read', booking, device: 'afamx0', line: 'inspect peers' } });
    assert.equal(strangers.isError, true);
    assert.deepEqual(called.filter((c) => c.name === 'inspect_seat' && c.args.command !== 'inspect version'), [], 'not one requested line reached the gateway');
  });
});
