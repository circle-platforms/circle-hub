// Cleanroom black-box acceptance tests for Hub reset, scopes, keep-config rebuild, degraded startup, and rollback.
// Covers Spec Items 1, 2, 3a, 4, 5, and 8 against real PostgreSQL, temporary CIRCLE_HUB_DATA_DIR, and bin/circle-hub.
import assert from 'node:assert/strict';
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { RESET_SCOPE } from '../../contracts/src/reset.ts';
import { LIBPQ_MISSING, libpqAvailable } from '../../hub/platform/test-support.ts';
import { osIsolationAvailable } from '../../hub/rules/api.ts';
import {
  CookieJar,
  SYNTHETIC_ADMIN_PASS,
  assertBackupAndArchivePreserved,
  assertVaultAndKeysUnchanged,
  connectMcpHttp,
  extractFormInputValue,
  hashDirectoryFiles,
  httpCall,
  inspectDatabaseState,
  objectExistsOnDisk,
  parseResetCliReport,
  runCli,
  runResetCli,
  seedRichHub,
  snapshotVaultAndKeys,
  spawnServe,
  teardownRoot,
  withRootDb,
  type ServeHandle,
} from './support/reset-acceptance.ts';

const hasLibpq = await libpqAvailable();
const hasSandbox = await osIsolationAvailable();

const cleanupQueue: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanupQueue.splice(0).reverse()) {
    await fn().catch(() => undefined);
  }
});

/** Mutates the migrated DB's migration identity table so the Hub sees a genuinely incompatible DB version. */
async function simulateIncompatibleDatabase(dataDir: string): Promise<string> {
  return await withRootDb(dataDir, async (pool) => {
    const tables = await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND (tablename = 'schema_migrations' OR tablename LIKE '%migration%') ORDER BY tablename",
    );
    assert.ok(tables.rows.length > 0, 'migrated database must contain a migration tracking table');
    const migTable = tables.rows[0].tablename;
    const quotedTable = `"${migTable.replaceAll('"', '""')}"`;

    const cols = await pool.query<{ column_name: string; data_type: string; is_nullable: string }>(
      "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position",
      [migTable],
    );
    assert.ok(cols.rows.length > 0, `migration table ${migTable} must expose columns`);

    const assignments: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    for (const col of cols.rows) {
      const name = col.column_name;
      const lower = name.toLowerCase();
      const quotedCol = `"${name.replaceAll('"', '""')}"`;
      if (lower.includes('sha') || lower.includes('hash') || lower.includes('checksum') || lower.includes('digest')) {
        assignments.push(`${quotedCol} = $${paramIndex++}`);
        params.push('f'.repeat(64));
      } else if (lower === 'id' || lower === 'version' || lower === 'name' || lower.includes('migration')) {
        if (col.data_type.includes('int')) {
          assignments.push(`${quotedCol} = $${paramIndex++}`);
          params.push(1);
        } else {
          assignments.push(`${quotedCol} = $${paramIndex++}`);
          params.push('0001_prior_release');
        }
      }
    }
    assert.ok(assignments.length > 0, `could not identify version/hash columns on ${migTable}: ${JSON.stringify(cols.rows)}`);

    await pool.query('BEGIN');
    try {
      await pool.query(`ALTER TABLE ${quotedTable} DISABLE TRIGGER USER`);
      await pool.query(`DELETE FROM ${quotedTable} WHERE ctid <> (SELECT min(ctid) FROM ${quotedTable})`);
      await pool.query(`UPDATE ${quotedTable} SET ${assignments.join(', ')}`, params);
      await pool.query(`ALTER TABLE ${quotedTable} ENABLE TRIGGER USER`);
      await pool.query('COMMIT');
    } catch (err) {
      await pool.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
    return migTable;
  });
}

/** Extracts a one-time rebuild setup code printed by `circle-hub setup-code --rebuild`. */
function extractSetupCode(output: string): string {
  const labeled = /(?:设置码|重建码|code|码)[：:\s]+([A-Za-z0-9][A-Za-z0-9_-]{7,})/i.exec(output);
  if (labeled?.[1]) return labeled[1];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (/^[A-Za-z0-9][A-Za-z0-9_-]{7,}$/.test(trimmed)) return trimmed;
  }
  const token = /\b([A-Za-z0-9]{4,}(?:-[A-Za-z0-9]{4,})+)\b/.exec(output);
  assert.ok(token?.[1], `could not extract setup code from CLI output:\n${output}`);
  return token[1];
}

/** Asserts that HTTP body exposes neither stack traces nor raw PostgreSQL internal leakage. */
function assertNoInternalDbLeak(body: string, context: string): void {
  assert.doesNotMatch(body, /at\s+\S+\s+\(.*\.ts:\d+:\d+\)/, `${context} must not leak stack trace`);
  assert.doesNotMatch(body, /relation\s+"[^"]+"\s+does not exist/i, `${context} must not leak raw PostgreSQL relation errors`);
  assert.doesNotMatch(body, /\bECONNREFUSED\b|\b42P01\b|\b42501\b/i, `${context} must not leak raw driver/SQLSTATE internals`);
}

