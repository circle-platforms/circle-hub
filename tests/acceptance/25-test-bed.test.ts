// Scenario 25 (acceptance): the test-bed pack end to end through the real Hub and the MCP client. An admin publishes a
// synthetic inventory with `doc put` (the named document doc:doc:bed-topology); a user searches and acquires; the
// second user on the same device is refused with LEASE_UNAVAILABLE and the earliest free moment; facts gives the
// listener and the blind address; a manifest with a duplicate address refuses the whole call with its pointer; a user
// the pack is not assigned to gets the neutral SOURCE_UNAVAILABLE. Synthetic addresses only (192.0.2.0/24).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { INDEX } from '../../hub/runs/engine/store.ts';
import { openBed, type Bed } from './support/hub.ts';
import type { McpClient } from './support/mcp.ts';

/** The synthetic inventory: bed-a (full: lb, router, client, server, console) and bed-b (lb + client, apv1 with a blind address). */
const INVENTORY = {
  schema: 'test-bed-manifest@1',
  beds: [
    {
      name: 'bed-a',
      devices: [
        { name: 'apv0', type: 'load-balancer', ipv4: ['192.0.2.10/26', '192.0.2.74/26'], ipv6: [] },
        { name: 'router0', type: 'router', ipv4: ['192.0.2.1/26'], ipv6: [] },
        { name: 'client0', type: 'client', ipv4: ['192.0.2.80/26'], ipv6: [] },
        { name: 'server0', type: 'server', ipv4: ['192.0.2.90/26'], ipv6: [] },
        { name: 'console0', type: 'console', ipv4: ['192.0.2.140/26'], ipv6: [] },
      ],
      services: [{ host: 'server0', ip: '192.0.2.90', proto: 'tcp', port: 80 }],
      reserved: ['192.0.2.1-192.0.2.9', '192.0.2.65-192.0.2.69'],
    },
    {
      name: 'bed-b',
      devices: [
        { name: 'apv1', type: 'load-balancer', ipv4: ['192.0.2.130/26', '192.0.2.194/26'], ipv6: [] },
        { name: 'client1', type: 'client', ipv4: ['192.0.2.150/26'], ipv6: [] },
      ],
      services: [],
      reserved: [],
    },
  ],
};

/** A manifest with one address on two devices: refused as a whole. */
const DUPLICATE = {
  schema: 'test-bed-manifest@1',
  beds: [
    {
      name: 'bed-dup',
      devices: [
        { name: 'apv0', type: 'load-balancer', ipv4: ['192.0.2.10/26'], ipv6: [] },
        { name: 'router0', type: 'router', ipv4: ['192.0.2.10/26'], ipv6: [] },
      ],
      services: [],
      reserved: [],
    },
  ],
};

interface Claim {
  statement: { text: string; data?: unknown; verdict?: string };
  qualifier?: { nature?: string };
  warrant?: Record<string, unknown>;
}

interface RunRecordBody {
  sources?: Array<{ external?: string | null }>;
  groups?: Array<Record<string, unknown>>;
  leases?: Array<{ lease: string; keys: string[]; until: string }>;
}

interface ResultBody {
  partitions?: Record<string, Array<{ requirements?: Array<{ claims?: Claim[] }> }>>;
  cross_item?: Claim[];
}

/** Every claim of the run's latest validation result: per-item claims from the partitions plus the cross-item ones. */
async function claimsOf(bed: Bed, run: string): Promise<Claim[]> {
  const page = await bed.hub.records.store.find({ key: INDEX.resultRun, value: run, kind: 'validation_result', limit: 10, newestFirst: true });
  assert.ok(page.items.length > 0, `a validation result of ${run}`);
  const body = page.items[0]!.body as ResultBody;
  const claims: Claim[] = [];
  for (const partition of Object.values(body.partitions ?? {})) {
    for (const bucket of partition) for (const requirement of bucket.requirements ?? []) claims.push(...(requirement.claims ?? []));
  }
  claims.push(...(body.cross_item ?? []));
  return claims;
}

