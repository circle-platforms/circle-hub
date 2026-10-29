// Scenario 19's real MCP path: ten concurrent 67-item submissions, with bounded synthetic CPU load.
//
// Whether ten such submissions fit an MCP client's request deadline (the SDK's default is 60 s) depends on what one
// submission costs and on whether the ten run side by side. Both are checked here without a stopwatch, so the test says
// the same on a fast machine and on a crowded runner:
// - a submission costs a fixed number of sandbox launches, one batch per per-item check rather than one launch per item
//   (per-item launches once took ten submissions to 47-49 s), and its format parsing is per document, not per item;
// - all ten reach the run engine before the first one is answered, so one session's calls are not queued behind each other;
// - the Hub, which runs in this process, spends at most 2 x 10 times the CPU time on the ten together that it spends on one
//   submission timed alone under the same load. CPU time leaves out the time a thread waits for a core.
// Their wall-clock time measured the runner as much as the code: with unchanged code the last of the ten answered after
// 26-49 s on the 4-core Ubuntu runner and 13 s on a 10-core machine, and after 60 s on a saturated runner. CEILING_MS only
// catches a hang or a gross regression.
import assert from 'node:assert/strict';
import {realpathSync} from 'node:fs';
import childProcess from 'node:child_process';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { availableParallelism, loadavg } from 'node:os';
import { Worker } from 'node:worker_threads';
import { test } from 'node:test';
import { startPostgres } from '../testing/postgres.ts';
import type { ToolCallResult } from './testing-real.ts';
import { DOCUMENTS } from '../../tests/fixtures/agile/index.ts';
import { openBed } from '../../tests/acceptance/support/hub.ts';
import { checkAnswer } from '../../tests/acceptance/support/mcp.ts';
import { draft, resultOf, startReview } from '../../tests/acceptance/support/review.ts';

const SUBMISSIONS = 10;
const ITEMS = 67;
// level_consistency and review_scope add one run check each, and reviewScopeSubject adds one run-subject build, so the
// six existing calls of a submission become nine.
const LAUNCHES = 9;
// negative_commands adds a second item-check batch and expected_quality_evidence a third; all three command checks still
// share one commandSubject build.
const PARSES = 3;
// Request timeout of each submission: three times the SDK's default deadline. The slowest passing CI run of the ten took 49 s.
const CEILING_MS = 180_000;