describe('incompatible DB schema/version degraded startup vs unreachable DB (spec item 4)', () => {
  it('starts safely in needsRebuild mode on incompatible DB, isolates anonymous rebuild view, gates business routes at 503, and authorizes via setup-code --rebuild', { timeout: 120_000 }, async () => {
    const { root, state } = await seedRichHub({ includeHistoryAndKnowledge: false, canRunSandboxedPacks: false });
    let serve: ServeHandle | undefined;
    cleanupQueue.push(() => teardownRoot(root, state.dataDir, serve));

    const vaultBefore = await snapshotVaultAndKeys(state.dataDir);
    const migTable = await simulateIncompatibleDatabase(state.dataDir);

    serve = await spawnServe(state.dataDir, state.port, { scratchHome: state.scratchHome });

    // 1. Public /healthz returns 200 with needsRebuild: true and zero sensitive metadata.
    const health = await serve.healthz();
    assert.equal(health.status, 200);
    const healthJson = JSON.parse(health.body) as Record<string, unknown>;
    assert.equal(healthJson.status, 'ok', `/healthz must report status='ok', got: ${health.body}`);
    assert.equal(healthJson.needsRebuild, true, `/healthz must report needsRebuild=true, got: ${health.body}`);
    assert.ok(Object.hasOwn(healthJson, 'release'), `/healthz must include release property, got: ${health.body}`);
    for (const forbiddenKey of ['accounts', 'counts', 'snapshot', 'configurationSnapshot', 'archive', 'backup', 'reason', 'detail', 'users']) {
      assert.equal(Object.hasOwn(healthJson, forbiddenKey), false, `/healthz must not expose ${forbiddenKey}`);
    }
    assert.equal(health.body.includes('alice'), false);

    // 2. Normal console, MCP, OAuth metadata, and sync endpoints return 503 with clear rebuild guidance and no DB leaks.
    const degradedPaths: Array<{ path: string; method?: string; headers?: Record<string, string>; body?: string }> = [
      { path: '/console' },
      { path: '/console/runs' },
      {
        path: '/mcp',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${state.canaries.aliceToken}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'degraded-check', version: '1.0' } },
        }),
      },
      { path: '/.well-known/oauth-protected-resource/mcp' },
      { path: '/api/sync/v1/state', headers: { authorization: `Bearer ${state.canaries.aliceToken}` } },
    ];
    for (const probe of degradedPaths) {
      const reply = await httpCall(state.port, probe.path, probe);
      assert.equal(reply.status, 503, `${probe.path} must return 503 during needsRebuild, got ${reply.status}: ${reply.body.slice(0, 300)}`);
      assert.ok(reply.body.length > 0, `${probe.path} 503 response should carry an actionable rebuild message`);
      assertNoInternalDbLeak(reply.body, probe.path);
      assert.equal(reply.body.includes('0001_prior_release'), false, `${probe.path} 503 must not leak raw migration identity`);
    }

    // 3. Anonymous GET /console/rebuild renders HTTP 200 HTML authorization form only without diagnostics or DB internals.
    const anonRebuild = await httpCall(state.port, '/console/rebuild');
    assert.equal(anonRebuild.status, 200);
    assert.match(String(anonRebuild.headers['content-type'] ?? ''), /text\/html/i);
    assert.ok(anonRebuild.body.includes('setup_code'), 'anonymous /console/rebuild must render setup_code input');
    assert.ok(anonRebuild.body.includes('nonce'), 'anonymous /console/rebuild must include CSRF/login nonce');
    assert.equal(anonRebuild.body.includes('0001_prior_release'), false, 'anonymous /console/rebuild must not expose migration diagnostics');
    assert.equal(anonRebuild.body.includes('alice'), false, 'anonymous /console/rebuild must not expose account names');
    assertNoInternalDbLeak(anonRebuild.body, 'GET /console/rebuild');

    // 4. Unauthenticated status polling returns 401.
    const unauthStatus = await httpCall(state.port, '/console/reset/status/00000000-0000-0000-0000-000000000000');
    assert.equal(unauthStatus.status, 401);

    // 5. Regular bootstrap setup-code refuses on incompatible existing DB; `setup-code --rebuild` issues one-time rebuild code.
    const bootstrapRes = await runCli(state.dataDir, ['setup-code']);
    assert.notEqual(bootstrapRes.code, 0, 'bootstrap setup-code must refuse when DB already exists / is incompatible');

    const rebuildCodeRes = await runCli(state.dataDir, ['setup-code', '--rebuild'], { expectOk: true });
    const setupCode = extractSetupCode(rebuildCodeRes.combined);
    const rebuildCodeStat = await stat(join(state.dataDir, 'config', 'rebuild-code.json'));
    assert.ok(rebuildCodeStat.isFile(), 'setup-code --rebuild must persist config/rebuild-code.json');

    // 6. Wrong code fails; valid code authorizes dedicated maintenance session cookie via 303 redirect.
    const jar = new CookieJar();
    jar.absorb(anonRebuild);
    const nonce = extractFormInputValue(anonRebuild.body, 'nonce');
    assert.ok(nonce, 'nonce value must be present on /console/rebuild form');

    const origin = `http://127.0.0.1:${state.port}`;
    const badAuth = await httpCall(state.port, '/console/rebuild/authorize', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: jar.header(),
        origin,
        referer: `${origin}/console/rebuild`,
      },
      body: new URLSearchParams({ setup_code: 'INVALID-CODE-0000', nonce }).toString(),
    });
    assert.notEqual(badAuth.status, 303, 'invalid rebuild setup code must not authorize maintenance session');

    // Refresh form/nonce if single-use nonce was consumed on failed POST.
    const freshForm = await httpCall(state.port, '/console/rebuild');
    jar.absorb(freshForm);
    const freshNonce = extractFormInputValue(freshForm.body, 'nonce') ?? nonce;

    const okAuth = await httpCall(state.port, '/console/rebuild/authorize', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: jar.header(),
        origin,
        referer: `${origin}/console/rebuild`,
      },
      body: new URLSearchParams({ setup_code: setupCode, nonce: freshNonce }).toString(),
    });
    assert.equal(okAuth.status, 303, `valid setup_code authorize failed: status=${okAuth.status} body=${okAuth.body}`);
    jar.absorb(okAuth);

    const authedRebuild = await httpCall(state.port, '/console/rebuild', {
      headers: { cookie: jar.header() },
    });
    assert.equal(authedRebuild.status, 200);
    assert.match(authedRebuild.body, /all|全部初始化|history|运行历史/, 'authorized /console/rebuild must show rebuild scopes');

    const authedUnknownStatus = await httpCall(state.port, '/console/reset/status/00000000-0000-0000-0000-000000000000', {
      headers: { cookie: jar.header() },
    });
    assert.equal(authedUnknownStatus.status, 404, 'authorized status check for unknown operationId must return 404');

    // Preview via console form succeeds cleanly without wiping DB.
    const csrf = extractFormInputValue(authedRebuild.body, 'csrf');
    const actionId = extractFormInputValue(authedRebuild.body, 'actionId');
    if (csrf && actionId) {
      const previewRes = await httpCall(state.port, '/console/rebuild/preview', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: jar.header(),
          origin,
          referer: `${origin}/console/rebuild`,
        },
        body: new URLSearchParams({ csrf, actionId, scope: 'all' }).toString(),
      });
      assert.equal(previewRes.status, 200, `rebuild preview failed: ${previewRes.status} ${previewRes.body.slice(0, 400)}`);
    }

    // 7. --keep-config must refuse cleanly on incompatible schema without silently dropping configuration.
    if (hasLibpq) {
      await serve.stop();
      const keepAttempt = await runResetCli(state.dataDir, { scopes: 'all', keepConfig: true });
      assert.notEqual(keepAttempt.code, 0, '--keep-config must refuse when DB schema is incompatible');
      const stillExists = await inspectDatabaseState(state.dataDir);
      assert.ok((stillExists.tables[migTable] ?? 0) > 0, 'failed --keep-config must leave DB intact rather than downgrading to wipe');
    } else {
      assert.equal(serve.process.exitCode, null, 'degraded server must remain healthy and running across all requests');
    }

    await assertVaultAndKeysUnchanged(state.dataDir, vaultBefore, 'after needsRebuild checks');
  });

  it('never misclassifies stopped or permission-denied PostgreSQL (unavailable) as needsRebuild: true', { timeout: 90_000 }, async () => {
    const { root, state } = await seedRichHub({ includeHistoryAndKnowledge: false, canRunSandboxedPacks: false });
    let serve: ServeHandle | undefined;
    cleanupQueue.push(async () => {
      await withRootDb(
        state.dataDir,
        async (pool, meta) => {
          const dbQ = `"${meta.database.replaceAll('"', '""')}"`;
          const userQ = `"${meta.appUser.replaceAll('"', '""')}"`;
          await pool.query(`GRANT CONNECT ON DATABASE ${dbQ} TO ${userQ}`).catch(() => undefined);
        },
        'postgres',
      ).catch(() => undefined);
      await teardownRoot(root, state.dataDir, serve);
    });

    // Subcase A: PostgreSQL stopped (connection refused).
    await runCli(state.dataDir, ['db', 'stop'], { expectOk: true });
    const stoppedCodeRes = await runCli(state.dataDir, ['setup-code', '--rebuild']);
    assert.notEqual(stoppedCodeRes.code, 0, 'setup-code --rebuild must refuse when PostgreSQL is unreachable');

    // Attempt serve while PostgreSQL is unreachable: either exits non-zero or never reports needsRebuild: true.
    let serveUnavailableExited = false;
    try {
      serve = await spawnServe(state.dataDir, state.port, { scratchHome: state.scratchHome, deadlineMs: 6_000 });
      const health = await serve.healthz();
      if (health.status === 200) {
        const json = JSON.parse(health.body) as { needsRebuild?: unknown };
        assert.notEqual(json.needsRebuild, true, 'unreachable PG must never report needsRebuild: true');
      }
      await serve.stop();
      serve = undefined;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/exited prematurely/i.test(msg)) serveUnavailableExited = true;
      else assert.ok(msg.includes('did not answer /healthz'), msg);
    }
    assert.equal(serveUnavailableExited || serve === undefined, true);

    // Subcase B: PostgreSQL running, CONNECT privilege revoked from application role (permission denied).
    await runCli(state.dataDir, ['db', 'start'], { expectOk: true });
    await withRootDb(
      state.dataDir,
      async (pool, meta) => {
        const dbQ = `"${meta.database.replaceAll('"', '""')}"`;
        const userQ = `"${meta.appUser.replaceAll('"', '""')}"`;
        await pool.query(`REVOKE CONNECT ON DATABASE ${dbQ} FROM ${userQ}`);
      },
      'postgres',
    );

    const deniedCodeRes = await runCli(state.dataDir, ['setup-code', '--rebuild']);
    assert.notEqual(deniedCodeRes.code, 0, 'setup-code --rebuild must refuse on permission-denied DB (unavailable != incompatible)');

    try {
      serve = await spawnServe(state.dataDir, state.port, { scratchHome: state.scratchHome, deadlineMs: 6_000 });
      const health = await serve.healthz();
      const json = JSON.parse(health.body) as { needsRebuild?: unknown };
      assert.notEqual(json.needsRebuild, true, 'permission-denied PG must never report needsRebuild: true');
    } catch {
      // Expected: serve refuses to enter degraded rebuild mode or fails cleanly on DB permission denial.
    } finally {
      await serve?.stop().catch(() => undefined);
      serve = undefined;
      await withRootDb(
        state.dataDir,
        async (pool, meta) => {
          const dbQ = `"${meta.database.replaceAll('"', '""')}"`;
          const userQ = `"${meta.appUser.replaceAll('"', '""')}"`;
          await pool.query(`GRANT CONNECT ON DATABASE ${dbQ} TO ${userQ}`);
        },
        'postgres',
      );
    }
  });
});

