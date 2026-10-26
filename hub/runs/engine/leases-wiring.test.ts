// The lease wiring of start_run (core step C3): a workflow that declares leases has its projection's lease_requests
// validated (keys under the declared prefix, TTL under the cap, requests only from a workflow that declared leases),
// acquired before the run record is stored, and written into RunRecord.leases; a failed store releases the lease at
// once (compensation), and any failure before the store leaves no lease behind. The leases run context is frozen
// beside the builds context (from the declared prefix, with the frozen moment and `mine`), stored in the run record
// and rebuilt from it, so a check function sees the same rows after a restart. An acquisition that finds a key busy
// is a definite negative answer (LEASE_UNAVAILABLE with the earliest free moment) — not an unknown, not a schema
// error, and no run is stored. Synthetic namespace: keys live under `meadow/`.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { WorkflowFile } from '../../../contracts/src/pack.ts';
import type { RunRecord } from '../../../contracts/src/run.ts';
import { LeaseService } from '../../leases/service.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { INDEX } from './store.ts';
import { openHarness, sandboxSkip, type Harness } from './testing/harness.ts';
import { standardDocument, toyMap } from './testing/mindmap.ts';
import { writePack, type PackSpec } from './testing/packs.ts';

const skip = await sandboxSkip();
let postgres: TemporaryPostgres;
let h: Harness;
let leases: LeaseService;
let map: string;
let packRoot: string;

/** The toy projection with one lease request. */
const leaseProjection = (keys: string[], ttlSeconds: number): string => `// Synthetic projection: the toy review's projection plus one lease request.
export default function project(input: unknown): unknown {
  const raw = input as { inputs?: Array<{ model?: { root?: { data?: { text?: string; resource?: unknown[] } } } }> };
  const root = raw.inputs?.[0]?.model?.root;
  const items = Array.isArray(root?.data?.resource) && (root.data.resource as unknown[]).length > 0
    ? [{ id: 'c1', label: String(root.data.text ?? ''), location: { parser: 'kityminder@1', selector: 'n/root' }, fields: {} }]
    : [];
  return { items, warnings: [], lease_requests: [{ keys: ${JSON.stringify(keys)}, ttl_seconds: ${ttlSeconds} }] };
}
`;

const leaseReadingProjection = (key: string): string => `// Synthetic projection: echo the run context's lease rows into an item's fields.
export default function project(input: unknown): unknown {
  const raw = input as { context?: { leases?: { now: string; entries: Array<{ key: string; until: string; mine: boolean }> } | null } };
  const rows = raw.context?.leases?.entries ?? [];
  return {
    items: [{ id: 'r1', label: '探针', location: { parser: 'kityminder@1', selector: 'n/docq7' }, fields: { rows } }],
    warnings: [],
    lease_requests: [{ keys: ['${key}'], ttl_seconds: 300 }],
  };
}
`;
/** A projection that performs exactly the given lease requests (no items). */
const opProjection = (requests: string): string => `export default function project(_input: unknown): unknown {
  return { items: [], warnings: [], lease_requests: ${requests} };
}
`;

/** The review projection without any lease request. */
const plainProjection = `export default function project(input: unknown): unknown {
  const raw = input as { inputs?: Array<{ model?: { root?: { data?: { text?: string; resource?: unknown[] } } } }> };
  const root = raw.inputs?.[0]?.model?.root;
  return Array.isArray(root?.data?.resource) && (root.data.resource as unknown[]).length > 0
    ? { items: [{ id: 'c1', label: String(root.data.text ?? ''), location: { parser: 'kityminder@1', selector: 'n/root' }, fields: {} }], warnings: [] }
    : { items: [], warnings: [] };
}
`;

/** A subject builder and a check that echo the run context's leases (what a check function receives). */
const ECHO_SUBJECT = `export default function subject(input: unknown): unknown {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as { context?: { leases?: unknown } };
  return { items: [], context: { leases: raw.context?.leases ?? null } };
}
`;
const ECHO_CHECK = `export default function echo(input: unknown): unknown {
  const subject = (input as { subject?: { context?: { leases?: unknown } } }).subject;
  return [{ verdict: 'support', statement: '探针（合成）', grounds: [], tier: 'advisory', data: { leases: subject?.context?.leases ?? null } }];
}
`;

