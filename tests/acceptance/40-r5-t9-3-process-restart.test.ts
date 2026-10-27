// T9-3: a device job is already in flight, the Hub process object is closed and started again, the stored result
// bytes stay, and the late report continues on the new process without another send.
// Addresses and the executor stay synthetic. The first service is the in-process stand-in that wrote the job;
// the restarted object is a new Hub assembly on the same records.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { DispatchService } from '../../hub/dispatch/service.ts';
import { setup } from '../../hub/dispatch/testing/context.ts';
import { createApp } from '../../hub/server/app.ts';
import { assembleHub } from '../../hub/server/assemble/hub.ts';

test('restarting the hub process continues a pending device report and keeps the stored result', async (t) => {
  let ready = false;
  const c = await setup({
    alter: (name, value) => {
      if (name !== 'read_blob') return value;
      const complete = ready;
      return {
        ...value,
        ownership: 'staging_directory',
        complete,
        rows: [{ id: 'synthetic-case', outcome: complete ? 'good' : 'unreported', log: 'CHECK_ONE_PASS\nSYNTHETIC_END', stale: false }],
      };
    },
  });
  t.after(() => c.close());
  const certification = await c.kit.artifacts.ingest({
    bytes: Buffer.from('synthetic ownership certification'),
    mediaType: 'text/plain',
    origin: { upload: { session: 'synthetic' } },
    author: { user: c.admin.id },
    provenanceType: 'declared',
    visibility: { readers: [c.admin.id], admins: true, packs: [], shareable: false },
  });
  await c.registry.update(c.admin, c.executor.id, {
    ...c.executor.definition,
    premises: { result_ownership: { version: '1', evidence: [`src:${certification.body.sha256}`] } },
    result: {
      ...c.executor.definition.result,
      ownership: { pointer: '/ownership', value: 'staging_directory', reason: '/ownership_reason' },
      request_id: '/request',
      log: '/log',
      log_stale: '/stale',
      closing_marker: 'SYNTHETIC_END',
    },
  });
  await c.freezeExecutor();
  const quiet = { ...c.service.options, sleep: async () => {} };
  const first = new DispatchService(quiet);
  const pending = await first.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(pending.report_pending, true);
  assert.ok(pending.result);
  const stored = Buffer.from((await c.kit.objects.get(pending.result.slice(4)))!);
  const config = {
    dataDir: c.kit.dataDir,
    logDir: join(c.kit.dataDir, 'logs'),
    host: '127.0.0.1',
    port: 0,
    database: c.kit.database,
    keychain: { service: 'circle-hub-test', account: 'vault' },
    limits: { ...c.kit.config.limits },
  };
  const restarted = await assembleHub(config, c.kit, {
    requireOsIsolation: false,
    requireVaultKey: false,
    resourceCacheMs: 0,
    extractDir: join(c.kit.dataDir, 'extracted'),
  });
  const app = createApp(restarted.deps, { codeRoot: c.kit.dataDir, closeTimeoutMs: 5000 });
  await app.listen();
  try {
    assert.ok(restarted.dispatch);
    ready = true;
    const continued = await restarted.dispatch.resume(c.admin, pending.job);
    assert.deepEqual(Buffer.from((await c.kit.objects.get(pending.result.slice(4)))!), stored);
    assert.equal(c.calls.filter((name) => name === 'send_blob').length, 1);
    assert.equal(continued.report_pending, undefined);
    const source = await c.kit.artifacts.source(c.admin, continued.result!.slice(4));
    assert.ok(source?.bytes);
    const report = JSON.parse(Buffer.from(source.bytes).toString()) as { rows: Array<{ dynamic_terminal: string }> };
    assert.equal(report.rows[0]?.dynamic_terminal, 'pass');
  } finally {
    await app.close();
  }
});