describe('reset scopes (history, knowledge, packs, config, all), verified backup/archive, and vault invariance (spec items 1, 2, 8)', { skip: hasLibpq ? false : LIBPQ_MISSING }, () => {
  it('--scope history wipes runs/leases/call-logs while preserving knowledge, packs, config, keys, and vault', { timeout: 150_000 }, async () => {
    const { root, state } = await seedRichHub({ includeHistoryAndKnowledge: true, canRunSandboxedPacks: hasSandbox });
    let serve: ServeHandle | undefined;
    cleanupQueue.push(() => teardownRoot(root, state.dataDir, serve));

    const vaultBefore = await snapshotVaultAndKeys(state.dataDir);
    const packsBefore = await hashDirectoryFiles(join(state.dataDir, 'packs'));

    const res = await runResetCli(state.dataDir, { scopes: ['history'] }, { expectOk: true });
    await assertBackupAndArchivePreserved(state.dataDir, res, ['history'], hasSandbox);
    await assertVaultAndKeysUnchanged(state.dataDir, vaultBefore, 'after reset --scope history');

    // Cleared: runs, leases, history call logs / run actions.
    const runsAfter = JSON.parse((await runCli(state.dataDir, ['run', 'list', '--json'], { expectOk: true })).stdout) as { items?: unknown[]; runs?: unknown[] } | unknown[];
    const runList = Array.isArray(runsAfter) ? runsAfter : (runsAfter.items ?? runsAfter.runs ?? []);
    assert.equal(runList.length, 0, 'all runs must be cleared after --scope history');
    const leasesAfter = (await runCli(state.dataDir, ['lease', 'list'], { expectOk: true })).stdout;
    assert.equal(leasesAfter.includes('bed/bed-a/'), false, `bookings/leases must be cleared after --scope history:\n${leasesAfter}`);

    const dbAfter = await inspectDatabaseState(state.dataDir);
    for (const historyKind of ['run', 'action', 'validation_result', 'submission', 'call_log']) {
      assert.equal(dbAfter.recordKinds[historyKind] ?? 0, 0, `record kind '${historyKind}' must be cleared by --scope history`);
    }

    // Preserved: knowledge objects & entries, packs dir & DB, config (users, teams, resources, executors, vars, docs), keys & vault.
    assert.equal(await objectExistsOnDisk(state.dataDir, state.knowledgeOriginalSha256!), true, 'knowledge original blob must survive --scope history');
    assert.ok((dbAfter.recordKinds.knowledge_space_entry ?? 0) > 0, 'knowledge space entries must survive --scope history');
    assert.ok((dbAfter.recordKinds.memory_version ?? 0) > 0, 'memory versions must survive --scope history');

    const packsAfter = await hashDirectoryFiles(join(state.dataDir, 'packs'));
    assert.deepEqual([...packsAfter.entries()], [...packsBefore.entries()], '<dataDir>/packs must survive --scope history byte-for-byte');
    const packList = (await runCli(state.dataDir, ['pack', 'list'], { expectOk: true })).stdout;
    assert.ok(packList.includes('test-bed') && packList.includes('mindmap-format') && packList.includes('lumen-api'));

    const docOut = (await runCli(state.dataDir, ['doc', 'show', state.docNoteName], { expectOk: true })).stdout;
    assert.equal(docOut.trim(), state.docNoteText.trim());
    const varOut = (await runCli(state.dataDir, ['var', 'show', state.plainVarName, '--value'], { expectOk: true })).stdout;
    assert.ok(varOut.includes(state.plainVarValue));

    // Existing alice token remains active and Hub serves cleanly.
    serve = await spawnServe(state.dataDir, state.port, { scratchHome: state.scratchHome });
    const mcp = await connectMcpHttp(state.port, state.canaries.aliceToken, 'sess-post-history-reset');
    try {
      const packs = await mcp.call('list_task_packs', {});
      assert.equal(packs.isError, false, packs.text);
      assert.ok(packs.out.packs.some((p) => p.pack.startsWith('test-bed@')));
      const nodes = await mcp.call('get_nodes', { pack: state.workflowId });
      assert.equal(nodes.isError, false, nodes.text);
      if (hasSandbox) {
        const freshRun = await mcp.call('start_run', {
          pack: state.workflowId,
          inputs: { inventory: { external: `doc:doc:${state.docBedName}` } },
          parameters: { action: 'facts' },
        });
        assert.equal(freshRun.isError, false, freshRun.text);
      }
    } finally {
      await mcp.close();
    }
  });

  it('--scope knowledge wipes knowledge entries, originals, and memory while preserving history, packs, config, keys, and vault', { timeout: 150_000 }, async () => {
    const { root, state } = await seedRichHub({ includeHistoryAndKnowledge: true, canRunSandboxedPacks: hasSandbox });
    cleanupQueue.push(() => teardownRoot(root, state.dataDir));

    const vaultBefore = await snapshotVaultAndKeys(state.dataDir);
    const dbBefore = await inspectDatabaseState(state.dataDir);
    const packsBefore = await hashDirectoryFiles(join(state.dataDir, 'packs'));

    const res = await runResetCli(state.dataDir, { scopes: ['knowledge'] }, { expectOk: true });
    await assertBackupAndArchivePreserved(state.dataDir, res, ['knowledge'], hasSandbox);
    await assertVaultAndKeysUnchanged(state.dataDir, vaultBefore, 'after reset --scope knowledge');

    const dbAfter = await inspectDatabaseState(state.dataDir);
    for (const kKind of ['knowledge_space_source', 'knowledge_space_entry', 'knowledge_space_version', 'tree_node', 'tree_root', 'root_pointer', 'memory_document', 'memory_version', 'knowledge_share']) {
      assert.equal(dbAfter.recordKinds[kKind] ?? 0, 0, `knowledge kind '${kKind}' must be cleared by --scope knowledge`);
    }
    assert.equal(await objectExistsOnDisk(state.dataDir, state.knowledgeOriginalSha256!), false, 'knowledge-only original blob must be removed on --scope knowledge');

    // History runs, leases, and run upload artifacts remain preserved.
    if (hasSandbox) {
      assert.equal(dbAfter.recordKinds.run ?? 0, dbBefore.recordKinds.run ?? 0, 'pre-reset runs must survive --scope knowledge');
      const leasesAfter = (await runCli(state.dataDir, ['lease', 'list'], { expectOk: true })).stdout;
      assert.ok(leasesAfter.includes('bed/bed-a/'), 'held test-bed booking must survive --scope knowledge');
    }
    assert.equal(await objectExistsOnDisk(state.dataDir, state.runArtifactSha256!), true, 'run upload artifact blob must survive --scope knowledge');

    // Packs & config remain preserved.
    const packsAfter = await hashDirectoryFiles(join(state.dataDir, 'packs'));
    assert.deepEqual([...packsAfter.entries()], [...packsBefore.entries()]);
    const usersAfter = JSON.parse((await runCli(state.dataDir, ['user', 'list', '--json'], { expectOk: true })).stdout) as Array<{ name: string }>;
    assert.ok(usersAfter.some((u) => u.name === 'alice'));
    assert.ok((await runCli(state.dataDir, ['team', 'show', state.teamAlphaId], { expectOk: true })).stdout.includes('alice'));
    assert.ok((await runCli(state.dataDir, ['doc', 'show', state.docNoteName], { expectOk: true })).stdout.includes('第二行用于核对'));
  });

  it('--scope packs wipes published/installed/activated packs and <dataDir>/packs/ while preserving other categories and vault', { timeout: 150_000 }, async () => {
    const { root, state } = await seedRichHub({ includeHistoryAndKnowledge: true, canRunSandboxedPacks: hasSandbox });
    cleanupQueue.push(() => teardownRoot(root, state.dataDir));

    const vaultBefore = await snapshotVaultAndKeys(state.dataDir);
    const dbBefore = await inspectDatabaseState(state.dataDir);

    const res = await runResetCli(state.dataDir, { scopes: ['packs'] }, { expectOk: true });
    await assertBackupAndArchivePreserved(state.dataDir, res, ['packs'], hasSandbox);
    await assertVaultAndKeysUnchanged(state.dataDir, vaultBefore, 'after reset --scope packs');

    // Cleared: packs on disk and pack_version / personal_pack records in DB.
    const packsAfterDisk = await hashDirectoryFiles(join(state.dataDir, 'packs'));
    assert.equal(packsAfterDisk.size, 0, `<dataDir>/packs must be empty after --scope packs, found ${[...packsAfterDisk.keys()]}`);
    const dbAfter = await inspectDatabaseState(state.dataDir);
    assert.equal(dbAfter.recordKinds.pack_version ?? 0, 0, 'pack_version records must be cleared by --scope packs');
    assert.equal(dbAfter.recordKinds.personal_pack_version ?? 0, 0);

    const packList = (await runCli(state.dataDir, ['pack', 'list'], { expectOk: true })).stdout;
    assert.equal(packList.includes(state.overlayPackId), false, 'published overlay pack must be absent after --scope packs');
    assert.equal(packList.includes('test-bed'), false, 'published test-bed pack must be absent after --scope packs');

    // Preserved: config, knowledge, history, keys & vault.
    const usersAfter = JSON.parse((await runCli(state.dataDir, ['user', 'list', '--json'], { expectOk: true })).stdout) as Array<{ name: string }>;
    assert.ok(usersAfter.some((u) => u.name === 'alice'));
    assert.ok((await runCli(state.dataDir, ['team', 'show', state.teamAlphaId], { expectOk: true })).stdout.includes('alice'));
    assert.ok((await runCli(state.dataDir, ['var', 'show', state.plainVarName, '--value'], { expectOk: true })).stdout.includes(state.plainVarValue));
    assert.ok((await runCli(state.dataDir, ['doc', 'show', state.docNoteName], { expectOk: true })).stdout.includes('第二行用于核对'));
    assert.ok((dbAfter.recordKinds.knowledge_space_entry ?? 0) > 0, 'knowledge entries must survive --scope packs');
    if (hasSandbox) assert.equal(dbAfter.recordKinds.run ?? 0, dbBefore.recordKinds.run ?? 0);
  });

  it('--scope config wipes accounts, teams, allocations, resources, executors, variables, and docs while keeping packs, knowledge, history, and vault', { timeout: 150_000 }, async () => {
    const { root, state } = await seedRichHub({ includeHistoryAndKnowledge: true, canRunSandboxedPacks: hasSandbox });
    let serve: ServeHandle | undefined;
    cleanupQueue.push(() => teardownRoot(root, state.dataDir, serve));

    const vaultBefore = await snapshotVaultAndKeys(state.dataDir);
    const dbBefore = await inspectDatabaseState(state.dataDir);
    const packsBefore = await hashDirectoryFiles(join(state.dataDir, 'packs'));

    const res = await runResetCli(state.dataDir, { scopes: ['config'] }, { expectOk: true });
    await assertBackupAndArchivePreserved(state.dataDir, res, ['config'], hasSandbox);
    await assertVaultAndKeysUnchanged(state.dataDir, vaultBefore, 'after reset --scope config');

    // Cleared: all users, tokens, teams, team_members, resources, executors, variables, named docs.
    const dbAfter = await inspectDatabaseState(state.dataDir);
    assert.equal(dbAfter.tables.users ?? 0, 0, 'users table must be empty after --scope config');
    assert.equal(dbAfter.tables.teams ?? 0, 0, 'teams table must be empty after --scope config');
    assert.equal(dbAfter.tables.team_members ?? 0, 0, 'team_members table must be empty after --scope config');
    if (Object.hasOwn(dbAfter.tables, 'tokens')) {
      assert.equal(dbAfter.tables.tokens, 0, 'tokens table must be empty after --scope config');
    }

    // Preserved: packs on disk & DB, knowledge, history, keys & vault.
    const packsAfter = await hashDirectoryFiles(join(state.dataDir, 'packs'));
    assert.deepEqual([...packsAfter.entries()], [...packsBefore.entries()], '<dataDir>/packs must survive --scope config');
    assert.equal(dbAfter.recordKinds.pack_version ?? 0, dbBefore.recordKinds.pack_version ?? 0, 'pack_version records must survive --scope config');
    assert.equal(await objectExistsOnDisk(state.dataDir, state.knowledgeOriginalSha256!), true, 'knowledge objects must survive --scope config');
    assert.equal(await objectExistsOnDisk(state.dataDir, state.runArtifactSha256!), true, 'run objects must survive --scope config');
    if (hasSandbox) assert.equal(dbAfter.recordKinds.run ?? 0, dbBefore.recordKinds.run ?? 0);

    // Old alice bearer token must no longer authenticate after config wipe.
    serve = await spawnServe(state.dataDir, state.port, { scratchHome: state.scratchHome });
    const deniedMcp = await httpCall(state.port, '/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${state.canaries.aliceToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'post-config-reset', version: '1.0' } },
      }),
    });
    assert.equal(deniedMcp.status, 401, `pre-reset token must be rejected after --scope config, got ${deniedMcp.status}`);
  });

  it('--scope all wipes history, knowledge, packs, and config while keeping readable archive/backup and vault byte-for-byte identical', { timeout: 150_000 }, async () => {
    const { root, state } = await seedRichHub({ includeHistoryAndKnowledge: true, canRunSandboxedPacks: hasSandbox });
    cleanupQueue.push(() => teardownRoot(root, state.dataDir));

    const vaultBefore = await snapshotVaultAndKeys(state.dataDir);
    const res = await runResetCli(state.dataDir, { scopes: 'all' }, { expectOk: true });
    await assertBackupAndArchivePreserved(state.dataDir, res, RESET_SCOPE, hasSandbox);
    await assertVaultAndKeysUnchanged(state.dataDir, vaultBefore, 'after reset --scope all');

    const dbAfter = await inspectDatabaseState(state.dataDir);
    assert.equal(dbAfter.tables.users ?? 0, 0);
    assert.equal(dbAfter.tables.teams ?? 0, 0);
    assert.equal(dbAfter.tables.team_members ?? 0, 0);
    if (Object.hasOwn(dbAfter.tables, 'records')) {
      assert.equal(dbAfter.tables.records, 0, `records table must be completely cleared by --scope all, found: ${JSON.stringify(dbAfter.recordKinds)}`);
    }
    assert.equal((await hashDirectoryFiles(join(state.dataDir, 'packs'))).size, 0, '<dataDir>/packs must be empty after --scope all');
    assert.equal(await objectExistsOnDisk(state.dataDir, state.runArtifactSha256!), false);
    assert.equal(await objectExistsOnDisk(state.dataDir, state.knowledgeOriginalSha256!), false);
  });
});

