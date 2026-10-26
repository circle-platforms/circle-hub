// Two concurrent submissions with one item and two checks sharing a pure subject builder.
// Count real isolated function invocations rather than asserting a machine-dependent duration.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { ActionBody } from '../../records/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { INDEX } from './store.ts';
import { openHarness, sandboxSkip } from './testing/harness.ts';
import { standardDocument, toyMap } from './testing/mindmap.ts';
import { reviewPack, writePack } from './testing/packs.ts';

const skip = await sandboxSkip();
let postgres: TemporaryPostgres;
before(async () => { postgres = await startPostgres(); });
after(async () => { await postgres?.stop(); });

for (const applies of ['item', 'run'] as const) for (const copyFault of [false, true]) test(`two concurrent one-item submissions build the shared ${applies} subject once each (copy fault ${copyFault})`, { skip }, async () => {
  const h = await openHarness(postgres);
  const root = await mkdtemp(join(tmpdir(), 'circle-hub-shared-subject-'));
  const originalSpawn = childProcess.spawn;
  const originalParse = JSON.parse; let copyFailed = false;
  try {
    const spec = reviewPack(); spec.version = '1.0.1';
    spec.files['requirements.json'] = { json: { schema: 'requirements@1', requirements: [{ ...h.review.requirements[0], checks: ['first', 'second'] }, h.review.requirements[3]] } };
    spec.files['slots.schema.json'] = { json: { schema: 'slots@1', item: {}, run: h.review.slots.run } };
    spec.files['functions/shared-subject.ts'] = `export default input => { let deep=7; for(let i=0;i<4000;i++) deep={next:deep}; return { items: input.items ?? [input.item], deep }; };`;
    spec.files['checks.json'] = { json: { schema: 'checks@1', checks: ['first', 'second'].map(id => ({
      id, applies, interpreter: 'structure@1', table: 'tables/structure.json', judges: 'subject', tier: 'blocking',
      subject: { module: 'functions/shared-subject.ts' },
    })) } };
    const workflow = await h.workflows.add(await writePack(root, spec));
    const document = standardDocument(); document.groups = [{ ...document.groups[0], cases: [document.groups[0].cases[0]] }];
    const source = await h.upload(h.alice, toyMap(document));
    const runs = [];
    for (let i = 0; i < 2; i++) {
      const started = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: source } } }, h.call());
      assert.ok(started.run); assert.equal(started.run.items.length, 1); runs.push(started.run);
    }
    let builds = 0; let checks = 0;
    const readJson = workflow.readJson.bind(workflow);
    workflow.readJson = path => { if (path === 'tables/structure.json') checks++; return readJson(path); };
    childProcess.spawn = ((...args: Parameters<typeof originalSpawn>) => {
      const child = originalSpawn(...args);
      if (child.stdin) {
        const end = child.stdin.end;
        child.stdin.end = function (this: NodeJS.WritableStream, chunk: unknown, ...rest: unknown[]) {
          if (typeof chunk === 'string') {
            try { if (JSON.parse(chunk).entry.endsWith('/functions/shared-subject.ts')) builds++; } catch { /* Non-sandbox subprocess. */ }
          }
          return Reflect.apply(end, this, [chunk, ...rest]);
        } as typeof child.stdin.end;
      }
      return child;
    }) as typeof originalSpawn;
    syncBuiltinESMExports();
    if (copyFault) JSON.parse = ((text: string, ...rest: unknown[]) => {
      if (!copyFailed && text.startsWith('{"items":') && text.includes('"deep":')) {
        copyFailed = true; throw new RangeError('synthetic host copy failure');
      }
      return Reflect.apply(originalParse, JSON, [text, ...rest]);
    }) as typeof JSON.parse;
    const submissions = runs.map(run => ({ run: run.run, model: 'synthetic-model', items: [{ item: run.items[0].id, handling: 'handled', slots: {} }], cross_item: [{ nature: 'judgment', statement: '一般', grounds: [], code: 'draft_level', rank: 'P4' }] }));
    const answers = await Promise.all(submissions.map(args => h.service.submitResult(h.alice, args, h.call())));
    for (const answer of answers) assert.equal(answer.acceptance, 'accepted');
    assert.equal(checks, copyFault ? 3 : 4, 'checks with an available subject execute independently');
    if (copyFault) {
      const claims = answers.flatMap(answer => Object.values(answer.result!.partitions).flat()).flatMap(item => item.requirements).flatMap(requirement => requirement.claims);
      const failed = claims.filter(claim => claim.statement.data?.phase === 'subject_copy');
      assert.equal(failed.length, 1); assert.ok(failed.every(claim => claim.statement.data?.sandbox === undefined));
      assert.ok(failed.every(claim => claim.statement.text.includes('Hub 复制') && !claim.statement.text.includes('包内函数')));
    }
    assert.equal(builds, 2, 'identical subject construction runs once per evaluation, never once per check');
    const repeats = await Promise.all([0, 0, 1, 1].map(index => h.service.submitResult(h.alice, structuredClone(submissions[index]), h.call())));
    for (const [i, answer] of repeats.entries()) {
      const originalIndex=i<2?0:1;
      if(answers[originalIndex].counts!.unknown===0)assert.deepEqual(answer,answers[originalIndex]);
      else {
        assert.equal(answer.counts!.unknown,0,'the original copy fault is gone and the same submission is rechecked');
        assert.ok(!Object.values(answer.result!.partitions).flat().flatMap(item=>item.requirements).flatMap(r=>r.claims).some(c=>c.statement.data?.phase==='subject_copy'));
      }
      assert.equal(JSON.stringify(answer),JSON.stringify(repeats[originalIndex*2]),'settled repeats have identical bytes');
    }
    assert.equal(builds,copyFault?3:2);assert.equal(checks,copyFault?5:4,'only the transitional evaluation is repeated');
    for (const [i,run] of runs.entries()) {
      const rechecked=answers[i].counts!.unknown>0;
      assert.equal((await h.kit.store.find({key:INDEX.submissionRun,value:run.run,kind:'submission'})).items.length,1);
      assert.equal((await h.kit.store.find({key:INDEX.resultRun,value:run.run,kind:'validation_result'})).items.length,rechecked?2:1);
      const actions=(await h.kit.store.find({key:INDEX.actionRun,value:run.run,kind:'action'})).items;
      assert.equal(actions.filter(record=>(record.body as ActionBody).action==='validate'&&(record.body as ActionBody).component==='runs.engine@1').length,rechecked?2:1);
    }
  } finally {
    JSON.parse = originalParse; childProcess.spawn = originalSpawn; syncBuiltinESMExports();
    await h.close(); await rm(root, { recursive: true, force: true });
  }
});
