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

for (const applies of ['item', 'run'] as const) test(`two concurrent one-item submissions build the shared ${applies} subject once each and retain both checks`, { skip }, async () => {
  const h = await openHarness(postgres);
  const root = await mkdtemp(join(tmpdir(), 'circle-hub-shared-subject-'));
  const originalSpawn = childProcess.spawn;
  try {
    const spec = reviewPack(); spec.version = '1.0.1';
    spec.files['requirements.json'] = { json: { schema: 'requirements@1', requirements: [{ ...h.review.requirements[0], checks: ['first', 'second'] }, h.review.requirements[3]] } };
    spec.files['slots.schema.json'] = { json: { schema: 'slots@1', item: {}, run: h.review.slots.run } };
    spec.files['functions/shared-subject.ts'] = `export default input => ({ items: input.items ?? [input.item] });`;
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
    const submissions = runs.map(run => ({ run: run.run, model: 'synthetic-model', items: [{ item: run.items[0].id, handling: 'handled', slots: {} }], cross_item: [{ nature: 'judgment', statement: '一般', grounds: [], code: 'draft_level', rank: 'P4' }] }));
    const answers = await Promise.all(submissions.map(args => h.service.submitResult(h.alice, args, h.call())));
    for (const answer of answers) assert.equal(answer.acceptance, 'accepted');
    assert.equal(checks, 4, 'both checks still execute independently in both submissions');
    assert.equal(builds, 2, 'identical subject construction runs once per evaluation, never once per check');
    const repeats = await Promise.all([0, 0, 1, 1].map(index => h.service.submitResult(h.alice, structuredClone(submissions[index]), h.call())));
    for (const [i, answer] of repeats.entries()) {
      assert.deepEqual(answer, answers[i < 2 ? 0 : 1]);
      assert.equal(JSON.stringify(answer), JSON.stringify(answers[i < 2 ? 0 : 1]), 'the repeated receipt bytes are unchanged');
    }
    assert.equal(builds, 2); assert.equal(checks, 4, 'idempotent resubmissions do not rerun checks');
    for (const run of runs) {
      for (const [key, kind] of [[INDEX.submissionRun, 'submission'], [INDEX.resultRun, 'validation_result']] as const) {
        assert.equal((await h.kit.store.find({ key, value: run.run, kind })).items.length, 1);
      }
      const actions = (await h.kit.store.find({ key: INDEX.actionRun, value: run.run, kind: 'action' })).items;
      assert.equal(actions.filter(record => (record.body as ActionBody).action === 'validate').length, 1);
    }
  } finally {
    childProcess.spawn = originalSpawn; syncBuiltinESMExports();
    await h.close(); await rm(root, { recursive: true, force: true });
  }
});