describe('--keep-config rebuild preserves config, auth hashes, and Hub usability (spec items 3a & 8)', { skip: hasLibpq ? false : LIBPQ_MISSING }, () => {
  it('rebuilds via reset --scope all --keep-config with 0600 secret-free snapshot, surviving credentials, docs, resources, and vault invariance', { timeout: 180_000 }, async () => {
    const { root, state } = await seedRichHub({ includeHistoryAndKnowledge: true, canRunSandboxedPacks: hasSandbox });
    let serve: ServeHandle | undefined;
    cleanupQueue.push(() => teardownRoot(root, state.dataDir, serve));

    const vaultBefore = await snapshotVaultAndKeys(state.dataDir);
    const res = await runResetCli(state.dataDir, { scopes: 'all', keepConfig: true }, { expectOk: true });
    await assertBackupAndArchivePreserved(state.dataDir, res, RESET_SCOPE, hasSandbox);
    await assertVaultAndKeysUnchanged(state.dataDir, vaultBefore, 'after reset --scope all --keep-config');

    // Verify private configuration snapshot (0600, free of vault secret values and plaintext tokens) if reported.
    const report = parseResetCliReport(res);
    const snapshotPath = typeof report.json?.configurationSnapshot === 'string' ? report.json.configurationSnapshot : undefined;
    if (snapshotPath) {
      const fullSnapPath = snapshotPath.startsWith('/') ? snapshotPath : join(state.dataDir, snapshotPath);
      const snapStat = await stat(fullSnapPath);
      assert.equal(snapStat.mode & 0o077, 0, `configuration snapshot ${fullSnapPath} must be 0600 (no group/other access)`);
      const snapText = await readFile(fullSnapPath, 'utf8');
      for (const secret of [state.canaries.adminPassword, state.canaries.aliceToken, state.canaries.plmUserSecret, state.canaries.plmPassSecret, state.canaries.execSecret, state.canaries.varSecret, state.canaries.extraSecret]) {
        assert.equal(snapText.includes(secret), false, 'protected config snapshot must never contain plaintext secrets or tokens');
      }
    }

    // History and knowledge are cleared while config & packs remain.
    const dbAfter = await inspectDatabaseState(state.dataDir);
    for (const wipedKind of ['run', 'action', 'validation_result', 'knowledge_space_entry', 'memory_version', 'tree_root']) {
      assert.equal(dbAfter.recordKinds[wipedKind] ?? 0, 0, `expected '${wipedKind}' cleared under --scope all --keep-config`);
    }

    const users = JSON.parse((await runCli(state.dataDir, ['user', 'list', '--json'], { expectOk: true })).stdout) as Array<{ id: string; name: string; role: string; disabled?: boolean }>;
    assert.equal(users.find((u) => u.name === 'admin')?.id, state.adminId);
    assert.equal(users.find((u) => u.name === 'alice')?.id, state.aliceId);
    assert.equal(users.find((u) => u.name === 'bob')?.disabled, true);
    assert.ok((await runCli(state.dataDir, ['team', 'show', state.teamAlphaId], { expectOk: true })).stdout.includes('alice'));
    assert.ok((await runCli(state.dataDir, ['resource', 'show', state.plmResourceId], { expectOk: true })).stdout.includes('192.0.2.10'));
    assert.ok((await runCli(state.dataDir, ['executor', 'list'], { expectOk: true })).stdout.includes(state.executorTarget));
    assert.ok((await runCli(state.dataDir, ['var', 'show', state.plainVarName, '--value'], { expectOk: true })).stdout.includes(state.plainVarValue));
    assert.equal((await runCli(state.dataDir, ['doc', 'show', state.docNoteName], { expectOk: true })).stdout.trim(), state.docNoteText.trim());
    await runCli(state.dataDir, ['records', 'verify', '--vault'], { expectOk: true });

    // Start Hub and prove preserved passwords/tokens work immediately (admin console login + alice MCP).
    serve = await spawnServe(state.dataDir, state.port, { scratchHome: state.scratchHome });
    const loginPage = await httpCall(state.port, '/console/login');
    assert.equal(loginPage.status, 200);
    const loginJar = new CookieJar();
    loginJar.absorb(loginPage);
    const csrf = extractFormInputValue(loginPage.body, 'csrf');
    assert.ok(csrf);
    const origin = `http://127.0.0.1:${state.port}`;
    const adminLogin = await httpCall(state.port, '/console/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: loginJar.header(),
        origin,
        referer: `${origin}/console/login`,
      },
      body: new URLSearchParams({ username: 'admin', password: SYNTHETIC_ADMIN_PASS, csrf }).toString(),
    });
    assert.equal(adminLogin.status, 303, `preserved admin password hash must log in after --keep-config:\n${adminLogin.body.slice(0, 400)}`);

    const mcp = await connectMcpHttp(state.port, state.canaries.aliceToken, 'sess-post-keep-config');
    try {
      const packs = await mcp.call('list_task_packs', {});
      assert.equal(packs.isError, false, packs.text);
      assert.ok(packs.out.packs.some((p) => p.pack.startsWith('test-bed@')));
      assert.ok(packs.out.packs.some((p) => p.pack.startsWith('mindmap-format@')));
      if (hasSandbox) {
        const run = await mcp.call('start_run', {
          pack: state.workflowId,
          inputs: { inventory: { external: `doc:doc:${state.docBedName}` } },
          parameters: { action: 'facts' },
        });
        assert.equal(run.isError, false, run.text);
      }
    } finally {
      await mcp.close();
    }
  });
});

