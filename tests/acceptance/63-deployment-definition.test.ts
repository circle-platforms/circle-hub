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
  RFC5737_PLM_OAUTH,
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

/** Clears export's missingConfiguration advisory once an operator confirms explicit knowledgeSources. */
async function writeConfirmedApplyManifest(exportPath: string, outPath: string): Promise<Record<string, unknown>> {
  const raw = JSON.parse(await readFile(exportPath, 'utf8')) as Record<string, unknown>;
  raw.missingConfiguration = [];
  await writeFile(outPath, JSON.stringify(raw, null, 2), 'utf8');
  return raw;
}

/** Helper to run CLI list assertions across users, teams, packs, resources, executors, vars, and docs. */
async function readConfigCliSnapshot(dataDir: string) {
  const usersRes = await runCli(dataDir, ['user', 'list', '--json'], { expectOk: true });
  const users = JSON.parse(usersRes.stdout) as Array<{ id: string; name: string; role: string; disabled?: boolean }>;
  const teams = (await runCli(dataDir, ['team', 'list'], { expectOk: true })).stdout;
  const packs = (await runCli(dataDir, ['pack', 'list'], { expectOk: true })).stdout;
  const resources = (await runCli(dataDir, ['resource', 'list'], { expectOk: true })).stdout;
  const executors = (await runCli(dataDir, ['executor', 'list'], { expectOk: true })).stdout;
  const vars = (await runCli(dataDir, ['var', 'list'], { expectOk: true })).stdout;
  const docs = (await runCli(dataDir, ['doc', 'list'], { expectOk: true })).stdout;
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
    const exportFailures: string[] = [];
    if (!parsed.accounts.some((a) => a.name === 'alice' && a.role === 'user' && a.disabled === false)) {
      exportFailures.push(`exported accounts missing active user 'alice': ${JSON.stringify(parsed.accounts)}`);
    }
    if (!parsed.accounts.some((a) => a.name === 'bob' && a.disabled === true)) {
      exportFailures.push(`exported accounts missing disabled 'bob': ${JSON.stringify(parsed.accounts)}`);
    }
    if (!parsed.teams.some((t) => t.name === '研发测试组' && t.members.includes('alice'))) {
      exportFailures.push(
        `exported teams must retain '研发测试组' with member account name 'alice' (not UserId); got teams=${JSON.stringify(parsed.teams)}`,
      );
    }
    const exportedPlm = parsed.resources.find((r) => r.definition.name === 'synth-plm');
    assert.ok(exportedPlm, 'exported definition must contain synth-plm resource');
    assert.equal(exportedPlm.definition.credentials.username, 'SYNTH_PLM_USER');
    assert.equal(exportedPlm.definition.credentials.password, 'SYNTH_PLM_PASS');
    assert.equal(exportedPlm.definition.origins['plm-api'], RFC5737_PLM_API);
    const exportedExec = parsed.executors.find((e) => e.target === state.executorTarget);
    assert.ok(exportedExec, 'exported definition must contain synthetic executor');
    assert.equal(exportedExec.credential, '${secret:SYNTH_EXEC_TOKEN}');
    assert.equal(exportFailures.length, 0, exportFailures.join('\n'));
  });
});

