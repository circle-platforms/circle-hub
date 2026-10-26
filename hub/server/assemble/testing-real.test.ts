// The real Hub in-process (createTestHub of hub/server/testing-real.ts): a smoke test over the official MCP client that lists
// the packs, starts a run on a synthetic mind map the agile stub serves (read through a real resource with the password kept
// as its digest) and submits a result that is accepted, with the call-log lines; a user without the pack gets the neutral
// answer while the engine's reason is in the admin note only; the default publication of the repository's packs (a
// synthetic tree standing in for packs/), product packs activated by publishPack unless told otherwise, and a knowledge
// sync through the helper that produces nothing the second time; and the pack discovery and staging helpers. Synthetic
// packs written to a temporary directory; every external system is a loopback stub.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { writePack } from '../../runs/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { AGILE_DOCUMENT, createTestHub, findPackDirectories, stagePack } from '../testing-real.ts';
import { removeTree } from './files.ts';
import { AGILE_PACK, LOCATE_PACK, PRODUCT_PACK, REVIEW_PACK, SITE_PACK, locatePack, productPack, syncSiteFiles, writeTestPacks } from './test-packs.ts';

let postgres: TemporaryPostgres;
let packRoot: string;
let packs: Awaited<ReturnType<typeof writeTestPacks>>;
let locate: string;

before(async () => {
  postgres = await startPostgres();
  packRoot = await mkdtemp(join(tmpdir(), 'circle-hub-testhub-packs-'));
  packs = await writeTestPacks(packRoot);
  locate = (await writePack(join(packRoot, LOCATE_PACK), locatePack())).dir;
});

/** The get_nodes call a text gives after `marker`, parsed. */
function callAfter(text: string, marker: string): Record<string, unknown> | null {
  const at = text.indexOf(`${marker}get_nodes `);
  if (at < 0) return null;
  const from = at + `${marker}get_nodes `.length;
  for (let end = text.indexOf('}', from); end >= 0; end = text.indexOf('}', end + 1)) {
    try {
      return JSON.parse(text.slice(from, end + 1)) as Record<string, unknown>;
    } catch {
      // not the end of the object yet
    }
  }
  return null;
}
after(async () => {
  await postgres?.stop();
  if (packRoot) await removeTree(packRoot);
});

interface StartedRun {
  run: string;
  pack: string;
  items: { id: string; label: string; location: string }[];
  sources: { reference: string; role: string; external?: string }[];
  requirements: { key: string }[];
}

