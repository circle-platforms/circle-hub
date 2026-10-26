// Scenario 17 (brief section 9 & task acceptance.md):
// Restart: stop the Hub process object, start a new one on the same data, previous runs and results are intact.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { RunSummary } from '../../contracts/src/run.ts';
import { createApp } from '../../hub/server/app.ts';
import { assembleHub } from '../../hub/server/assemble/hub.ts';
import { type ToolCallResult } from '../../hub/server/testing-real.ts';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { DOCUMENTS } from '../fixtures/agile/index.ts';
import { openConsole, type ConsoleClient } from './support/console.ts';
import { openBed, type Bed } from './support/hub.ts';
import { checkAnswer, type McpClient } from './support/mcp.ts';
import { draft, resultOf, startReview } from './support/review.ts';

let postgres: TemporaryPostgres;
let bed: Bed;
let client1: McpClient;
let consoleClient: ConsoleClient;

before(async () => {
  postgres = await startPostgres();
  bed = await openBed({ postgres });
  client1 = await bed.connect(bed.reviewer, 'sess-s17-before');
  consoleClient = await openConsole(bed.hub, bed.reviewer.token);
});
after(async () => {
  await bed?.close().catch(() => {});
  await postgres?.stop().catch(() => {});
});

describe('scenario 17: hub process restart preserves runs and results', () => {
  let run1: RunSummary;
  let resultDigest: string;

  test('before restart: start a review run and submit result to completion', async () => {
    run1 = await startReview(client1, {
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } },
    });
    assert.ok(run1.run);

    const submission = draft(run1);
    const answer = await client1.call('submit_result', submission);
    assert.equal(answer.isError, false);
    assert.equal(answer.out.acceptance, 'accepted');

    const result = resultOf(answer);
    assert.equal(result.partitions.delivered.length, run1.items.length);

    // Stored validation result
    const stored = await bed.hub.records.store.find({ key: 'runs.result.run', value: run1.run });
    assert.equal(stored.items.length, 1);
    resultDigest = stored.items[0].digest;
  });

  test('stop the Hub process object, start a new one on the same data; runs and results are intact', async () => {
    // 1. Close first client and stop the initial Hub process object
    await client1.close().catch(() => {});
    await bed.hub.app.close();

    // 2. Start a fresh Hub assembly and app on the EXACT same records (same postgres database and vault)
    const config = {
      dataDir: bed.hub.records.dataDir,
      logDir: `${bed.hub.records.dataDir}/logs`,
      host: '127.0.0.1',
      port: 0,
      database: bed.hub.records.database,
      keychain: { service: 'circle-hub-test', account: 'vault' },
      limits: { ...bed.hub.records.config.limits },
    };

    const reassembledHub = await assembleHub(config, bed.hub.records, {
      requireOsIsolation: false,
      requireVaultKey: false,
      resourceCacheMs: 0,
      extractDir: `${bed.hub.records.dataDir}/extracted`,
    });

    const restartedApp = createApp(reassembledHub.deps, {
      codeRoot: bed.hub.records.dataDir,
      closeTimeoutMs: 5000,
    });
    const info = await restartedApp.listen();

    // 3. Connect a new MCP client to the restarted Hub process on its new port
    const transport = new StreamableHTTPClientTransport(new URL(`http://${info.host}:${info.port}/mcp`), {
      requestInit: {
        headers: {
          authorization: `Bearer ${bed.reviewer.token}`,
          'circle-session-id': 'sess-s17-after',
        },
      },
    });
    const mcpSdkClient = new Client({ name: 'hub-client-restart-test', version: '1.0.0' });
    await mcpSdkClient.connect(transport);
    await mcpSdkClient.listTools();

    const client2: McpClient = {
      async call(name, args) {
        const raw = (await mcpSdkClient.callTool({ name, arguments: args })) as unknown as ToolCallResult;
        return checkAnswer(name, raw);
      },
      async upload(bytes, name, mediaType = 'application/json') {
        const answer = await client2.call('upload_file', {
          file_path: Buffer.from(bytes).toString('base64'),
          name,
          media_type: mediaType,
        });
        return answer.out.reference!;
      },
      close: () => mcpSdkClient.close(),
    };

    try {
      // 4. Verify previous runs and results are completely intact
      const runDetail = await reassembledHub.runs.getRun(bed.reviewer.principal, run1.run);
      assert.ok(runDetail, 'previous run is intact after restart');
      assert.equal(runDetail.run.run, run1.run);
      assert.equal(runDetail.submissions.length, 1);
      assert.equal(runDetail.submissions[0].acceptance, 'accepted');
      assert.equal(runDetail.latest?.record, resultDigest, 'latest result record digest matches');

      // Verify reading result by reference through MCP get_nodes on the restarted server
      const readResult = await client2.call('get_nodes', { reference: `rec:${resultDigest}` });
      assert.equal(readResult.isError, false);
      assert.ok(readResult.text.includes(run1.run) || readResult.text.includes('已交付'));

      // Console on restarted Hub
      const reconnectedConsole = await openConsole(
        {
          ...bed.hub,
          port: info.port,
          app: restartedApp,
        },
        bed.reviewer.token,
      );
      const page = await reconnectedConsole.get(`/console/runs/${run1.run}`);
      assert.equal(page.status, 200);
      assert.ok(page.body.includes(run1.run));
    } finally {
      await client2.close().catch(() => {});
      await restartedApp.close().catch(() => {});
    }
  });
});