describe('deployment definition apply idempotency and field-level diff refusal (spec item 6)', () => {
  it('applies an identical exported definition twice without duplicating rows or failing', async () => {
    const { root, state } = await seedRichHub({ includeHistoryAndKnowledge: false, canRunSandboxedPacks: false });
    cleanupQueue.push(() => teardownRoot(root, state.dataDir));

    const exportPath = join(state.scratchHome, 'idempotent-export.json');
    await runExportCli(state.dataDir, exportPath, { expectOk: true });
    const applyPath = join(state.scratchHome, 'idempotent-confirmed.json');
    await writeConfirmedApplyManifest(exportPath, applyPath);

    const dbBefore = await inspectDatabaseState(state.dataDir);
    const cliBefore = await readConfigCliSnapshot(state.dataDir);

    await runApplyCli(state.dataDir, applyPath, { expectOk: true });
    await runApplyCli(state.dataDir, applyPath, { expectOk: true });

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

    const exportPath = join(state.scratchHome, 'base-diff-export.json');
    await runExportCli(state.dataDir, exportPath, { expectOk: true });
    const basePath = join(state.scratchHome, 'base-diff-confirmed.json');
    await writeConfirmedApplyManifest(exportPath, basePath);
    const baseRaw = await readFile(basePath, 'utf8');
    const baseParsed = DeploymentDefinition.parse(JSON.parse(baseRaw));

    const writeMutated = async (name: string, obj: unknown): Promise<string> => {
      const p = join(state.scratchHome, name);
      await writeFile(p, JSON.stringify(obj, null, 2), 'utf8');
      return p;
    };

    const diffFailures: string[] = [];

    // 1. Account role change (alice: user -> admin).
    const diffAccount = structuredClone(baseParsed);
    const aliceEntry = diffAccount.accounts.find((a) => a.name === 'alice');
    assert.ok(aliceEntry);
    aliceEntry.role = 'admin';
    const accountRes = await runApplyCli(state.dataDir, await writeMutated('diff-account.json', diffAccount));
    if (accountRes.code === 0) diffFailures.push(`mutated account role was NOT rejected:\n${accountRes.combined}`);
    if (!accountRes.combined.includes('alice')) diffFailures.push(`account diff missing 'alice':\n${accountRes.combined}`);
    if (!/role|角色/i.test(accountRes.combined)) diffFailures.push(`account diff missing role field:\n${accountRes.combined}`);

    // 2. Team membership change (remove alice from 研发测试组).
    const diffTeam = structuredClone(baseParsed);
    const teamEntry = diffTeam.teams.find((t) => t.name === '研发测试组');
    assert.ok(teamEntry);
    teamEntry.members = [];
    const teamRes = await runApplyCli(state.dataDir, await writeMutated('diff-team.json', diffTeam));
    if (teamRes.code === 0) {
      diffFailures.push(`mutated team members was NOT rejected (exit 0):\n${teamRes.combined}`);
    } else {
      if (!teamRes.combined.includes('研发测试组') && !teamRes.combined.includes(state.teamAlphaId)) {
        diffFailures.push(`team diff missing '研发测试组' / '${state.teamAlphaId}':\n${teamRes.combined}`);
      }
      if (!/member|成员/i.test(teamRes.combined)) diffFailures.push(`team diff missing members field:\n${teamRes.combined}`);
    }

    // 3. Resource origin change (synth-plm plm-api -> RFC 5737 alternate).
    const diffResource = structuredClone(baseParsed);
    const resEntry = diffResource.resources.find((r) => r.definition.name === 'synth-plm');
    assert.ok(resEntry);
    resEntry.definition.origins['plm-api'] = RFC5737_PLM_ALT;
    const resourceRes = await runApplyCli(state.dataDir, await writeMutated('diff-resource.json', diffResource));
    if (resourceRes.code === 0) {
      diffFailures.push(`mutated resource origin was NOT rejected (exit 0):\n${resourceRes.combined}`);
    } else {
      if (!resourceRes.combined.includes('synth-plm') && !resourceRes.combined.includes(state.plmResourceId)) {
        diffFailures.push(`resource diff missing 'synth-plm' / '${state.plmResourceId}':\n${resourceRes.combined}`);
      }
      if (!/origin|plm-api|地址|192\.0\.2/i.test(resourceRes.combined)) {
        diffFailures.push(`resource diff missing origin field:\n${resourceRes.combined}`);
      }
    }

    // 4. Executor endpoint change (synthetic-bed endpoint port 19201 -> 19299).
    const diffExecutor = structuredClone(baseParsed);
    const execEntry = diffExecutor.executors.find((e) => e.target === state.executorTarget);
    assert.ok(execEntry);
    execEntry.endpoint = LOOPBACK_EXEC_ALT;
    const execRes = await runApplyCli(state.dataDir, await writeMutated('diff-executor.json', diffExecutor));
    if (execRes.code === 0) {
      diffFailures.push(`mutated executor endpoint was NOT rejected (exit 0):\n${execRes.combined}`);
    } else {
      if (!execRes.combined.includes(state.executorTarget)) {
        diffFailures.push(`executor diff missing '${state.executorTarget}':\n${execRes.combined}`);
      }
      if (!/endpoint|端点/i.test(execRes.combined)) diffFailures.push(`executor diff missing endpoint field:\n${execRes.combined}`);
    }

    // 5. Workflow assignment diff (remove alice assignment).
    const diffAssign = structuredClone(baseParsed);
    diffAssign.workflowAssignments = diffAssign.workflowAssignments.filter(
      (a) => !('user' in a && a.user === 'alice' && a.pack === state.workflowId),
    );
    const assignRes = await runApplyCli(state.dataDir, await writeMutated('diff-assign.json', diffAssign));
    if (assignRes.code === 0) {
      diffFailures.push(`mutated workflowAssignments was NOT rejected (exit 0):\n${assignRes.combined}`);
    } else if (!/test-bed|alice|assignment|workflowAssignments|分配/i.test(assignRes.combined)) {
      diffFailures.push(`workflowAssignments diff missing entity/field:\n${assignRes.combined}`);
    }

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
      if (varRes.code === 0) diffFailures.push(`mutated variable value was NOT rejected (exit 0):\n${varRes.combined}`);
      else if (!varRes.combined.includes(state.plainVarName)) diffFailures.push(`variable diff missing '${state.plainVarName}':\n${varRes.combined}`);
    }

    const rawDocClone = JSON.parse(baseRaw) as Record<string, unknown>;
    if (mutateOptionalSectionField(rawDocClone, ['documents', 'namedDocuments', 'docs'], state.docNoteName, (rec) => {
      for (const field of ['bytesBase64', 'content', 'text', 'body', 'bytes_base64', 'content_base64', 'base64']) {
        if (typeof rec[field] === 'string') {
          const updated = field.toLowerCase().includes('base64')
            ? Buffer.from('mutated-doc-bytes-conflict', 'utf8').toString('base64')
            : 'mutated-doc-bytes-conflict';
          rec[field] = updated;
          if (typeof rec.sha256 === 'string') {
            rec.sha256 = createHash('sha256').update(Buffer.from('mutated-doc-bytes-conflict', 'utf8')).digest('hex');
          }
          if (typeof rec.size === 'number') {
            rec.size = Buffer.byteLength('mutated-doc-bytes-conflict', 'utf8');
          }
          return true;
        }
      }
      return false;
    })) {
      const docRes = await runApplyCli(state.dataDir, await writeMutated('diff-doc.json', rawDocClone));
      if (docRes.code === 0) diffFailures.push(`mutated document bytes was NOT rejected (exit 0):\n${docRes.combined}`);
      else if (!docRes.combined.includes(state.docNoteName)) diffFailures.push(`document diff missing '${state.docNoteName}':\n${docRes.combined}`);
    }

    // Confirm none of the refused applies mutated any existing live configuration.
    const usersAfter = JSON.parse((await runCli(state.dataDir, ['user', 'list', '--json'], { expectOk: true })).stdout) as Array<{ name: string; role: string }>;
    assert.equal(usersAfter.find((u) => u.name === 'alice')?.role, 'user', 'alice role must remain user after refused apply');
    const teamShow = (await runCli(state.dataDir, ['team', 'show', state.teamAlphaId], { expectOk: true })).stdout;
    assert.ok(teamShow.includes('alice'), 'alice must remain in 研发测试组 after refused apply');
    const resShow = (await runCli(state.dataDir, ['resource', 'show', state.plmResourceId, '--values'], { expectOk: true })).stdout;
    assert.ok(resShow.includes('synth-plm') && resShow.includes('SYNTH_PLM_USER'), `resource show missing synth-plm:\n${resShow}`);
    const afterDiffExportPath = join(state.scratchHome, 'after-diff-export.json');
    await runExportCli(state.dataDir, afterDiffExportPath, { expectOk: true });
    const afterDiffParsed = DeploymentDefinition.parse(JSON.parse(await readFile(afterDiffExportPath, 'utf8')));
    const plmAfterDiff = afterDiffParsed.resources.find((r) => r.definition.name === 'synth-plm');
    assert.ok(plmAfterDiff, 'synth-plm resource must still exist after refused diff applies');
    if (plmAfterDiff.definition.origins['plm-api'] !== RFC5737_PLM_API) {
      diffFailures.push(
        `plm-api origin changed after refused apply (expected ${RFC5737_PLM_API}, got ${plmAfterDiff.definition.origins['plm-api']}):\n` +
          `diff-resource output=${resourceRes.combined}`,
      );
    }
    assert.notEqual(plmAfterDiff.definition.origins['plm-api'], RFC5737_PLM_ALT, 'mutated plm-api origin must not overwrite existing resource');
    const postExec = afterDiffParsed.executors.find((e) => e.target === state.executorTarget);
    if (!postExec || postExec.endpoint !== LOOPBACK_EXEC_ENDPOINT) {
      diffFailures.push(`executor endpoint changed after refused apply: ${JSON.stringify(afterDiffParsed.executors)}`);
    }
    const execShow = (await runCli(state.dataDir, ['executor', 'list'], { expectOk: true })).stdout;
    if (!execShow.includes('执行器 1')) {
      diffFailures.push(`executor list unexpected after refused apply:\n${execShow}`);
    }
    const varVal = (await runCli(state.dataDir, ['var', 'show', state.plainVarName, '--value'], { expectOk: true })).stdout;
    assert.ok(varVal.includes(state.plainVarValue));
    const docVal = (await runCli(state.dataDir, ['doc', 'show', state.docNoteName], { expectOk: true })).stdout;
    assert.ok(docVal.includes(state.docNoteSha256), `doc show missing SHA-256 ${state.docNoteSha256}:\n${docVal}`);

    assert.equal(diffFailures.length, 0, `apply diff refusal / immutability checks failed:\n${diffFailures.join('\n---\n')}`);
  });
});

