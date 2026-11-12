// The masking dictionary through the real read engine, the run engine and MCP (B02 R[11], decision 159, issue 194 step
// two): a run that reads a business system whose answer carries a value a rule matches gets the answer with a placeholder
// in its place, and nothing the run, its reader or an administrator can reach holds the value. Synthetic fixtures only.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ReadManifest } from '../../contracts/src/resources.ts';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { BUGS } from '../fixtures/plm/index.ts';
import { openBed, type Bed } from './support/hub.ts';
import type { McpClient } from './support/mcp.ts';
import { openConsole } from './support/console.ts';

const MASKED = '6161', PLAIN = '6262';
const VALUE = ['Synthetic', 'Masked', 'Value', '61'].join('-');
const PLACEHOLDER = '[密码已遮盖 *****]';

let postgres: TemporaryPostgres;
let bed: Bed;
let client: McpClient;

before(async () => {
  BUGS[MASKED] = { id: Number(MASKED), title: '示例组件登录失败', status: 'active', openedDate: '2026-02-07 09:00:00', steps: `<p>设备 192.0.2.61 登录 password=${VALUE} 后复现</p>` };
  BUGS[PLAIN] = { id: Number(PLAIN), title: '示例组件升级后报错', status: 'active', openedDate: '2026-02-07 09:00:00', steps: '<p>升级后重启即复现</p>' };
  postgres = await startPostgres();
  bed = await openBed({ postgres, syncTwoName: true, syncOneName: false });
  await bed.hub.assignPack(bed.reviewer.principal, 'source-read');
  client = await bed.connect(bed.reviewer, 'session-masking');
  await bed.hub.records.masking!.set(bed.hub.admin.principal, { name: 'device-password', label: '密码', pattern: 'password=(?<secret>[^\\s<"\\\\]+)', ignore_case: true }, '合成设备口令不进知识');
});

after(async () => {
  delete BUGS[MASKED]; delete BUGS[PLAIN];
  await client?.close().catch(() => undefined);
  await bed?.close().catch(() => undefined);
  await postgres?.stop().catch(() => undefined);
});

const read = async (id: string) => {
  const res = await client.call('start_run', { pack: 'source-read', inputs: { defect: { external: `plm:bug:${id}` } } });
  assert.equal(res.out.call_result, 'ok', JSON.stringify(res.out.errors));
  assert.equal(res.isError, false);
  const source = res.out.run!.sources.find((row) => row.slot === 'defect')!;
  assert.ok(source.read_manifest, 'the read is on record');
  const manifest = ReadManifest.parse((await bed.hub.records.store.get(source.read_manifest!))!.body);
  return { res, source, manifest };
};
const artifactsOf = async (manifest: ReadManifest) => {
  const out: Array<{ body: { sha256: string; masking?: { rules: Array<{ rule: string; count: number }> }; read_tier: string }; text: string }> = [];
  for (const request of manifest.requests) {
    if (request.artifact === null) continue;
    const record = await bed.hub.records.store.get<{ sha256: string; masking?: { rules: Array<{ rule: string; count: number }> }; read_tier: string }>(request.artifact);
    const bytes = await bed.hub.records.objects.get(record!.body.sha256);
    out.push({ body: record!.body, text: Buffer.from(bytes!).toString('utf8') });
  }
  return out;
};

describe('a run that reads a business system while a masking rule is in force', () => {
  it('gets the answer with a placeholder where the value was, and the value is stored nowhere', async () => {
    const { res, source, manifest } = await read(MASKED);
    // What the reader and the model get: the words around the value, the placeholder, never the value.
    assert.ok(!res.text.includes(VALUE) && !JSON.stringify(res.out).includes(VALUE), 'the answer of start_run');
    const originals = await artifactsOf(manifest);
    assert.ok(originals.length > 0);
    const replaced = originals.filter((row) => row.body.masking !== undefined);
    assert.equal(replaced.length, 1, 'the one answer that carried the value is marked');
    assert.deepEqual(replaced[0].body.masking!.rules, [{ rule: 'device-password', count: 1 }]);
    assert.equal(replaced[0].body.read_tier, 'model_readable', 'it is read like any other answer');
    assert.ok(replaced[0].text.includes(`password=${PLACEHOLDER}`), 'the words around the value stay');
    assert.doesNotThrow(() => JSON.parse(replaced[0].text), 'a replaced JSON answer is still JSON');
    for (const row of originals) assert.ok(!row.text.includes(VALUE), 'no stored answer of this read holds the value');
    // The reference the run was given resolves to the replaced text, for the model too.
    const node = await client.call('get_nodes', { reference: source.reference });
    assert.equal(node.isError, false, node.text);
    assert.ok(!node.text.includes(VALUE));
    // Nothing else the Hub wrote down about the read holds it: the manifest, the actions, the call log, any generated view.
    for (const kind of ['action', 'call_log', 'source_artifact', 'run'] as const) {
      for (const record of (await bed.hub.records.store.list({ kind, limit: 500 })).items) assert.ok(!JSON.stringify(record.body).includes(VALUE), kind);
    }
    const generated = (await bed.hub.records.store.list<{ sha256: string; origin: object }>({ kind: 'source_artifact', limit: 500 })).items.filter((record) => 'generated' in record.body.origin);
    for (const record of generated) assert.ok(!Buffer.from((await bed.hub.records.objects.get(record.body.sha256))!).toString('utf8').includes(VALUE), 'a view generated from the answer');
  });

  it('leaves an answer no rule matches exactly as it was sent, with the record it always had', async () => {
    const { manifest } = await read(PLAIN);
    const originals = await artifactsOf(manifest);
    assert.ok(originals.length > 0);
    assert.ok(originals.every((row) => row.body.masking === undefined));
    assert.ok(originals.some((row) => row.text.includes('升级后重启即复现')));
  });

  it('shows the administrator the rule on the settings page and the mark on the original', async () => {
    const { manifest } = await read(MASKED);
    const original = (await artifactsOf(manifest)).find((row) => row.body.masking !== undefined)!;
    const admin = await openConsole(bed.hub, bed.hub.admin.token);
    const settings = await admin.get('/console/settings');
    assert.equal(settings.status, 200);
    assert.match(settings.body, /<td>device-password<\/td><td>\[密码已遮盖 \*\*\*\*\*\]<\/td>/);
    assert.ok(!settings.body.includes(VALUE));
    assert.ok(original.body.sha256.length === 64);
  });
});
