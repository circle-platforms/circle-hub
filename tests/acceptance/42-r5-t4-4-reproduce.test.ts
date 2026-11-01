// T4-4: a synthetic problem ticket, source-read, a test-bed search, then an observation.
// The phenomenon quote is verbatim from the ticket. The echo quote is verbatim from the uploaded capture.
// The recorded version comes from what the booked device showed when the booking was granted (decision 112): the
// manifest declares another build, which is ignored. A model-supplied version is refused.
// ORBIT/COMET names and 192.0.2.0/24 only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KnowledgeContributionView } from '../../contracts/src/contributions.ts';
import { ExecutorDefinition } from '../../hub/dispatch/api.ts';
import { addSyntheticExecutor } from '../../hub/dispatch/testing/credentials.ts';
import { definition } from '../../hub/dispatch/testing/definition.ts';
import { probes } from '../../hub/dispatch/testing/probes.ts';
import { startEndpoint } from '../../hub/dispatch/testing/server.ts';
import { parseReference } from '../../hub/refs/api.ts';
import { INDEX } from '../../hub/runs/engine/store.ts';
import { startPostgres } from '../../hub/testing/postgres.ts';
import { openBed, type Bed } from './support/hub.ts';
import type { McpClient } from './support/mcp.ts';

const PHENOMENON = 'ORBIT 合成监听没有应答';
const ECHO = 'ORBIT 合成回显：没有应答';
// The exit of an unmatched build: who takes each step and by which existing means; test-bed has no upgrade action (D05 R[8]).
const EXIT = '要在这个构建上跑：去掉 need.build 整台预订一个设备够用的环境，再用 bed-install 给它装上这个构建（你的运行就能做）；只用环境现有的构建也可以，去掉 need.build 再搜索或预订。没有观察记录的设备，预订时 Hub 会在设备上看一次';

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
          // A declaration the device contradicts: the device shows the ticket's build, and the declaration is ignored.
          { name: 'orbit0', type: 'load-balancer', ipv4: ['192.0.2.10/26'], ipv6: [], installed: { build: otherBuild } },
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

  // An executor bound to this inventory has a version seat at orbit-bed/orbit0; its synthetic gateway echoes the ticket's
  // build. comet-bed/comet0 has no seat, so nobody can look at it.
  const gateway = await startEndpoint([...definition('x').allowed_tools, 'inspect_seat'], (name, args) => {
    if (name === 'open_slot' || name === 'touch_slot') return { ok: true, ticket: 'synthetic-ticket', token: 'synthetic-token', ttl: 30000 };
    if (name === 'inspect_seat') return { output: args.command === 'inspect version' ? `version: ${ticketBuild}` : 'address: 192.0.2.10/26' };
    return { ok: true };
  });
  t.after(() => gateway.close());
  const sha = (await bed.hub.hub.docs.show('orbit-bed'))!.sha256;
  const raw = definition(gateway.endpoint);
  const seat = { ...probes.seats[0]!, seat: 'orbit0', manifest: { ...probes.seats[0]!.manifest, device: '/beds/0/devices/0' } };
  const executor = ExecutorDefinition.parse({ ...raw, probes: { ...probes, seats: [seat] }, allowed_tools: [...raw.allowed_tools, 'inspect_seat'], manifest_sha256: sha });
  await addSyntheticExecutor(bed.hub.records, bed.hub.hub.dispatch!.registry, bed.hub.admin.principal, executor, 'synthetic-orbit-key');

  // Before anyone looked: no observation, unknown, never the declared build.
  const unseen = await client.call('start_run', { pack: 'test-bed', inputs, parameters: { action: 'search', need } });
  assert.equal(unseen.isError, false, unseen.text.slice(0, 800));
  const unseenClaims = (await claimsOf(bed, unseen.out.run!.run!)).map((claim) => claim.statement.text);
  assert.ok(unseenClaims.some((text) => text.includes('orbit-bed') && text.includes('设备上装的构建没有观察记录（未知；预订时 Hub 会在设备上看一次）')), JSON.stringify(unseenClaims).slice(0, 800));
  assert.ok(!unseenClaims.some((text) => text.includes(otherBuild)), 'the declared build is not used');

  // The booking looks at the booked device and says what it showed and when.
  const booked = await client.call('start_run', { pack: 'test-bed', inputs, parameters: { action: 'acquire', bed: 'orbit-bed', need } });
  assert.equal(booked.isError, false, booked.text.slice(0, 800));
  const booking = booked.out.run?.run;
  assert.ok(booking);
  assert.match(booked.text, /预订时在设备上看到的构建：/);
  assert.match(booked.text, new RegExp(`orbit-bed/orbit0 装的是 ${ticketBuild}（设备回显，观察于 \\d{4}-`));
  assert.ok(gateway.calls.some((call) => call.params.name === 'inspect_seat' && (call.params.arguments as Record<string, unknown>).command === 'inspect version'));
  assert.ok(!gateway.calls.some((call) => call.params.name === 'send_blob'), 'nothing is dispatched');

  const matched = await client.call('start_run', { pack: 'test-bed', inputs, parameters: { action: 'search', need } });
  assert.equal(matched.isError, false, matched.text.slice(0, 800));
  const matchedClaims = (await claimsOf(bed, matched.out.run!.run!)).map((claim) => claim.statement.text);
  assert.ok(matchedClaims.some((text) => text.includes('orbit-bed') && text.includes(`构建一致（${ticketBuild}，观察于 `)), JSON.stringify(matchedClaims).slice(0, 500));
  assert.ok(!matchedClaims.some((text) => text.includes('没有任何自动化测试环境最近一次观察到')));

  const missed = await client.call('start_run', { pack: 'test-bed', inputs, parameters: { action: 'search', need: { ...need, build: otherBuild } } });
  assert.equal(missed.isError, false, missed.text.slice(0, 800));
  const missedClaims = (await claimsOf(bed, missed.out.run!.run!)).map((claim) => claim.statement.text);
  assert.ok(missedClaims.some((text) => text.includes('orbit-bed') && text.includes(`构建不一致（装的是 ${ticketBuild}，要的是 ${otherBuild}，观察于 `)), JSON.stringify(missedClaims).slice(0, 800));
  assert.ok(missedClaims.some((text) => text.includes('comet-bed') && text.includes('没有观察记录（未知')));
  const unknown = missedClaims.find((text) => text.includes('没有任何自动化测试环境最近一次观察到装的是'));
  assert.ok(unknown, JSON.stringify(missedClaims).slice(0, 800));
  assert.ok(unknown.includes(`最近一次观察到装的是 ${otherBuild}（构建名或它的基础构建逐字相等才算；观察只对它被观察的时刻成立）`), unknown);
  assert.match(unknown, new RegExp(`最近一次观察到的是别的构建：orbit-bed/orbit0 装的是 ${ticketBuild}（观察于 `));
  assert.match(unknown, /没有观察记录：comet-bed\/comet0/);
  assert.ok(unknown.includes(`。下一步：${EXIT}`), unknown);
  assert.doesNotMatch(unknown, /升级到|先升级|把某台升级/);
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
