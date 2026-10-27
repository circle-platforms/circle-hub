import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startPostgres } from '../../hub/testing/postgres.ts';
import { openBed } from './support/hub.ts';
import { productSite } from './support/env.ts';
import { osIsolationAvailable } from '../../hub/rules/api.ts';
import { sha256Hex } from '../../hub/records/api.ts';
import { KnowledgeContributionView } from '../../contracts/src/contributions.ts';
import { SESSION, scratch, enable, hook, skill } from '../../packs/workflow/knowledge-contribution/testing/operation-support.ts';
import { sessionDirectory } from '../../packs/workflow/knowledge-contribution/tools/operation-capture/lib/common.ts';

test('scenario 37: Circle captures and integrates operation records through the real Hub without model supplied versions', async t => {
  if (!await osIsolationAvailable()) { t.skip('sandbox-exec 不可用；未验证真实 Hub 沙箱验收'); return; }
  const postgres = await startPostgres();
  t.after(() => postgres.stop());
  const bed = await openBed({ postgres, syncOneName: false });
  t.after(() => bed.close());
  await bed.hub.assignPack(bed.reviewer.principal, 'knowledge-contribution');
  const site = await productSite();
  const local = await scratch(t);
  await writeFile(local.tokenFile, `${bed.reviewer.token}\n`, { mode: 0o600 });
  assert.equal((await enable(local, bed.hub.mcpUrl)).code, 0);
  const outputs = [
    'ORBIT synthetic status: ready\n',
    'step one: check ORBIT\nstep two: record ready\n',
    'COMET synthetic display empty\n',
  ];
  for (const output of outputs) {
    const result = await hook(local, output, { bed: 'bed-synthetic', device: 'device-synthetic' });
    assert.equal(result.code, 0, result.err);
    assert.equal(result.out, '');
    assert.equal(result.err, '');
  }
  const [observation, procedure, pitfall] = outputs.map(sha256Hex);
  for (const digest of [observation, procedure, pitfall]) {
    const artifacts = await bed.hub.records.artifacts.records(digest);
    assert.ok(artifacts.some(row => row.body.provenance_type === 'client_captured' && 'upload' in row.body.origin), digest);
  }
  const produced = bed.syncs.two?.builds.find(build => build.name === site.RELEASED && build.outcome === 'produced' && build.root !== null);
  assert.ok(produced?.root);
  const client = await bed.connect(bed.reviewer, SESSION);
  const tree = await client.call('get_nodes', { root: produced.root, paths: ['/commands'], depth: 6 });
  assert.equal(tree.isError, false, tree.text);
  const commandNode = tree.out.nodes?.find(node => node.entries.some(entry => Array.isArray((entry.data as { words?: unknown } | undefined)?.words)));
  assert.ok(commandNode, 'the locked synthetic tree contains a structurally identified command node');
  const path = commandNode.path;
  const document = {
    schema: 'operation-integration@1',
    session: SESSION,
    items: [
      { capture: observation, kind: 'observation', path, statement: '核对 ORBIT 合成状态', action: '执行合成状态检查', quote: { line: 1, text: 'ORBIT synthetic status: ready' } },
      { capture: procedure, kind: 'procedure', path, statement: 'ORBIT 合成检查步骤', goal: '记录合成状态', steps: [{ text: '先检查', quote: { line: 1, text: 'step one: check ORBIT' } }, { text: '再记录', quote: { line: 2, text: 'step two: record ready' } }] },
      { capture: pitfall, kind: 'pitfall', path, statement: 'COMET 合成空显示先检查输入', phenomenon: '合成显示为空', suggestion: '先核对合成输入', quote: { line: 1, text: 'COMET synthetic display empty' } },
    ],
  };
  const proposals = join(local.home, 'proposals.json');
  await writeFile(proposals, JSON.stringify(document));
  const result = await skill(local, ['submit', '--session', SESSION, '--proposals', proposals, '--product', bed.product.names[0], '--build', site.RELEASED, '--model', 'integration-synthetic@1']);
  assert.equal(result.code, 0, `${result.out}\n${result.err}`);
  assert.ok(!`${result.out}${result.err}`.includes(bed.reviewer.token));
  const receiptFile = join(sessionDirectory(SESSION, { CIRCLE_HOME: local.home }), 'receipts.jsonl');
  const receipts = (await readFile(receiptFile, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
  assert.equal(receipts.length, 1);
  const receipt = receipts[0].receipt;
  assert.equal(receipt.acceptance, 'accepted');
  assert.equal(receipt.result.contributions.stored.length, 3);
  const run = receipt.result.run as string;
  const locked = await bed.hub.hub.runs.getRun(bed.reviewer.principal, run);
  assert.equal(locked?.run.build, site.RELEASED);
  const root = locked?.run.root;
  assert.ok(root);
  const page = await client.call('get_nodes', { root, paths: [path], depth: 0 });
  assert.equal(page.isError, false, page.text);
  const contributions = (page.out.nodes?.[0]?.contributions ?? []).map(row => KnowledgeContributionView.parse(row));
  assert.equal(contributions.length, 3);
  const bodies = contributions.map(row => {
    assert.ok('statement' in row.contribution);
    return row.contribution;
  });
  assert.deepEqual(new Set(bodies.map(row => row.feeding?.schema)), new Set(['fed-observation@1', 'fed-procedure@1', 'fed-pitfall@1']));
  for (const contribution of bodies) {
    assert.equal(contribution.kind, 'assertion');
    assert.equal(contribution.source.provenance, 'client_captured');
    const feeding = contribution.feeding as any;
    assert.equal(feeding.binding.source, 'run_lock');
    assert.equal(feeding.binding.build, site.RELEASED);
    assert.ok(!('version' in feeding));
  }
  const stored = await bed.hub.records.store.find<any>({ key: 'runs.submission.run', value: run, kind: 'submission', limit: 10 });
  assert.ok(stored.items.length >= 1);
  const changed = structuredClone(stored.items.at(-1)!.body);
  changed.items[0].slots.contribution[0].data.feeding.result.text += 'X';
  const refused = await client.call('submit_result', changed);
  assert.equal(refused.out.acceptance, 'not_accepted');
  assert.match(JSON.stringify(refused.out.errors), /逐字/);
  const after = await client.call('get_nodes', { root, paths: [path], depth: 0 });
  assert.equal(after.out.nodes?.[0]?.contributions?.length, 3);
});
