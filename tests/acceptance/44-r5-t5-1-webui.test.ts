import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { sha256Hex } from '../../hub/records/api.ts';
import { FedProcedureSchema } from '../../contracts/src/feeding.ts';
import { fakeHub, skill } from '../../packs/workflow/knowledge-contribution/testing/operation-support.ts';
import { sessionDirectory } from '../../packs/workflow/knowledge-contribution/tools/operation-capture/lib/common.ts';
import {
  capture, contribution, integrate, openOperationWorld, pageTarget, quote,
} from './support/operation-acceptance.ts';

const PAGE_TEXT = 'Navigation: Synthetic Pools\nForm: Interval [10]\nManual: Interval [20]\n';

describe('scenario 44: T5-1 synthetic WebUI originals and operation integration', () => {
  test('accepts verbatim page procedures and rejects an altered element quote locally and at the Hub', async t => {
    const world = await openOperationWorld(t, { manual: true });
    if (!world) return;
    const path = await pageTarget(world);
    const saved = await capture(world, PAGE_TEXT, {
      url: 'http://192.0.2.45/synthetic/pools', bed: 'bench-web', device: 'edge-web',
    }, 'browser_snapshot');
    const first = quote(saved.event, 1, 'Navigation: Synthetic Pools');
    const second = quote(saved.event, 2, 'Form: Interval [10]');
    const proposals = [{
      capture: saved.event.output.sha256, kind: 'procedure', path,
      statement: '合成 WebUI 页面操作步骤', goal: '核对合成页面导航与表单',
      steps: [
        { text: '打开合成池页面', quote: { line: 1, text: first.text } },
        { text: '核对合成间隔输入框', quote: { line: 2, text: second.text } },
      ],
    }];
    const receipt = await integrate(world, proposals);
    assert.equal(receipt.result.contributions.stored.length, 1);
    const record = receipt.result.contributions.stored[0].record;
    const view = await contribution(world, path, record);
    const feeding = FedProcedureSchema.parse(view.contribution.feeding);
    assert.equal(view.contribution.source.provenance, 'client_captured');
    assert.deepEqual(feeding.steps.map(step => step.quote), [first, second]);
    assert.equal(view.contribution.session, world.session);

    const changed = structuredClone(proposals);
    (changed[0].steps[1].quote as { text: string }).text = 'Form: Interval [11]';
    const changedFile = join(world.local.home, 'changed-page-proposals.json');
    await writeFile(changedFile, JSON.stringify({ schema: 'operation-integration@1', session: world.session, items: changed }));
    const localRefusal = await skill(world.local, [
      'submit', '--session', world.session, '--proposals', changedFile,
      '--product', world.product, '--build', world.build, '--model', 'integration-synthetic@1',
    ]);
    assert.notEqual(localRefusal.code, 0);
    assert.match(`${localRefusal.out}${localRefusal.err}`, /quote_mismatch/);
    const receipts = (await readFile(join(sessionDirectory(world.session, { CIRCLE_HOME: world.local.home }), 'receipts.jsonl'), 'utf8'))
      .trimEnd().split('\n');
    assert.equal(receipts.length, 1, 'a client-side quote refusal is not submitted again');

    const stored = await world.bed.hub.records.store.find<any>({ key: 'runs.submission.run', value: receipt.result.run, kind: 'submission', limit: 10 });
    assert.ok(stored.items.length > 0);
    const resubmission = structuredClone(stored.items.at(-1)!.body);
    resubmission.items[0].slots.contribution[0].data.feeding.steps[1].quote.text = 'Form: Interval [11]';
    const hubRefusal = await world.client.call('submit_result', resubmission);
    assert.equal(hubRefusal.out.acceptance, 'not_accepted', hubRefusal.text);
    assert.match(JSON.stringify(hubRefusal.out.errors), /逐字/);
    assert.equal((await world.bed.hub.records.store.get(record))?.digest, record);
    const afterRefusal = await world.client.call('get_nodes', { root: world.root, paths: [path], depth: 0 });
    assert.equal(afterRefusal.out.nodes?.[0]?.contributions?.length, 1);
  });

  test('sends page text through the loopback hook and stores an independent PNG byte for byte, never as a text quote', async t => {
    const fake = await fakeHub(t);
    const world = await openOperationWorld(t, { captureUrl: fake.url });
    if (!world) return;
    const saved = await capture(world, PAGE_TEXT, {
      url: 'http://192.0.2.45/synthetic/pools', bed: 'bench-web', device: 'edge-web',
    }, 'browser_snapshot');
    assert.ok(saved.event.output.file.endsWith('.txt'));
    const upload = fake.uploads.get(saved.event.output.sha256);
    assert.ok(upload);
    assert.deepEqual(upload.bytes, saved.bytes);
    assert.equal(upload.provenance, 'client_captured');
    const request = fake.requests.find(row => row.body.method === 'tools/call' && row.body.params.name === 'upload_file');
    assert.ok(request);
    assert.equal(request.headers['circle-session-id'], world.session);
    assert.equal(request.body.params.arguments.media_type, 'text/plain');
    assert.equal(request.body.params.arguments.provenance_type, 'client_captured');

    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const uploaded = await world.client.call('upload_file', {
      name: 'synthetic-page.png', media_type: 'image/png', file_path: png.toString('base64'), provenance_type: 'client_captured',
    });
    assert.equal(uploaded.isError, false, uploaded.text);
    assert.equal(uploaded.out.acceptance, 'accepted');
    assert.equal(uploaded.out.media_type, 'image/png');
    const sha = sha256Hex(png);
    assert.equal(uploaded.out.sha256, sha);
    assert.equal(uploaded.out.reference, `src:${sha}`);
    const records = await world.bed.hub.records.artifacts.records(sha);
    const artifact = records.find(row => 'upload' in row.body.origin && row.body.origin.upload.session === world.session);
    assert.ok(artifact);
    assert.equal(artifact.body.provenance_type, 'client_captured');
    assert.equal(artifact.body.media_type, 'image/png');
    const source = await world.bed.hub.records.artifacts.source(world.bed.reviewer.principal, sha, { record: artifact.digest });
    assert.deepEqual(Buffer.from(source?.bytes ?? []), png);
    const notText = await world.client.call('get_nodes', { reference: `src:${sha}/text@1/l/1` });
    assert.equal(notText.isError, true, 'a PNG is not promoted to a text@1 quotation');
  });

  test('submits a declared browser device and keeps the device and bed it names', async t => {
    const world = await openOperationWorld(t, { manual: true });
    if (!world) return;
    const path = await pageTarget(world);
    const saved = await capture(world, PAGE_TEXT, {
      url: 'http://192.0.2.45/synthetic/pools', bed: 'bench-web', device: 'edge-web',
    }, 'browser_snapshot');
    const first = quote(saved.event, 1, 'Navigation: Synthetic Pools');
    const receipt = await integrate(world, [{
      capture: saved.event.output.sha256, kind: 'procedure', path, device: 'edge-web',
      statement: '合成页面设备声明', goal: '核对设备与台架',
      steps: [{ text: '打开合成池页面', quote: { line: 1, text: first.text } }],
    }]);
    assert.deepEqual(receipt.result.contributions.stored[0], { item: 'operation-1', record: receipt.result.contributions.stored[0].record });
    const record = receipt.result.contributions.stored[0].record;
    const view = await contribution(world, path, record);
    const feeding = FedProcedureSchema.parse(view.contribution.feeding);
    assert.equal(feeding.device, 'edge-web');
    assert.equal(feeding.bed, 'bench-web');
    assert.match(view.note ?? '', /设备 edge-web（台架 bench-web）/);
    const page = await world.client.call('get_nodes', { root: world.root, paths: [path], depth: 0 });
    assert.match(page.text, /设备 edge-web（台架 bench-web）/);
  });
});
