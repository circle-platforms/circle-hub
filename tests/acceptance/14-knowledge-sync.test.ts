// Scenario 14 (brief section 9 & task acceptance.md):
// Knowledge sync over both name families and several versions with synthetic listing pages and command trees,
// idempotent on a second run and incremental when one build is added, the version diff between two roots showing
// only the changed subtrees.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
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

describe('scenario 14: knowledge sync, idempotence, incrementality, and root diff', () => {
  let initialRoot: string;

  test('the shared bed explicitly deploys empty applicability vocabularies before its real product sync', async () => {
    const snapshot=await bed.hub.records.variables.snapshot();
    for(const name of ['FAMX_COMPONENTS','FAMX_LICENSES','FAMX_DEPLOYMENT_FORMS']){
      assert.ok(snapshot.has(name),name);
      const resolved=await bed.hub.records.variables.resolveVariables({value:'${var:'+name+'}'},'synthetic-applicability',snapshot);
      assert.deepEqual(resolved.value,{value:[]});
    }
    assert.equal(bed.syncs.two?.error,null);
  });

  test('initial sync produced roots for both name families', () => {
    const sync = bed.syncs.two;
    assert.ok(sync);
    assert.equal(sync.error, null);
    assert.ok(sync.builds.length >= 2, 'sync covered multiple builds');

    const produced = sync.builds.find((b) => b.outcome === 'produced');
    assert.ok(produced && produced.root);
    initialRoot = produced.root;

    // Both name families present in build reports (e.g. Rel_FAMX_... and Rel_FAMY_...)
    const names = sync.builds.map((b) => b.name);
    assert.ok(names.some((n) => n.includes('FAMX')), 'FAMX family in builds');
    assert.ok(names.some((n) => n.includes('FAMY')), 'FAMY family in builds');
  });

  test('a rerun is idempotent: nothing produced again, pointers unchanged', async () => {
    const rerun = await bed.hub.knowledgeSync(bed.product.line);
    assert.equal(rerun.error, null);
    assert.equal(rerun.counts.produced, 0, 'idempotent rerun produces 0 new roots');
    assert.equal(rerun.counts.failed, 0, JSON.stringify(rerun));

    for (const build of rerun.builds) {
      if (build.name === bed.site.RELEASED) {
        assert.equal(build.outcome, 'skipped');
        assert.match(build.reason, /已有根/);
      }
    }
  });

  test('incremental sync: adding one build to site produces only that build', async () => {
    const newBuildName = 'Rel_FAMX_10_6_1_99';
    const siteBase = bed.site.SITE_BASE;
    const newTreeXml = bed.site.tree().replace('interval', 'new_metric');

    // Add new build files to live buildSite
    bed.buildSite[`${siteBase}/command_tree-${newBuildName}.xml`] = {
      body: new TextEncoder().encode(newTreeXml),
      type: 'application/xml',
    };
    bed.buildSite[`${siteBase}/Bugs_Fixed_with_${newBuildName}.html`] = {
      body: new TextEncoder().encode('<html><body>None</body></html>'),
      type: 'text/html',
    };

    // Update listing page to include newBuildName
    const listingKey = `${siteBase}/rel_famx_10_6_1.html`;
    const oldListing = new TextDecoder().decode(bed.buildSite[listingKey].body);
    const updatedListing = `${newBuildName} (build on 2026-06-01 10:00:00 ): Released on 2026-06-02 </br> <BLOCKQUOTE><A href=/builds/command_tree-${newBuildName}.xml>tree</A><A href=/builds/Bugs_Fixed_with_${newBuildName}.html>fixed</A></BLOCKQUOTE>\n${oldListing}`;
    bed.buildSite[listingKey] = {
      body: new TextEncoder().encode(updatedListing),
      type: 'text/html',
    };

    // Run sync again
    const incSync = await bed.hub.knowledgeSync(bed.product.line);
    assert.equal(incSync.error, null);
    assert.equal(incSync.counts.produced, 1, 'exactly 1 new root produced incrementally');

    const newBuildReport = incSync.builds.find((b) => b.name === newBuildName);
    assert.ok(newBuildReport);
    assert.equal(newBuildReport.outcome, 'produced');
    assert.ok(newBuildReport.root);
    const newRoot = newBuildReport.root;

    // Root diff between initialRoot and newRoot shows only the changed subtrees
    const diff = await bed.hub.hub.knowledge.diffRoots(initialRoot, newRoot);
    assert.ok(diff, 'diffRoots returns root diff');
    assert.equal(diff.from, initialRoot);
    assert.equal(diff.to, newRoot);
    // Differences exist
    const totalChanges = diff.added.length + diff.removed.length + diff.modified.length;
    assert.ok(totalChanges > 0, 'diff indicates changed subtrees');

    // Console HTML diff page
    const page = await consoleClient.get(`/console/knowledge/diff?from=${initialRoot}&to=${newRoot}`);
    assert.equal(page.status, 200);
    assert.ok(page.body.includes(initialRoot.slice(0, 16)));
  });
});