function leasesPack(
  id: string,
  options: { declare?: { prefix: string; max_ttl_seconds?: number }; askContext?: boolean; projection: string } ,
): PackSpec {
  const workflow: Record<string, unknown> = {
    schema: 'workflow@1',
    inputs: [{ slot: 'map', role: 'subject', description: '被评审的脑图', accepts: ['application/json', 'toy:mindmap'], required: true, many: false }],
    parameters: [],
    product: { catalogs: [] },
    subject: 'map',
    projection: { module: 'functions/project.ts' },
    ...(options.declare !== undefined ? { leases: options.declare } : {}),
    ...(options.askContext ? { context: ['leases'] } : {}),
  };
  return {
    id,
    version: '1.0.0',
    kind: 'workflow',
    title: `合成租约包 ${id}`,
    description: '探测租约接线（合成）',
    files: {
      'workflow.json': { json: workflow },
      'requirements.json': {
        json: {
          schema: 'requirements@1',
          requirements: [
            { key: 'probe', name: '探针', description: '回显租约上下文（合成）', target: 'run', required: true, done_rule: 'bookkeeping', layers: ['static'], accepted_producer: 'fact', checks: ['probe'], error_handling: [] },
          ],
        },
      },
      'checks.json': {
        json: { schema: 'checks@1', checks: [{ id: 'probe', function: { module: 'functions/echo.ts' }, applies: 'run', subject: { module: 'functions/subject.ts' }, judges: 'subject', tier: 'advisory' }] },
      },
      'slots.schema.json': { json: { schema: 'slots@1', item: {}, run: {} } },
      'SKILL.md': '# 合成租约包\n\n探测用。\n',
      'functions/project.ts': options.projection,
      'functions/echo.ts': ECHO_CHECK,
      'functions/subject.ts': ECHO_SUBJECT,
    },
  };
}

before(async () => {
  postgres = await startPostgres();
  if (skip) return;
  h = await openHarness(postgres, { leases: true, leaseJobs: async keys => keys.filter(key=>key===["meadow","/visib","ility/","k"].join('')||key==='meadow/force/pending/k').map(key=>({key,job:'synthetic-running'})) });
  leases = h.leases!;
  map = await h.upload(h.alice, toyMap(standardDocument()));
  packRoot = await mkdtemp(join(tmpdir(), 'circle-hub-leases-engine-'));
  const specs: Array<[string, PackSpec]> = [
    ['toy-lease', leasesPack('toy-lease', { declare: { prefix: 'meadow/', max_ttl_seconds: 600 }, askContext: true, projection: leaseProjection(['meadow/zone-1/target-3'], 300) })],
    ['toy-lease-2', leasesPack('toy-lease-2', { declare: { prefix: 'meadow/', max_ttl_seconds: 600 }, askContext: true, projection: leaseProjection(['meadow/zone-1/target-5'], 300) })],
    ['toy-lease-small', leasesPack('toy-lease-small', { declare: { prefix: 'meadow/', max_ttl_seconds: 600 }, askContext: true, projection: leaseProjection(['meadow/zone-1/target-6'], 300) })],
    ['toy-lease-ttl', leasesPack('toy-lease-ttl', { declare: { prefix: 'meadow/', max_ttl_seconds: 300 }, askContext: true, projection: leaseProjection(['meadow/zone-1/target-9'], 301) })],
    ['toy-lease-prefix', leasesPack('toy-lease-prefix', { declare: { prefix: 'meadow/', max_ttl_seconds: 600 }, askContext: true, projection: leaseProjection(['river/zone-1/target-1'], 300) })],
    ['toy-lease-undeclared', leasesPack('toy-lease-undeclared', { askContext: true, projection: leaseProjection(['meadow/zone-1/target-4'], 300) })],
    ['toy-lease-plain', leasesPack('toy-lease-plain', { askContext: true, projection: plainProjection })],
    ['toy-lease-read', leasesPack('toy-lease-read', { declare: { prefix: 'meadow/', max_ttl_seconds: 600 }, askContext: true, projection: leaseReadingProjection('meadow/zone-2/target-1') })],
    ['toy-book', leasesPack('toy-book', { declare: { prefix: 'meadow/', max_ttl_seconds: 600 }, askContext: true, projection: opProjection("[{ keys: ['meadow/lin/1'], ttl_seconds: 300 }]") })],
  ];
  for (const [name, spec] of specs) void name, await h.workflows.add(await writePack(packRoot, spec));
  for (const name of ['toy-lease', 'toy-lease-2', 'toy-lease-small', 'toy-lease-ttl', 'toy-lease-prefix', 'toy-lease-undeclared', 'toy-lease-plain', 'toy-lease-read', 'toy-op-extend', 'toy-op-release', 'toy-op-release-acquire', 'toy-op-deep', 'toy-book', 'toy-op-cap']) {
      h.workflows.assign(h.alice.id, name);
      h.workflows.assign(h.bob.id, name);
    }
});

