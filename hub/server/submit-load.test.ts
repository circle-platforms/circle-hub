// Scenario 19's real MCP path: ten concurrent 67-item submissions, with bounded synthetic CPU load.
import assert from 'node:assert/strict';
import {realpathSync} from 'node:fs';
import childProcess from 'node:child_process';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { availableParallelism, loadavg } from 'node:os';
import { Worker } from 'node:worker_threads';
import { test } from 'node:test';
import { startPostgres } from '../testing/postgres.ts';
import { DOCUMENTS } from '../../tests/fixtures/agile/index.ts';
import { openBed } from '../../tests/acceptance/support/hub.ts';
import { draft, resultOf, startReview } from '../../tests/acceptance/support/review.ts';

test('scenario 19 under load completes ten 67-item MCP submissions within the existing 60 seconds', { timeout: 180_000 }, async t => {
  const postgres = await startPostgres();
  let bed: Awaited<ReturnType<typeof openBed>> | undefined;
  const workers: Worker[] = []; const flag = new Int32Array(new SharedArrayBuffer(4));
  const spawn = childProcess.spawn;
  let restoreEngine = () => {};
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  t.after(async () => {
    if (watchdog) clearTimeout(watchdog);
    Atomics.store(flag, 0, 1); await Promise.allSettled(workers.map(worker => worker.terminate()));
    childProcess.spawn = spawn; syncBuiltinESMExports(); restoreEngine();
    await bed?.close(); await postgres.stop();
  });
  bed = await openBed({ postgres });
  const client = await bed.connect(bed.reviewer, 'synthetic-submit-load');
  const runs = [];
  for (let i = 0; i < 10; i++) {
    const run = await startReview(client, { product: bed.product.names[0], version: bed.site.LINE, inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } } });
    assert.equal(run.items.length, 67); runs.push(run);
  }
  const engine = bed.hub.hub.runs;
  const submit = engine.submitResult.bind(engine); const work: Promise<unknown>[] = [];
  engine.submitResult = (...args) => { const result = submit(...args); work.push(result); return result; };
  restoreEngine = () => { engine.submitResult = submit; };
  await bed.hub.hub.knowledge.feeding!.drain();
  const parserDirectories=(await bed.hub.hub.registry.installedSkills()).map(pack=>'--allow-fs-read='+realpathSync(pack.handle.directory));
  let launches = 0,parserLaunches=0;
  childProcess.spawn = ((...args: Parameters<typeof spawn>) => {
    if (args[1]?.some(arg => String(arg).endsWith('/bootstrap.ts'))){if(args[1].some(arg=>parserDirectories.includes(String(arg))))parserLaunches++;else launches++;}
    return spawn(...args);
  }) as typeof spawn; syncBuiltinESMExports();
  const loadWorkers = Math.min(8, Math.max(1, availableParallelism() - 2));
  const ready: Promise<unknown>[] = [];
  for (let i = 0; i < loadWorkers; i++) { const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');const stop=new Int32Array(workerData);parentPort.postMessage('ready');let x=0;while(!Atomics.load(stop,0)){for(let i=0;i<10000;i++)x=(x+Math.sqrt(i+1))%1000000;}`, { eval: true, workerData: flag.buffer, resourceLimits: { maxOldGenerationSizeMb: 32 } }); workers.push(worker); ready.push(once(worker, 'message')); }
  await Promise.all(ready);
  watchdog = setTimeout(() => Atomics.store(flag, 0, 1), 120_000);
  const loadBefore = loadavg(); console.log(JSON.stringify({ phase: 'submit-load-ready', items: 67, submissions: 10, loadWorkers }));
  const started = performance.now(); const completed: number[] = [];
  const answers = await Promise.allSettled(runs.map(async run => {
    try { return await client.call('submit_result', draft(run)); }
    finally { completed.push(performance.now() - started); }
  }));
  // Drain the observed server work even if MCP timed out; do not let abandoned baseline evaluations poison later tests.
  await Promise.allSettled(work);
  t.diagnostic(JSON.stringify({ submissions: 10, items: 67, loadWorkers, loadBefore, loadAfter: loadavg(), submitMs: completed.map(ms => Math.round(ms)), launches,parserLaunches }));
  assert.equal(work.length, 10);
  for (const [index, answer] of answers.entries()) {
    assert.equal(answer.status, 'fulfilled', `submission ${index} exceeded the unchanged MCP deadline or failed`);
    if (answer.status !== 'fulfilled') continue;
    assert.equal(answer.value.isError, false); assert.equal(answer.value.out.acceptance, 'accepted');
    const result = resultOf(answer.value); assert.equal(result.run, runs[index].run);
    assert.equal(result.partitions.delivered.length, 67);
    assert.equal((await bed.hub.records.store.find({ key: 'runs.result.run', value: result.run })).items.length, 1);
  }
  assert.ok(Math.max(...completed) < 60_000, 'submission phase must stay inside the existing MCP timeout');
  // negative_commands adds a second item-check batch and expected_quality_evidence a third; all three command checks still share one commandSubject build.
  assert.ok(parserLaunches<=10*3,`format parsing must stay per document, not per item: ${parserLaunches}`);
  // level_consistency and review_scope add one run check each, and reviewScopeSubject adds one run-subject build, so the six existing calls become nine.
  assert.equal(launches, 10 * 9, 'the existing six calls plus level_consistency and the reviewScopeSubject/reviewScopeCheck pair per submission');
});
