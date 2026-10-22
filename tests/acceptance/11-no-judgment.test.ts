// Scenario 11 (owner decision 2026-10-22, docs/hub-r4-tasks/no-judgment-in-hub.md): the Hub calls no model. The
// production assembly has no placer: entries the code cannot place stay at the root, marked unplaced, with no
// judgment and no model candidate; the production records placement.spans 0; the report carries no judgment-service
// wording. The knowledge tree stays queryable over the console.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { TreeRootBody } from '../../contracts/src/knowledge.ts';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { openConsole, type ConsoleClient } from './support/console.ts';
import { openBed, type Bed } from './support/hub.ts';

let postgres: TemporaryPostgres;
let bed: Bed;
let consoleClient: ConsoleClient;

before(async () => {
  postgres = await startPostgres();
  bed = await openBed({ postgres, syncTwoName: true, syncOneName: false });
  consoleClient = await openConsole(bed.hub, bed.hub.admin.token);
});
after(async () => {
  await bed?.close();
  await postgres?.stop();
});

describe('scenario 11: no judgment in the hub; path-less entries stay unplaced at the root', () => {
  test('the assembly has no placer and the produced roots mark every path-less entry unplaced at the root', async () => {
    assert.equal(bed.hub.hub.knowledge.placement.model, null, 'no placer in the production assembly');
    const sync = bed.syncs.two;
    assert.ok(sync && sync.builds.length > 0);
    const produced = sync.builds.filter((build) => build.outcome === 'produced');
    assert.ok(produced.length > 0, 'at least one build was produced');
    let unplacedSeen = 0;
    for (const build of produced) {
      assert.doesNotMatch(build.reason, /判断服务|模型归类/, `no judgment-service wording in the report of ${build.name}`);
      const action = await bed.hub.hub.knowledge.store.latestProduction(sync.product, build.name);
      assert.ok(action !== null, `the production of ${build.name} is recorded`);
      assert.equal(action.detail.placement?.spans ?? 0, 0, 'no span was handed to any judge');
      const compRecord = await bed.hub.records.store.get(build.composition as string);
      assert.ok(compRecord, 'the composition record exists');
      const body = TreeRootBody.parse(compRecord.body);
      unplacedSeen += body.unplaced.length;
      for (const row of body.unplaced) {
        assert.equal(row.stopped_at, '/', 'stays at the root');
        assert.deepEqual(row.judgments, [], 'no judgment');
        assert.equal(row.candidate, null, 'no model candidate');
        assert.match(row.note, /未归位/, 'marked unplaced');
      }
    }
    assert.ok(unplacedSeen > 0, 'the product emits path-less entries, so the marking is exercised');
  });

  test('the produced root stays queryable over the console tree page', async () => {
    const produced = bed.syncs.two?.builds.find((build) => build.outcome === 'produced' && build.root !== null);
    assert.ok(produced?.root);
    const treePage = await consoleClient.get(`/console/knowledge/tree?root=${produced.root}&path=/`);
    assert.equal(treePage.status, 200);
    assert.ok(treePage.body.includes(produced.root.slice(0, 16)));
  });
});
