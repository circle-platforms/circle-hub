// Scenario 9 (brief section 9): Connectors: a route outside the allow-list is refused;
// an expired token logs in once and a second failure stops; originals are stored by SHA-256.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { SystemProfile } from '../../contracts/src/resources.ts';
import { ConnectorError } from '../../hub/connectors/errors.ts';
import { HttpSource } from '../../hub/connectors/http.ts';
import { plmSystem } from '../../hub/connectors/testing/packs.ts';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { DOCUMENTS } from '../fixtures/agile/index.ts';
import { openConsole, type ConsoleClient } from './support/console.ts';
import { openBed, type Bed } from './support/hub.ts';

let postgres: TemporaryPostgres;
let bed: Bed;
let consoleClient: ConsoleClient;

before(async () => {
  postgres = await startPostgres();
  bed = await openBed({ postgres });
  consoleClient = await openConsole(bed.hub, bed.hub.admin.token);
});
after(async () => {
  await bed?.close();
  await postgres?.stop();
});

describe('scenario 9: connectors allow-list, login retry and sha256 storage', () => {
  test('originals are stored by SHA-256', async () => {
    const readResult = await bed.hub.hub.external.read(`agile:mindmap:${DOCUMENTS.review}`, {
      principal: bed.reviewer.principal,
      purpose: 'acceptance-test',
    });
    assert.equal(readResult.ok, true, readResult.ok ? '' : readResult.reason);

    assert.ok(readResult.artifacts.length > 0, 'read returned source artifacts');
    const original = readResult.artifacts.find((a) => a.name === 'original');
    assert.ok(original, 'contains an original artifact');

    for (const art of readResult.artifacts) {
      const sha256 = art.artifact.body.sha256;
      assert.match(sha256, /^[0-9a-f]{64}$/, 'artifact has sha256');
      const bytes = await bed.hub.records.objects.get(sha256);
      assert.ok(bytes !== null, 'object exists in content-addressed object store');
      assert.equal(bytes.length, art.artifact.body.size, 'stored bytes length matches artifact size');
    }
  });

  test('a route outside the allow-list is refused before any network request', async () => {
    const profile = SystemProfile.parse(plmSystem());
    const source = new HttpSource({
      resource: bed.resources.plm?.id ?? 'res_test_plm',
      origins: { 'plm-api': bed.plmStub.origin, 'plm-oauth': bed.hub.stubs!.agile.origin },
      allowPlaintext: [bed.plmStub.origin],
      routes: profile.routes,
      envelope: profile.envelope,
    });

    // Unallowlisted route (POST /plmquery/testtask/edit/ or invalid method/path) is refused by allow-list
    const writesBefore = bed.plmWrites();
    await assert.rejects(
      source.request({
        method: 'POST',
        path: '/plmquery/testtask/edit/',
        query: {},
        body: { id: 1 },
      }),
      (err: unknown) => err instanceof ConnectorError && err.code === 'ROUTE_REFUSED',
      'route outside allow-list throws ROUTE_REFUSED',
    );
    assert.equal(bed.plmWrites(), writesBefore, 'no write reached the external server');
  });

  test('an expired token logs in once; a second failure stops', async () => {
    const agileStub = bed.hub.stubs!.agile;
    const initialLogins = agileStub.logins;

    // 1. Expired token triggers re-login once, then request completes
    agileStub.expireTokens();
    const readAfterExpiry = await bed.hub.hub.external.read(`agile:mindmap:${DOCUMENTS.review}`, {
      principal: bed.reviewer.principal,
      purpose: 'test-renewal',
    });
    assert.equal(readAfterExpiry.ok, true);
    assert.equal(agileStub.logins, initialLogins + 1, 'logged in once after token expiry');

    // 2. A subsequent failure (e.g. wrong password) stops the connector and never retries in a loop
    agileStub.setPassword('ChangedWrongPass123');
    agileStub.expireTokens();

    const failedRead = await bed.hub.hub.external.read(`agile:mindmap:${DOCUMENTS.review}`, {
      principal: bed.reviewer.principal,
      purpose: 'test-stop',
    });
    assert.equal(failedRead.ok, false);
    assert.match(failedRead.reason, /LOGIN_FAILED/);
    const loginsAfterFailure = agileStub.logins;

    // Subsequent reads are stopped: no further login attempts are sent
    for (let i = 0; i < 3; i++) {
      const stoppedRead = await bed.hub.hub.external.read(`agile:mindmap:${DOCUMENTS.review}`, {
        principal: bed.reviewer.principal,
        purpose: 'test-stopped-check',
      });
      assert.equal(stoppedRead.ok, false);
      assert.match(stoppedRead.reason, /停止/);
    }
    assert.equal(agileStub.logins, loginsAfterFailure, 'stopped connector sends no further login attempts');

    const status = await bed.hub.hub.connectors.admin.loginStatus(bed.hub.admin.principal, bed.resources.agile.id);
    assert.equal(status?.stopped, true, 'login status is stopped');

    // Reset login for cleanup
    await bed.hub.hub.connectors.admin.resetLogin(bed.hub.admin.principal, bed.resources.agile.id);
  });
});