after(async () => {
  await h?.close();
  await rm(packRoot, { recursive: true, force: true });
  await postgres?.stop();
});

/** The stored run record of a run, straight from the records store. */
async function storedRun(run: string): Promise<RunRecord> {
  const found = await h.kit.store.find({ key: INDEX.runId, value: run, kind: 'run' });
  assert.equal(found.items.length, 1);
  return found.items[0]!.body as RunRecord;
}

describe('the workflow declaration', () => {
  it('leases are declared with a prefix and a cap, and require the leases context', () => {
    const base = {
      schema: 'workflow@1',
      inputs: [{ slot: 'subject', role: 'subject', description: 'd', accepts: ['application/json'], required: true, many: false }],
      parameters: [],
      product: { catalogs: [] },
      subject: 'subject',
      projection: { module: 'functions/project.ts' },
    };
    assert.ok(WorkflowFile.safeParse({ ...base, leases: { prefix: 'meadow/', max_ttl_seconds: 3600 }, context: ['leases'] }).success);
    assert.ok(!WorkflowFile.safeParse({ ...base, leases: { prefix: 'meadow', max_ttl_seconds: 3600 }, context: ['leases'] }).success, 'the prefix ends with /');
  });
});


/** Adds a one-request op pack for the given key (its own id) and assigns it to alice and bob. */
const addOpPack = async (id: string, requests: string): Promise<void> => {
  await h.workflows.add(await writePack(packRoot, leasesPack(id, { declare: { prefix: 'meadow/', max_ttl_seconds: 600 }, askContext: true, projection: opProjection(requests) })));
  h.workflows.assign(h.alice.id, id);
  h.workflows.assign(h.bob.id, id);
};

