// Scenario 6 (brief section 9): A user without the pack gets "对你不可用" and the same empty shape;
// the real reason is only in the admin log.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { openConsole, type ConsoleClient } from './support/console.ts';
import { openBed, type Bed } from './support/hub.ts';
import type { McpClient } from './support/mcp.ts';

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
  test('a user without the pack gets SOURCE_UNAVAILABLE ("对你不可用") with empty shape matching a non-existent pack', async () => {
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
    assert.equal(unassignedAnswer.out.errors[0]?.code, 'SOURCE_UNAVAILABLE');
    assert.ok(unassignedAnswer.text.includes('对你不可用'), 'response text contains 对你不可用');
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
    assert.equal(nonExistentAnswer.out.errors[0]?.code, 'SOURCE_UNAVAILABLE');
    assert.ok(nonExistentAnswer.text.includes('对你不可用'));

    // Absent and forbidden give the same empty shape (apart from trace id)
    assert.deepEqual(
      { ...unassignedAnswer.out, trace: 'fixed' },
      { ...nonExistentAnswer.out, trace: 'fixed' },
      'absent and forbidden give the exact same empty shape',
    );

    // 3. Admin log holds the real reason
    const logs = await bed.hub.records.callLog.query(bed.hub.admin.principal, { userId: outsider.user.id });
    const unassignedCall = logs.items.find((l) => l.session === 'sess-s06-outsider');
    assert.ok(unassignedCall, 'call log entry exists');
    assert.equal(unassignedCall.call_result, 'error');
    assert.equal(unassignedCall.error_code, 'SOURCE_UNAVAILABLE');
    // Private administrator reasons capture the internal cause, outside the bounded summary.
    assert.ok(unassignedCall.admin_reasons?.some(reason=>reason.length>0), 'admin_reasons contains the real reason');
    assert.equal(unassignedCall.admin_note, `管理员理由 ${unassignedCall.admin_reasons?.length} 条；详见管理员调用日志详情`);

    // 4. Console log check
    const callsPage = await consoleClient.get('/console/admin/calls');
    assert.equal(callsPage.status, 200);
    assert.ok(callsPage.body.includes('SOURCE_UNAVAILABLE') || callsPage.body.includes(outsider.user.id));
  });
});
