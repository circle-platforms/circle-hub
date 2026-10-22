// Scenario 11 (brief section 9): A scripted Jev: no calibrated threshold or a low probability
// leaves the fragment at the parent node, marked uncalibrated.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { TreeRootBody } from '../../contracts/src/knowledge.ts';
import { NONE_OPTION, SCRIPTED_MODEL, ScriptedJev, type ScriptedAnswer } from '../../hub/jev/api.ts';
import { PLACEMENT_CHAIN } from '../../hub/knowledge/calibration.ts';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { openConsole, type ConsoleClient } from './support/console.ts';
import { openBed, type Bed } from './support/hub.ts';

let postgres: TemporaryPostgres;
let bed: Bed;
let consoleClient: ConsoleClient;

// Jev judge that answers a specific choice but with low probability or uncalibrated
const scriptedJudge: ScriptedAnswer = (question, state, id) => {
  if (question.type !== 'choice') return { noul: 0.5 };
  const hit = Object.keys(question.criteria).find((k) => k !== NONE_OPTION);
  if (!hit) return { choice: NONE_OPTION, p: 0.9 };
  // Low probability under 0.7
  return { choice: hit, p: 0.65 };
};

before(async () => {
  postgres = await startPostgres();
  // Open bed without calibration samples so the placement chain is uncalibrated
  const jev = new ScriptedJev(scriptedJudge);
  bed = await openBed({ postgres, jev, syncTwoName: true, syncOneName: false });
  consoleClient = await openConsole(bed.hub, bed.hub.admin.token);
});
after(async () => {
  await bed?.close();
  await postgres?.stop();
});

describe('scenario 11: scripted jev calibration and placement', () => {
  test('an uncalibrated chain leaves fragments at the parent node, marked uncalibrated', async () => {
    // 1. Calibration threshold is null (uncalibrated)
    const threshold = await bed.hub.hub.knowledge.calibration.threshold(PLACEMENT_CHAIN, SCRIPTED_MODEL);
    assert.equal(threshold, null, 'placement chain threshold is null without calibration');

    // 2. Inspect the composition produced during syncTwoName
    const sync = bed.syncs.two;
    assert.ok(sync && sync.builds.length > 0);
    const produced = sync.builds.find((b) => b.outcome === 'produced');
    assert.ok(produced && produced.composition);

    const compRecord = await bed.hub.records.store.get(produced.composition);
    assert.ok(compRecord);
    const body = TreeRootBody.parse(compRecord.body);

    // If any unplaced rows exist with candidates, they must be marked calibrated: false and stopped at parent
    for (const unplaced of body.unplaced) {
      if (unplaced.candidate !== null) {
        assert.equal(unplaced.candidate.calibrated, false, 'candidate is flagged calibrated: false');
        assert.ok(unplaced.note.includes('未校准') || unplaced.note.includes('尚未校准'));
      }
    }

    // 3. Console tree inspection: tree is queryable over MCP / console
    const treePage = await consoleClient.get(`/console/knowledge/tree?root=${produced.root}&path=/`);
    assert.equal(treePage.status, 200);
    assert.ok(treePage.body.includes(produced.root!.slice(0, 16)));
  });
});