test('scenario 19 under load: ten 67-item MCP submissions each launch a fixed number of sandboxes and run side by side', { timeout: 480_000 }, async t => {
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
  const submitter = await bed.hub.client(bed.reviewer.token, { sessionId: 'synthetic-submit-load' });
  // One run is submitted alone first, as the baseline; the other ten together.
  const runs: Awaited<ReturnType<typeof startReview>>[] = [];
  for (let i = 0; i <= SUBMISSIONS; i++) {
    const run = await startReview(client, { product: bed.product.names[0], version: bed.site.LINE, inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } } });
    assert.equal(run.items.length, ITEMS); runs.push(run);
  }
  const engine = bed.hub.hub.runs;
  const submit = engine.submitResult.bind(engine); let served: Promise<[number, number]>[] = [];
  engine.submitResult = (...args) => {
    const began = performance.now(), result = submit(...args);
    served.push(result.then(() => [began, performance.now()], () => [began, performance.now()]));
    return result;
  };
  restoreEngine = () => { engine.submitResult = submit; };
  await bed.hub.hub.knowledge.feeding!.drain();
  const parserDirectories=(await bed.hub.hub.registry.installedSkills()).map(pack=>'--allow-fs-read='+realpathSync(pack.handle.directory));
  let launches = 0,parserLaunches=0,stopped=0;
  childProcess.spawn = ((...args: Parameters<typeof spawn>) => {
    const child = spawn(...args);
    if (args[1]?.some(arg => String(arg).endsWith('/bootstrap.ts'))){
      if(args[1].some(arg=>parserDirectories.includes(String(arg))))parserLaunches++;
      else { launches++; child.once('exit', (_code, signal) => { if (signal !== null) stopped++; }); }
    }
    return child;
  }) as typeof spawn; syncBuiltinESMExports();
  const loadWorkers = Math.min(8, Math.max(1, availableParallelism() - 2));
  const ready: Promise<unknown>[] = [];
  for (let i = 0; i < loadWorkers; i++) { const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');const stop=new Int32Array(workerData);parentPort.postMessage('ready');let x=0;while(!Atomics.load(stop,0)){for(let i=0;i<10000;i++)x=(x+Math.sqrt(i+1))%1000000;}`, { eval: true, workerData: flag.buffer, resourceLimits: { maxOldGenerationSizeMb: 32 } }); workers.push(worker); ready.push(once(worker, 'message')); }
  await Promise.all(ready);
  watchdog = setTimeout(() => Atomics.store(flag, 0, 1), 2 * CEILING_MS + 60_000);
  const loadBefore = loadavg(); console.log(JSON.stringify({ phase: 'submit-load-ready', items: ITEMS, submissions: SUBMISSIONS, loadWorkers }));

  /** Submits the runs at once; returns the answers, the server-side spans and the Hub's CPU time and launches meanwhile. */
  const submitAll = async (batch: typeof runs) => {
    served = []; const launched = launches, parsed = parserLaunches, killed = stopped, cpu = process.threadCpuUsage(), started = performance.now(); const completed: number[] = [];
    const answers = await Promise.allSettled(batch.map(async run => {
      try { return checkAnswer('submit_result', await submitter.client.callTool({ name: 'submit_result', arguments: draft(run) }, undefined, { timeout: CEILING_MS }) as unknown as ToolCallResult); }
      finally { completed.push(performance.now() - started); }
    }));
    // Drain the observed server work even if a call timed out; do not let abandoned evaluations poison later tests.
    const spans = await Promise.all(served), used = process.threadCpuUsage(cpu);
    return { answers, spans, completed, cpuMs: (used.user + used.system) / 1000, launches: launches - launched, stopped: stopped - killed, parserLaunches: parserLaunches - parsed };
  };
  const alone = await submitAll(runs.slice(0, 1)), together = await submitAll(runs.slice(1));

  const ratio = together.cpuMs / alone.cpuMs;
  const firstEnd = Math.min(...together.spans.map(([, end]) => end)), lastStart = Math.max(...together.spans.map(([start]) => start));
  t.diagnostic(JSON.stringify({ submissions: SUBMISSIONS, items: ITEMS, loadWorkers, loadBefore, loadAfter: loadavg(),
    aloneMs: alone.completed.map(ms => Math.round(ms)), submitMs: together.completed.map(ms => Math.round(ms)),
    cpuMs: { alone: Math.round(alone.cpuMs), together: Math.round(together.cpuMs), ratio: Number(ratio.toFixed(2)) },
    launches: { alone: alone.launches, together: together.launches }, stopped: { alone: alone.stopped, together: together.stopped }, parserLaunches: { alone: alone.parserLaunches, together: together.parserLaunches },
    lastStartMs: Math.round(lastStart - Math.min(...together.spans.map(([start]) => start))), firstEndMs: Math.round(firstEnd - Math.min(...together.spans.map(([start]) => start))) }));

  for (const [phase, batch] of [[alone, runs.slice(0, 1)], [together, runs.slice(1)]] as const) {
    assert.equal(phase.spans.length, batch.length);
    for (const [index, answer] of phase.answers.entries()) {
      assert.equal(answer.status, 'fulfilled', `submission ${index} of ${batch.length} failed or exceeded the ${CEILING_MS} ms ceiling`);
      if (answer.status !== 'fulfilled') continue;
      assert.equal(answer.value.isError, false); assert.equal(answer.value.out.acceptance, 'accepted');
      const result = resultOf(answer.value); assert.equal(result.run, batch[index].run);
      assert.equal(result.partitions.delivered.length, ITEMS);
      assert.equal((await bed.hub.records.store.find({ key: 'runs.result.run', value: result.run })).items.length, 1);
    }
  }
  // A child the Hub stops at a wall-clock or observation cap (a saturated machine: its time limit, or a resident-memory
  // reading that does not come back in time) is retried once or, for a batch, replaced by one call per item. Only then may
  // a phase launch more, and each stopped child at most ITEMS more; with nothing stopped the count is exact.
  for (const [phase, submissions] of [[alone, 1], [together, SUBMISSIONS]] as const) {
    const expected = submissions * LAUNCHES, label = `${submissions} submission(s): nine launches each, not one per item; ${phase.stopped} stopped by the Hub`;
    if (phase.stopped === 0) assert.equal(phase.launches, expected, label);
    else assert.ok(phase.launches >= expected && phase.launches <= expected + phase.stopped * ITEMS, `${label}: ${phase.launches} launches`);
  }
  assert.ok(alone.parserLaunches <= PARSES && together.parserLaunches <= SUBMISSIONS * PARSES, `format parsing must stay per document, not per item: ${alone.parserLaunches}, ${together.parserLaunches}`);
  assert.ok(lastStart < firstEnd, `every submission must reach the run engine before the first one is answered; the last came ${Math.round(lastStart - firstEnd)} ms after`);
  assert.ok(ratio <= 2 * SUBMISSIONS, `the Hub's CPU time for ${SUBMISSIONS} submissions together was ${ratio.toFixed(1)} times that of one alone (limit ${2 * SUBMISSIONS})`);
});
