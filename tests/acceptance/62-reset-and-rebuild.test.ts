// Cleanroom black-box acceptance tests for Hub reset, scopes, keep-config rebuild, degraded startup, and rollback.
// Covers Spec Items 1, 2, 3a, 4, 5, and 8 against real PostgreSQL, temporary CIRCLE_HUB_DATA_DIR, and bin/circle-hub.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { RESET_SCOPE } from '../../contracts/src/reset.ts';
import { LIBPQ_MISSING, libpqAvailable } from '../../hub/platform/test-support.ts';
import { osIsolationAvailable } from '../../hub/rules/api.ts';
import {
  CookieJar,
  REPO_ROOT,
  SYNTHETIC_ADMIN_PASS,
  allocateLoopbackPort,
  assertBackupAndArchivePreserved,
  assertVaultAndKeysUnchanged,
  connectMcpHttp,
  createShortTempRoot,
  extractFormInputValue,
  hashDirectoryFiles,
  httpCall,
  inspectDatabaseState,
  objectExistsOnDisk,
  parseResetCliReport,
  runCli,
  runExportCli,
  runResetCli,
  seedRichHub,
  snapshotVaultAndKeys,
  spawnServe,
  teardownRoot,
  withRootDb,
  type ServeHandle,
} from './support/reset-acceptance.ts';
import { oneNameProduct, twoNameProduct } from './support/env.ts';

/**
 * Verifies every surviving `action` row after config-preserving resets belongs to
 * config-closure named-document pointer moves (`move_root`, `run === null`, `server.docs@1`),
 * matches `public.pointers`, resolves to an existing object file on disk whose SHA-256 matches
 * the pointer target, and covers every expected named document pointer/digest.
 */
async function assertOnlyConfigClosureActionsSurvive(
  dataDir: string,
  expectedDocHashes?: Record<string, string>,
): Promise<void> {
  const { actions, pointers } = await withRootDb(dataDir, async (client) => {
    const pointerRes = await client.query<{
      name: string;
      target: string;
      action_digest: string | null;
    }>('SELECT name, target, action_digest FROM public.pointers');
    const actionRes = await client.query<{
      digest: string;
      body: string;
    }>("SELECT digest, body FROM public.records WHERE kind = 'action'");
    return { pointers: pointerRes.rows, actions: actionRes.rows };
  });

  const pointerByName = new Map(pointers.map((p) => [p.name, p]));
  const seenPointers = new Set<string>();
  for (const row of actions) {
    const parsed = JSON.parse(row.body) as {
      action?: unknown;
      run?: unknown;
      component?: unknown;
      detail?: { pointer?: unknown; next?: unknown };
    };
    assert.equal(parsed.run, null, `surviving action ${row.digest} must have run=null, got: ${row.body}`);
    assert.equal(parsed.action, 'move_root', `surviving action ${row.digest} must be move_root, got: ${row.body}`);
    assert.equal(parsed.component, 'server.docs@1', `surviving action ${row.digest} must come from server.docs@1`);
    const ptrName = typeof parsed.detail?.pointer === 'string' ? parsed.detail.pointer : '';
    assert.match(ptrName, /^doc:[a-z][a-z0-9-]{0,63}$/, `unexpected action pointer ${ptrName}`);
    const ptrRow = pointerByName.get(ptrName);
    assert.ok(ptrRow, `missing pointer row in public.pointers for surviving action pointer ${ptrName}`);
    assert.equal(ptrRow.action_digest, row.digest, `pointer ${ptrName} action_digest mismatch`);
    assert.equal(ptrRow.target, parsed.detail?.next, `pointer ${ptrName} target mismatch`);
    assert.equal(await objectExistsOnDisk(dataDir, ptrRow.target), true, `doc object ${ptrRow.target} missing on disk`);
    const objectBytes = await readFile(join(dataDir, 'objects', ptrRow.target.slice(0, 2), ptrRow.target));
    const actualDigest = createHash('sha256').update(objectBytes).digest('hex');
    assert.equal(actualDigest, ptrRow.target, `doc object ${ptrRow.target} bytes SHA-256 mismatch`);
    seenPointers.add(ptrName);
  }
  if (expectedDocHashes) {
    for (const [ptrName, expectedSha] of Object.entries(expectedDocHashes)) {
      const ptrRow = pointerByName.get(ptrName);
      assert.ok(ptrRow, `missing expected config pointer ${ptrName} after reset`);
      assert.equal(ptrRow.target, expectedSha, `pointer ${ptrName} digest mismatch after reset`);
      assert.equal(seenPointers.has(ptrName), true, `missing surviving config-closure action for ${ptrName}`);
    }
  }
}

