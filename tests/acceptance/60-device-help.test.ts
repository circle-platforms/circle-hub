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
const HELP = {
  line_pattern: '^[A-Za-z0-9 ._:/"\'-]{1,500}$',
  call: { tool: 'ask_position', arguments: { seat: { $value: 'seat_index' }, line: { $value: 'line' }, ticket: { $value: 'lease_id' } } },
  text: '/help', caret_only: '/caret', entered: '/entered', cleared: '/cleared',
};
const KNOWN: Record<string, string> = {
  'widget': 'set    configure a widget\nshow   show the widgets',
  'widget set demo': '<1-9>   a number\n<cr>',
};

describe('scenario 60: a writer asks a booked device what it expects', () => {
  let postgres: TemporaryPostgres;
  let bed: Bed;
  let client: McpClient;
  let gateway: Awaited<ReturnType<typeof startEndpoint>>;
  const called: Array<{ name: string; args: Record<string, unknown> }> = [];

  before(async () => {
    postgres = await startPostgres();
    bed = await openBed({ postgres });
    gateway = await startEndpoint([...definition('x').allowed_tools, 'inspect_seat', 'ask_position'], (name, args) => {
      called.push({ name, args });
      if (name === 'open_slot' || name === 'touch_slot') return { ok: true, ticket: 'synthetic-ticket', token: 'synthetic-token', ttl: 30000 };
      if (name === 'inspect_seat') return { output: 'version: synthetic-build' };
      if (name === 'ask_position') {
        const line = String(args.line);
        return Object.hasOwn(KNOWN, line) ? { help: KNOWN[line], caret: false, entered: false, cleared: true } : { help: '', caret: true, entered: false, cleared: true };
      }
      return { ok: true };
    });
    await bed.hub.hub.docs.put(bed.hub.admin.principal, 'bed-topology', new TextEncoder().encode(JSON.stringify(INVENTORY)), { fileName: 'bed-topology.json' });
    const sha = (await bed.hub.hub.docs.show('bed-topology'))!.sha256;
    const proof = await bed.hub.records.artifacts.ingest({ bytes: new TextEncoder().encode('synthetic audit of the help tool'), mediaType: 'text/plain', origin: { upload: { session: 'synthetic' } }, author: { user: bed.hub.admin.principal.id }, provenanceType: 'declared', visibility: { readers: [bed.hub.admin.principal.id], admins: true, packs: [], shareable: false } });
    const raw = definition(gateway.endpoint);
    const seats = [{ ...probes.seats[0]!, seat: 'afamx0', manifest: { ...probes.seats[0]!.manifest, device: '/beds/0/devices/0' } }];
    const d = ExecutorDefinition.parse({
      ...raw, target: 'bed-a', resources: ['bed/bed-a/afamx0'], manifest_sha256: sha,
      allowed_tools: [...raw.allowed_tools, 'inspect_seat', 'ask_position'],
      probes: { ...probes, seats, help: HELP },
      premises: { read_only: { version: '1', evidence: [`src:${proof.body.sha256}`] } },
    });
    await addSyntheticExecutor(bed.hub.records, bed.hub.hub.dispatch!.registry, bed.hub.admin.principal, d, 'synthetic-help-key');
    const user = await bed.user('问设备的写手', ['test-bed']);
    client = await bed.connect(user, 'sess-s60');
  });

  after(async () => {
    await gateway?.close();
    await bed?.close();
    await postgres?.stop();
  });

  const inputs = { inventory: { external: 'doc:doc:bed-topology' } };

  test('the Hub asks the longest prefix first and the shorter ones after it, and the device words come back as received', async () => {
    const booked = await client.call('start_run', { pack: 'test-bed', inputs, parameters: { action: 'acquire', bed: 'bed-a', need: { devices: [{ type: 'load-balancer', count: 1 }] } } });
    assert.equal(booked.isError, false, booked.text.slice(0, 800));
    const booking = (booked.out as { run: { run: string } }).run.run;
    called.length = 0;
    const asked = await client.call('start_run', { pack: 'test-bed', inputs, predecessor: booking, parameters: { action: 'help', booking, device: 'afamx0', line: 'widget set demo 5 6' } });
    assert.equal(asked.isError, false, asked.text.slice(0, 1200));
    const lines = called.filter((c) => c.name === 'ask_position').map((c) => c.args.line);
    assert.deepEqual(lines, ['widget set demo 5 6', 'widget set demo 5', 'widget set demo'], 'from the whole line down to the first prefix the device describes');
    assert.ok(lines.every((line) => !/[?\x00-\x1f]/.test(String(line))), 'no question mark of the Hub\'s own, no line end');
    assert.ok(called.every((c) => c.name !== 'send_blob'), 'nothing is dispatched');
    assert.ok(called.some((c) => c.name === 'close_slot'), 'the gateway lease of the questioning is released');
    assert.match(asked.text, /设备输出仅供参考，不能作为原始用例的期望依据。/);
    assert.match(asked.text, /\n<1-9>   a number\n<cr>(?:\n|$)/);
    assert.match(asked.text, /设备给出说明的最长前缀是“widget set demo”；它后面的词是“5”/);
    // The run holds them as claims of the target's report, not as a source.
    const run = (asked.out as { run: { run: string; device_help: Array<{ statement: { data?: Record<string, unknown> }; qualifier: { marks: string[]; provenance: string }; grounds: string[] }>; sources: Array<{ reference: string }> } }).run;
    assert.deepEqual(run.device_help.map((c) => c.statement.data?.kind), ['summary', 'position', 'position', 'position']);
    assert.equal(run.device_help[3]!.statement.data?.help, KNOWN['widget set demo']);
    assert.ok(run.device_help.every((c) => c.qualifier.marks.includes('target_reported') && c.qualifier.marks.includes('local_ops_not_excluded')));
    const answers = run.device_help.flatMap((c) => c.grounds);
    assert.ok(answers.length >= 4 && run.sources.every((source) => !answers.includes(source.reference)), 'the stored answers are grounds of the claims; none of them is a source bound to the run');
    const stored = (await bed.hub.records.store.find({ key: INDEX.runId, value: run.run, kind: 'run', limit: 1 })).items[0]!.body as { device_help?: unknown[]; leases?: unknown[] };
    assert.equal(stored.device_help?.length, 4, 'the record keeps the claims');
    assert.equal(stored.leases, undefined, 'asking takes and gives no lease');
    const view = await bed.hub.leases.view('bed/');
    assert.ok(view.entries.some((e) => e.key === 'bed/bed-a/afamx0'), 'the booking still holds the device');
  });

  test('whoever does not hold the device is refused before the gateway is reached', async () => {
    const booked = await client.call('start_run', { pack: 'test-bed', inputs, parameters: { action: 'acquire', bed: 'bed-a', need: { devices: [{ type: 'client', count: 1 }] } } });
    assert.equal(booked.isError, false, booked.text.slice(0, 800));
    const booking = (booked.out as { run: { run: string } }).run.run;
    called.length = 0;
    // The booking holds client0, not afamx0, which the first test's booking still holds for the same user: this run's lineage holds only client0.
    const notHeld = await client.call('start_run', { pack: 'test-bed', inputs, predecessor: booking, parameters: { action: 'help', booking, device: 'afamx0', line: 'widget' } });
    assert.equal(notHeld.isError, true);
    assert.match(JSON.stringify(notHeld.out), /你没有持有设备 afamx0 的预订/);
    const noPredecessor = await client.call('start_run', { pack: 'test-bed', inputs, parameters: { action: 'help', booking, device: 'client0', line: 'widget' } });
    assert.equal(noPredecessor.isError, true);
    assert.match(JSON.stringify(noPredecessor.out), /predecessor/);
    const stranger = await bed.user('别的写手', ['test-bed']);
    const other = await bed.connect(stranger, 'sess-s60-b');
    const strangers = await other.call('start_run', { pack: 'test-bed', inputs, parameters: { action: 'help', booking, device: 'afamx0', line: 'widget' } });
    assert.equal(strangers.isError, true);
    assert.deepEqual(called.filter((c) => c.name === 'ask_position'), [], 'not one question reached the gateway');
  });
});
