// Cleanroom black-box acceptance tests for declarative deployment definitions (`circle-hub export` / `apply`).
// Covers Spec Items 3b, 6, 7, and 8 against real PostgreSQL, temporary CIRCLE_HUB_DATA_DIR, and bin/circle-hub.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { DeploymentDefinition } from '../../contracts/src/deployment.ts';
import { RESET_SCOPE } from '../../contracts/src/reset.ts';
import { LIBPQ_MISSING, libpqAvailable } from '../../hub/platform/test-support.ts';
import { osIsolationAvailable } from '../../hub/rules/api.ts';
import {
  LOOPBACK_EXEC_ALT,
  LOOPBACK_EXEC_ENDPOINT,
  RFC5737_PLM_ALT,
  RFC5737_PLM_API,
  assertBackupAndArchivePreserved,
  assertVaultAndKeysUnchanged,
  connectMcpHttp,
  extractDbAuthHashes,
  inspectDatabaseState,
  runApplyCli,
  runCli,
  runExportCli,
  runResetCli,
  seedRichHub,
  snapshotVaultAndKeys,
  spawnServe,
  teardownRoot,
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

/** Helper to run CLI list assertions across users, teams, packs, resources, executors, vars, and docs. */
async function readConfigCliSnapshot(dataDir: string, asAdmin = 'admin') {
  const usersRes = await runCli(dataDir, ['user', 'list', '--json', '--as', asAdmin], { expectOk: true });
  const users = JSON.parse(usersRes.stdout) as Array<{ id: string; name: string; role: string; disabled?: boolean }>;
  const teams = (await runCli(dataDir, ['team', 'list', '--as', asAdmin], { expectOk: true })).stdout;
  const packs = (await runCli(dataDir, ['pack', 'list', '--as', asAdmin], { expectOk: true })).stdout;
  const resources = (await runCli(dataDir, ['resource', 'list', '--as', asAdmin], { expectOk: true })).stdout;
  const executors = (await runCli(dataDir, ['executor', 'list', '--as', asAdmin], { expectOk: true })).stdout;
  const vars = (await runCli(dataDir, ['var', 'list', '--as', asAdmin], { expectOk: true })).stdout;
  const docs = (await runCli(dataDir, ['doc', 'list', '--as', asAdmin], { expectOk: true })).stdout;
  return { users, teams, packs, resources, executors, vars, docs };
}

/** Mutates a nested JSON entry matching targetName by replacing a scalar field value for diff-refusal checks. */
function mutateOptionalSectionField(
  exportedObj: Record<string, unknown>,
  sectionCandidates: readonly string[],
  targetName: string,
  mutator: (entry: Record<string, unknown>) => boolean,
): boolean {
  for (const section of sectionCandidates) {
    const val = exportedObj[section];
    if (Array.isArray(val)) {
      for (const item of val) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const rec = item as Record<string, unknown>;
          if (rec.name === targetName || rec.id === targetName || rec.key === targetName) {
            if (mutator(rec)) return true;
          }
        }
      }
    } else if (val && typeof val === 'object' && !Array.isArray(val)) {
      const map = val as Record<string, unknown>;
      const entry = map[targetName];
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        if (mutator(entry as Record<string, unknown>)) return true;
      }
    }
  }
  return false;
}