describe('scenario 25: test-bed search, facts and acquire through the real Hub', () => {
  let postgres: TemporaryPostgres;
  let bed: Bed;
  let client: McpClient;

  before(async () => {
    postgres = await startPostgres();
    bed = await openBed({ postgres });
    // The administrator publishes the inventory as a named document.
    await bed.hub.hub.docs.put(bed.hub.admin.principal, 'bed-topology', new TextEncoder().encode(JSON.stringify(INVENTORY)), { fileName: 'bed-topology.json' });
    await bed.hub.hub.docs.put(bed.hub.admin.principal, 'bed-topology-dup', new TextEncoder().encode(JSON.stringify(DUPLICATE)), { fileName: 'bed-topology-dup.json' });
    const user = await bed.user('台架用户', ['test-bed']);
    client = await bed.connect(user, 'sess-s25');
  });

  after(async () => {
    await bed?.close();
    await postgres?.stop();
  });

  test('search: the beds get their conclusions with the exact "Hub 记录里" wording, the doc frozen with its digest', async () => {
    const started = await client.call('start_run', {
      pack: 'test-bed',
      inputs: { inventory: { external: 'doc:doc:bed-topology' } },
      parameters: { action: 'search', need: { devices: [{ type: 'load-balancer', count: 1 }, { type: 'client', count: 1 }], hours: 2 } },
    });
    assert.equal(started.isError, false, started.text.slice(0, 800));
    const run = (started.out as { run?: { run?: string; sources?: Array<{ external?: string | null }> } }).run;
    assert.ok(run?.run, 'the run id');
    const shown = await bed.hub.hub.docs.show('bed-topology');
    assert.ok(shown);
    const sha = shown.sha256;
    assert.ok(run.sources?.some((s) => s.external === `doc:doc:bed-topology@${sha}`), 'the inventory froze with its digest at start');
    const record = await bed.hub.records.store.find({ key: INDEX.runId, value: run.run, kind: 'run', limit: 1 });
    const body = record.items[0]!.body as RunRecordBody;
    const group = body.groups?.[0] as { action?: string; manifest?: unknown } | undefined;
    assert.equal(group?.action, 'search');
    assert.ok(group?.manifest, 'the manifest is frozen in the run groups');
    const claims = await claimsOf(bed, run.run);
    const statements = claims.map((c) => c.statement.text);
    assert.ok(statements.some((text) => text.includes('bed-a') && text.includes('Hub 记录里空闲（未排除本地操作）')), JSON.stringify(statements).slice(0, 400));
    assert.ok(statements.some((text) => text.includes('bed-b') && text.includes('Hub 记录里空闲（未排除本地操作）')), 'bed-b fits the need too');
    const short = await client.call('start_run', {
      pack: 'test-bed',
      inputs: { inventory: { external: 'doc:doc:bed-topology' } },
      parameters: { action: 'search', need: { devices: [{ type: 'load-balancer', count: 2 }], hours: 2 } },
    });
    assert.equal(short.isError, false);
    const shortRun = (short.out as { run?: { run?: string } }).run?.run;
    assert.ok(shortRun);
    const shortClaims = await claimsOf(bed, shortRun);
    assert.ok(shortClaims.some((c) => c.statement.text.includes('bed-b') && c.statement.text.includes('需要 2 台负载均衡，台架里有 1 台')), 'bed-b says what it lacks');
  });

  test('acquire: the lease is granted and frozen; the second user on the same device is refused with the earliest free moment', async () => {
    const started = await client.call('start_run', {
      pack: 'test-bed',
      inputs: { inventory: { external: 'doc:doc:bed-topology' } },
      parameters: { action: 'acquire', bed: 'bed-a', need: { devices: [{ type: 'load-balancer', count: 1 }, { type: 'client', count: 1 }], hours: 2 } },
    });
    assert.equal(started.isError, false, started.text.slice(0, 800));
    const run = (started.out as { run?: { run?: string } }).run?.run;
    assert.ok(run);
    const record = await bed.hub.records.store.find({ key: INDEX.runId, value: run, kind: 'run', limit: 1 });
    const body = record.items[0]!.body as RunRecordBody;
    assert.ok(body.leases !== undefined && body.leases.length > 0, 'the granted leases are in the run record');
    assert.deepEqual(body.leases.flatMap((l) => l.keys).sort(), ['bed/bed-a/apv0', 'bed/bed-a/client0']);
    const until = body.leases[0]!.until;
    const view = await bed.hub.leases.view('bed/');
    assert.ok(view.entries.some((e) => e.key === 'bed/bed-a/apv0' && e.until === until), 'the lease table holds the rows');

    const other = await bed.user('台架用户乙', ['test-bed']);
    const otherClient = await bed.connect(other, 'sess-s25-b');
    const refused = await otherClient.call('start_run', {
      pack: 'test-bed',
      inputs: { inventory: { external: 'doc:doc:bed-topology' } },
      parameters: { action: 'acquire', bed: 'bed-a', need: { devices: [{ type: 'load-balancer', count: 1 }], hours: 2 } },
    });
    assert.equal(refused.isError, true, 'the same device is held');
    const error = (refused.out as { errors?: Array<{ code: string; message: string }> }).errors?.[0];
    assert.ok(error, 'the refusal carries its error');
    assert.equal(error.code, 'LEASE_UNAVAILABLE');
    assert.match(error.message, /bed\/bed-a\/apv0/);
    assert.ok(error.message.includes(until) || /最早空闲/.test(error.message), `the earliest free moment travels with the refusal: ${error.message}`);
  });

  test('facts: the listener of bed-a and the blind address of bed-b, computed from the frozen manifest', async () => {
    const started = await client.call('start_run', {
      pack: 'test-bed',
      inputs: { inventory: { external: 'doc:doc:bed-topology' } },
      parameters: { action: 'facts' },
    });
    assert.equal(started.isError, false, started.text.slice(0, 800));
    const factsRun = (started.out as { run?: { run?: string } }).run?.run;
    assert.ok(factsRun);
    const claims = await claimsOf(bed, factsRun);
    const listening = claims.find((c) => c.statement.text.includes('bed-a'));
    assert.ok(listening, 'a claim of bed-a');
    const dataA = listening.statement.data as { listeners?: Array<{ address: string }>; blind?: unknown[] };
    assert.deepEqual((dataA.listeners ?? []).map((l) => l.address), ['192.0.2.10', '192.0.2.74'], 'both apv0 addresses listen');
    assert.deepEqual(dataA.blind, [], 'no blind address on bed-a');
    const claimB = claims.find((c) => c.statement.text.includes('bed-b'));
    const dataB = (claimB === undefined ? {} : claimB.statement.data) as { blind?: Array<{ address: string; subnet: string }> };
    assert.deepEqual((dataB?.blind ?? []).map((b) => [b.address, b.subnet]), [['192.0.2.194', '192.0.2.192/26']], 'apv1 has a blind address on the segment without a trigger');
  });

  test('a manifest with a duplicate address refuses the whole call with the pointer, and an unassigned user gets SOURCE_UNAVAILABLE', async () => {
    const dup = await client.call('start_run', {
      pack: 'test-bed',
      inputs: { inventory: { external: 'doc:doc:bed-topology-dup' } },
      parameters: { action: 'search' },
    });
    assert.equal(dup.isError, true, 'the invalid inventory refuses the call');
    const text = JSON.stringify(dup.out);
    assert.match(text, /test-bed.manifest_invalid|台架清单/);
    assert.match(text, /\/beds\/0\/devices\/1\/ipv4\/0/, 'the pointer of the duplicate address is named');
    const outsider = await bed.user('没分配的人', []);
    const outsideClient = await bed.connect(outsider, 'sess-s25-c');
    const neutral = await outsideClient.call('start_run', {
      pack: 'test-bed',
      inputs: { inventory: { external: 'doc:doc:bed-topology' } },
      parameters: { action: 'search' },
    });
    assert.equal(neutral.isError, true);
    assert.equal((neutral.out as { errors?: Array<{ code: string }> }).errors?.[0]?.code, 'SOURCE_UNAVAILABLE');
  });
});
