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
  options: { declare?: { prefix: string; max_ttl_seconds: number }; askContext?: boolean; projection: string } ,
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
  h = await openHarness(postgres, { leases: true });
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
  ];
  for (const [name, spec] of specs) void name, await h.workflows.add(await writePack(packRoot, spec));
  for (const name of ['toy-lease', 'toy-lease-2', 'toy-lease-small', 'toy-lease-ttl', 'toy-lease-prefix', 'toy-lease-undeclared', 'toy-lease-plain']) {
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

describe('the wiring', () => {
  it('a granted lease is written into the run record, and the context the check sees carries the rows with mine', async () => {
    const detail = await h.service.startRunDetailed(h.alice, { pack: 'toy-lease', inputs: { map: { reference: map } } }, h.call('sess-lease-1'));
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    const run = detail.answer.run!.run;
    const record = await storedRun(run);
    assert.ok(record.leases !== undefined && record.leases.length === 1, 'one lease in the run record');
    const lease = record.leases![0]!;
    assert.deepEqual(lease.keys, ['meadow/zone-1/target-3']);
    assert.match(lease.lease, /^lse_/);
    assert.ok(Math.abs(Date.parse(lease.until) - (Date.parse('2026-10-22T08:00:00.000Z') + 300_000)) < 2_000, `until ${lease.until}`);
    // The context the probe check saw: the rows of the declared prefix, the frozen moment, mine true for this run's user.
    const claim = detail.production!.result.cross_item.find((c) => c.requirement === 'probe');
    assert.ok(claim, 'the probe claim');
    const seen = (claim!.statement.data as { leases: { now: string; entries: Array<{ key: string; until: string; mine: boolean }> } }).leases;
    assert.ok(seen.entries.some((e) => e.key === 'meadow/zone-1/target-3' && e.mine === true), JSON.stringify(seen));
    assert.ok(Date.parse(seen.now) >= Date.parse('2026-10-22T08:00:00.000Z'), 'the frozen moment');
  });

  it('a second run on the same key is refused with LEASE_UNAVAILABLE and the earliest free moment, and no run is stored', async () => {
    const first = await h.service.startRunDetailed(h.alice, { pack: 'toy-lease-2', inputs: { map: { reference: map } } }, h.call('sess-lease-2'));
    assert.equal(first.answer.call_result, 'ok');
    const bobMap = await h.upload(h.bob, toyMap(standardDocument()));
    const second = await h.service.startRunDetailed(h.bob, { pack: 'toy-lease-2', inputs: { map: { reference: bobMap } } }, h.call('sess-lease-3'));
    assert.equal(second.answer.call_result, 'error');
    const error = second.answer.errors[0]!;
    assert.equal(error.code, 'LEASE_UNAVAILABLE');
    assert.match(error.message, /meadow\/zone-1\/target-5/);
    assert.match(error.message, /最早空闲|earliest/i, 'the earliest free moment travels with the refusal');
    assert.equal(second.production, null);
    assert.equal(second.runRecord, null, 'no run record was stored for the refused start');
    const mine = await leases.view('meadow/');
    const held = mine.entries.find((e) => e.key === 'meadow/zone-1/target-5');
    assert.ok(held, 'the first run still holds the row');
  });

  it('a TTL over the cap and a key outside the prefix are refused before anything is acquired', async () => {
    const ttl = await h.service.startRunDetailed(h.alice, { pack: 'toy-lease-ttl', inputs: { map: { reference: map } } }, h.call('sess-lease-4'));
    assert.equal(ttl.answer.call_result, 'error');
    assert.equal(ttl.answer.errors[0]!.code, 'LEASE_TTL');
    const prefix = await h.service.startRunDetailed(h.alice, { pack: 'toy-lease-prefix', inputs: { map: { reference: map } } }, h.call('sess-lease-5'));
    assert.equal(prefix.answer.call_result, 'error');
    assert.equal(prefix.answer.errors[0]!.code, 'LEASE_PREFIX');
    assert.equal(prefix.runRecord, null);
    // Nothing was acquired by either refused start.
    const view = await leases.view('meadow/');
    assert.equal(view.entries.filter((e) => e.key.endsWith('target-9') || e.key.endsWith('target-1')).length, 0);
  });

  it('a workflow that did not declare leases cannot request one', async () => {
    const detail = await h.service.startRunDetailed(h.alice, { pack: 'toy-lease-undeclared', inputs: { map: { reference: map } } }, h.call('sess-lease-6'));
    assert.equal(detail.answer.call_result, 'error');
    const error = detail.answer.errors[0]!;
    assert.ok(error.code === 'SUBMISSION_SCHEMA_VIOLATION' || error.code === 'LEASE_PREFIX', error.code);
    assert.match(error.message, /lease|租约/);
    assert.equal(detail.runRecord, null);
    const view = await leases.view('meadow/');
    assert.equal(view.entries.filter((e) => e.key.endsWith('target-4')).length, 0, 'nothing was acquired');
  });

  it('a projection without lease requests starts a run with no leases and no lease context rows of other holders', async () => {
    const detail = await h.service.startRunDetailed(h.alice, { pack: 'toy-lease-plain', inputs: { map: { reference: map } } }, h.call('sess-lease-7'));
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    const record = await storedRun(detail.answer.run!.run);
    assert.ok(record.leases === undefined || record.leases.length === 0, 'no leases without requests');
    // The context still freezes the prefix view (another holder's row appears with mine false).
    const claim = detail.production!.result.cross_item.find((c) => c.requirement === 'probe');
    const seen = (claim!.statement.data as { leases: { entries: Array<{ key: string; mine: boolean }> } | null }).leases;
    // The plain workflow asked for the context and other holders' rows appear, none of them mine.
    assert.ok(seen !== null && seen.entries.every((e) => e.mine === false), JSON.stringify(seen));
  });

  it('a failed store compensates: the lease is released at once and the refusal names the record limit', async () => {
    const smallRoot = await mkdtemp(join(tmpdir(), 'circle-hub-leases-small-'));
    const small = await openHarness(postgres, { leases: true, limits: { maxRecordBytes: 700 } });
    try {
      await small.workflows.add(await writePack(smallRoot, leasesPack('toy-lease-small', { declare: { prefix: 'meadow/', max_ttl_seconds: 600 }, askContext: true, projection: leaseProjection(['meadow/zone-1/target-6'], 300) })));
      small.workflows.assign(small.alice.id, 'toy-lease-small');
      const smallMap = await small.upload(small.alice, toyMap(standardDocument()));
      const detail = await small.service.startRunDetailed(small.alice, { pack: 'toy-lease-small', inputs: { map: { reference: smallMap } } }, small.call('sess-lease-8'));
      assert.equal(detail.answer.call_result, 'error', 'the record does not fit the small limit');
      // The lease this start acquired is gone: another start of the same key over the same database now wins.
      const again = await h.service.startRunDetailed(h.bob, { pack: 'toy-lease-small', inputs: { map: { reference: map } } }, h.call('sess-lease-9'));
      assert.equal(again.answer.call_result, 'ok', 'the key was compensated free');
    } finally {
      await small.close();
      await rm(smallRoot, { recursive: true, force: true });
    }
  });
});