describe('deployment definition export excludes all secret values (spec item 7)', () => {
  it('omits vault secrets, passwords, API tokens, operator tokens, master keys, DB hashes, and vault ciphertext', async () => {
    const { root, state } = await seedRichHub({ includeHistoryAndKnowledge: false, canRunSandboxedPacks: false });
    cleanupQueue.push(() => teardownRoot(root, state.dataDir));

    const vaultBefore = await snapshotVaultAndKeys(state.dataDir);
    const dbHashes = await extractDbAuthHashes(state.dataDir);
    const exportPath = join(state.scratchHome, 'exported-secrets-check.json');
    const exportRes = await runExportCli(state.dataDir, exportPath, { expectOk: true });

    const exportedRaw = await readFile(exportPath, 'utf8');
    const parsed = DeploymentDefinition.parse(JSON.parse(exportedRaw));
    assert.equal(parsed.schema, 'deployment@1');

    const forbiddenValues = [
      state.canaries.adminPassword,
      ...state.canaries.userPasswords,
      state.canaries.aliceToken,
      state.canaries.plmUserSecret,
      state.canaries.plmPassSecret,
      state.canaries.execSecret,
      state.canaries.varSecret,
      state.canaries.extraSecret,
      ...dbHashes,
      ...vaultBefore.rawSubstrings,
    ].filter((v) => v.length >= 6);

    for (const secret of forbiddenValues) {
      assert.equal(exportedRaw.includes(secret), false, `exported definition must not leak secret material (length=${secret.length})`);
      assert.equal(exportRes.combined.includes(secret), false, `export stdout/stderr must not leak secret material (length=${secret.length})`);
    }

    // Secret reference names and non-secret structural configuration must still be exported.
    assert.ok(parsed.accounts.some((a) => a.name === 'alice' && a.role === 'user' && a.disabled === false));
    assert.ok(parsed.accounts.some((a) => a.name === 'bob' && a.disabled === true));
    assert.ok(parsed.teams.some((t) => t.name === '研发测试组' && t.members.includes('alice')));
    const exportedPlm = parsed.resources.find((r) => r.definition.name === 'synth-plm');
    assert.ok(exportedPlm, 'exported definition must contain synth-plm resource');
    assert.equal(exportedPlm.definition.credentials.username, 'SYNTH_PLM_USER');
    assert.equal(exportedPlm.definition.credentials.password, 'SYNTH_PLM_PASS');
    assert.equal(exportedPlm.definition.origins['plm-api'], RFC5737_PLM_API);
    const exportedExec = parsed.executors.find((e) => e.target === state.executorTarget);
    assert.ok(exportedExec, 'exported definition must contain synthetic executor');
    assert.equal(exportedExec.credential, '${secret:SYNTH_EXEC_TOKEN}');
  });
});

