// Scenario 6 (brief section 9), as decision 112 changed it: a user without the pack is told the pack exists and is not
// assigned to them (SOURCE_NOT_PERMITTED); a pack the Hub does not have is SOURCE_ABSENT. Neither answer shows anything of
// the pack, and the account behind the refusal is only in the admin log.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workflowPack, writePack } from '../../hub/runs/packs/testing/builder.ts';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { openConsole, type ConsoleClient } from './support/console.ts';
import { openBed, type Bed } from './support/hub.ts';

let postgres: TemporaryPostgres;
let bed: Bed;
let consoleClient: ConsoleClient;

before(async () => {
  postgres = await startPostgres();
  bed = await openBed({ postgres });
  consoleClient = await openConsole(bed.hub, bed.hub.admin.token);
});
after(async () => {
  await bed?.close();
  await postgres?.stop();
});

describe('scenario 6: user without pack', () => {
  test('a user without the pack gets SOURCE_NOT_PERMITTED, a non-existent pack SOURCE_ABSENT, both with the empty shape', async () => {
    // Create a user with NO packs assigned
    const outsider = await bed.user('外人', []);
    const client = await bed.connect(outsider, 'sess-s06-outsider');

    // 1. Calling start_run for a pack that exists in the Hub but is NOT assigned to this user
    const unassignedAnswer = await client.call('start_run', {
      pack: 'case-review',
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: {},
    });
    assert.equal(unassignedAnswer.isError, true);
    assert.equal(unassignedAnswer.out.call_result, 'error');
    assert.equal(unassignedAnswer.out.errors[0]?.code, 'SOURCE_NOT_PERMITTED');
    assert.ok(unassignedAnswer.text.includes('当前账户未获授权使用工作流「case-review」'), unassignedAnswer.text);
    assert.ok(unassignedAnswer.text.includes('请联系管理员为该账户或所在团队分配此工作流'), 'the fix names who can assign it');
    assert.equal(unassignedAnswer.out.run, undefined);

    // 2. Calling start_run for a completely non-existent pack
    const nonExistentAnswer = await client.call('start_run', {
      pack: 'totally-fictitious-pack-999',
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: {},
    });
    assert.equal(nonExistentAnswer.isError, true);
    assert.equal(nonExistentAnswer.out.call_result, 'error');
    assert.equal(nonExistentAnswer.out.errors[0]?.code, 'SOURCE_ABSENT');
    assert.equal(
      nonExistentAnswer.text,
      '不存在：Hub 里没有名为「totally-fictitious-pack-999」的工作流或技能。请核对名称；当前账户可用的工作流和技能用 list_task_packs 查看。',
    );

    // Apart from the error itself, both answers have the same empty shape: nothing of the pack is shown.
    const shape = (out: Record<string, unknown>) => ({ ...out, trace: 'fixed', errors: undefined });
    assert.deepEqual(shape(unassignedAnswer.out), shape(nonExistentAnswer.out), 'the same empty shape');
    assert.ok(!unassignedAnswer.text.includes(outsider.user.id), 'the account id stays in the admin log');

    // 3. Admin log holds the real reason
    const logs = await bed.hub.records.callLog.query(bed.hub.admin.principal, { userId: outsider.user.id });
    const unassignedCall = logs.items.find((l) => l.session === 'sess-s06-outsider');
    assert.ok(unassignedCall, 'call log entry exists');
    assert.equal(unassignedCall.call_result, 'error');
    assert.ok(['SOURCE_NOT_PERMITTED', 'SOURCE_ABSENT'].includes(String(unassignedCall.error_code)), String(unassignedCall.error_code));
    // Private administrator reasons capture the internal cause, outside the bounded summary.
    assert.ok(unassignedCall.admin_reasons?.some(reason=>reason.length>0), 'admin_reasons contains the real reason');
    assert.equal(unassignedCall.admin_note, `管理员理由 ${unassignedCall.admin_reasons?.length} 条；详见管理员调用日志详情`);

    // 4. Console log check
    const callsPage = await consoleClient.get('/console/records');
    assert.equal(callsPage.status, 200);
    assert.ok(callsPage.body.includes('SOURCE_NOT_PERMITTED') || callsPage.body.includes(outsider.user.id));
  });
  test('name suggestions disclose a personal workflow only inside its owner namespace', async (t) => {
    const owner = await bed.user('合成私有包主人', []), other = await bed.user('合成无授权读者', []);
    const directory = await mkdtemp(join(tmpdir(), 's06-private-names-')); t.after(() => rm(directory, { recursive: true, force: true }));
    const spec = workflowPack({ id: 'synthetic-private-suggestion', product: { catalogs: [] } });
    spec.files['knowledge.json'] = { schema: 'knowledge@1', requires: [] };
    const written = await writePack(join(directory, 'pack'), spec);
    const published = await bed.hub.hub.registry.personal!.publish(owner.principal, written.dir);
    assert.equal(published.ok, true, JSON.stringify(published));
    const ownerClient = await bed.connect(owner), otherClient = await bed.connect(other);
    assert.ok((await ownerClient.call('list_task_packs', {})).out.packs.some(row => row.id === spec.id && row.space === owner.user.id));
    assert.ok(!(await otherClient.call('list_task_packs', {})).out.packs.some(row => row.id === spec.id));
    const asked = 'synthetic-private-sugestion';
    for (const actor of [ownerClient, otherClient]) {
      const absent = await actor.call('start_run', { pack: asked, inputs: {} });
      assert.equal(absent.out.errors[0]?.code, 'SOURCE_ABSENT');
      assert.equal(absent.text, '不存在：Hub 里没有名为「synthetic-private-sugestion」的工作流或技能。请核对名称；当前账户可用的工作流和技能用 list_task_packs 查看。');
      assert.equal(absent.out.run, undefined);
      assert.ok(!JSON.stringify(absent).includes(spec.id), 'a team-space refusal discloses no personal workflow');
    }
    const own = await ownerClient.call('start_run', { pack: asked, pack_space: owner.user.id, inputs: {} });
    assert.equal(own.out.errors[0]?.message, 'Hub 里没有名为「synthetic-private-sugestion」的工作流或技能，当前账户可用的名称里最接近的是 synthetic-private-suggestion@1.0.0');
    const ownerCall = (await bed.hub.records.callLog.query(bed.hub.admin.principal, { traceId: own.out.trace })).items[0];
    const reasons = ownerCall.admin_reasons ?? [];
    assert.ok(reasons.some(reason => reason.startsWith('参数预览 ')));
    assert.ok(!reasons.join('\n').includes(spec.id), 'admin diagnostics keep the personal workflow name private');
    const error = JSON.parse(reasons.find(reason => reason.startsWith('调用错误 '))!.slice('调用错误 '.length));
    assert.deepEqual(error, { code: own.out.errors[0].code, path: own.out.errors[0].path });
    const badList = await ownerClient.call('list_task_packs', { pack_id:spec.id, offset:-1 });
    assert.equal(badList.isError, true);
    const listCall = (await bed.hub.records.callLog.query(bed.hub.admin.principal, { traceId:badList.out.trace })).items[0];
    assert.ok(listCall.admin_reasons?.some(reason => reason.startsWith('参数预览 ')));
    assert.ok(!listCall.admin_reasons!.join('\n').includes(spec.id), 'a filtered catalog also includes the caller’s personal packs');

    const denied = await otherClient.call('start_run', { pack: asked, pack_space: owner.user.id, inputs: {} });
    assert.equal(denied.out.errors[0]?.code, 'SOURCE_UNAVAILABLE');
    assert.equal(denied.out.run, undefined);
    assert.ok(!JSON.stringify(denied).includes(spec.id), 'another account cannot obtain the personal name by asking for its space');
  });

});
