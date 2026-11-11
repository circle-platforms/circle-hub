// An object whose answer holds unreviewed suspected credentials, through the real read engine and the run engine: the run that
// only reads ends normally, and what its reader can reach says the object exists and nothing else of the answer, while a named
// administrator is asked to review it (D05 R[3], decision 152). Synthetic fixtures only.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ReadManifest } from '../../contracts/src/resources.ts';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { BUGS } from '../fixtures/plm/index.ts';
import { openBed, type Bed } from './support/hub.ts';
import type { McpClient } from './support/mcp.ts';
import { withCredentialDetectors } from '../../hub/testing/records.ts';

// Issue 194: new content is no longer held for looking like a credential. This file covers what a held object answers,
// which records stored under credential-scan@3 still follow, so it turns the detectors on for itself.
withCredentialDetectors();

const ID = '5151';
const VALUE = ['Synthetic', 'Held', 'Value', '42'].join('-');
const OBJECT = `plm:bug:${ID}`;

let postgres: TemporaryPostgres;
let bed: Bed;
let client: McpClient;

before(async () => {
  BUGS[ID] = { id: Number(ID), title: '示例组件升级后报错', status: 'active', openedDate: '2026-02-07 09:00:00', steps: `<p>password=${VALUE}</p>` };
  postgres = await startPostgres();
  bed = await openBed({ postgres, syncTwoName: true, syncOneName: false });
  await bed.hub.assignPack(bed.reviewer.principal, 'source-read');
  client = await bed.connect(bed.reviewer, 'session-held-source');
});

after(async () => {
  delete BUGS[ID];
  await client?.close().catch(() => undefined);
  await bed?.close().catch(() => undefined);
  await postgres?.stop().catch(() => undefined);
});

describe('a held object in a run that only reads', () => {
  it('ends normally, says the object exists and that its content awaits review, and reaches nothing of the answer', async () => {
    const res = await client.call('start_run', { pack: 'source-read', inputs: { defect: { external: OBJECT } } });
    assert.equal(res.out.call_result, 'ok', JSON.stringify(res.out.errors));
    assert.equal(res.isError, false);
    assert.match(res.text, new RegExp(`系统 plm 里有 ${OBJECT}，内容待核看`));
    assert.match(res.text, /到来源系统看原文/);
    const said = JSON.stringify(res.out);
    for (const secret of [VALUE, 'password=', 'SOURCE_CREDENTIAL']) assert.ok(!said.includes(secret) && !res.text.includes(secret), secret);

    const source = res.out.run!.sources.find(row => row.slot === 'defect')!;
    assert.equal(source.coverage?.complete, false);
    assert.ok(source.read_manifest, 'the read that observed it is on record');
    const manifest = await client.call('get_nodes', { reference: `rec:${source.read_manifest}` });
    assert.equal(manifest.isError, false, manifest.text);
    for (const secret of [VALUE, 'password=', 'SOURCE_CREDENTIAL']) assert.ok(!manifest.text.includes(secret), secret);
    const body = ReadManifest.parse((await bed.hub.records.store.get(source.read_manifest))!.body);
    const entry = body.requests.find(row => row.key === body.original)!;
    assert.deepEqual([entry.sha256, entry.size, entry.media_type, entry.etag, entry.artifact], [null, null, null, null, null]);
  });

  it('asks a named administrator once, however often the object is read', async () => {
    await client.call('start_run', { pack: 'source-read', inputs: { defect: { external: OBJECT } } });
    const rows = (await bed.hub.records.store.find<{ detail: { credential?: { external: string }; audience_user: string } }>({ key: 'action.kind', value: 'read', kind: 'action', limit: 500 })).items
      .filter(row => row.body.detail?.credential?.external === OBJECT);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].body.detail.audience_user, bed.hub.admin.principal.id);
  });
});
