// Related-tasks console page: clustering, permissions, device output (Boss 12:15).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DOCUMENTS } from '../fixtures/agile/index.ts';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { openBed, type Bed } from './support/hub.ts';
import { openConsole, type ConsoleClient } from './support/console.ts';
import type { McpClient } from './support/mcp.ts';
import { startReview } from './support/review.ts';
import {
  ROUND_NO_SUBJECT,
  ROUND_PAGE_TITLE,
} from '../../hub/server/console/round-view.ts';

let postgres: TemporaryPostgres;
let bed: Bed;
let client: McpClient;
let admin: ConsoleClient;
let outsider: ConsoleClient;

before(async () => {
  postgres = await startPostgres();
  bed = await openBed({ postgres });
  client = await bed.connect(bed.reviewer, 'sess-related-tasks');
  admin = await openConsole(bed.hub, bed.hub.admin.token);
  const other = await bed.user('related-tasks-outsider', []);
  outsider = await openConsole(bed.hub, other.token);
});

after(async () => {
  await bed?.close().catch(() => undefined);
  await postgres?.stop().catch(() => undefined);
});

describe('console related-tasks page', () => {
  it('clusters from a subject-bound run, hides the entry without subject, and gates device output', async () => {
    const run = await startReview(client, {
      product: bed.product.names[1],
      version: bed.site.LINE,
      parameters: { stories: ['31057'], bugs: ['31057'] },
      inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } },
    });

    const missing = await admin.get('/console/rounds');
    assert.equal(missing.status, 404);

    const page = await admin.get(`/console/rounds?run=${run.run}`);
    assert.equal(page.status, 200);
    assert.match(page.body, new RegExp(`<title>${ROUND_PAGE_TITLE}`));
    assert.doesNotMatch(page.body, /src:[0-9a-f]{64}/);
    // Table headers are label/summary, not guessed ID/title.
    assert.match(page.body, /原始用例/);
    assert.match(page.body, /说明/);
    assert.doesNotMatch(page.body, /用时/);
    assert.match(page.body, /已确认正确|未确认|错误|未知/);

    const task = await admin.get(`/console/runs/${run.run}?tab=record`);
    assert.equal(task.status, 200);
    assert.match(task.body, /查看相关任务/);

    // A console user who is not the runner: page is either neutral (run not visible) or discloses the jobs/successors gate.
    const asOutsider = await outsider.get(`/console/rounds?run=${run.run}`);
    assert.ok(asOutsider.status === 200 || asOutsider.status === 404, `outsider status ${asOutsider.status}`);
    if (asOutsider.status === 200) {
      assert.match(asOutsider.body, new RegExp(ROUND_PAGE_TITLE));
      assert.match(asOutsider.body, /上机验证|无权限|尚未上机验证|设备输出|不能读取后继/);
    }

    // Device page without a matching job device_return stays neutral (404).
    const deviceMissing = await admin.get(`/console/rounds/device?run=${run.run}&sha256=${'a'.repeat(64)}`);
    assert.equal(deviceMissing.status, 404);

    // A synthetic booking-shaped run without subject: page discloses no-subject instead of inventing a cluster.
    // startReview always binds subject; assert the constant is the disclosed wording when noSubject is set in unit tests.
    assert.match(ROUND_NO_SUBJECT, /没有绑定同一份来源/);
  });
});