describe('deployment definition apply idempotency and field-level diff refusal (spec item 6)', () => {
  it('applies an identical exported definition twice without duplicating rows or failing', async () => {
    const { root, state } = await seedRichHub({ includeHistoryAndKnowledge: false, canRunSandboxedPacks: false });
    cleanupQueue.push(() => teardownRoot(root, state.dataDir));

    const exportPath = join(state.scratchHome, 'idempotent-export.json');
    await runExportCli(state.dataDir, exportPath, { expectOk: true });

    const dbBefore = await inspectDatabaseState(state.dataDir);
    const cliBefore = await readConfigCliSnapshot(state.dataDir);

    await runApplyCli(state.dataDir, exportPath, { expectOk: true });
    await runApplyCli(state.dataDir, exportPath, { expectOk: true });

    const dbAfter = await inspectDatabaseState(state.dataDir);
    const cliAfter = await readConfigCliSnapshot(state.dataDir);

    assert.equal(cliAfter.users.length, cliBefore.users.length, 'repeated apply must not duplicate user accounts');
    assert.equal(cliAfter.teams, cliBefore.teams, 'repeated apply must keep teams identical');
    assert.equal(cliAfter.resources, cliBefore.resources, 'repeated apply must keep resources identical');
    assert.equal(cliAfter.executors, cliBefore.executors, 'repeated apply must keep executors identical');
    assert.equal(cliAfter.vars, cliBefore.vars, 'repeated apply must keep variables identical');
    assert.equal(cliAfter.docs, cliBefore.docs, 'repeated apply must keep named documents identical');
    assert.equal(dbAfter.tables.teams, dbBefore.tables.teams);
    assert.equal(dbAfter.tables.team_members, dbBefore.tables.team_members);
    assert.equal(dbAfter.tables.users, dbBefore.tables.users);
  });

  it('refuses non-trivial field diffs cleanly, avoids overwriting existing state, and names the differing entity and field', async () => {
    const { root, state } = await seedRichHub({ includeHistoryAndKnowledge: false, canRunSandboxedPacks: false });
    cleanupQueue.push(() => teardownRoot(root, state.dataDir));

    const basePath = join(state.scratchHome, 'base-diff-export.json');
    await runExportCli(state.dataDir, basePath, { expectOk: true });
    const baseRaw = await readFile(basePath, 'utf8');
    const baseParsed = DeploymentDefinition.parse(JSON.parse(baseRaw));

    const writeMutated = async (name: string, obj: unknown): Promise<string> => {
      const p = join(state.scratchHome, name);
      await writeFile(p, JSON.stringify(obj, null, 2), 'utf8');
      return p;
    };

    // 1. Account role change (alice: user -> admin).
    const diffAccount = structuredClone(baseParsed);
    const aliceEntry = diffAccount.accounts.find((a) => a.name === 'alice');
    assert.ok(aliceEntry);
    aliceEntry.role = 'admin';
    const accountRes = await runApplyCli(state.dataDir, await writeMutated('diff-account.json', diffAccount));
    assert.notEqual(accountRes.code, 0, `mutated account role must be rejected:\n${accountRes.combined}`);
    assert.ok(accountRes.combined.includes('alice'), `refusal output must name 'alice':\n${accountRes.combined}`);
    assert.match(accountRes.combined, /role|角色/i, `refusal output must name role field:\n${accountRes.combined}`);

    // 2. Team membership change (remove alice from 研发测试组).
    const diffTeam = structuredClone(baseParsed);
    const teamEntry = diffTeam.teams.find((t) => t.name === '研发测试组');
    assert.ok(teamEntry);
    teamEntry.members = [];
    const teamRes = await runApplyCli(state.dataDir, await writeMutated('diff-team.json', diffTeam));
    assert.notEqual(teamRes.code, 0, `mutated team members must be rejected:\n${teamRes.combined}`);
    assert.ok(teamRes.combined.includes('研发测试组') || teamRes.combined.includes(state.teamAlphaId), `refusal output must name team '研发测试组' or '${state.teamAlphaId}':\n${teamRes.combined}`);
    assert.match(teamRes.combined, /member|成员/i, `refusal output must name members field:\n${teamRes.combined}`);

    // 3. Resource origin change (synth-plm plm-api -> RFC 5737 alternate).
    const diffResource = structuredClone(baseParsed);
    const resEntry = diffResource.resources.find((r) => r.definition.name === 'synth-plm');
    assert.ok(resEntry);
    resEntry.definition.origins['plm-api'] = RFC5737_PLM_ALT;
    const resourceRes = await runApplyCli(state.dataDir, await writeMutated('diff-resource.json', diffResource));
    assert.notEqual(resourceRes.code, 0, `mutated resource origin must be rejected:\n${resourceRes.combined}`);
    assert.ok(resourceRes.combined.includes('synth-plm') || resourceRes.combined.includes(state.plmResourceId), `refusal output must name 'synth-plm' or '${state.plmResourceId}':\n${resourceRes.combined}`);
    assert.match(resourceRes.combined, /origin|plm-api|地址|192\.0\.2/i, `refusal output must name differing origin field:\n${resourceRes.combined}`);

    // 4. Executor endpoint change (synthetic-bed endpoint port 19201 -> 19299).
    const diffExecutor = structuredClone(baseParsed);
    const execEntry = diffExecutor.executors.find((e) => e.target === state.executorTarget);
    assert.ok(execEntry);
    execEntry.endpoint = LOOPBACK_EXEC_ALT;
    const execRes = await runApplyCli(state.dataDir, await writeMutated('diff-executor.json', diffExecutor));
    assert.notEqual(execRes.code, 0, `mutated executor endpoint must be rejected:\n${execRes.combined}`);
    assert.ok(execRes.combined.includes(state.executorTarget), `refusal output must name executor '${state.executorTarget}':\n${execRes.combined}`);
    assert.match(execRes.combined, /endpoint|端点/i, `refusal output must name endpoint field:\n${execRes.combined}`);

    // 5. Workflow assignment diff (remove alice assignment).
    const diffAssign = structuredClone(baseParsed);
    diffAssign.workflowAssignments = diffAssign.workflowAssignments.filter(
      (a) => !('user' in a && a.user === 'alice' && a.pack === state.workflowId),
    );
    const assignRes = await runApplyCli(state.dataDir, await writeMutated('diff-assign.json', diffAssign));
    assert.notEqual(assignRes.code, 0, `mutated workflowAssignments must be rejected:\n${assignRes.combined}`);
    assert.match(assignRes.combined, /test-bed|alice|assignment|分配/i);

    // 6. Variable or named-document content diff if present in exported JSON.
    const rawVarClone = JSON.parse(baseRaw) as Record<string, unknown>;
    if (mutateOptionalSectionField(rawVarClone, ['variables', 'vars'], state.plainVarName, (rec) => {
      if (typeof rec.value === 'string') {
        rec.value = 'mutated-unexpected-var-value';
        return true;
      }
      return false;
    })) {
      const varRes = await runApplyCli(state.dataDir, await writeMutated('diff-var.json', rawVarClone));
      assert.notEqual(varRes.code, 0, `mutated variable value must be rejected:\n${varRes.combined}`);
      assert.ok(varRes.combined.includes(state.plainVarName), `refusal output must name '${state.plainVarName}':\n${varRes.combined}`);
    }

    const rawDocClone = JSON.parse(baseRaw) as Record<string, unknown>;
    if (mutateOptionalSectionField(rawDocClone, ['documents', 'namedDocuments', 'docs'], state.docNoteName, (rec) => {
      for (const field of ['content', 'text', 'body', 'bytes_base64', 'content_base64', 'base64']) {
        if (typeof rec[field] === 'string') {
          rec[field] = field.includes('base64')
            ? Buffer.from('mutated-doc-bytes-conflict', 'utf8').toString('base64')
            : 'mutated-doc-bytes-conflict';
          return true;
        }
      }
      return false;
    })) {
      const docRes = await runApplyCli(state.dataDir, await writeMutated('diff-doc.json', rawDocClone));
      assert.notEqual(docRes.code, 0, `mutated document bytes must be rejected:\n${docRes.combined}`);
      assert.ok(docRes.combined.includes(state.docNoteName), `refusal output must name '${state.docNoteName}':\n${docRes.combined}`);
    }

    // Confirm none of the refused applies mutated any existing live configuration.
    const usersAfter = JSON.parse((await runCli(state.dataDir, ['user', 'list', '--json'], { expectOk: true })).stdout) as Array<{ name: string; role: string }>;
    assert.equal(usersAfter.find((u) => u.name === 'alice')?.role, 'user', 'alice role must remain user after refused apply');
    const teamShow = (await runCli(state.dataDir, ['team', 'show', state.teamAlphaId], { expectOk: true })).stdout;
    assert.ok(teamShow.includes('alice'), 'alice must remain in 研发测试组 after refused apply');
    const resShow = (await runCli(state.dataDir, ['resource', 'show', state.plmResourceId], { expectOk: true })).stdout;
    assert.ok(resShow.includes(RFC5737_PLM_API), 'plm-api origin must remain unchanged');
    assert.equal(resShow.includes(RFC5737_PLM_ALT), false, 'mutated plm-api origin must not overwrite existing resource');
    const execShow = (await runCli(state.dataDir, ['executor', 'list'], { expectOk: true })).stdout;
    assert.ok(execShow.includes(LOOPBACK_EXEC_ENDPOINT) || !execShow.includes(LOOPBACK_EXEC_ALT));
    const varVal = (await runCli(state.dataDir, ['var', 'show', state.plainVarName, '--value'], { expectOk: true })).stdout;
    assert.ok(varVal.includes(state.plainVarValue));
    const docVal = (await runCli(state.dataDir, ['doc', 'show', state.docNoteName], { expectOk: true })).stdout;
    assert.equal(docVal.trim(), state.docNoteText.trim());
  });
});

