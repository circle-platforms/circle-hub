// T4-4: a synthetic problem ticket, source-read, a test-bed search, then an observation.
// The phenomenon quote is verbatim from the ticket. The echo quote is verbatim from the uploaded capture.
// The recorded version comes from the booked bed's installed build. A model-supplied version is refused.
// ORBIT/COMET names and 192.0.2.0/24 only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KnowledgeContributionView } from '../../contracts/src/contributions.ts';
import { parseReference } from '../../hub/refs/api.ts';
import { INDEX } from '../../hub/runs/engine/store.ts';
import { startPostgres } from '../../hub/testing/postgres.ts';
import { openBed, type Bed } from './support/hub.ts';
import type { McpClient } from './support/mcp.ts';

const PHENOMENON = 'ORBIT 合成监听没有应答';
const ECHO = 'ORBIT 合成回显：没有应答';
const EXIT = '管理员在清单登记在装构建，或把某台升级到该构建后重试';

interface Claim { statement: { text: string } }
interface ResultBody { partitions?: Record<string, Array<{ requirements?: Array<{ claims?: Claim[] }> }>>; cross_item?: Claim[] }

function recordWith(value: unknown, key: string): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = recordWith(child, key);
      if (found) return found;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record[key] === 'string') return record;
    for (const child of Object.values(record)) {
      const found = recordWith(child, key);
      if (found) return found;
    }
  }
  return null;
}

function stringSelector(value: unknown, want: string, prefix = 'p'): string | null {
  if (typeof value === 'string') return value === want ? prefix : null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = stringSelector(value[index], want, `${prefix}/${index}`);
      if (found) return found;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const found = stringSelector(child, want, `${prefix}/${key}`);
      if (found) return found;
    }
  }
  return null;
}

async function claimsOf(bed: Bed, run: string): Promise<Claim[]> {
  const page = await bed.hub.records.store.find({ key: INDEX.resultRun, value: run, kind: 'validation_result', limit: 5, newestFirst: true });
  assert.ok(page.items.length > 0, run);
  const body = page.items[0]!.body as ResultBody;
  const claims: Claim[] = [];
  for (const partition of Object.values(body.partitions ?? {})) {
    for (const bucket of partition) for (const requirement of bucket.requirements ?? []) claims.push(...(requirement.claims ?? []));
  }
  claims.push(...(body.cross_item ?? []));
  return claims;
}