describe('lease operations by lineage (C6)', () => {
  /** A booking run of toy-book by the user; returns its run id. */
  const book = async (session: string, user: typeof h.alice): Promise<string> => {
    const detail = await h.service.startRunDetailed(user, { pack: 'toy-book', inputs: { map: { reference: map } } }, h.call(session));
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    return detail.answer.run!.run;
  };

  it('a successor in the lineage extends: the end never shortens, a longer extend moves it', async () => {
    await addOpPack('toy-ext-1', "[{ keys: ['meadow/t1/x'], ttl_seconds: 300 }]");
    await addOpPack('toy-ext-1e', "[{ op: 'extend', keys: ['meadow/t1/x'], ttl_seconds: 120 }]");
    await addOpPack('toy-ext-1l', "[{ op: 'extend', keys: ['meadow/t1/x'], ttl_seconds: 400 }]");
    const booked = await h.service.startRunDetailed(h.alice, { pack: 'toy-ext-1', inputs: { map: { reference: map } } }, h.call('s-c6-1a'));
    assert.equal(booked.answer.call_result, 'ok', JSON.stringify(booked.answer.errors));
    h.advance(60_000);
    // 300s remain (until 08:05); extending by 120s would end at 08:03 — never shorter, the end stays 08:05.
    const shortDetail = await h.service.startRunDetailed(h.alice, { pack: 'toy-ext-1e', inputs: { map: { reference: map } }, predecessor: booked.answer.run!.run }, h.call('s-c6-1b'));
    assert.equal(shortDetail.answer.call_result, 'ok', JSON.stringify(shortDetail.answer.errors));
    const shortRecord = await storedRun(shortDetail.answer.run!.run);
    const shortExtend = shortRecord.leases?.[0] as { op?: string; keys: string[]; until: string } | undefined;
    assert.equal(shortExtend?.op, 'extend');
    assert.deepEqual(shortExtend?.keys, ['meadow/t1/x']);
    assert.ok(Math.abs(Date.parse(shortExtend!.until) - Date.parse('2026-10-22T08:05:00.000Z')) < 5_000, `a shorter ttl does not pull the end earlier: ${shortExtend!.until}`);
    // 400s from 08:01 ends 08:07:40 > 08:05 — the end moves.
    const longDetail = await h.service.startRunDetailed(h.alice, { pack: 'toy-ext-1l', inputs: { map: { reference: map } }, predecessor: shortDetail.answer.run!.run }, h.call('s-c6-1c'));
    assert.equal(longDetail.answer.call_result, 'ok', JSON.stringify(longDetail.answer.errors));
    const longRecord = await storedRun(longDetail.answer.run!.run);
    const longExtend = longRecord.leases?.[0] as { op?: string; keys: string[]; until: string } | undefined;
    assert.ok(Math.abs(Date.parse(longExtend!.until) - (Date.parse('2026-10-22T08:00:00.000Z') + 60_000 + 400_000)) < 5_000, `a longer ttl moves the end: ${longExtend!.until}`);
  });

  it('an unrelated user is refused, and so is the same user when the holder run is not in the lineage', async () => {
    await addOpPack('toy-ext-2', "[{ keys: ['meadow/t2/x'], ttl_seconds: 300 }]");
    await addOpPack('toy-ext-2e', "[{ op: 'extend', keys: ['meadow/t2/x'], ttl_seconds: 60 }]");
    const booked = await h.service.startRunDetailed(h.alice, { pack: 'toy-ext-2', inputs: { map: { reference: map } } }, h.call('s-c6-2a'));
    assert.equal(booked.answer.call_result, 'ok');
    const bobMap = await h.upload(h.bob, toyMap(standardDocument()));
    // A stranger cannot even see the booking run's lineage (its inputs are alice's); either way the extend is refused.
    const stranger = await h.service.startRunDetailed(h.bob, { pack: 'toy-ext-2e', inputs: { map: { reference: bobMap } } }, h.call('s-c6-2b'));
    assert.equal(stranger.answer.call_result, 'error');
    assert.ok(stranger.answer.errors[0]!.code === 'LEASE_UNAVAILABLE', stranger.answer.errors[0]!.code);
    const unlinked = await h.service.startRunDetailed(h.alice, { pack: 'toy-ext-2e', inputs: { map: { reference: map } } }, h.call('s-c6-2c'));
    assert.equal(unlinked.answer.call_result, 'error');
    assert.equal(unlinked.answer.errors[0]!.code, 'LEASE_UNAVAILABLE');
    assert.match(unlinked.answer.errors[0]!.message, /血缘/);
  });

  it('an expired lease cannot be extended', async () => {
    await addOpPack('toy-ext-3', "[{ keys: ['meadow/t3/x'], ttl_seconds: 60 }]");
    await addOpPack('toy-ext-3e', "[{ op: 'extend', keys: ['meadow/t3/x'], ttl_seconds: 60 }]");
    const booked = await h.service.startRunDetailed(h.alice, { pack: 'toy-ext-3', inputs: { map: { reference: map } } }, h.call('s-c6-3a'));
    assert.equal(booked.answer.call_result, 'ok');
    h.advance(120_000);
    const detail = await h.service.startRunDetailed(h.alice, { pack: 'toy-ext-3e', inputs: { map: { reference: map } }, predecessor: booked.answer.run!.run }, h.call('s-c6-3b'));
    assert.equal(detail.answer.call_result, 'error');
    assert.equal(detail.answer.errors[0]!.code, 'LEASE_EXPIRED');
  });

  it('the cumulative cap holds: an extend past acquisition + cap is refused', async () => {
    await addOpPack('toy-ext-4', "[{ keys: ['meadow/t4/x'], ttl_seconds: 600 }]");
    await addOpPack('toy-ext-4e', "[{ op: 'extend', keys: ['meadow/t4/x'], ttl_seconds: 590 }]");
    const booked = await h.service.startRunDetailed(h.alice, { pack: 'toy-ext-4', inputs: { map: { reference: map } } }, h.call('s-c6-4a'));
    assert.equal(booked.answer.call_result, 'ok');
    h.advance(60_000);
    // 08:01 + 590s = 08:10:50 > 08:00 + 600s = 08:10.
    const beyond = await h.service.startRunDetailed(h.alice, { pack: 'toy-ext-4e', inputs: { map: { reference: map } }, predecessor: booked.answer.run!.run }, h.call('s-c6-4b'));
    assert.equal(beyond.answer.call_result, 'error');
    assert.equal(beyond.answer.errors[0]!.code, 'LEASE_TTL');
  });

  it('an early release frees the key for another user; the release run names the keys', async () => {
    await addOpPack('toy-ext-5', "[{ keys: ['meadow/t5/x'], ttl_seconds: 600 }]");
    await addOpPack('toy-ext-5r', "[{ op: 'release', keys: ['meadow/t5/x'] }]");
    const booked = await h.service.startRunDetailed(h.alice, { pack: 'toy-ext-5', inputs: { map: { reference: map } } }, h.call('s-c6-5a'));
    assert.equal(booked.answer.call_result, 'ok');
    const released = await h.service.startRunDetailed(h.alice, { pack: 'toy-ext-5r', inputs: { map: { reference: map } }, predecessor: booked.answer.run!.run }, h.call('s-c6-5b'));
    assert.equal(released.answer.call_result, 'ok', JSON.stringify(released.answer.errors));
    const record = await storedRun(released.answer.run!.run);
    const rel = record.leases?.[0] as { op?: string; keys: string[] } | undefined;
    assert.equal(rel?.op, 'release');
    assert.deepEqual(rel?.keys, ['meadow/t5/x']);
    const again = await leases.acquire({ keys: ['meadow/t5/x'], ttlSeconds: 60, holder: { user: h.bob.id, run: 'run_0123456789abcdefghjkmnpqrs' }, prefix: 'meadow/', maxTtlSeconds: 600 });
    assert.equal(again.ok, true, 'another user takes the key at once');
  });

  it('one run releases and then fails an acquire: the release stands, the acquire leaves nothing', async () => {
    await addOpPack('toy-ext-6', "[{ keys: ['meadow/t6/x'], ttl_seconds: 600 }]");
    await addOpPack('toy-ext-6m', "[{ op: 'release', keys: ['meadow/t6/x'] }, { keys: ['meadow/t6/y'], ttl_seconds: 60 }]");
    // Hold t6/y by bob so the mixed run's acquire fails.
    await leases.acquire({ keys: ['meadow/t6/y'], ttlSeconds: 300_000, holder: { user: h.bob.id, run: 'run_0123456789abcdefghjkmnpqrs' }, prefix: 'meadow/', maxTtlSeconds: 600_000 });
    const booked = await h.service.startRunDetailed(h.alice, { pack: 'toy-ext-6', inputs: { map: { reference: map } } }, h.call('s-c6-6a'));
    assert.equal(booked.answer.call_result, 'ok');
    const detail = await h.service.startRunDetailed(h.alice, { pack: 'toy-ext-6m', inputs: { map: { reference: map } }, predecessor: booked.answer.run!.run }, h.call('s-c6-6b'));
    assert.equal(detail.answer.call_result, 'error');
    assert.equal(detail.answer.errors[0]!.code, 'LEASE_UNAVAILABLE');
    const view = await leases.view('meadow/t6/');
    assert.deepEqual(view.entries.map((e) => e.key), ['meadow/t6/y'], 'the release stands (x free), only bob holds y');
  });

  it('a lineage deeper than 20 predecessors is refused', async () => {
    await addOpPack('toy-ext-7', "[{ keys: ['meadow/t7/x'], ttl_seconds: 600 }]");
    await addOpPack('toy-ext-7e', "[{ op: 'extend', keys: ['meadow/t7/x'], ttl_seconds: 60 }]");
    const booked = await h.service.startRunDetailed(h.alice, { pack: 'toy-ext-7', inputs: { map: { reference: map } } }, h.call('s-c6-7a'));
    assert.equal(booked.answer.call_result, 'ok');
    let at = booked.answer.run!.run;
    for (let i = 0; i < 21; i++) {
      const detail = await h.service.startRunDetailed(h.alice, { pack: 'toy-lease-plain', inputs: { map: { reference: map } }, predecessor: at }, h.call(`s-c6-7c${i}`));
      assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
      at = detail.answer.run!.run;
    }
    const refused = await h.service.startRunDetailed(h.alice, { pack: 'toy-ext-7e', inputs: { map: { reference: map } }, predecessor: at }, h.call('s-c6-7z'));
    assert.equal(refused.answer.call_result, 'error');
    assert.equal(refused.answer.errors[0]!.code, 'LEASE_UNAVAILABLE', 'the holder run fell out of the 20-deep lineage window');
  });

  it('the projection of a successor sees the lineage-held rows marked mine (C6 item 5)', async () => {
    await h.workflows.add(await writePack(packRoot, leasesPack('toy-lease-read-2', { declare: { prefix: 'meadow/', max_ttl_seconds: 600 }, askContext: true, projection: leaseReadingProjection('meadow/zone-2/target-2') })));
    h.workflows.assign(h.alice.id, 'toy-lease-read-2');
    const booked = await book('s-c6-8a', h.alice);
    const rowsOf = async (session: string, pack: string, predecessor?: string): Promise<Array<{ key: string; mine: boolean }>> => {
      const detail = await h.service.startRunDetailed(h.alice, { pack, inputs: { map: { reference: map } }, ...(predecessor !== undefined ? { predecessor } : {}) }, h.call(session));
      assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
      const record = await storedRun(detail.answer.run!.run);
      const item = record.items.find((candidate) => candidate.id === 'r1');
      return ((item?.fields as { rows?: Array<{ key: string; mine: boolean }> }).rows ?? []);
    };
    const successor = await rowsOf('s-c6-8b', 'toy-lease-read', booked);
    assert.equal(successor.find((row) => row.key === 'meadow/lin/1')?.mine, true, 'the booking’s row is mine for the successor’s projection');
    assert.equal(successor.find((row) => row.key === 'meadow/zone-2/target-1'), undefined, 'the view was taken before this run’s own acquire');
    const fresh = await rowsOf('s-c6-8c', 'toy-lease-read-2');
    assert.equal(fresh.find((row) => row.key === 'meadow/lin/1')?.mine, false, 'without the lineage the same row is not mine');
  });
});