describe('export -> reset --scope all -> apply round-trip rebuild & vault invariance (spec items 3b & 8)', { skip: hasLibpq ? false : LIBPQ_MISSING }, () => {
  it('rebuilds full usable Hub configuration after wiping DB while keeping keys/ and vault/ byte-for-byte identical', { timeout: 180_000 }, async () => {
    const { root, state } = await seedRichHub({ includeHistoryAndKnowledge: true, canRunSandboxedPacks: hasSandbox });
    let serve: ServeHandle | undefined;
    cleanupQueue.push(() => teardownRoot(root, state.dataDir, serve));

    const exportPath = join(state.scratchHome, 'roundtrip-export.json');
    await runExportCli(state.dataDir, exportPath, { expectOk: true });
    const vaultBefore = await snapshotVaultAndKeys(state.dataDir);

    const resetRes = await runResetCli(state.dataDir, { scopes: 'all' }, { expectOk: true });
    await assertBackupAndArchivePreserved(state.dataDir, resetRes, RESET_SCOPE, hasSandbox);
    await assertVaultAndKeysUnchanged(state.dataDir, vaultBefore, 'immediately after reset --scope all');

    // Confirm config and history are cleared before applying the deployment definition.
    const dbEmpty = await inspectDatabaseState(state.dataDir);
    assert.equal(dbEmpty.tables.users ?? 0, 0, 'all users must be cleared by reset --scope all before apply');
    assert.equal(dbEmpty.tables.teams ?? 0, 0, 'all teams must be cleared by reset --scope all before apply');
    assert.equal(dbEmpty.tables.team_members ?? 0, 0, 'all team_members must be cleared by reset --scope all before apply');

    await runApplyCli(state.dataDir, exportPath, { expectOk: true });
    await assertVaultAndKeysUnchanged(state.dataDir, vaultBefore, 'after apply');

    // Refresh local operator-token only if pre-reset operator token is no longer bound after full apply (plan.md:40).
    const probeUsers = await runCli(state.dataDir, ['user', 'list', '--json']);
    if (probeUsers.code !== 0) {
      await runCli(state.dataDir, ['operator-token', 'remove', '--confirm-only-operator-token'], { expectOk: true });
      await runCli(state.dataDir, ['operator-token', 'reissue', '--as', 'admin'], { expectOk: true });
    }

    // Inspect accounts, teams, packs (including whole-Hub activation), assignments, resources, executors, variables, docs.
    const snap = await readConfigCliSnapshot(state.dataDir, 'admin');
    const adminAfter = snap.users.find((u) => u.name === 'admin');
    const aliceAfter = snap.users.find((u) => u.name === 'alice');
    const bobAfter = snap.users.find((u) => u.name === 'bob');
    assert.equal(adminAfter?.role, 'admin');
    assert.equal(adminAfter?.disabled ?? false, false);
    assert.equal(aliceAfter?.role, 'user');
    assert.equal(aliceAfter?.disabled ?? false, false);
    assert.equal(bobAfter?.disabled, true);

    assert.ok(snap.teams.includes('研发测试组') && snap.teams.includes('辅助观测组'));
    const alphaTeamId = /tm_[0-7][0-9a-hjkmnp-tv-z]{25}/.exec(
      snap.teams.split('\n').find((l) => l.includes('研发测试组')) ?? snap.teams,
    )?.[0] ?? state.teamAlphaId;
    const teamDetail = (await runCli(state.dataDir, ['team', 'show', alphaTeamId, '--as', 'admin'], { expectOk: true })).stdout;
    assert.ok(teamDetail.includes('alice'), `team membership for alice must be restored:\n${teamDetail}`);

    assert.ok(snap.packs.includes('mindmap-format'));
    assert.ok(snap.packs.includes('lumen-api'));
    assert.ok(snap.packs.includes('plm'));
    assert.ok(snap.packs.includes('test-bed'));
    assert.ok(snap.packs.includes(state.overlayPackId));
    assert.ok(snap.resources.includes('synth-plm'));
    const restoredPlmId = /res_[0-9a-hjkmnp-tv-z]{26}/.exec(snap.resources) ?? [state.plmResourceId];
    const plmDetail = (await runCli(state.dataDir, ['resource', 'show', restoredPlmId[0], '--as', 'admin'], { expectOk: true })).stdout;
    assert.ok(plmDetail.includes('192.0.2.10') && plmDetail.includes('192.0.2.11'), `restored plm origins missing RFC 5737 addresses:\n${plmDetail}`);
    assert.ok(plmDetail.includes('SYNTH_PLM_USER') && plmDetail.includes('SYNTH_PLM_PASS'), `restored plm credential names missing:\n${plmDetail}`);
    assert.ok(plmDetail.includes(alphaTeamId) || snap.resources.includes('研发测试组') || plmDetail.includes('研发测试组'), 'restored plm resource assignment should remain visible');
    assert.ok(snap.executors.includes(state.executorTarget));
    assert.ok(snap.vars.includes(state.plainVarName) && snap.vars.includes(state.secretVarName));
    assert.ok(snap.docs.includes(state.docBedName) && snap.docs.includes(state.docNoteName));

    const varValAfter = (await runCli(state.dataDir, ['var', 'show', state.plainVarName, '--value', '--as', 'admin'], { expectOk: true })).stdout;
    assert.ok(varValAfter.includes(state.plainVarValue));

    const noteAfter = (await runCli(state.dataDir, ['doc', 'show', state.docNoteName, '--as', 'admin'], { expectOk: true })).stdout;
    const noteShaAfter = createHash('sha256').update(Buffer.from(noteAfter, 'utf8')).digest('hex');
    assert.ok(
      noteShaAfter === state.docNoteSha256 || noteAfter.trim() === state.docNoteText.trim(),
      'named doc content must match pre-reset content losslessly',
    );
    const bedAfter = (await runCli(state.dataDir, ['doc', 'show', state.docBedName, '--as', 'admin'], { expectOk: true })).stdout;
    const expectedBedBytes = await readFile(new URL('../../../packs/workflow/test-bed/examples/bed-topology.json', import.meta.url), 'utf8');
    const bedShaAfter = createHash('sha256').update(Buffer.from(bedAfter, 'utf8')).digest('hex');
    assert.ok(
      bedShaAfter === state.docBedSha256 || JSON.stringify(JSON.parse(bedAfter)) === JSON.stringify(JSON.parse(expectedBedBytes)),
      'bed-topology named document must match exact pre-reset bytes/JSON',
    );

    // Verify whole-Hub product activation state via knowledge roots/sync acceptance check without erroring on missing activation.
    const kbList = await runCli(state.dataDir, ['knowledge', 'roots', state.productId, '--as', 'admin']);
    assert.equal(kbList.code, 0, `activated product ${state.productId} should be queryable cleanly after apply:\n${kbList.combined}`);

    // Vault entries decrypt cleanly without re-entering plaintext secrets.
    await runCli(state.dataDir, ['records', 'verify', '--vault', '--as', 'admin'], { expectOk: true });
    const secretListAfter = (await runCli(state.dataDir, ['secret', 'list', '--as', 'admin'], { expectOk: true })).stdout;
    assert.ok(secretListAfter.includes('SYNTH_PLM_USER') && secretListAfter.includes('SYNTH_PLM_PASS'));

    // Issue fresh token for alice after full rebuild and verify live Hub MCP usability.
    const issueRes = await runCli(state.dataDir, ['token', 'issue', 'alice', '--label', 'post-apply-mcp', '--raw'], { expectOk: true });
    const freshAliceToken = issueRes.stdout.trim();
    assert.ok(freshAliceToken.length >= 16);

    serve = await spawnServe(state.dataDir, state.port, { scratchHome: state.scratchHome });
    const health = await serve.healthz();
    assert.equal(health.status, 200);
    const healthJson = JSON.parse(health.body) as { status: string; needsRebuild?: boolean };
    assert.equal(healthJson.status, 'ok');
    assert.notEqual(healthJson.needsRebuild, true, 'rebuilt Hub must be healthy and compatible');

    const mcp = await connectMcpHttp(state.port, freshAliceToken, 'sess-post-apply');
    try {
      const listed = await mcp.call('list_task_packs', {});
      assert.equal(listed.isError, false, listed.text);
      assert.ok(listed.out.packs.some((p) => p.pack.startsWith('test-bed@')), 'alice must see team/user-assigned test-bed after apply');
      assert.ok(listed.out.packs.some((p) => p.pack.startsWith('mindmap-format@')), 'installed skill mindmap-format must be available after apply');

      const docNodes = await mcp.call('get_nodes', { pack: state.workflowId });
      assert.equal(docNodes.isError, false, docNodes.text);

      const uploadAfter = await mcp.call('upload_file', {
        file_path: Buffer.from('post-apply usability upload check\n', 'utf8').toString('base64'),
        name: 'post-apply.txt',
        media_type: 'text/plain',
      });
      assert.equal(uploadAfter.out.acceptance, 'accepted', uploadAfter.text);

      if (hasSandbox) {
        const runAfter = await mcp.call('start_run', {
          pack: state.workflowId,
          inputs: { inventory: { external: `doc:doc:${state.docBedName}` } },
          parameters: { action: 'facts' },
        });
        assert.equal(runAfter.isError, false, runAfter.text);
        assert.ok(runAfter.out.run?.run, 'test-bed start_run must succeed after export -> reset -> apply using restored bed-topology');
      }
    } finally {
      await mcp.close();
    }
  });
});