test('T4-4 synthetic reproduction: ticket, bed search, observation quotes, lease', { timeout: 600_000 }, async (t) => {
  const postgres = await startPostgres();
  t.after(() => postgres.stop());
  const bed = await openBed({ postgres, syncOneName: false });
  t.after(() => bed.close());
  for (const pack of ['source-read', 'test-bed', 'knowledge-contribution']) await bed.hub.assignPack(bed.reviewer.principal, pack);
  const client = await bed.connect(bed.reviewer, 'sess-t4-4');

  const read = await client.call('start_run', { pack: 'source-read', inputs: { defect: { external: 'plm:bug:88001' } } });
  assert.equal(read.isError, false, read.text.slice(0, 800));
  const readRun = read.out.run?.run;
  assert.ok(readRun);
  const readRecord = (await bed.hub.records.store.find({ key: INDEX.runId, value: readRun, kind: 'run' })).items[0]!;
  const sources = (readRecord.body as { sources?: Array<{ reference: string }> }).sources ?? [];
  let ticketSha = '';
  let ticket: Record<string, unknown> | null = null;
  let selector = '';
  for (const source of sources) {
    let sha = '';
    try { const ref = parseReference(source.reference); if (ref.scheme === 'src') sha = ref.sha256; } catch { continue; }
    if (!sha) continue;
    const bytes = await bed.hub.records.artifacts.trustedBytes(sha);
    if (!bytes) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { continue; }
    const found = stringSelector(parsed, PHENOMENON);
    if (!found) continue;
    ticketSha = sha;
    selector = found;
    ticket = parsed as Record<string, unknown>;
  }
  assert.ok(ticket && ticketSha && selector, 'the frozen ticket contains the phenomenon verbatim');
  const bug = recordWith(ticket, 'phenomenon');
  assert.ok(bug, 'the frozen ticket has a phenomenon field');
  assert.equal(bug.phenomenon, PHENOMENON);
  assert.equal(bug.version_line, 'SYN_ORBIT_10_8');
  assert.equal(bug.build, 'SYN_ORBIT_10_8_1');
  const ticketBuild = String(bug.build);
  const otherBuild = `${ticketBuild}_other`;

  const inventory = {
    schema: 'test-bed-manifest@1',
    beds: [
      {
        name: 'orbit-bed',
        devices: [
          { name: 'orbit0', type: 'load-balancer', ipv4: ['192.0.2.10/26'], ipv6: [], installed: { build: ticketBuild } },
          { name: 'comet0', type: 'client', ipv4: ['192.0.2.20/26'], ipv6: [] },
        ],
        services: [],
        reserved: [],
      },
      {
        name: 'comet-bed',
        devices: [{ name: 'comet0', type: 'load-balancer', ipv4: ['192.0.2.30/26'], ipv6: [] }],
        services: [],
        reserved: [],
      },
    ],
  };
  await bed.hub.hub.docs.put(bed.hub.admin.principal, 'orbit-bed', new TextEncoder().encode(JSON.stringify(inventory)), { fileName: 'orbit-bed.json' });
  const inputs = { inventory: { external: 'doc:doc:orbit-bed' } };
  const need = { devices: [{ type: 'load-balancer', count: 1 }], build: ticketBuild };

  const matched = await client.call('start_run', { pack: 'test-bed', inputs, parameters: { action: 'search', need } });
  assert.equal(matched.isError, false, matched.text.slice(0, 800));
  const matchedRun = matched.out.run?.run;
  assert.ok(matchedRun);
  const matchedClaims = (await claimsOf(bed, matchedRun)).map((claim) => claim.statement.text);
  assert.ok(matchedClaims.some((text) => text.includes('orbit-bed') && text.includes(`构建一致（${ticketBuild}，声明，未核对）`)), JSON.stringify(matchedClaims).slice(0, 500));
  assert.ok(!matchedClaims.some((text) => text.includes('没有任何台架的在装构建匹配')));

  const missed = await client.call('start_run', { pack: 'test-bed', inputs, parameters: { action: 'search', need: { ...need, build: otherBuild } } });
  assert.equal(missed.isError, false, missed.text.slice(0, 800));
  const missedRun = missed.out.run?.run;
  assert.ok(missedRun);
  const missedClaims = (await claimsOf(bed, missedRun)).map((claim) => claim.statement.text);
  assert.ok(missedClaims.some((text) => text.includes('orbit-bed') && text.includes(`需要升级到 ${otherBuild}`)));
  assert.ok(missedClaims.some((text) => text.includes('comet-bed') && text.includes('没有记录（未知）')));
  const unknown = missedClaims.find((text) => text.includes('没有任何台架的在装构建匹配'));
  assert.ok(unknown, JSON.stringify(missedClaims).slice(0, 800));
  assert.match(unknown, new RegExp(`版本线 ${otherBuild}`));
  assert.match(unknown, new RegExp(`orbit-bed/orbit0 装的是 ${ticketBuild}`));
  assert.match(unknown, /缺在装构建记录：comet-bed\/comet0/);
  assert.match(unknown, new RegExp(EXIT));

  const booked = await client.call('start_run', { pack: 'test-bed', inputs, parameters: { action: 'acquire', bed: 'orbit-bed', need } });
  assert.equal(booked.isError, false, booked.text.slice(0, 800));
  const booking = booked.out.run?.run;
  assert.ok(booking);
  const bookingBody = (await bed.hub.records.store.find({ key: INDEX.runId, value: booking, kind: 'run' })).items[0]!.body as { leases?: Array<{ lease: string; keys: string[] }> };
  const lease = bookingBody.leases?.find((row) => row.keys.some((key) => key === 'bed/orbit-bed/orbit0'));
  assert.ok(lease);

  const produced = bed.syncs.two?.builds.find((build) => build.name === bed.site.RELEASED && build.outcome === 'produced' && build.root !== null);
  assert.ok(produced?.root);
  const tree = await client.call('get_nodes', { root: produced.root, paths: ['/commands'], depth: 6 });
  assert.equal(tree.isError, false, tree.text.slice(0, 500));
  const command = tree.out.nodes?.find((node) => node.entries.some((entry) => Array.isArray((entry.data as { words?: unknown } | undefined)?.words)));
  assert.ok(command);
  const path = command.path;
  const manifest = await client.upload(Buffer.from(JSON.stringify({ items: [{ id: 'reproduce', title: 'ORBIT 合成复现' }] })), 'orbit-reproduce.json');
  const echo = `${ECHO}\n`;
  const captured = await client.call('upload_file', { file_path: Buffer.from(echo).toString('base64'), name: 'orbit-echo.txt', media_type: 'text/plain', provenance_type: 'client_captured' });
  assert.equal(captured.isError, false, captured.text.slice(0, 500));
  const captureSha = String(captured.out.sha256);
  const started = await client.call('start_run', {
    pack: 'knowledge-contribution',
    product: bed.product.names[0],
    build: bed.site.RELEASED,
    predecessor: booking,
    inputs: { subject: { reference: manifest }, originals: [{ reference: `src:${ticketSha}` }, { reference: `src:${captureSha}` }] },
  });
  assert.equal(started.isError, false, JSON.stringify(started.out.errors));
  const run = started.out.run?.run;
  assert.ok(run);
  const locked = await bed.hub.hub.runs.getRun(bed.reviewer.principal, run);
  assert.equal(locked?.run.build, bed.site.RELEASED);
  const root = locked?.run.root;
  const product = locked?.run.product;
  assert.ok(root && product);
  const observation = (result: string) => ({
    schema: 'fed-observation@1', product, root, path,
    source: { system: 'upload', bytes: captureSha },
    action: '执行 ORBIT 合成监听',
    result: { reference: `src:${captureSha}/text@1/l/1`, text: result },
  });
  const submit = (quote: string, feeding: Record<string, unknown>, statement: string) => ({
    run, model: 'integration-synthetic@1',
    items: [{ item: 'reproduce', handling: 'handled' as const, slots: { contribution: [{ code: 'assertion', text: statement, data: { root, path, source: { reference: `src:${ticketSha}/json@1/${selector}`, quote }, feeding } }] } }],
  });

  const accepted = await client.call('submit_result', submit(PHENOMENON, observation(ECHO), 'ORBIT 合成监听没有应答'));
  assert.equal(accepted.out.acceptance, 'accepted', JSON.stringify(accepted.out.errors).slice(0, 800));
  const page = await client.call('get_nodes', { root, paths: [path], depth: 0 });
  assert.equal(page.isError, false, page.text.slice(0, 500));
  const stored = (page.out.nodes?.[0]?.contributions ?? []).map((row) => KnowledgeContributionView.parse(row)).find((row) => 'statement' in row.contribution && row.contribution.statement === 'ORBIT 合成监听没有应答');
  assert.ok(stored && 'statement' in stored.contribution);
  const feeding = stored.contribution.feeding as { binding?: { source?: string; build?: string; bed_installed?: { build?: string }; run_lock?: { build?: string } } } | undefined;
  assert.ok(feeding?.binding);
  assert.equal(feeding.binding.source, 'conflict');
  assert.equal(feeding.binding.bed_installed?.build, ticketBuild);
  assert.equal(feeding.binding.run_lock?.build, bed.site.RELEASED);
  const linked = await bed.hub.records.store.find({ key: 'knowledge.contribution.lease', value: lease.lease, kind: 'claim', limit: 5 });
  assert.ok(linked.items.some((row) => row.digest === stored.record));

  const rewritten = await client.call('submit_result', submit(`${PHENOMENON.slice(0, -1)}达`, observation(ECHO), '现象被改写一个字'));
  assert.equal(rewritten.out.acceptance, 'not_accepted');
  assert.match(JSON.stringify(rewritten.out.errors), /逐字/);
  const alien = await client.call('submit_result', submit(PHENOMENON, observation('COMET 并不在捕获里'), '回显不在原件里'));
  assert.equal(alien.out.acceptance, 'not_accepted');
  assert.match(JSON.stringify(alien.out.errors), /逐字|上传原件/);
  const reported = await client.call('submit_result', submit(PHENOMENON, { ...observation(ECHO), build: 'model-said-1' }, '模型自报版本'));
  assert.equal(reported.out.acceptance, 'not_accepted');
  assert.match(JSON.stringify(reported.out.errors), /版本/);
});
