// Related-tasks console page: subject-bound entry, outsider gate, device output 404.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DOCUMENTS } from '../fixtures/agile/index.ts';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { openBed, type Bed } from './support/hub.ts';
import { openConsole, type ConsoleClient } from './support/console.ts';
import type { McpClient } from './support/mcp.ts';
import { startReview } from './support/review.ts';
import { ROUND_PAGE_TITLE } from '../../hub/server/console/round-view.ts';

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
  it('opens for a subject-bound run, links from the task page, and gates outsiders and device digests', async () => {
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
    assert.match(page.body, /<th scope="col">原始用例<\/th>/);
    assert.match(page.body, /<th scope="col">说明<\/th>/);
    assert.match(page.body, /<th scope="col"[^>]*>本条上机验证次数<\/th>/);
    assert.match(page.body, /完成的上机验证/);
    assert.doesNotMatch(page.body, /用时|上机作业|衔接边/);

    const task = await admin.get(`/console/runs/${run.run}?tab=record`);
    assert.equal(task.status, 200);
    assert.match(task.body, /查看相关任务/);

    // Outsider without the run: neutral 404 (same visibility as getRun).
    const asOutsider = await outsider.get(`/console/rounds?run=${run.run}`);
    assert.equal(asOutsider.status, 404);

    const deviceMissing = await admin.get(`/console/rounds/device?run=${run.run}&sha256=${'a'.repeat(64)}`);
    assert.equal(deviceMissing.status, 404);
  });
});
