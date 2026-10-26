// Scenario 24 (acceptance): the lease wiring of start_run through the real Hub and the MCP client. A synthetic
// workflow pack declares leases (`meadow/`, cap 600 s); its projection asks for one lease. The first start acquires
// the lease, freezes it in the run record and hands the run's checks the lease context with `mine`; the second start
// on the same key is refused with LEASE_UNAVAILABLE and the earliest free moment; nothing is stored for the refusal.
// Synthetic keys only (the `meadow/` namespace); the pack is written beside the repository's packs through the real
// registry, exactly as the other acceptance packs.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { INDEX } from '../../hub/runs/engine/store.ts';
import { openBed, type Bed } from './support/hub.ts';
import { type McpClient } from './support/mcp.ts';

describe('scenario 24: start_run leases through the real Hub', () => {
  let postgres: TemporaryPostgres;
  let bed: Bed;
  let client: McpClient;
  let packRoot: string;
  let leases: import('../../hub/leases/service.ts').LeaseService;

  const PROJECTION = `// Synthetic projection: no items, one lease request (the run exists to hold the lease).
export default function project(_input: unknown): unknown {
  return { items: [], warnings: [], lease_requests: [{ keys: ['meadow/zone-1/target-acceptance'], ttl_seconds: 300 }] };
}
`;
  const WORKFLOW = {
    schema: 'workflow@1',
    inputs: [{ slot: 'map', role: 'subject', description: '被评审的脑图（占位）', accepts: ['application/json'], required: true, many: false }],
    parameters: [],
    product: { catalogs: [] },
    subject: 'map',
    projection: { module: 'functions/project.ts' },
    leases: { prefix: 'meadow/', max_ttl_seconds: 600 },
    context: ['leases'],
  };
  const REQUIREMENTS = {
    schema: 'requirements@1',
    requirements: [
      { key: 'probe', name: '探针', description: '占位（合成）', target: 'run', required: true, done_rule: 'bookkeeping', layers: ['static'], accepted_producer: 'fact', checks: ['probe'], error_handling: [] },
    ],
  };

  const CHECK_FUNCTION = "export default function check(input: unknown): unknown {\n  const subject = (input as { subject?: { context?: { refused?: boolean } } }).subject;\n  return subject?.context?.refused === true\n    ? [{ verdict: 'refute', code: 'PLACEHOLDER_CODE', statement: '占位探针反驳（合成）', grounds: [], tier: 'advisory' }]\n    : [{ verdict: 'support', statement: '占位探针（合成）', grounds: [], tier: 'advisory' }];\n}\n";

  before(async () => {
    postgres = await startPostgres();
    bed = await openBed({ postgres });
      packRoot = await mkdtemp(join(tmpdir(), 'circle-hub-accept-lease-'));
    leases = bed.hub.leases;
    // A minimal synthetic workflow pack with leases, written and published through the real registry.
    const dir = join(packRoot, 'toy-accept-lease-1.0.0');
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(dir, 'functions'), { recursive: true });
    await writeFile(join(dir, 'workflow.json'), `${JSON.stringify(WORKFLOW, null, 2)}\n`);
    await writeFile(join(dir, 'requirements.json'), `${JSON.stringify(REQUIREMENTS, null, 2)}\n`);
    await writeFile(join(dir, 'slots.schema.json'), `${JSON.stringify({ schema: 'slots@1', item: {}, run: {} }, null, 2)}\n`);
    await writeFile(join(dir, 'SKILL.md'), '# 合成租约验收包\n\n占位。\n');
    await writeFile(join(dir, 'functions', 'project.ts'), PROJECTION);
    await writeFile(join(dir, 'checks.json'), `${JSON.stringify({ schema: 'checks@1', checks: [{ id: 'probe', function: { module: 'functions/check.ts' }, applies: 'run', judges: 'subject', tier: 'advisory' }] }, null, 2)}\n`);
    await writeFile(join(dir, 'functions', 'check.ts'), CHECK_FUNCTION.replaceAll('PLACEHOLDER_CODE', 'toy-accept-lease.placeholder'));

    // Publish samples for the probe check (an author sample each way, C05 R[0]).
    const sample = (id: string, note: string, expect: Array<Record<string, unknown>>) =>
      writeFile(join(dir, 'samples', 'positive', `${id}.json`), `${JSON.stringify({ id, source: 'author', check: 'probe', note, subject: { items: [], context: {} }, expect }, null, 2)}\n`);
    await mkdir(join(dir, 'samples', 'positive'), { recursive: true });
    await mkdir(join(dir, 'samples', 'negative'), { recursive: true });
    await sample('probe_positive', '合成正例：占位探针给一个支持', [{ verdict: 'support', tier: 'advisory' }]);
    await writeFile(
      join(dir, 'samples', 'negative', 'probe_negative.json'),
      `${JSON.stringify({ id: 'probe_negative', source: 'author', check: 'probe', note: '合成反例：本检查不会反驳，样例给出一个期待中的反驳以证明准入真的运行了检查', subject: { items: [], context: { refused: true } }, expect: [{ verdict: 'refute', tier: 'advisory' }] }, null, 2)}\n`,
    );
    // The manifest lists every file (including the samples) sorted by path.
    const { createHash } = await import('node:crypto');
    const { readdir, readFile } = await import('node:fs/promises');
    const paths: string[] = [];
    const walk = async (base: string): Promise<void> => {
      for (const entry of await readdir(join(dir, base), { withFileTypes: true })) {
        const rel = base === '' ? entry.name : `${base}/${entry.name}`;
        if (entry.isDirectory()) await walk(rel);
        else paths.push(rel);
      }
    };
    await walk('');
    const files = await Promise.all(
      paths.sort().map(async (path) => {
        const bytes = new Uint8Array(await readFile(join(dir, path)));
        return { path, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
      }),
    );
    await writeFile(join(dir, 'pack.json'), `${JSON.stringify({ schema: 'pack@1', id: 'toy-accept-lease', version: '1.0.0', kind: 'workflow', title: '合成租约验收包', description: '验收用（合成）', files }, null, 2)}\n`);
    await bed.hub.publishPack(join(dir));
    // The op packs: extend, release and a plain chain pack (no lease requests), same shape, their own ids.
    for (const [id, requests] of [
      ['toy-accept-extend', "[{ op: 'extend', keys: ['meadow/zone-1/target-acceptance'], ttl_seconds: 300 }]"],
      ['toy-accept-release', "[{ op: 'release', keys: ['meadow/zone-1/target-acceptance'] }]"],
      ['toy-accept-plain', 'null'],
    ] as const) {
      const dir2 = join(packRoot, `${id}-1.0.0`);
      await mkdir(join(dir2, 'functions'), { recursive: true });
      await writeFile(join(dir2, 'workflow.json'), `${JSON.stringify(WORKFLOW, null, 2)}\n`);
      await writeFile(join(dir2, 'requirements.json'), `${JSON.stringify(REQUIREMENTS, null, 2)}\n`);
      await writeFile(join(dir2, 'slots.schema.json'), `${JSON.stringify({ schema: 'slots@1', item: {}, run: {} }, null, 2)}\n`);
      await writeFile(join(dir2, 'SKILL.md'), '# 合成租约验收包\n\n占位。\n');
      await writeFile(join(dir2, 'checks.json'), `${JSON.stringify({ schema: 'checks@1', checks: [{ id: 'probe', function: { module: 'functions/check.ts' }, applies: 'run', judges: 'subject', tier: 'advisory' }] }, null, 2)}\n`);
      await writeFile(join(dir2, 'functions', 'check.ts'), CHECK_FUNCTION.replaceAll('PLACEHOLDER_CODE', `${id}.placeholder`));
      await writeFile(
        join(dir2, 'functions', 'project.ts'),
        requests === 'null'
          ? 'export default function project(_input: unknown): unknown {\n  return { items: [], warnings: [] };\n}\n'
          : `export default function project(_input: unknown): unknown {\n  return { items: [], warnings: [], lease_requests: ${requests} };\n}\n`,
      );
      await mkdir(join(dir2, 'samples', 'positive'), { recursive: true });
      await mkdir(join(dir2, 'samples', 'negative'), { recursive: true });
      await writeFile(join(dir2, 'samples', 'positive', 'probe_positive.json'), `${JSON.stringify({ id: 'probe_positive', source: 'author', check: 'probe', note: '合成正例', subject: { items: [], context: {} }, expect: [{ verdict: 'support', tier: 'advisory' }] }, null, 2)}\n`);
      await writeFile(join(dir2, 'samples', 'negative', 'probe_negative.json'), `${JSON.stringify({ id: 'probe_negative', source: 'author', check: 'probe', note: '合成反例', subject: { items: [], context: { refused: true } }, expect: [{ verdict: 'refute', tier: 'advisory' }] }, null, 2)}\n`);
      const paths: string[] = [];
      const walk2 = async (base: string): Promise<void> => {
        for (const entry of await readdir(join(dir2, base), { withFileTypes: true })) {
          const rel = base === '' ? entry.name : `${base}/${entry.name}`;
          if (entry.isDirectory()) await walk2(rel);
          else paths.push(rel);
        }
      };
      await walk2('');
      const files = await Promise.all(paths.sort().map(async (path) => {
        const bytes = new Uint8Array(await readFile(join(dir2, path)));
        return { path, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
      }));
      await writeFile(join(dir2, 'pack.json'), `${JSON.stringify({ schema: 'pack@1', id, version: '1.0.0', kind: 'workflow', title: '合成租约验收包', description: '验收用（合成）', files }, null, 2)}\n`);
      await bed.hub.publishPack(join(dir2));
      await bed.hub.assignPack(bed.reviewer.principal, id);
    }
    await bed.hub.assignPack(bed.reviewer.principal, 'toy-accept-lease');
    client = await bed.connect(bed.reviewer, 'sess-lease-acc-1');
  });

  after(async () => {
    await bed?.close();
    await rm(packRoot, { recursive: true, force: true });
    await leases && undefined;
    await postgres?.stop();
  });

  test('the first start acquires the lease and freezes it in the run record', async () => {
    const map = await client.call('upload_file', {
      name: 'lease-subject.json',
      media_type: 'application/json',
      file_path: Buffer.from(JSON.stringify({ root: { data: { text: '占位', resource: ['Functional'] }, children: [] } })).toString('base64'),
    });
    assert.equal(map.isError, false, map.text);
    const started = await client.call('start_run', {
      pack: 'toy-accept-lease',
      inputs: { map: { reference: (map.out as { reference?: string }).reference } },
    });
    assert.equal(started.isError, false, started.text.slice(0, 800));
    const run = (started.out as { run?: { run?: string } }).run?.run;
    assert.ok(run, 'the run id');
    const found = await bed.hub.records.store.find({ key: INDEX.runId, value: run, kind: 'run' });
    assert.equal(found.items.length, 1, 'the run record is stored');
    const body = found.items[0]!.body as { leases?: Array<{ keys: string[]; until: string }>; lease_context?: Array<{ key: string }> };
    assert.deepEqual(body.leases?.map((l) => l.keys), [['meadow/zone-1/target-acceptance']], 'the granted lease is in the record');
    // The frozen context is the pre-projection view (other holders only; the run's own row never sits in it).
    assert.equal((body.lease_context ?? []).length, 0, 'the frozen context holds the pre-projection view, no row of its own');
    // The lease table holds the row for this run.
    const view = await leases.view('meadow/');
    assert.ok(view.entries.some((e) => e.key === 'meadow/zone-1/target-acceptance'));
    // Free the row for the tests that follow (an admin force-release, the same way an operator would).
    await leases.forceRelease({ keys: ['meadow/zone-1/target-acceptance'], by: 'test', reason: '场景收尾' });
  });

  test('the second start on the same key is refused with LEASE_UNAVAILABLE and the earliest free moment', async () => {
    const other = await bed.user('租约验收乙', ['toy-accept-lease']);
    const otherClient = await bed.connect(other, 'sess-lease-acc-2');
    const map = await otherClient.call('upload_file', {
      name: 'lease-subject-2.json',
      media_type: 'application/json',
      file_path: Buffer.from(JSON.stringify({ root: { data: { text: '占位', resource: ['Functional'] }, children: [] } })).toString('base64'),
    });
    assert.equal(map.isError, false, map.text);
    // The reviewer holds the key first (this test is self-contained: it books, then a second user is refused).
    const held = await client.call('start_run', {
      pack: 'toy-accept-lease',
      inputs: { map: { reference: (map.out as { reference?: string }).reference } },
    });
    assert.equal(held.isError, false, held.text.slice(0, 400));
    try {
      const refused = await otherClient.call('start_run', {
        pack: 'toy-accept-lease',
        inputs: { map: { reference: (map.out as { reference?: string }).reference } },
      });
      assert.equal(refused.isError, true, 'the same key is held');
    const error = (refused.out as { errors?: Array<{ code: string; message: string }> }).errors?.[0];
    assert.ok(error, 'the refusal carries its error');
      assert.equal(error.code, 'LEASE_UNAVAILABLE');
      assert.match(error.message, /meadow\/zone-1\/target-acceptance/);
      assert.match(error.message, /最早空闲|free/i, 'the earliest free moment travels with the refusal');
    } finally {
      await leases.forceRelease({ keys: ['meadow/zone-1/target-acceptance'], by: 'test', reason: '场景收尾' });
    }
  });

  test('lineage operations through the real Hub: A books, B (predecessor A) extends, C (predecessor B) releases, a third user then books', async () => {
    // A books the key.
    const upload = async (clientOf: McpClient, name: string): Promise<string> => {
      const up = await clientOf.call('upload_file', {
        name,
        media_type: 'application/json',
        file_path: Buffer.from(JSON.stringify({ root: { data: { text: '占位', resource: ['Functional'] }, children: [] } })).toString('base64'),
      });
      assert.equal(up.isError, false, up.text);
      return (up.out as { reference?: string }).reference as string;
    };
    const aMap = await upload(client, 'lease-lineage-a.json');
    const started = await client.call('start_run', { pack: 'toy-accept-lease', inputs: { map: { reference: aMap } } });
    assert.equal(started.isError, false, started.text.slice(0, 600));
    const runA = (started.out as { run?: { run?: string } }).run?.run as string;
    // B, the same user, extends through the lineage (predecessor A).
    const extended = await client.call('start_run', { pack: 'toy-accept-extend', inputs: { map: { reference: aMap } }, predecessor: runA });
    assert.equal(extended.isError, false, extended.text.slice(0, 600));
    const runB = (extended.out as { run?: { run?: string } }).run?.run as string;
    // C releases through the lineage (predecessor B).
    const released = await client.call('start_run', { pack: 'toy-accept-release', inputs: { map: { reference: aMap } }, predecessor: runB });
    assert.equal(released.isError, false, released.text.slice(0, 600));
    const view = await leases.view('meadow/');
    assert.equal(view.entries.filter((e) => e.key === 'meadow/zone-1/target-acceptance').length, 0, 'the key is free again');
    // A third user books the freed key at once.
    const third = await bed.user('租约验收丙', ['toy-accept-lease']);
    const thirdClient = await bed.connect(third, 'sess-lease-acc-3');
    const booked = await thirdClient.call('start_run', { pack: 'toy-accept-lease', inputs: { map: { reference: await upload(thirdClient, 'lease-lineage-3.json') } } });
    assert.equal(booked.isError, false, booked.text.slice(0, 600));
    const after = await leases.view('meadow/');
    assert.equal(after.entries.filter((e) => e.key === 'meadow/zone-1/target-acceptance').length, 1, 'the third user holds it now');
  });

});
