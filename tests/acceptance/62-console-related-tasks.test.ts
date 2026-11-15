// Related-tasks console page: opens from a real run, uses structured KPI labels, no coined「一轮编译」.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DOCUMENTS } from '../fixtures/agile/index.ts';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { openBed, type Bed } from './support/hub.ts';
import { openConsole, type ConsoleClient } from './support/console.ts';
import type { McpClient } from './support/mcp.ts';
import { startReview } from './support/review.ts';

let postgres: TemporaryPostgres;
let bed: Bed;
let client: McpClient;
let admin: ConsoleClient;

before(async () => {
  postgres = await startPostgres();
  bed = await openBed({ postgres });
  client = await bed.connect(bed.reviewer, 'sess-related-tasks');
  admin = await openConsole(bed.hub, bed.hub.admin.token);
});

after(async () => {
  await bed?.close().catch(() => undefined);
  await postgres?.stop().catch(() => undefined);
});

describe('console related-tasks page', () => {
  it('renders from a run without coined round names or raw src digests', async () => {
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
    assert.match(page.body, /<title>相关任务/);
    assert.doesNotMatch(page.body, /一轮编译|锚点任务|成句函数|Hub 没有/);
    assert.doesNotMatch(page.body, /src:[0-9a-f]{64}/);
    assert.match(page.body, /原始用例 ID|这些相关任务里还没有可读的原始用例/);
    assert.match(page.body, /已确认正确|未确认/);

    const task = await admin.get(`/console/runs/${run.run}?tab=record`);
    assert.equal(task.status, 200);
    assert.match(task.body, /查看相关任务/);
    assert.doesNotMatch(task.body, /本轮编译|查看本轮/);
  });
});