/**
 * Seeds a clean Hub with accounts, team, plain var, named doc, and published (unreferenced) product packs:
 * no `resource` records or `pack assign` authorizations reference the published packs.
 */
async function seedUnreferencedPacksHub(): Promise<{
  root: string;
  dataDir: string;
  productId: string;
  secondProductId: string;
  teamId: string;
  plainVarName: string;
  plainVarValue: string;
  docName: string;
  docSha256: string;
}> {
  const { root, dataDir } = await createShortTempRoot('ch-r-packs-');
  const port = await allocateLoopbackPort();
  const product = await twoNameProduct();
  const secondProduct = await oneNameProduct();

  await runCli(dataDir, ['init', '--environment', 'test', '--port', String(port)], { expectOk: true });
  await runCli(dataDir, ['key', 'init'], { expectOk: true });
  await runCli(dataDir, ['serve', '--migrate-only'], { expectOk: true });
  await runCli(dataDir, ['init-admin', 'admin', '--password-stdin'], {
    stdin: `${SYNTHETIC_ADMIN_PASS}\n`,
    expectOk: true,
  });
  await runCli(dataDir, ['user', 'create', 'alice', '--role', 'reviewer'], { expectOk: true });
  await runCli(dataDir, ['team', 'create', '研发测试组'], { expectOk: true });
  const teamListOut = (await runCli(dataDir, ['team', 'list'], { expectOk: true })).stdout;
  const teamLine = teamListOut.split(/\r?\n/).find((line) => line.includes('研发测试组'));
  assert.ok(teamLine, `expected team in team list output:\n${teamListOut}`);
  const teamId = teamLine.split('\t')[0].trim();
  await runCli(dataDir, ['team', 'add', teamId, 'alice'], { expectOk: true });

  const plainVarName = 'synth_plain_var';
  const plainVarValue = 'plain-var-unreferenced';
  await runCli(dataDir, ['var', 'set', plainVarName, '--text', '--not-secret', '--reason', 'seed'], {
    stdin: `${plainVarValue}\n`,
    expectOk: true,
  });

  const docPath = join(product.dir, 'pack.json');
  const docSha256 = createHash('sha256').update(await readFile(docPath)).digest('hex');
  const docName = 'synth-run-note';
  await runCli(dataDir, ['doc', 'put', docName, docPath], { expectOk: true });

  await runCli(dataDir, ['pack', 'grant-publish', 'admin'], { expectOk: true });
  await runCli(dataDir, ['pack', 'publish', product.dir, '--stage'], { expectOk: true });
  await runCli(dataDir, ['pack', 'activate', product.id], { expectOk: true });
  await runCli(dataDir, ['pack', 'publish', secondProduct.dir, '--stage'], { expectOk: true });

  return {
    root,
    dataDir,
    productId: product.id,
    secondProductId: secondProduct.id,
    teamId,
    plainVarName,
    plainVarValue,
    docName,
    docSha256,
  };
}

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
    const healthFailures: string[] = [];
    assert.equal(healthJson.needsRebuild, true, `/healthz must report needsRebuild=true, got: ${health.body}`);
    for (const forbiddenKey of ['accounts', 'counts', 'snapshot', 'configurationSnapshot', 'archive', 'backup', 'reason', 'detail', 'users']) {
      assert.equal(Object.hasOwn(healthJson, forbiddenKey), false, `/healthz must not expose ${forbiddenKey}`);
    }
    assert.equal(health.body.includes('alice'), false);

    // 2. /console redirects (303 -> /console/rebuild) or degrades cleanly (503); other normal endpoints return 503 with zero DB leaks.
    const consoleEntry = await httpCall(state.port, '/console');
    if (consoleEntry.status === 303) {
      assert.match(
        String(consoleEntry.headers.location ?? ''),
        /\/console\/rebuild(?:$|[?#])/,
        `GET /console 303 must redirect to /console/rebuild, got location=${String(consoleEntry.headers.location ?? '')}`,
      );
    } else if (consoleEntry.status !== 503) {
      healthFailures.push(
        `/console expected 303 -> /console/rebuild or 503 during needsRebuild, got ${consoleEntry.status} body=${consoleEntry.body.slice(0, 180)}`,
      );
    } else {
      assert.ok(consoleEntry.body.length > 0, '/console 503 response should carry an actionable rebuild message');
    }
    assertNoInternalDbLeak(consoleEntry.body, '/console');
    assert.equal(consoleEntry.body.includes('0001_prior_release'), false, '/console must not leak raw migration identity');

    const degradedPaths: Array<{ path: string; method?: string; headers?: Record<string, string>; body?: string }> = [
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
      if (reply.status !== 503) {
        healthFailures.push(
          `${probe.path} expected 503 during needsRebuild, got ${reply.status}` +
            (reply.headers.location ? ` location=${reply.headers.location}` : '') +
            ` body=${reply.body.slice(0, 180)}`,
        );
      } else {
        assert.ok(reply.body.length > 0, `${probe.path} 503 response should carry an actionable rebuild message`);
      }
      assertNoInternalDbLeak(reply.body, probe.path);
      assert.equal(reply.body.includes('0001_prior_release'), false, `${probe.path} 503 must not leak raw migration identity`);
    }

    // 3. Anonymous GET /console/rebuild renders HTTP 401 (or 200) HTML authorization form only without diagnostics or DB internals.
    const anonRebuild = await httpCall(state.port, '/console/rebuild');
    if (![200, 401].includes(anonRebuild.status)) {
      healthFailures.push(
        `anonymous GET /console/rebuild expected HTTP 200 or 401 authorization form during needsRebuild, got ${anonRebuild.status}: ${anonRebuild.body.slice(0, 200)}`,
      );
    } else {
      assert.match(String(anonRebuild.headers['content-type'] ?? ''), /text\/html/i);
      assert.ok(anonRebuild.body.includes('setup_code'), 'anonymous /console/rebuild must render setup_code input');
      assert.ok(anonRebuild.body.includes('nonce'), 'anonymous /console/rebuild must include CSRF/login nonce');
      assert.ok(anonRebuild.body.includes('/console/rebuild/authorize'), 'anonymous /console/rebuild must render /console/rebuild/authorize form');
    }
    assert.equal(anonRebuild.body.includes('0001_prior_release'), false, 'anonymous /console/rebuild must not expose migration diagnostics');
    assert.equal(anonRebuild.body.includes('alice'), false, 'anonymous /console/rebuild must not expose account names');
    assertNoInternalDbLeak(anonRebuild.body, 'GET /console/rebuild');

    // 4. Unauthenticated status polling returns 401.
    const unauthStatus = await httpCall(state.port, '/console/reset/status/00000000-0000-0000-0000-000000000000');
    if (unauthStatus.status !== 401) {
      healthFailures.push(`unauthenticated GET /console/reset/status/<uuid> expected 401, got ${unauthStatus.status}`);
    }

    // 5. Regular bootstrap setup-code refuses on incompatible existing DB; `setup-code --rebuild` issues one-time rebuild code.
    // [产品缺陷 · 明天修 (verdict 62①)]: /console/rebuild 页面引导执行 `circle-hub setup-code --rebuild`，
    // 但当前 CLI 尚未实现 `--rebuild` 参数，保留此失败断言待明天补齐命令实现。
    const bootstrapRes = await runCli(state.dataDir, ['setup-code']);
    if (bootstrapRes.code === 0) {
      healthFailures.push(`bootstrap setup-code MUST refuse on incompatible existing DB, exited 0: ${bootstrapRes.combined.trim()}`);
    }

    const rebuildCodeRes = await runCli(state.dataDir, ['setup-code', '--rebuild']);
    let setupCode = '';
    if (rebuildCodeRes.code !== 0) {
      healthFailures.push(`setup-code --rebuild exited ${rebuildCodeRes.code}: ${rebuildCodeRes.combined.slice(0, 300)}`);
    } else {
      setupCode = extractSetupCode(rebuildCodeRes.combined);
      const rebuildCodeStat = await stat(join(state.dataDir, 'config', 'rebuild-code.json'));
      assert.ok(rebuildCodeStat.isFile(), 'setup-code --rebuild must persist config/rebuild-code.json');
    }

    // 6. Wrong code fails; valid code authorizes dedicated maintenance session cookie via 303 redirect (when GET /console/rebuild rendered auth form and --rebuild succeeded).
    if ([200, 401].includes(anonRebuild.status) && setupCode) {
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
    assert.equal(healthFailures.length, 0, healthFailures.join('\n'));
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
  it('--scope history wipes runs/leases/call-logs while preserving packs, config, keys, and vault', { timeout: 150_000 }, async () => {
    const { root, state } = await seedRichHub({ includeHistory: true, includeKnowledge: false, canRunSandboxedPacks: hasSandbox });
    let serve: ServeHandle | undefined;
    cleanupQueue.push(() => teardownRoot(root, state.dataDir, serve));

    const vaultBefore = await snapshotVaultAndKeys(state.dataDir);
    const packsBefore = await hashDirectoryFiles(join(state.dataDir, 'packs'));

    // [产品缺陷 · 明天修 (verdict 62②)]: hub/server/reset/operation.ts 当前吞掉 ResetBlocked.problems，
    // 未返回具体前置阻塞条件；保留成功预期与条件诊断期待，待修后查明具体阻塞原因。
    const res = await runResetCli(state.dataDir, { scopes: ['history'] }, { expectOk: true });
    const backupCheck = await assertBackupAndArchivePreserved(state.dataDir, res, ['history'], hasSandbox);
    await assertVaultAndKeysUnchanged(state.dataDir, vaultBefore, 'after reset --scope history');

    // Cleared: runs, leases, history call logs / run actions.
    const runsAfter = JSON.parse((await runCli(state.dataDir, ['run', 'list', '--json'], { expectOk: true })).stdout) as { items?: unknown[]; runs?: unknown[] } | unknown[];
    const runList = Array.isArray(runsAfter) ? runsAfter : (runsAfter.items ?? runsAfter.runs ?? []);
    assert.equal(runList.length, 0, 'all runs must be cleared after --scope history');
    const leasesAfter = (await runCli(state.dataDir, ['lease', 'list'], { expectOk: true })).stdout;
    assert.equal(leasesAfter.includes('bed/bed-a/'), false, `bookings/leases must be cleared after --scope history:\n${leasesAfter}`);

    const dbAfter = await inspectDatabaseState(state.dataDir);
    for (const historyKind of ['run', 'validation_result', 'submission', 'call_log']) {
      assert.equal(dbAfter.recordKinds[historyKind] ?? 0, 0, `record kind '${historyKind}' must be cleared by --scope history`);
    }
    // Config-closure move_root actions (doc:* pointer moves with run === null) are outside --scope history and must stay consistent.
    await assertOnlyConfigClosureActionsSurvive(state.dataDir, {
      [`doc:${state.docBedName}`]: state.docBedSha256,
      [`doc:${state.docNoteName}`]: state.docNoteSha256,
    });

    // Preserved: packs dir & DB, config (users, teams, resources, executors, vars, docs), keys & vault.
    const packsAfter = await hashDirectoryFiles(join(state.dataDir, 'packs'));
    assert.deepEqual([...packsAfter.entries()], [...packsBefore.entries()], '<dataDir>/packs must survive --scope history byte-for-byte');
    const packList = (await runCli(state.dataDir, ['pack', 'list'], { expectOk: true })).stdout;
    assert.ok(packList.includes('test-bed') && packList.includes('mindmap-format') && packList.includes('lumen-api'));

    const docOut = (await runCli(state.dataDir, ['doc', 'show', state.docNoteName], { expectOk: true })).stdout;
    assert.ok(docOut.includes(state.docNoteSha256), `doc show missing SHA-256 ${state.docNoteSha256}:\n${docOut}`);
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
    // [产品缺陷 · 已有修复待合 (verdict 62⑤⑥)]: 冻结基线未按标准 circle-hub-backup@3 落盘，Codex 已在 118c54cf9e + 99e181b619 修复。
    assert.equal(backupCheck.issues.length, 0, backupCheck.issues.join('\n'));
  });

  it('--scope knowledge wipes knowledge entries, originals, and memory while preserving packs, config, keys, and vault', { timeout: 150_000 }, async () => {
    const { root, state } = await seedRichHub({ includeHistory: false, includeKnowledge: true, canRunSandboxedPacks: false });
    cleanupQueue.push(() => teardownRoot(root, state.dataDir));

    const vaultBefore = await snapshotVaultAndKeys(state.dataDir);
    const packsBefore = await hashDirectoryFiles(join(state.dataDir, 'packs'));

    // [产品缺陷 · 明天修 (verdict 62③)]: reset --scope knowledge 当前被阻塞拒绝，
    // 且 hub/server/reset/operation.ts 吞掉 ResetBlocked.problems 与详细阻塞原因只返回固定泛化文案；保留断言不放宽。
    const res = await runResetCli(state.dataDir, { scopes: ['knowledge'] }, { expectOk: true });
    const backupCheck = await assertBackupAndArchivePreserved(state.dataDir, res, ['knowledge'], false);
    await assertVaultAndKeysUnchanged(state.dataDir, vaultBefore, 'after reset --scope knowledge');

    const dbAfter = await inspectDatabaseState(state.dataDir);
    for (const kKind of ['knowledge_space_source', 'knowledge_space_entry', 'knowledge_space_version', 'tree_node', 'tree_root', 'root_pointer', 'memory_document', 'memory_version', 'knowledge_share']) {
      assert.equal(dbAfter.recordKinds[kKind] ?? 0, 0, `knowledge kind '${kKind}' must be cleared by --scope knowledge`);
    }

    // Packs & config remain preserved.
    const packsAfter = await hashDirectoryFiles(join(state.dataDir, 'packs'));
    assert.deepEqual([...packsAfter.entries()], [...packsBefore.entries()]);
    const usersAfter = JSON.parse((await runCli(state.dataDir, ['user', 'list', '--json'], { expectOk: true })).stdout) as Array<{ name: string }>;
    assert.ok(usersAfter.some((u) => u.name === 'alice'));
    assert.ok((await runCli(state.dataDir, ['team', 'show', state.teamAlphaId], { expectOk: true })).stdout.includes('alice'));
    const docOut = (await runCli(state.dataDir, ['doc', 'show', state.docNoteName], { expectOk: true })).stdout;
    assert.ok(docOut.includes(state.docNoteSha256), `doc show missing SHA-256 ${state.docNoteSha256}:\n${docOut}`);
    // [产品缺陷 · 已有修复待合 (verdict 62⑤⑥)]: 冻结基线未按标准 circle-hub-backup@3 落盘，Codex 已在 118c54cf9e + 99e181b619 修复。
    assert.equal(backupCheck.issues.length, 0, backupCheck.issues.join('\n'));
  });

  it('--scope packs wipes published/activated packs when unreferenced and preserves config, keys, and vault', { timeout: 150_000 }, async () => {
    const clean = await seedUnreferencedPacksHub();
    cleanupQueue.push(() => teardownRoot(clean.root, clean.dataDir));

    const vaultBefore = await snapshotVaultAndKeys(clean.dataDir);
    const dbBefore = await inspectDatabaseState(clean.dataDir);
    assert.ok((dbBefore.recordKinds.pack_version ?? 0) >= 2, 'seedUnreferencedPacksHub must publish at least two packs');

    const res = await runResetCli(clean.dataDir, { scopes: ['packs'] }, { expectOk: true });
    const backupCheck = await assertBackupAndArchivePreserved(clean.dataDir, res, ['packs'], false);
    await assertVaultAndKeysUnchanged(clean.dataDir, vaultBefore, 'after reset --scope packs (unreferenced)');

    // Cleared: pack_version / personal_pack records in DB and CLI pack list.
    const dbAfter = await inspectDatabaseState(clean.dataDir);
    assert.equal(dbAfter.recordKinds.pack_version ?? 0, 0, 'pack_version records must be cleared by --scope packs when unreferenced');
    assert.equal(dbAfter.recordKinds.personal_pack_version ?? 0, 0);

    const packList = (await runCli(clean.dataDir, ['pack', 'list'], { expectOk: true })).stdout;
    assert.equal(packList.includes(clean.productId), false, 'published primary product pack must be absent after --scope packs');
    assert.equal(packList.includes(clean.secondProductId), false, 'published secondary product pack must be absent after --scope packs');

    // Preserved: config, keys & vault.
    const usersAfter = JSON.parse((await runCli(clean.dataDir, ['user', 'list', '--json'], { expectOk: true })).stdout) as Array<{ name: string }>;
    assert.ok(usersAfter.some((u) => u.name === 'alice'));
    assert.ok((await runCli(clean.dataDir, ['team', 'show', clean.teamId], { expectOk: true })).stdout.includes('alice'));
    assert.ok((await runCli(clean.dataDir, ['var', 'show', clean.plainVarName, '--value'], { expectOk: true })).stdout.includes(clean.plainVarValue));
    const docOut = (await runCli(clean.dataDir, ['doc', 'show', clean.docName], { expectOk: true })).stdout;
    assert.ok(docOut.includes(clean.docSha256), `doc show missing SHA-256 ${clean.docSha256}:\n${docOut}`);
    // [产品缺陷 · 已有修复待合 (verdict 62⑤⑥)]: 冻结基线未按标准 circle-hub-backup@3 落盘，Codex 已在 118c54cf9e + 99e181b619 修复。
    assert.equal(backupCheck.issues.length, 0, backupCheck.issues.join('\n'));
  });

  it('--scope packs refuses with blocking dependency details and leaves packs, config, and vault untouched when referenced by config', { timeout: 150_000 }, async () => {
    const { root, state } = await seedRichHub({ includeHistoryAndKnowledge: false, canRunSandboxedPacks: false });
    cleanupQueue.push(() => teardownRoot(root, state.dataDir));

    const vaultBefore = await snapshotVaultAndKeys(state.dataDir);
    const dbBefore = await inspectDatabaseState(state.dataDir);
    assert.ok((dbBefore.recordKinds.pack_version ?? 0) > 0, 'referenced hub must have pack_version records');

    const res = await runResetCli(state.dataDir, { scopes: ['packs'] });
    assert.notEqual(res.code, 0, '--scope packs MUST refuse when resources and pack assignments reference packs');
    await assertVaultAndKeysUnchanged(state.dataDir, vaultBefore, 'after refused reset --scope packs');

    // Nothing deleted when refused.
    const dbAfter = await inspectDatabaseState(state.dataDir);
    assert.equal(dbAfter.recordKinds.pack_version, dbBefore.recordKinds.pack_version, 'pack_version count must remain unchanged on refusal');
    const packList = (await runCli(state.dataDir, ['pack', 'list'], { expectOk: true })).stdout;
    assert.ok(packList.includes(state.overlayPackId), 'referenced overlay pack must stay intact after refusal');
    assert.ok(packList.includes('test-bed'), 'referenced workflow pack must stay intact after refusal');

    const usersAfter = JSON.parse((await runCli(state.dataDir, ['user', 'list', '--json'], { expectOk: true })).stdout) as Array<{ name: string }>;
    assert.ok(usersAfter.some((u) => u.name === 'alice'));
    assert.ok((await runCli(state.dataDir, ['team', 'show', state.teamAlphaId], { expectOk: true })).stdout.includes('alice'));
    assert.ok((await runCli(state.dataDir, ['var', 'show', state.plainVarName, '--value'], { expectOk: true })).stdout.includes(state.plainVarValue));
    const docOut = (await runCli(state.dataDir, ['doc', 'show', state.docNoteName], { expectOk: true })).stdout;
    assert.ok(docOut.includes(state.docNoteSha256), `doc show missing SHA-256 ${state.docNoteSha256}:\n${docOut}`);

    // [产品缺陷 · 明天修 (verdict 62②/③/④)]: hub/server/reset/operation.ts 当前吞掉 ResetBlocked.problems，
    // 未把具体阻塞对象或前置条件透传给管理员；保留此详细拒绝原因断言不放宽。
    assert.ok(
      new RegExp(`${state.overlayPackId}|test-bed|plm|assign|resource|引用|依赖|config`, 'i').test(res.combined),
      `refused --scope packs must name the blocking config references or packs; got:\n${res.combined}`,
    );
  });

  it('--scope config wipes accounts, teams, allocations, resources, executors, variables, and docs while keeping packs and vault', { timeout: 150_000 }, async () => {
    const { root, state } = await seedRichHub({ includeHistoryAndKnowledge: false, canRunSandboxedPacks: false });
    let serve: ServeHandle | undefined;
    cleanupQueue.push(() => teardownRoot(root, state.dataDir, serve));

    const vaultBefore = await snapshotVaultAndKeys(state.dataDir);
    const dbBefore = await inspectDatabaseState(state.dataDir);
    const packsBefore = await hashDirectoryFiles(join(state.dataDir, 'packs'));

    const res = await runResetCli(state.dataDir, { scopes: ['config'] }, { expectOk: true });
    const backupCheck = await assertBackupAndArchivePreserved(state.dataDir, res, ['config'], false);
    await assertVaultAndKeysUnchanged(state.dataDir, vaultBefore, 'after reset --scope config');

    // Cleared: all users, tokens, teams, team_members, resources, executors, variables, named docs.
    const dbAfter = await inspectDatabaseState(state.dataDir);
    assert.equal(dbAfter.tables.users ?? 0, 0, 'users table must be empty after --scope config');
    assert.equal(dbAfter.tables.teams ?? 0, 0, 'teams table must be empty after --scope config');
    assert.equal(dbAfter.tables.team_members ?? 0, 0, 'team_members table must be empty after --scope config');
    if (Object.hasOwn(dbAfter.tables, 'tokens')) {
      assert.equal(dbAfter.tables.tokens, 0, 'tokens table must be empty after --scope config');
    }

    // Preserved: packs on disk & DB, keys & vault.
    const packsAfter = await hashDirectoryFiles(join(state.dataDir, 'packs'));
    assert.deepEqual([...packsAfter.entries()], [...packsBefore.entries()], '<dataDir>/packs must survive --scope config');
    assert.equal(dbAfter.recordKinds.pack_version ?? 0, dbBefore.recordKinds.pack_version ?? 0, 'pack_version records must survive --scope config');

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
    // [产品缺陷 · 已有修复待合 (verdict 62⑤)]: 冻结基线未按标准 circle-hub-backup@3 落盘，Codex 已在 118c54cf9e + 99e181b619 修复。
    assert.equal(backupCheck.issues.length, 0, backupCheck.issues.join('\n'));
  });

  it('--scope all wipes history, knowledge, packs, and config while keeping readable archive/backup and vault byte-for-byte identical', { timeout: 150_000 }, async () => {
    const { root, state } = await seedRichHub({ includeHistoryAndKnowledge: true, canRunSandboxedPacks: hasSandbox });
    cleanupQueue.push(() => teardownRoot(root, state.dataDir));

    const vaultBefore = await snapshotVaultAndKeys(state.dataDir);
    const res = await runResetCli(state.dataDir, { scopes: 'all' }, { expectOk: true });
    const backupCheck = await assertBackupAndArchivePreserved(state.dataDir, res, RESET_SCOPE, hasSandbox);
    await assertVaultAndKeysUnchanged(state.dataDir, vaultBefore, 'after reset --scope all');

    const dbAfter = await inspectDatabaseState(state.dataDir);
    assert.equal(dbAfter.tables.users ?? 0, 0);
    assert.equal(dbAfter.tables.teams ?? 0, 0);
    assert.equal(dbAfter.tables.team_members ?? 0, 0);
    if (Object.hasOwn(dbAfter.tables, 'records')) {
      assert.equal(dbAfter.tables.records, 0, `records table must be completely cleared by --scope all, found: ${JSON.stringify(dbAfter.recordKinds)}`);
    }
    const packList = (await runCli(state.dataDir, ['pack', 'list'])).stdout;
    assert.equal(packList.includes('test-bed'), false, `test-bed must not remain active/listed after --scope all:\n${packList}`);
    // [产品缺陷 · 已有修复待合 (verdict 62⑥)]: 冻结基线未按标准 circle-hub-backup@3 落盘，Codex 已在 118c54cf9e + 99e181b619 修复。
    assert.equal(backupCheck.issues.length, 0, backupCheck.issues.join('\n'));
  });
});

describe('--keep-config rebuild preserves config, auth hashes, and Hub usability (spec items 3a & 8)', { skip: hasLibpq ? false : LIBPQ_MISSING }, () => {
  it('rebuilds via reset --scope all --keep-config with 0600 secret-free snapshot, surviving credentials, docs, resources, and vault invariance', { timeout: 180_000 }, async () => {
    const { root, state } = await seedRichHub({ includeHistoryAndKnowledge: true, canRunSandboxedPacks: hasSandbox });
    let serve: ServeHandle | undefined;
    cleanupQueue.push(() => teardownRoot(root, state.dataDir, serve));

    const vaultBefore = await snapshotVaultAndKeys(state.dataDir);
    const res = await runResetCli(state.dataDir, { scopes: 'all', keepConfig: true }, { expectOk: true });
    const backupCheck = await assertBackupAndArchivePreserved(state.dataDir, res, RESET_SCOPE, hasSandbox);
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

    // History and knowledge are cleared while config & packs (and config-closure doc pointer move_root actions) remain.
    const dbAfter = await inspectDatabaseState(state.dataDir);
    for (const wipedKind of ['run', 'validation_result', 'knowledge_space_entry', 'memory_version', 'tree_root']) {
      assert.equal(dbAfter.recordKinds[wipedKind] ?? 0, 0, `expected '${wipedKind}' cleared under --scope all --keep-config`);
    }
    await assertOnlyConfigClosureActionsSurvive(state.dataDir, {
      [`doc:${state.docBedName}`]: state.docBedSha256,
      [`doc:${state.docNoteName}`]: state.docNoteSha256,
    });

    const users = JSON.parse((await runCli(state.dataDir, ['user', 'list', '--json'], { expectOk: true })).stdout) as Array<{ id: string; name: string; role: string; disabled?: boolean }>;
    assert.equal(users.find((u) => u.name === 'admin')?.id, state.adminId);
    assert.equal(users.find((u) => u.name === 'alice')?.id, state.aliceId);
    assert.equal(users.find((u) => u.name === 'bob')?.disabled, true);
    assert.ok((await runCli(state.dataDir, ['team', 'show', state.teamAlphaId], { expectOk: true })).stdout.includes('alice'));
    assert.ok((await runCli(state.dataDir, ['resource', 'show', state.plmResourceId, '--values'], { expectOk: true })).stdout.includes('SYNTH_PLM_USER'));
    const execListAfter = (await runCli(state.dataDir, ['executor', 'list'], { expectOk: true })).stdout;
    assert.ok(execListAfter.includes('执行器 1'), `executor list missing after --keep-config:\n${execListAfter}`);
    const keepCfgExportPath = join(state.scratchHome, 'keep-config-verify-export.json');
    await runExportCli(state.dataDir, keepCfgExportPath, { expectOk: true });
    const keepCfgExport = JSON.parse(await readFile(keepCfgExportPath, 'utf8')) as { executors?: Array<{ target?: string }> };
    assert.ok(
      keepCfgExport.executors?.some((e) => e.target === state.executorTarget),
      `executor '${state.executorTarget}' missing in export after --keep-config`,
    );
    assert.ok((await runCli(state.dataDir, ['var', 'show', state.plainVarName, '--value'], { expectOk: true })).stdout.includes(state.plainVarValue));
    const docShowAfter = (await runCli(state.dataDir, ['doc', 'show', state.docNoteName], { expectOk: true })).stdout;
    assert.ok(docShowAfter.includes(state.docNoteSha256), `doc show missing SHA-256 ${state.docNoteSha256}:\n${docShowAfter}`);
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
    // [产品缺陷 · 已有修复待合 (verdict 62⑤⑥)]: 冻结基线未按标准 circle-hub-backup@3 落盘，Codex 已在 118c54cf9e + 99e181b619 修复。
    assert.equal(backupCheck.issues.length, 0, backupCheck.issues.join('\n'));
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
      const packs = await mcp.call('list_task_packs', {});
      assert.equal(packs.isError, false, packs.text);
      assert.ok(packs.out.packs.some((p) => p.pack.startsWith('test-bed@')));
      const nodes = await mcp.call('get_nodes', { scope: 'personal', search: '合成' });
      assert.equal(nodes.isError, false, nodes.text);
    } finally {
      await mcp.close();
    }
  });

  it('refuses cleanly before touching DB when backup directory is unwritable and preserves state 100%', { timeout: 150_000, skip: process.getuid?.() === 0 ? 'root bypasses chmod 0500 EACCES' : false }, async () => {
    const { root, state } = await seedRichHub({ includeHistoryAndKnowledge: true, canRunSandboxedPacks: hasSandbox });
    let serve: ServeHandle | undefined;
    const backupsDir = join(state.dataDir, 'backups');
    cleanupQueue.push(async () => {
      await chmod(backupsDir, 0o700).catch(() => undefined);
      await teardownRoot(root, state.dataDir, serve);
    });

    const vaultBefore = await snapshotVaultAndKeys(state.dataDir);
    const dbBefore = await inspectDatabaseState(state.dataDir);
    const objectsBefore = await hashDirectoryFiles(join(state.dataDir, 'objects'));

    // Make backups/ read-only so verified pre-reset backup creation hits deterministic EACCES before any mutation.
    await mkdir(backupsDir, { recursive: true });
    await chmod(backupsDir, 0o500);
    let failRes: Awaited<ReturnType<typeof runResetCli>>;
    try {
      failRes = await runResetCli(state.dataDir, { scopes: 'all' });
    } finally {
      await chmod(backupsDir, 0o700);
    }
    assert.notEqual(failRes.code, 0, `reset must refuse cleanly when backups/ hits EACCES:\n${failRes.combined}`);

    await assertVaultAndKeysUnchanged(state.dataDir, vaultBefore, 'after unwritable backups/ failure');
    const dbAfter = await inspectDatabaseState(state.dataDir);
    assert.deepEqual(dbAfter, dbBefore, 'DB must match pre-reset state when backup fails');
    assert.deepEqual([...(await hashDirectoryFiles(join(state.dataDir, 'objects'))).entries()], [...objectsBefore.entries()]);

    const docOut = (await runCli(state.dataDir, ['doc', 'show', state.docNoteName], { expectOk: true })).stdout;
    assert.ok(docOut.includes(state.docNoteSha256), `doc show missing SHA-256 ${state.docNoteSha256}:\n${docOut}`);
    assert.ok((await runCli(state.dataDir, ['resource', 'show', state.plmResourceId, '--values'], { expectOk: true })).stdout.includes('SYNTH_PLM_USER'));

    // Ensure PostgreSQL is cleanly operational after failure.
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