describe('createTestHub', () => {
  test('smoke: list packs, start a run on a synthetic mind map read through the agile stub, submit, and the call log', async (t) => {
    const hub = await createTestHub({ postgres, repositoryPacks: false, packs: [packs.agile, packs.review] });
    t.after(() => hub.close());
    assert.deepEqual(
      hub.published.map((v) => `${v.id}@${v.version}`),
      [`${AGILE_PACK}@1.0.0`, `${REVIEW_PACK}@1.0.0`],
    );
    const stubs = hub.stubs!;
    const resource = await hub.addResource({
      system_pack: AGILE_PACK,
      name: '合成敏捷平台',
      environment: 'test',
      origins: { 'agile-oauth': stubs.agile.origin, 'agile-api': stubs.agile.origin },
      allow_plaintext: [stubs.agile.origin],
      settings: { roots: ['7714'] },
    });
    await hub.setCredential(resource.id, 'username', stubs.agileAccount.username);
    await hub.setCredential(resource.id, 'password', stubs.agileAccount.password);
    const alice = await hub.createUser('甲');
    await hub.assignPack(alice.principal, REVIEW_PACK);

    const client = await hub.client(alice.token, { sessionId: 'smoke-session-1' });
    const listed = await client.call('list_task_packs');
    assert.equal(listed.isError, false);
    assert.deepEqual((listed.structuredContent.packs as { pack: string }[]).map((p) => p.pack), [`${REVIEW_PACK}@1.0.0`]);
    assert.equal(listed.content.length, 1, 'one plain-text block');

    const started = await client.call('start_run', { pack: REVIEW_PACK, inputs: { map: { external: `agile:mindmap:${AGILE_DOCUMENT}` } } });
    assert.equal(started.isError, false, JSON.stringify(started.structuredContent));
    const run = started.structuredContent.run as StartedRun;
    assert.match(run.run, /^run_[0-9a-z]{26}$/);
    assert.deepEqual(run.requirements.map((r) => r.key), ['titles', 'notes']);
    assert.equal(run.items.length, 2, 'the two tagged cases of the synthetic map');
    assert.ok(run.items.every((item) => item.id.startsWith(`${AGILE_DOCUMENT}:`) && item.location.startsWith('src:')));
    assert.ok(run.sources.some((s) => s.role === 'subject' && s.external?.startsWith(`agile:mindmap:${AGILE_DOCUMENT}`)));
    assert.equal(stubs.agile.logins, 1, 'one login with the stored digest');
    // The assembly gives the server the engine's detail: the text names the run record, and its references read.
    const startText = started.content[0].text ?? '';
    assert.match(startText, /\n- [^\n]+ \| [^\n]+ \| 1 个期望结果\n/, 'items as id | label | summary');
    const schema = callAfter(startText, '完整的槽位模式（JSON Schema，带说明和写法）：');
    assert.ok(schema !== null && /^rec:[0-9a-f]{64}#\/slots\/schema$/.test(String(schema.reference)), `the full slot schema is named: ${startText.slice(0, 200)}`);
    const read = await client.call('get_nodes', schema);
    assert.equal(read.isError, false, read.content[0].text);
    assert.match(read.content[0].text ?? '', /"notes"/, 'the full schema of the run record, by reference');

    const submitted = await client.call('submit_result', {
      run: run.run,
      model: 'scripted-smoke-1',
      items: [
        { item: run.items[0].id, handling: 'handled', slots: { notes: [{ text: '缺少边界值的用例', code: 'gap' }] } },
        { item: run.items[1].id, handling: 'handled', slots: { notes: [] } },
      ],
    });
    assert.equal(submitted.isError, false, JSON.stringify(submitted.structuredContent));
    assert.equal(submitted.structuredContent.acceptance, 'accepted');
    const result = submitted.structuredContent.result as { run: string; partitions: Record<string, unknown[]> };
    assert.equal(result.run, run.run);
    assert.equal(Object.values(result.partitions).reduce((sum, list) => sum + list.length, 0), 2, 'every item is in one partition');
    const counts = submitted.structuredContent.counts as Record<string, number>;
    assert.equal(Object.values(counts).reduce((sum, n) => sum + n, 0), 2);
    await client.close();

    const detail = await hub.hub.runs.getRun(alice.principal, run.run);
    assert.equal(detail?.submissions.length, 1);
    assert.equal(detail?.latest?.result.acceptance, 'accepted');
    assert.ok((submitted.content[0].text ?? '').includes(`存下的结果 rec:${detail?.latest?.record}（`), 'the receipt names the stored result');
    const lines = (await hub.records.callLog.query(hub.admin.principal, { userId: alice.user.id, newestFirst: false, limit: 50 })).items;
    const calls = lines.filter((line) => line.tool !== 'initialize' && line.tool !== 'tools/list');
    assert.deepEqual(calls.map((line) => line.tool), ['list_task_packs', 'start_run', 'get_nodes', 'submit_result']);
    assert.ok(lines.every((line) => line.session === 'smoke-session-1' && /^[0-9a-f]{32}$/.test(line.trace_id)));
    assert.deepEqual(calls.slice(1).map((line) => line.run), [run.run, null, run.run], 'a read by reference names no run');
    assert.equal(calls[3].acceptance, 'accepted');
  });

  test('a production run through the real engine: the start_run text gives the counts, each requirement and the problems first, and the whole result reads by reference', async (t) => {
    const hub = await createTestHub({ postgres, repositoryPacks: false, packs: [locate], stubs: false });
    t.after(() => hub.close());
    const alice = await hub.createUser('甲');
    await hub.assignPack(alice.principal, LOCATE_PACK);
    const client = await hub.client(alice.token, { sessionId: 'production-1' });
    const node = (id: string, text: string, children: unknown[] = [], data: Record<string, unknown> = {}) => ({ data: { id, text, ...data }, children });
    const map = {
      root: node('r1', '合成脑图', [
        node('c1', '用例一', [node('e1', '期望一')], { priority: 1, resource: ['功能'] }),
        node('c2', '用例二', [], { priority: 1, resource: ['功能'] }),
      ]),
      template: 'default',
      theme: 'fresh-blue',
      version: '1.4.43',
    };
    const uploaded = await client.call('upload_file', { file_path: Buffer.from(JSON.stringify(map)).toString('base64'), name: 'map.json' });
    assert.equal(uploaded.isError, false);
    const started = await client.call('start_run', { pack: LOCATE_PACK, inputs: { map: { reference: uploaded.structuredContent.reference } } });
    assert.equal(started.isError, false, started.content[0].text);
    const result = started.structuredContent.result as { reference: string; counts: Record<string, number> };
    assert.match(result.reference, /^rec:[0-9a-f]{64}$/, 'the answer carries the result the engine computed');
    const lines = (started.content[0].text ?? '').split('\n');
    assert.match(lines[1], /^结果（start_run 时由 Hub 算出）：分区：/);
    assert.ok(lines.includes('要求项（满足状态与各层终态的条目数）：'), 'the counts of each requirement');
    assert.ok(lines.some((line) => /^- titles 标题与期望：满足 1，未满足 1/.test(line)), lines.slice(0, 12).join('\n'));
    const problems = lines.findIndex((line) => line.startsWith('问题与未知（'));
    const whole = lines.findIndex((line) => line.startsWith(`完整结果 ${result.reference}：`));
    assert.ok(whole > 0 && problems > whole, 'the whole result is named before the problems');
    assert.ok(lines.slice(problems).some((line) => line.startsWith('- r1:c2 | 用例二 | ') && line.includes(' | titles | ')), 'the case without an expected result is a problem');
    assert.ok(problems < lines.findIndex((line) => line.startsWith('条目（')), 'the problems before the items');
    const read = await client.call('get_nodes', { reference: result.reference });
    assert.equal(read.isError, false, read.content[0].text);
    assert.match(read.content[0].text ?? '', new RegExp(`^内容 ${result.reference}：模型可读\n`));
    assert.ok((read.content[0].text ?? '').includes('- r1:c2 | 用例二 | '), 'the item is in the stored result');
    await client.close();
  });

  test('the production assembly wires the lease service: the assembled hub exposes it and it answers over the same database', async (t) => {
    const { createTestHub } = await import('../testing-real.ts');
    const postgres = await startPostgres();
    t.after(() => postgres.stop());
    const hub = await createTestHub({ postgres, stubs: false });
    t.after(() => hub.close());
    assert.ok(hub.leases !== null && hub.leases !== undefined, 'the assembled hub carries the lease service');
    const holder = { user: hub.admin.user.id, run: 'run_0123456789abcdefghjkmnpqrs' };
    const granted = await hub.leases.acquire({ keys: ['meadow/probe/1'], ttlSeconds: 60, holder, prefix: 'meadow/', maxTtlSeconds: 120 });
    assert.equal(granted.ok, true, 'the service answers over the hub database');
    const view = await hub.leases.view('meadow/probe/');
    assert.equal(view.entries.length, 1);
  });

  test('a user without the pack gets the neutral answer; the reason is in the admin note only', async (t) => {
    const hub = await createTestHub({ postgres, repositoryPacks: false, packs: [packs.review], stubs: false });
    t.after(() => hub.close());
    const bob = await hub.createUser('乙');
    const client = await hub.client(bob.token, { sessionId: 'neutral-1' });
    const started = await client.call('start_run', { pack: REVIEW_PACK, inputs: { map: { reference: `src:${'a'.repeat(64)}` } } });
    await client.close();
    assert.equal(started.isError, true);
    const errors = started.structuredContent.errors as { code: string; message: string }[];
    assert.deepEqual(errors.map((e) => [e.code, e.message]), [['SOURCE_UNAVAILABLE', '对你不可用']]);
    const asAdmin = (await hub.records.callLog.query(hub.admin.principal, { userId: bob.user.id, tool: 'start_run' })).items;
    assert.equal(asAdmin.length, 1);
    assert.match((asAdmin[0].admin_reasons ?? []).join('\n'), new RegExp(`start_run: pack ${REVIEW_PACK} is unknown, not assigned to ${bob.user.id}`));
    const asBob = (await hub.records.callLog.query(bob.principal, { tool: 'start_run' })).items;
    assert.equal(asBob.length, 1);
    assert.equal(asBob[0].admin_note, undefined, 'the caller never sees the reason');
    assert.equal(asBob[0].admin_reasons, undefined, 'the caller never sees private reasons');
    assert.ok(!JSON.stringify(started).includes('not assigned'));
  });

  test('by default the repository\'s packs are published with product packs activated; publishPack and knowledgeSync work on them', async (t) => {
    // A synthetic tree stands in for packs/ (the repository's own packs are other work and change under it).
    const repository = await mkdtemp(join(tmpdir(), 'circle-hub-repository-'));
    t.after(() => removeTree(repository));
    await writeTestPacks(repository);
    const hub = await createTestHub({ postgres, repositoryRoot: repository, buildSite: syncSiteFiles() });
    t.after(() => hub.close());
    assert.deepEqual(
      hub.published.map((v) => `${v.kind} ${v.id}@${v.version}`),
      [`product ${PRODUCT_PACK}@1.0.0`, `workflow ${REVIEW_PACK}@1.0.0`, `system ${AGILE_PACK}@1.0.0`, `system ${SITE_PACK}@1.0.0`],
      'every pack of the tree, by kind in the vocabulary\'s order',
    );
    assert.equal(await hub.hub.registry.isActive(PRODUCT_PACK), true, 'a product pack published at start is activated');

    // publishPack: a product pack is activated unless told otherwise.
    const variant = (id: string, name: string) => {
      const pack = productPack('1.0.0');
      const declaration = pack.files['product.json'] as Record<string, unknown>;
      return { ...pack, id, files: { ...pack.files, 'product.json': { ...declaration, id, names: [name] } } };
    };
    const later = await hub.publishPack((await writePack(join(repository, 'later'), variant('demo-later', 'LATER'))).dir, { activate: false });
    assert.equal(later.id, 'demo-later');
    assert.equal(await hub.hub.registry.isActive('demo-later'), false);
    await hub.activate('demo-later');
    assert.equal(await hub.hub.registry.isActive('demo-later'), true);
    await hub.publishPack((await writePack(join(repository, 'other'), variant('demo-other', 'OTHER'))).dir);
    assert.equal(await hub.hub.registry.isActive('demo-other'), true);

    await hub.addResource({ system_pack: SITE_PACK, name: '合成构建站', environment: 'shared', origins: { 'build-site': hub.stubs!.buildSite.origin } });
    const first = await hub.knowledgeSync('DEMO');
    assert.equal(first.error, null);
    assert.deepEqual(first.counts, { produced: 1, registered: 1, skipped: 2, failed: 1 });
    const again = await hub.knowledgeSync('ALT', { lines: ['2.1.0'] });
    assert.equal(again.counts.produced, 0);
    assert.match(again.builds.find((build) => build.name === 'Rel_DEMO_2_1_0_5')?.reason ?? '', /已有根，来源和生产器都没有变/);
    await assert.rejects(hub.knowledgeSync('NOTHING'), /没有叫 NOTHING 的启用中的产品包/);
  });

  test('pack directories are found by their pack.json and staged with exactly the files they list', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'circle-hub-find-'));
    t.after(() => removeTree(root));
    const write = async (path: string, text: string) => {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), text);
    };
    const manifest = (id: string, kind: string, files: string[]) => JSON.stringify({ schema: 'pack@1', id, version: '1.0.0', kind, title: id, description: id, files: files.map((path) => ({ path, sha256: '0'.repeat(64), size: 0 })) });
    await write('workflow/alpha/pack.json', manifest('alpha', 'workflow', ['functions/a.ts']));
    await write('workflow/alpha/functions/a.ts', 'export default function a() { return 1; }\n');
    await write('workflow/alpha/functions/a.test.ts', 'unlisted test file\n');
    await write('workflow/alpha/nested/pack.json', manifest('nested', 'workflow', []));
    await write('product/beta/pack.json', manifest('beta', 'product', []));
    await write('system/gamma/pack.json', manifest('gamma', 'system', []));
    await write('notes/readme.md', 'not a pack\n');
    const found = await findPackDirectories(root);
    assert.deepEqual(found.map((dir) => dir.slice(root.length + 1)), ['product/beta', 'workflow/alpha', 'system/gamma'], 'the kinds in vocabulary order; nothing below a pack');
    assert.deepEqual((await findPackDirectories(root, ['alpha', 'gamma'])).map((dir) => dir.slice(root.length + 1)), ['workflow/alpha', 'system/gamma']);
    await assert.rejects(findPackDirectories(root, ['alpha', 'delta']), /没有这些任务包：delta/);
    const staged = await stagePack(join(root, 'workflow/alpha'), root);
    assert.deepEqual((await readdir(staged, { recursive: true })).sort(), ['functions', 'functions/a.ts', 'pack.json']);
    await write('workflow/evil/pack.json', manifest('evil', 'workflow', ['../outside.ts']));
    await assert.rejects(stagePack(join(root, 'workflow/evil'), root), /不是任务包文件路径/);
    assert.deepEqual(await findPackDirectories(join(root, 'missing')), []);
  });
});
