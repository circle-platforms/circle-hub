import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
const app = process.env.CIRCLE_HUB_REPLAY_CIRCLE_APP;
test('installed Circle 1.17 discovers all four named roles and enforces each tool list before any knowledge refresh', { skip: app === undefined ? '需要显式指定已安装 Circle 的 CIRCLE_HUB_REPLAY_CIRCLE_APP' : false, timeout: 120_000 }, async () => {
  const worker = new Worker(new URL('../testing/named-agent-runtime.worker.ts', import.meta.url), { workerData: { app }, env: { CIRCLE_NO_MODELS_REFRESH: '1', CIRCLE_NO_UPDATE_CHECK: '1' }, execArgv: [] });
  try {
    const reply = await new Promise<any>((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); worker.once('exit', code => { if (code) reject(new Error('runtime worker exited')); }); });
    assert.equal(reply.error, undefined, reply.error); assert.equal(reply.roles, 4);
  } finally { await worker.terminate(); }
});