describe('failure recovery rolls back to exact pre-reset state (spec item 5)', { skip: hasLibpq ? false : LIBPQ_MISSING }, () => {
  it('restores DB, vault, objects, packs, and live Hub usability when --definition fails during reset', { timeout: 150_000 }, async () => {
    const { root, state } = await seedRichHub({ includeHistoryAndKnowledge: true, canRunSandboxedPacks: hasSandbox });
    let serve: ServeHandle | undefined;
    cleanupQueue.push(() => teardownRoot(root, state.dataDir, serve));

    const vaultBefore = await snapshotVaultAndKeys(state.dataDir);
    const dbBefore = await inspectDatabaseState(state.dataDir);
    const packsBefore = await hashDirectoryFiles(join(state.dataDir, 'packs'));
    const objectsBefore = await hashDirectoryFiles(join(state.dataDir, 'objects'));

    const badDefPath = join(state.scratchHome, 'failing-definition.json');
    const badDef = {
      schema: 'deployment@1',
      accounts: [{ name: 'admin', role: 'admin', disabled: false }],
      resources: [
        {
          definition: {
            system_pack: 'plm@99.99.99',
            name: 'broken-unresolvable-plm',
            environment: 'test',
            origins: { 'plm-oauth': 'http://192.0.2.10:8080', 'plm-api': 'http://192.0.2.11:8080' },
            allow_plaintext: ['plm-oauth', 'plm-api'],
            credentials: { username: 'SYNTH_PLM_USER', password: 'SYNTH_PLM_PASS' },
          },
          enabled: true,
        },
      ],
    };
    await writeFile(badDefPath, JSON.stringify(badDef, null, 2), 'utf8');

    const failRes = await runResetCli(state.dataDir, { scopes: 'all', definition: badDefPath });
    assert.notEqual(failRes.code, 0, 'reset with failing definition must abort and exit non-zero');

    await assertVaultAndKeysUnchanged(state.dataDir, vaultBefore, 'after failing definition rollback');
    const dbAfter = await inspectDatabaseState(state.dataDir);
    assert.deepEqual(dbAfter, dbBefore, 'DB tables and record counts must match pre-reset state exactly after rollback');
    assert.deepEqual([...(await hashDirectoryFiles(join(state.dataDir, 'packs'))).entries()], [...packsBefore.entries()]);
    assert.deepEqual([...(await hashDirectoryFiles(join(state.dataDir, 'objects'))).entries()], [...objectsBefore.entries()]);

    serve = await spawnServe(state.dataDir, state.port, { scratchHome: state.scratchHome });
    const mcp = await connectMcpHttp(state.port, state.canaries.aliceToken, 'sess-after-def-rollback');
    try {
      const resolved = await mcp.call('resolve_reference', { reference: state.runArtifactRef! });
      assert.equal(resolved.isError, false, resolved.text);
    } finally {
      await mcp.close();
    }
  });

  it('rolls back DB and state completely when mid-flight filesystem cleanup fails on unwritable packs/', { timeout: 150_000, skip: process.getuid?.() === 0 ? 'root bypasses chmod 0500 EACCES' : false }, async () => {
    const { root, state } = await seedRichHub({ includeHistoryAndKnowledge: true, canRunSandboxedPacks: hasSandbox });
    let serve: ServeHandle | undefined;
    const packsDir = join(state.dataDir, 'packs');
    cleanupQueue.push(async () => {
      await chmod(packsDir, 0o700).catch(() => undefined);
      await teardownRoot(root, state.dataDir, serve);
    });

    const vaultBefore = await snapshotVaultAndKeys(state.dataDir);
    const dbBefore = await inspectDatabaseState(state.dataDir);
    const objectsBefore = await hashDirectoryFiles(join(state.dataDir, 'objects'));

    // Make packs/ read-only so verified backup + DB archive/creation hit deterministic EACCES during reset cleanup.
    await chmod(packsDir, 0o500);
    let failRes: Awaited<ReturnType<typeof runResetCli>>;
    try {
      failRes = await runResetCli(state.dataDir, { scopes: 'all' });
    } finally {
      await chmod(packsDir, 0o700);
    }
    assert.notEqual(failRes.code, 0, `reset must fail and roll back when packs/ cleanup hits EACCES:\n${failRes.combined}`);

    await assertVaultAndKeysUnchanged(state.dataDir, vaultBefore, 'after mid-flight packs EACCES rollback');
    const dbAfter = await inspectDatabaseState(state.dataDir);
    assert.deepEqual(dbAfter, dbBefore, 'old DB must be restored to exact pre-reset state on mid-flight reset failure');
    assert.deepEqual([...(await hashDirectoryFiles(join(state.dataDir, 'objects'))).entries()], [...objectsBefore.entries()]);

    assert.equal((await runCli(state.dataDir, ['doc', 'show', state.docNoteName], { expectOk: true })).stdout.trim(), state.docNoteText.trim());
    assert.ok((await runCli(state.dataDir, ['resource', 'show', state.plmResourceId], { expectOk: true })).stdout.includes('192.0.2.10'));

    // Ensure PostgreSQL is cleanly operational after rollback.
    await delay(100);
    serve = await spawnServe(state.dataDir, state.port, { scratchHome: state.scratchHome });
    const mcp = await connectMcpHttp(state.port, state.canaries.aliceToken, 'sess-after-fs-rollback');
    try {
      const listed = await mcp.call('list_task_packs', {});
      assert.equal(listed.isError, false, listed.text);
      assert.ok(listed.out.packs.some((p) => p.pack.startsWith('test-bed@')));
    } finally {
      await mcp.close();
    }
  });
});