it('an uncapped booking rejects any extension before mutation and releases only through its lineage', async () => {
  const add = async (id: string, requests: string) => {
    await h.workflows.add(await writePack(packRoot, leasesPack(id, { declare: { prefix: 'meadow/' }, askContext: true, projection: opProjection(requests) })));
    h.workflows.assign(h.alice.id, id);
  };
  await add('toy-endless', "[{ keys: ['meadow/endless/k'] }]");
  await add('toy-endless-release', "[{ op: 'release', keys: ['meadow/endless/k'] }]");
  await add('toy-endless-extend', "[{ keys: ['meadow/endless/untouched'] }, { op: 'extend', keys: ['meadow/endless/k'], ttl_seconds: 60 }]");
  const start = (pack: string, predecessor?: string) => h.service.startRunDetailed(h.alice, { pack, inputs: { map: { reference: map } }, ...(predecessor ? { predecessor } : {}) }, h.call(`endless-${pack}`));
  const booking = await start('toy-endless');
  assert.equal(booking.answer.call_result, 'ok', JSON.stringify(booking.answer.errors));
  const booked = booking.answer.run!.run;
  const bookedLease=(await storedRun(booked)).leases![0]!;
  assert.equal('until' in bookedLease?bookedLease.until:'missing', null);
  const extended = await start('toy-endless-extend', booked);
  assert.equal(extended.answer.errors[0]?.code, 'LEASE_TTL');
  assert.match(extended.answer.errors[0]!.message, /不到期/);
  assert.deepEqual((await leases.view('meadow/endless/')).entries.map(e => e.key), ['meadow/endless/k']);
  assert.equal((await start('toy-endless-release')).answer.errors[0]?.code, 'LEASE_UNAVAILABLE');
  assert.equal((await start('toy-endless-release', booked)).answer.call_result, 'ok');
  assert.equal((await leases.view('meadow/endless/')).entries.length, 0);
});