describe('export -> reset --scope all -> apply round-trip rebuild & vault invariance (spec items 3b & 8)', { skip: hasLibpq ? false : LIBPQ_MISSING }, () => {
  it('rebuilds full usable Hub configuration after wiping DB while keeping keys/ and vault/ byte-for-byte identical', { timeout: 180_000 }, async () => {
    const { root, state } = await seedRichHub({ includeHistoryAndKnowledge: true, canRunSandboxedPacks: hasSandbox });
    let serve: ServeHandle | undefined;
    cleanupQueue.push(() => teardownRoot(root, state.dataDir, serve));

    const exportPath = join(state.scratchHome, 'roundtrip-export.json');
    await runExportCli(state.dataDir, exportPath, { expectOk: true });
    const applyPath = join(state.scratchHome, 'roundtrip-confirmed.json');
    await writeConfirmedApplyManifest(exportPath, applyPath);
    const vaultBefore = await snapshotVaultAndKeys(state.dataDir);

    const resetRes = await runResetCli(state.dataDir, { scopes: 'all' }, { expectOk: true });
    const backupCheck = await assertBackupAndArchivePreserved(state.dataDir, resetRes, RESET_SCOPE, hasSandbox);
    await assertVaultAndKeysUnchanged(state.dataDir, vaultBefore, 'immediately after reset --scope all');

    // Confirm config and history are cleared before applying the deployment definition.
    const dbEmpty = await inspectDatabaseState(state.dataDir);
    assert.equal(dbEmpty.tables.users ?? 0, 0, 'all users must be cleared by reset --scope all before apply');
    assert.equal(dbEmpty.tables.teams ?? 0, 0, 'all teams must be cleared by reset --scope all before apply');
    assert.equal(dbEmpty.tables.team_members ?? 0, 0, 'all team_members must be cleared by reset --scope all before apply');

    await runApplyCli(state.dataDir, applyPath, { expectOk: true });
    await assertVaultAndKeysUnchanged(state.dataDir, vaultBefore, 'after apply');

    // Refresh local operator-token only if pre-reset operator token is no longer bound after full apply (plan.md:40).
    const probeUsers = await runCli(state.dataDir, ['user', 'list', '--json']);
    if (probeUsers.code !== 0) {
      await runCli(state.dataDir, ['operator-token', 'remove', '--confirm-only-operator-token'], { expectOk: true });
      await runCli(state.dataDir, ['operator-token', 'reissue', '--as', 'admin'], { expectOk: true });
    }

    const rebuildFailures: string[] = [...backupCheck.issues];

    // Inspect accounts, teams, packs (including whole-Hub activation), assignments, resources, executors, variables, docs.
    const snap = await readConfigCliSnapshot(state.dataDir);
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
    const teamDetail = (await runCli(state.dataDir, ['team', 'show', alphaTeamId], { expectOk: true })).stdout;
    if (!teamDetail.includes('alice')) {
      rebuildFailures.push(`team membership for alice missing after export->reset->apply:\n${teamDetail}`);
    }

    assert.ok(snap.packs.includes('mindmap-format'));
    assert.ok(snap.packs.includes('lumen-api'));
    assert.ok(snap.packs.includes('plm'));
    assert.ok(snap.packs.includes('test-bed'));
    assert.ok(snap.packs.includes(state.overlayPackId));
    assert.ok(snap.resources.includes('synth-plm'));
    const restoredPlmId = /res_[0-9a-hjkmnp-tv-z]{26}/.exec(snap.resources) ?? [state.plmResourceId];
    const plmDetail = (await runCli(state.dataDir, ['resource', 'show', restoredPlmId[0], '--values'], { expectOk: true })).stdout;
    assert.ok(plmDetail.includes('SYNTH_PLM_USER') && plmDetail.includes('SYNTH_PLM_PASS'), `restored plm credential names missing:\n${plmDetail}`);
    const postApplyExportPath = join(state.scratchHome, 'post-apply-export.json');
    await runExportCli(state.dataDir, postApplyExportPath, { expectOk: true });
    const postApplyDef = DeploymentDefinition.parse(JSON.parse(await readFile(postApplyExportPath, 'utf8')));
    const postPlm = postApplyDef.resources.find((r) => r.definition.name === 'synth-plm');
    assert.ok(postPlm, 'synth-plm must exist in post-apply export');
    assert.equal(postPlm.definition.origins['plm-oauth'], RFC5737_PLM_OAUTH);
    assert.equal(postPlm.definition.origins['plm-api'], RFC5737_PLM_API);
    if (!postApplyDef.resourceAssignments.some((a) => a.resource === 'synth-plm' && 'team' in a && a.team === '研发测试组')) {
      rebuildFailures.push(
        `restored synth-plm resourceAssignment to 研发测试组 missing after apply: ${JSON.stringify(postApplyDef.resourceAssignments)}`,
      );
    }
    assert.ok(snap.executors.includes('执行器 1'), `executor list unexpected after apply:\n${snap.executors}`);
    assert.ok(
      postApplyDef.executors.some((e) => e.target === state.executorTarget && e.endpoint === LOOPBACK_EXEC_ENDPOINT),
      `restored executor ${state.executorTarget} missing in post-apply export: ${JSON.stringify(postApplyDef.executors)}`,
    );
    assert.ok(snap.vars.includes(state.plainVarName) && snap.vars.includes(state.secretVarName));
    assert.ok(snap.docs.includes(state.docBedName) && snap.docs.includes(state.docNoteName));

    const varValAfter = (await runCli(state.dataDir, ['var', 'show', state.plainVarName, '--value'], { expectOk: true })).stdout;
    assert.ok(varValAfter.includes(state.plainVarValue));

    const noteAfter = (await runCli(state.dataDir, ['doc', 'show', state.docNoteName], { expectOk: true })).stdout;
    assert.ok(
      noteAfter.includes(state.docNoteSha256) || noteAfter.includes(state.docNoteText.trim()),
      `named doc summary/content mismatch after apply (expected SHA-256 ${state.docNoteSha256}):\n${noteAfter}`,
    );
    const bedAfter = (await runCli(state.dataDir, ['doc', 'show', state.docBedName], { expectOk: true })).stdout;
    assert.ok(
      bedAfter.includes(state.docBedSha256),
      `bed-topology doc summary mismatch after apply (expected SHA-256 ${state.docBedSha256}):\n${bedAfter}`,
    );

    // Verify whole-Hub product activation state via knowledge roots/sync acceptance check without erroring on missing activation.
    const kbList = await runCli(state.dataDir, ['knowledge', 'roots', state.productId]);
    assert.equal(kbList.code, 0, `activated product ${state.productId} should be queryable cleanly after apply:\n${kbList.combined}`);

    // Vault entries decrypt cleanly without re-entering plaintext secrets.
    await runCli(state.dataDir, ['records', 'verify', '--vault'], { expectOk: true });
    const secretListAfter = (await runCli(state.dataDir, ['secret', 'list'], { expectOk: true })).stdout;
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
    assert.equal(rebuildFailures.length, 0, rebuildFailures.join('\n---\n'));
  });
});
