// A batch of subjects whose outputs together pass the sandbox output limit is halved and built again in batches, down to
// single subjects, instead of one sandbox per subject. Counted by real isolated invocations, not by duration.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { openHarness, sandboxSkip } from './testing/harness.ts';
import { standardDocument, toyMap } from './testing/mindmap.ts';
import { reviewPack, writePack } from './testing/packs.ts';

const skip = await sandboxSkip();
let postgres: TemporaryPostgres;
before(async () => { postgres = await startPostgres(); });
after(async () => { await postgres?.stop(); });

test('a subject batch too large for one answer is halved, not left to one sandbox per subject', { skip }, async () => {
  // Every subject is about 300 KB; four together pass the 1 MiB output limit, two fit.
  const h = await openHarness(postgres, { sandboxLimits: { outputBytes: 1024 * 1024 } });
  const root = await mkdtemp(join(tmpdir(), 'circle-hub-subject-split-'));
  const originalSpawn = childProcess.spawn;
  try {
    const spec = reviewPack(); spec.version = '1.0.2';
    spec.files['requirements.json'] = { json: { schema: 'requirements@1', requirements: [{ ...h.review.requirements[0], checks: ['first'] }, h.review.requirements[3]] } };
    spec.files['slots.schema.json'] = { json: { schema: 'slots@1', item: {}, run: h.review.slots.run } };
    spec.files['functions/large-subject.ts'] = `export default input => ({ item: input.item, filler: 'x'.repeat(300 * 1024) });`;
    spec.files['checks.json'] = { json: { schema: 'checks@1', checks: [{ id: 'first', applies: 'item', interpreter: 'structure@1', table: 'tables/structure.json', judges: 'subject', tier: 'blocking', subject: { module: 'functions/large-subject.ts' } }] } };
    await h.workflows.add(await writePack(root, spec));
    const document = standardDocument();
    const cases = document.groups.flatMap((group) => group.cases).slice(0, 4);
    assert.equal(cases.length, 4, 'the standard document has at least four cases');
    document.groups = [{ ...document.groups[0], cases }];
    const source = await h.upload(h.alice, toyMap(document));
    const started = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: source } } }, h.call());
    assert.ok(started.run); assert.equal(started.run.items.length, 4);
    const sizes: number[] = [];
    childProcess.spawn = ((...args: Parameters<typeof originalSpawn>) => {
      const child = originalSpawn(...args);
      if (child.stdin) {
        const end = child.stdin.end;
        child.stdin.end = function (this: NodeJS.WritableStream, chunk: unknown, ...rest: unknown[]) {
          if (typeof chunk === 'string') {
            try { const request = JSON.parse(chunk); if (request.entry.endsWith('/functions/large-subject.ts')) sizes.push(Array.isArray(request.input) && request.batch === true ? request.input.length : 1); } catch { /* Non-sandbox subprocess. */ }
          }
          return Reflect.apply(end, this, [chunk, ...rest]);
        } as typeof child.stdin.end;
      }
      return child;
    }) as typeof originalSpawn;
    syncBuiltinESMExports();
    const answer = await h.service.submitResult(h.alice, { run: started.run.run, model: 'synthetic-model', items: started.run.items.map((item) => ({ item: item.id, handling: 'handled', slots: {} })), cross_item: [{ nature: 'judgment', statement: '一般', grounds: [], code: 'draft_level', rank: 'P4' }] }, h.call());
    assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors ?? []).slice(0, 400));
    assert.equal(sizes.length, 3, `one batch of four that is too large, then two batches of two: ${JSON.stringify(sizes)}`);
  } finally {
    childProcess.spawn = originalSpawn; syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true }); await h.close();
  }
});