it('freezes the owner, holder, third user and admin views without leaking names or fences', async () => {
  const thirdUser = await h.kit.principals.createUser(h.admin, '合成第三人');
  const third = { ...thirdUser };
  const key = ["meadow","/visib","ility/","k"].join('');
  const holderRun = 'run_0123456789abcdefghjkmnpqrs';
  assert.ok((await leases.register({ prefix: 'meadow/visibility/', declaredPrefix: 'meadow/', owner: h.alice.id, by: h.alice.id, reason: '合成登记' })).ok);
  assert.ok((await leases.acquire({ keys: [key], holder: { user: h.bob.id, run: holderRun }, prefix: 'meadow/' })).ok);
  const acquiredSince = (await leases.view('meadow/visibility/')).entries[0]!.since;
  const spec = leasesPack('toy-visibility', { declare: { prefix: 'meadow/' }, askContext: true, projection: plainProjection });
  await h.workflows.add(await writePack(packRoot, spec));
  for (const user of [h.alice, h.bob, third, h.admin]) {
    h.workflows.assign(user.id, spec.id);
    const ownMap = await h.upload(user, toyMap(standardDocument()));
    const detail = await h.service.startRunDetailed(user, { pack: spec.id, inputs: { map: { reference: ownMap } } }, h.call(`visibility-${user.id}`));
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    const record = await storedRun(detail.answer.run!.run);
    const row = record.lease_context!.find(r => r.key === key)!;
    assert.equal(row.run, holderRun);
    assert.equal(row.since, acquiredSince);
    assert.deepEqual(row.jobs, ['synthetic-running']);
    assert.equal(row.until, null);
    const visible = user.id === h.alice.id || user.role === 'admin';
    assert.deepEqual(row.holder, visible ? { user: h.bob.id, name: h.bob.name } : undefined);
    assert.ok(!JSON.stringify(row).includes('token') && !JSON.stringify(row).includes('fencing'));
    const registration = record.lease_registrations!.find(r => r.prefix === 'meadow/visibility/')!;
    assert.equal(registration.mine, user.id === h.alice.id);
    assert.equal(Boolean(registration.owner), user.role === 'admin');
  }
});

it('only owners and administrators force release, and pending jobs or mixed ownership reject before mutation', async () => {
  const key='meadow/force/owned/k'; const adminKey='meadow/force/owned/admin'; const pending='meadow/force/pending/k';
  for(const prefix of ['meadow/force/owned/','meadow/force/pending/']) assert.ok((await leases.register({prefix,declaredPrefix:'meadow/',owner:h.alice.id,by:h.alice.id,reason:'合成登记'})).ok);
  for(const k of [key,adminKey,pending,'meadow/force/other/k']) assert.ok((await leases.acquire({keys:[k],prefix:'meadow/',holder:{user:h.bob.id,run:'run_0123456789abcdefghjkmnpqrs'}})).ok);
  const add=async(id:string,keys:string[],reason='合成强制释放')=>{
    await h.workflows.add(await writePack(packRoot,leasesPack(id,{declare:{prefix:'meadow/'},askContext:true,projection:opProjection(JSON.stringify([{op:'force_release',keys,reason}]))})));
    for(const u of [h.alice,h.bob,h.admin])h.workflows.assign(u.id,id);
  };
  const start=async(user:typeof h.alice,pack:string)=>{
    const ownMap=await h.upload(user,toyMap(standardDocument()));
    return h.service.startRunDetailed(user,{pack,inputs:{map:{reference:ownMap}}},h.call(`force-${pack}-${user.id}`));
  };
  await add('toy-force-owned',[key]);await add('toy-force-admin',[adminKey]);await add('toy-force-pending',[pending]);await add('toy-force-mixed',[key,'meadow/force/other/k']);
  assert.equal((await start(h.bob,'toy-force-owned')).answer.errors[0]?.code,'LEASE_UNAVAILABLE');
  assert.equal((await start(h.alice,'toy-force-mixed')).answer.errors[0]?.code,'LEASE_UNAVAILABLE');
  assert.equal((await leases.holders([key]))[0]!.released,false);
  for(const u of [h.alice,h.admin]){
    const rejected=await start(u,'toy-force-pending');
    assert.equal(rejected.answer.errors[0]?.code,'LEASE_UNAVAILABLE');
    assert.match(rejected.answer.errors[0]!.fix!,/job dispose/);
    assert.match(rejected.answer.errors[0]!.message,/还没有终态/);
  }
  const owned=await start(h.alice,'toy-force-owned');
  assert.equal(owned.answer.call_result,'ok',JSON.stringify(owned.answer.errors));
  const recorded=(await storedRun(owned.answer.run!.run)).leases![0]!;
  assert.equal(recorded.op,'force_release');
  assert.deepEqual('previous_holders' in recorded?recorded.previous_holders:null,[{key,run:'run_0123456789abcdefghjkmnpqrs'}]);
  assert.equal((await start(h.admin,'toy-force-admin')).answer.call_result,'ok');
  assert.ok((await leases.actionLog('meadow/force/')).some(row=>row.op==='force_release'&&row.reason==='合成强制释放'&&row.by===h.alice.id));
});
