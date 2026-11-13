// Cleanroom black-box acceptance tests for declarative deployment definitions (`circle-hub export` / `apply`).
// Aligned 1:1 with the 8 N6 scenario groups in `review/whitepaper-1113/team-v2/decompose/n6-definition-proposal.md` §5
// and Boss's 03:15 Q1-Q4 rulings, running strictly against real PostgreSQL, temporary CIRCLE_HUB_DATA_DIR, and bin/circle-hub.
// Existing assertions remain unrelaxed; unimplemented N6 behaviors fail honestly with clear `[N6 待合约/实现]` markers
// without inventing unapproved schemas, flags, record kinds, or error codes.
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
  SYNTHETIC_ADMIN_PASS,
  allocateLoopbackPort,
  assertBackupAndArchivePreserved,
  assertVaultAndKeysUnchanged,
  connectMcpHttp,
  createShortTempRoot,
  extractDbAuthHashes,
  hashDirectoryFiles,
  inspectDatabaseState,
  runApplyCli,
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
import { definition as baseExecutorDefinition } from '../../hub/dispatch/testing/definition.ts';

const hasLibpq = await libpqAvailable();
const hasSandbox = await osIsolationAvailable();

const cleanupQueue: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanupQueue.splice(0).reverse()) {
    await fn().catch(() => undefined);
  }
});

/**
 * Contract items still awaiting contracts/model/Codex freeze (n6-definition-proposal.md §2, §5, §8).
 * These remain explicit checklist markers so tests neither guess unapproved fields/codes nor relax requirements.
 */
const PENDING_N6_CONTRACTS = {
  strictSchemaCutover: '新公共部署 schema 标识与淘汰 deployment@1 的严格拒绝门（待 contracts/Codex 冻结）',
  executorStableName: '同一 target 多执行器的显式 name 绑定命令与未命名执行器 export 拒绝（待 Codex 定稿）',
  componentInputProfile: '组件 input profile 的 required/sensitive/default 声明与禁止无声明新绑定（待 Boss/contracts 审定）',
  previewCommitBarrier: 'previewDeployment / commitDeployment 与事务内 read-set 复核、锁顺序公开入口（待 Codex 定稿）',
  stagedObjectBoundary: '事务失败与崩溃时的暂存对象不可读边界及域级故障注入接口（待 objects/各包 owner 定稿）',
  syncIntentReceipt: '同事务持久同步意图与配置提交/后台动作分离回执结构（待 contracts/Codex 定稿）',
} as const;

const INTERNAL_ID_PATTERNS: ReadonlyArray<{ label: string; regex: RegExp }> = [
  { label: 'UserId', regex: /\busr_[0-7][0-9a-hjkmnp-tv-z]{25}\b/ },
  { label: 'TeamId', regex: /\btm_[0-7][0-9a-hjkmnp-tv-z]{25}\b/ },
  { label: 'ResourceId', regex: /\bres_[0-9a-hjkmnp-tv-z]{26}\b/ },
  { label: 'ExecutorId', regex: /\bexe_[0-9a-zA-Z_-]{10,}\b/ },
];

/** Clears export's missingConfiguration advisory once an operator confirms explicit knowledgeSources. */
async function writeConfirmedApplyManifest(exportPath: string, outPath: string): Promise<Record<string, unknown>> {
  const raw = JSON.parse(await readFile(exportPath, 'utf8')) as Record<string, unknown>;
  raw.missingConfiguration = [];
  await writeFile(outPath, JSON.stringify(raw, null, 2), 'utf8');
  return raw;
}

/** Writes JSON payload to a scratch file and returns its path. */
async function writeJsonFile(scratchHome: string, filename: string, payload: unknown): Promise<string> {
  const path = join(scratchHome, filename);
  await writeFile(path, JSON.stringify(payload, null, 2), 'utf8');
  return path;
}

/** Verifies every portable identity position in an exported definition excludes internal DB IDs. */
function collectInternalIdLeaks(exported: DeploymentDefinition): string[] {
  const leaks: string[] = [];
  const checkValue = (where: string, value: string | undefined): void => {
    if (!value) return;
    for (const { label, regex } of INTERNAL_ID_PATTERNS) {
      if (regex.test(value)) leaks.push(`${where} leaked ${label}: ${value}`);
    }
  };
  for (const [i, acc] of exported.accounts.entries()) {
    checkValue(`accounts[${i}].id`, acc.id);
    checkValue(`accounts[${i}].name`, acc.name);
  }
  for (const [i, team] of exported.teams.entries()) {
    checkValue(`teams[${i}].id`, team.id);
    checkValue(`teams[${i}].name`, team.name);
    for (const [j, member] of team.members.entries()) checkValue(`teams[${i}].members[${j}]`, member);
  }
  for (const [i, res] of exported.resources.entries()) {
    checkValue(`resources[${i}].id`, res.id);
    checkValue(`resources[${i}].definition.name`, res.definition.name);
  }
  for (const [i, exec] of exported.executors.entries()) {
    checkValue(`executors[${i}].id`, exec.id);
  }
  for (const [i, wf] of exported.workflowAssignments.entries()) {
    if ('user' in wf) checkValue(`workflowAssignments[${i}].user`, wf.user);
    if ('team' in wf) checkValue(`workflowAssignments[${i}].team`, wf.team);
  }
  for (const [i, ra] of exported.resourceAssignments.entries()) {
    checkValue(`resourceAssignments[${i}].resource`, ra.resource);
    if ('team' in ra) checkValue(`resourceAssignments[${i}].team`, ra.team);
  }
  for (const [i, lr] of exported.leaseRegistrations.entries()) {
    checkValue(`leaseRegistrations[${i}].owner`, lr.owner);
  }
  return leaks;
}

/** Normalizes two exported definitions into pure portable identity projections (stripping timestamps/internal IDs if present). */
function portableProjection(def: DeploymentDefinition) {
  return {
    schema: def.schema,
    accounts: [...def.accounts].map(({ name, role, disabled }) => ({ name, role, disabled })).sort((a, b) => a.name.localeCompare(b.name)),
    teams: [...def.teams]
      .map(({ name, members }) => ({ name, members: [...members].sort() }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    packs: [...def.packs].map(({ ref, install }) => ({ ref, install })).sort((a, b) => a.ref.localeCompare(b.ref)),
    resources: [...def.resources].map(({ definition, enabled }) => ({ definition, enabled })).sort((a, b) => a.definition.name.localeCompare(b.definition.name)),
    executors: [...def.executors].map(({ id: _id, ...rest }) => rest).sort((a, b) => a.target.localeCompare(b.target)),
    workflowAssignments: [...def.workflowAssignments].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    resourceAssignments: [...def.resourceAssignments].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    knowledgeSources: [...def.knowledgeSources].sort(),
    variables: [...def.variables].sort((a, b) => a.name.localeCompare(b.name)),
    documents: [...def.documents].sort((a, b) => a.name.localeCompare(b.name)),
    leaseRegistrations: [...def.leaseRegistrations].sort((a, b) => a.prefix.localeCompare(b.prefix)),
  };
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

/** Initializes a fresh empty target Hub root with initial admin (`circle-hub init -> key init -> migrate -> init-admin`). */
async function createFreshTargetHub(prefix: string): Promise<{ root: string; dataDir: string; scratchHome: string; port: number }> {
  const { root, dataDir, scratchHome } = await createShortTempRoot(prefix);
  const port = await allocateLoopbackPort();
  await runCli(dataDir, ['init', '--environment', 'test', '--port', String(port)], { scratchHome, expectOk: true });
  await runCli(dataDir, ['key', 'init'], { expectOk: true });
  await runCli(dataDir, ['serve', '--migrate-only'], { expectOk: true, timeoutMs: 30_000 });
  await runCli(dataDir, ['init-admin', 'admin', '--password-stdin'], {
    stdin: `${SYNTHETIC_ADMIN_PASS}\n`,
    expectOk: true,
  });
  await runCli(dataDir, ['pack', 'grant-publish', 'admin'], { expectOk: true });
  return { root, dataDir, scratchHome, port };
}

/** Snapshots public.records immutable run/action payloads & digests for byte-immutability checks. */
async function snapshotHistoricalRunAndActionRecords(dataDir: string): Promise<Array<{ id: string; kind: string; schema: string; digest: string; body: string }>> {
  return await withRootDb(dataDir, async (pool) => {
    const res = await pool.query<{ id: string; kind: string; schema: string; digest: string; body: string }>(
      "SELECT id, kind, schema, digest, body FROM public.records WHERE kind IN ('run', 'action') ORDER BY seq",
    );
    return res.rows;
  });
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

describe('Group 1: portable name-only export, cross-DB rebuild, vault invariance & secret exclusion (N6 §5 #1)', () => {
  it('excludes all secret materials, omits internal IDs from identity positions, and retains names', async () => {
    const { root, state } = await seedRichHub({ includeHistoryAndKnowledge: false, canRunSandboxedPacks: false });
    cleanupQueue.push(() => teardownRoot(root, state.dataDir));

    const vaultBefore = await snapshotVaultAndKeys(state.dataDir);
    const dbHashes = await extractDbAuthHashes(state.dataDir);
    const exportPath = join(state.scratchHome, 'deployment-export.json');

    const exportRes = await runExportCli(state.dataDir, exportPath, { expectOk: true });
    const exportedRaw = await readFile(exportPath, 'utf8');
    const parsed = DeploymentDefinition.parse(JSON.parse(exportedRaw));

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

    const exportFailures: string[] = [...collectInternalIdLeaks(parsed)];
    if (!parsed.accounts.some((a) => a.name === 'alice' && a.role === 'user' && a.disabled === false)) {
      exportFailures.push(`exported accounts missing active user 'alice': ${JSON.stringify(parsed.accounts)}`);
    }
    if (!parsed.accounts.some((a) => a.name === 'bob' && a.disabled === true)) {
      exportFailures.push(`exported accounts missing disabled 'bob': ${JSON.stringify(parsed.accounts)}`);
    }
    if (!parsed.teams.some((t) => t.name === '研发测试组' && t.members.includes('alice'))) {
      exportFailures.push(`exported teams must retain '研发测试组' with member account name 'alice': ${JSON.stringify(parsed.teams)}`);
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

  it('applies hub A export into a separate fresh empty hub B with independent IDs and matching normalized re-export', { skip: hasLibpq ? false : LIBPQ_MISSING, timeout: 180_000 }, async () => {
    const { root: rootA, state: stateA } = await seedRichHub({ includeHistoryAndKnowledge: false, canRunSandboxedPacks: false });
    cleanupQueue.push(() => teardownRoot(rootA, stateA.dataDir));

    const hubB = await createFreshTargetHub('ch-n6-b-');
    cleanupQueue.push(() => teardownRoot(hubB.root, hubB.dataDir));

    // Seed named secrets in hub B independently (secrets are never transported inside portable definitions).
    for (const [name, value] of [
      ['SYNTH_PLM_USER', stateA.canaries.plmUserSecret],
      ['SYNTH_PLM_PASS', stateA.canaries.plmPassSecret],
      ['SYNTH_EXEC_TOKEN', stateA.canaries.execSecret],
    ] as const) {
      await runCli(hubB.dataDir, ['secret', 'set', '--name', name, '--reason', 'independent target vault setup'], {
        stdin: `${value}\n`,
        expectOk: true,
      });
    }

    const exportAPath = join(stateA.scratchHome, 'hub-a-export.json');
    await runExportCli(stateA.dataDir, exportAPath, { expectOk: true });
    const parsedA = DeploymentDefinition.parse(JSON.parse(await readFile(exportAPath, 'utf8')));
    const leaksA = collectInternalIdLeaks(parsedA);
    assert.deepEqual(leaksA, [], `[N6 待合约/实现: ${PENDING_N6_CONTRACTS.strictSchemaCutover}] export A must omit all internal IDs:\n${leaksA.join('\n')}`);

    const applyPath = join(hubB.scratchHome, 'hub-a-for-b.json');
    await writeConfirmedApplyManifest(exportAPath, applyPath);
    await runApplyCli(hubB.dataDir, applyPath, { expectOk: true });

    const exportBPath = join(hubB.scratchHome, 'hub-b-export.json');
    await runExportCli(hubB.dataDir, exportBPath, { expectOk: true });
    const parsedB = DeploymentDefinition.parse(JSON.parse(await readFile(exportBPath, 'utf8')));

    assert.deepEqual(portableProjection(parsedB), portableProjection(parsedA), 'normalized portable export from B must match A');
  });

  it('rebuilds full usable Hub after reset --scope all -> init-admin -> apply while keeping vault/ and master key byte-for-byte identical', { skip: hasLibpq ? false : LIBPQ_MISSING, timeout: 180_000 }, async () => {
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

    const dbEmpty = await inspectDatabaseState(state.dataDir);
    assert.equal(dbEmpty.tables.users ?? 0, 0, 'all users must be cleared by reset --scope all before apply');
    assert.equal(dbEmpty.tables.teams ?? 0, 0, 'all teams must be cleared by reset --scope all before apply');
    assert.equal(dbEmpty.tables.team_members ?? 0, 0, 'all team_members must be cleared by reset --scope all before apply');

    const rebuildFailures: string[] = [...backupCheck.issues];
    const preInitApplyRes = await runApplyCli(state.dataDir, applyPath);
    assert.notEqual(preInitApplyRes.code, 0, 'apply on admin-empty post-reset DB before init-admin MUST refuse');
    if (!/init-admin/i.test(preInitApplyRes.combined)) {
      rebuildFailures.push(`apply on empty post-reset DB before init-admin must guide operator to init-admin; got:\n${preInitApplyRes.combined}`);
    }
    await assertVaultAndKeysUnchanged(state.dataDir, vaultBefore, 'after refused apply before init-admin');

    await runCli(state.dataDir, ['init-admin', 'admin', '--password-stdin'], {
      stdin: `${SYNTHETIC_ADMIN_PASS}\n`,
      expectOk: true,
    });
    const operatorTokenKeyFile = `${createHash('sha256').update(JSON.stringify(['circle-hub', 'operator-token'])).digest('hex')}.key`;
    const vaultAfterInit = await snapshotVaultAndKeys(state.dataDir);
    assert.deepEqual([...vaultAfterInit.vault.entries()], [...vaultBefore.vault.entries()], 'init-admin must keep vault/ files byte-for-byte identical');
    for (const [keyFile, digest] of vaultBefore.keys.entries()) {
      if (keyFile === operatorTokenKeyFile) continue;
      assert.equal(vaultAfterInit.keys.get(keyFile), digest, `init-admin must leave non-operator key file ${keyFile} byte-for-byte identical`);
    }
    assert.ok(vaultAfterInit.keys.has(operatorTokenKeyFile), 'init-admin must atomically write/replace operator-token key file');

    const applyRes = await runApplyCli(state.dataDir, applyPath);
    if (applyRes.code !== 0) {
      rebuildFailures.push(`apply after init-admin failed (exit ${applyRes.code}):\n${applyRes.combined}`);
      assert.fail(rebuildFailures.join('\n---\n'));
    }
    await assertVaultAndKeysUnchanged(state.dataDir, vaultAfterInit, 'after apply');

    const snap = await readConfigCliSnapshot(state.dataDir);
    assert.equal(snap.users.find((u) => u.name === 'admin')?.role, 'admin');
    assert.equal(snap.users.find((u) => u.name === 'alice')?.role, 'user');
    assert.equal(snap.users.find((u) => u.name === 'bob')?.disabled, true);
    assert.ok(snap.teams.includes('研发测试组') && snap.teams.includes('辅助观测组'));

    const postApplyExportPath = join(state.scratchHome, 'post-apply-export.json');
    await runExportCli(state.dataDir, postApplyExportPath, { expectOk: true });
    const postApplyDef = DeploymentDefinition.parse(JSON.parse(await readFile(postApplyExportPath, 'utf8')));
    const postPlm = postApplyDef.resources.find((r) => r.definition.name === 'synth-plm');
    assert.ok(postPlm, 'synth-plm must exist in post-apply export');
    assert.equal(postPlm.definition.origins['plm-oauth'], RFC5737_PLM_OAUTH);
    assert.equal(postPlm.definition.origins['plm-api'], RFC5737_PLM_API);
    if (!postApplyDef.resourceAssignments.some((a) => a.resource === 'synth-plm' && 'team' in a && a.team === '研发测试组')) {
      rebuildFailures.push(`restored synth-plm resourceAssignment missing after apply: ${JSON.stringify(postApplyDef.resourceAssignments)}`);
    }

    await runCli(state.dataDir, ['records', 'verify', '--vault'], { expectOk: true });
    const freshAliceToken = (await runCli(state.dataDir, ['token', 'issue', 'alice', '--label', 'post-apply-mcp', '--raw'], { expectOk: true })).stdout.trim();
    assert.ok(freshAliceToken.length >= 16);

    serve = await spawnServe(state.dataDir, state.port, { scratchHome: state.scratchHome });
    const health = await serve.healthz();
    assert.equal(health.status, 200);
    const healthJson = JSON.parse(health.body) as { status: string; needsRebuild?: boolean };
    assert.equal(healthJson.status, 'ok');
    assert.notEqual(healthJson.needsRebuild, true);

    const mcp = await connectMcpHttp(state.port, freshAliceToken, 'sess-post-apply');
    try {
      const listed = await mcp.call('list_task_packs', {});
      assert.equal(listed.isError, false, listed.text);
      assert.ok(listed.out.packs.some((p) => p.pack.startsWith('test-bed@')));
      assert.ok(listed.out.packs.some((p) => p.pack.startsWith('mindmap-format@')));
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
        assert.ok(runAfter.out.run?.run);
      }
    } finally {
      await mcp.close();
    }
    assert.equal(rebuildFailures.length, 0, rebuildFailures.join('\n---\n'));
  });
});

describe('Group 2: stable named executors sharing a target, duplicate name conflict, and unnamed export refusal (N6 §5 #2)', () => {
  it('supports two named executors sharing a target without synthesizing names from target or rejecting idempotency', async () => {
    const { root, state } = await seedRichHub({ includeHistoryAndKnowledge: false, canRunSandboxedPacks: false });
    cleanupQueue.push(() => teardownRoot(root, state.dataDir));

    // Seed an unnamed legacy executor directly and attempt adding a second executor sharing `same-target-synth`.
    const secondExecPath = await writeJsonFile(state.scratchHome, 'second-shared-target-exec.json', {
      ...baseExecutorDefinition(LOOPBACK_EXEC_ALT),
      target: state.executorTarget,
    });
    const addSecond = await runCli(state.dataDir, ['executor', 'add', secondExecPath]);
    assert.equal(addSecond.code, 0, `second executor on same target should succeed once named executors are supported:\n${addSecond.combined}`);

    // Once N6 lands: unnamed executors without explicit admin naming must cause export to refuse explicitly (listing them),
    // while named `{name, definition}` executors on the same target must export, apply idempotently, and reject name+diff conflicts.
    const exportPath = join(state.scratchHome, 'shared-target-export.json');
    const unnamedExport = await runExportCli(state.dataDir, exportPath);
    if (unnamedExport.code === 0) {
      assert.fail(
        `[N6 待合约/实现: ${PENDING_N6_CONTRACTS.executorStableName}] unnamed executors were exported without explicit admin naming or refusal`,
      );
    }
    assert.match(unnamedExport.combined, new RegExp(state.executorTarget), 'unnamed executor refusal must identify the unnamed executor(s)');
  });
});

describe('Group 3: component input declarations (required/default/sensitive) & unreferenced standalone vars/secrets (N6 §5 #3)', () => {
  it('allows standalone unreferenced variables and named secrets without consumers and preserves them across export', async () => {
    const { root, state } = await seedRichHub({ includeHistoryAndKnowledge: false, canRunSandboxedPacks: false });
    cleanupQueue.push(() => teardownRoot(root, state.dataDir));

    await runCli(state.dataDir, ['var', 'set', 'UNREF_PLAIN_VAR', '--not-secret', '--text', '--reason', 'standalone variable without consumer'], {
      stdin: 'standalone-plain-value-n6',
      expectOk: true,
    });
    await runCli(state.dataDir, ['secret', 'set', '--name', 'UNREF_NAMED_SECRET', '--reason', 'standalone secret without consumer'], {
      stdin: 'SYNTH_STANDALONE_SECRET_VAL\n',
      expectOk: true,
    });

    const exportPath = join(state.scratchHome, 'unref-export.json');
    await runExportCli(state.dataDir, exportPath, { expectOk: true });
    const exportedRaw = await readFile(exportPath, 'utf8');
    const parsed = DeploymentDefinition.parse(JSON.parse(exportedRaw));

    assert.ok(parsed.variables.some((v) => v.name === 'UNREF_PLAIN_VAR'), 'unreferenced ordinary variable must persist into export');
    assert.equal(exportedRaw.includes('SYNTH_STANDALONE_SECRET_VAL'), false, 'standalone secret value must never leak into export');
  });

  it('enforces component input profiles for required/default (false/0/"" vs null)/sensitive literals/choices once contracted', async () => {
    const { root, state } = await seedRichHub({ includeHistoryAndKnowledge: false, canRunSandboxedPacks: false });
    cleanupQueue.push(() => teardownRoot(root, state.dataDir));

    // Current ExecutorSource schema accepts unprofiled bindings without per-input required/default/sensitive declarations.
    // Once contracts freeze input profiles (n6-executor-input-declaration-draft.md), expand this block to invoke the real
    // component-binding validator and remove this explicit pending assertion.
    assert.fail(
      `[N6 待合约/实现: ${PENDING_N6_CONTRACTS.componentInputProfile}] no component input profile schema/validator exists yet on baseline ${DeploymentDefinition.shape.schema.value}`,
    );
  });
});

describe('Group 4: whole-file precheck atomic zero-write, idempotency & entity-named diff refusal (N6 §5 #4)', () => {
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

    assert.equal(cliAfter.users.length, cliBefore.users.length);
    assert.equal(cliAfter.teams, cliBefore.teams);
    assert.equal(cliAfter.resources, cliBefore.resources);
    assert.equal(cliAfter.executors, cliBefore.executors);
    assert.equal(cliAfter.vars, cliBefore.vars);
    assert.equal(cliAfter.docs, cliBefore.docs);
    assert.equal(dbAfter.tables.teams, dbBefore.tables.teams);
    assert.equal(dbAfter.tables.team_members, dbBefore.tables.team_members);
    assert.equal(dbAfter.tables.users, dbBefore.tables.users);
  });

  it('refuses non-trivial field diffs cleanly, avoids overwriting existing state, and names differing entities and fields', async () => {
    const { root, state } = await seedRichHub({ includeHistoryAndKnowledge: false, canRunSandboxedPacks: false });
    cleanupQueue.push(() => teardownRoot(root, state.dataDir));

    const exportPath = join(state.scratchHome, 'base-diff-export.json');
    await runExportCli(state.dataDir, exportPath, { expectOk: true });
    const basePath = join(state.scratchHome, 'base-diff-confirmed.json');
    await writeConfirmedApplyManifest(exportPath, basePath);
    const baseRaw = await readFile(basePath, 'utf8');
    const baseParsed = DeploymentDefinition.parse(JSON.parse(baseRaw));

    const diffFailures: string[] = [];

    const diffAccount = structuredClone(baseParsed);
    const aliceEntry = diffAccount.accounts.find((a) => a.name === 'alice');
    assert.ok(aliceEntry);
    aliceEntry.role = 'admin';
    const accountRes = await runApplyCli(state.dataDir, await writeJsonFile(state.scratchHome, 'diff-account.json', diffAccount));
    if (accountRes.code === 0) diffFailures.push(`mutated account role was NOT rejected:\n${accountRes.combined}`);
    if (!accountRes.combined.includes('alice')) diffFailures.push(`account diff missing 'alice':\n${accountRes.combined}`);
    if (!/role|角色/i.test(accountRes.combined)) diffFailures.push(`account diff missing role field:\n${accountRes.combined}`);

    // Omitting optional edges follows target-completion (never deleting unmentioned members/assignments).
    const diffTeam = structuredClone(baseParsed);
    const teamEntry = diffTeam.teams.find((t) => t.name === '研发测试组');
    assert.ok(teamEntry);
    teamEntry.members = [];
    const teamRes = await runApplyCli(state.dataDir, await writeJsonFile(state.scratchHome, 'diff-team.json', diffTeam));
    if (teamRes.code !== 0) diffFailures.push(`omitted team members must not fail (exit ${teamRes.code}):\n${teamRes.combined}`);

    const diffResource = structuredClone(baseParsed);
    const resEntry = diffResource.resources.find((r) => r.definition.name === 'synth-plm');
    assert.ok(resEntry);
    resEntry.definition.origins['plm-api'] = RFC5737_PLM_ALT;
    const resourceRes = await runApplyCli(state.dataDir, await writeJsonFile(state.scratchHome, 'diff-resource.json', diffResource));
    if (resourceRes.code === 0) {
      diffFailures.push(`mutated resource origin was NOT rejected:\n${resourceRes.combined}`);
    } else {
      if (!resourceRes.combined.includes('synth-plm') && !resourceRes.combined.includes(state.plmResourceId)) {
        diffFailures.push(`resource diff missing 'synth-plm':\n${resourceRes.combined}`);
      }
      if (!/origin|plm-api|地址|192\.0\.2/i.test(resourceRes.combined)) {
        diffFailures.push(`resource diff missing origin field:\n${resourceRes.combined}`);
      }
    }

    const diffExecutor = structuredClone(baseParsed);
    const execEntry = diffExecutor.executors.find((e) => e.target === state.executorTarget);
    assert.ok(execEntry);
    execEntry.endpoint = LOOPBACK_EXEC_ALT;
    const execRes = await runApplyCli(state.dataDir, await writeJsonFile(state.scratchHome, 'diff-executor.json', diffExecutor));
    if (execRes.code === 0) {
      diffFailures.push(`mutated executor endpoint was NOT rejected:\n${execRes.combined}`);
    } else if (!execRes.combined.includes(state.executorTarget)) {
      diffFailures.push(`executor diff missing '${state.executorTarget}':\n${execRes.combined}`);
    }

    const rawVarClone = JSON.parse(baseRaw) as Record<string, unknown>;
    if (mutateOptionalSectionField(rawVarClone, ['variables', 'vars'], state.plainVarName, (rec) => {
      if (typeof rec.value !== 'string') return false;
      rec.value = 'mutated-unexpected-var-value';
      return true;
    })) {
      const varRes = await runApplyCli(state.dataDir, await writeJsonFile(state.scratchHome, 'diff-var.json', rawVarClone));
      if (varRes.code === 0) diffFailures.push(`mutated variable was NOT rejected:\n${varRes.combined}`);
      else if (!varRes.combined.includes(state.plainVarName)) diffFailures.push(`variable diff missing '${state.plainVarName}':\n${varRes.combined}`);
    }

    const rawDocClone = JSON.parse(baseRaw) as Record<string, unknown>;
    if (mutateOptionalSectionField(rawDocClone, ['documents', 'namedDocuments', 'docs'], state.docNoteName, (rec) => {
      for (const field of ['bytesBase64', 'content', 'text', 'body']) {
        if (typeof rec[field] !== 'string') continue;
        rec[field] = Buffer.from('mutated-doc-bytes-conflict', 'utf8').toString('base64');
        if (typeof rec.sha256 === 'string') rec.sha256 = createHash('sha256').update('mutated-doc-bytes-conflict').digest('hex');
        if (typeof rec.size === 'number') rec.size = Buffer.byteLength('mutated-doc-bytes-conflict', 'utf8');
        return true;
      }
      return false;
    })) {
      const docRes = await runApplyCli(state.dataDir, await writeJsonFile(state.scratchHome, 'diff-doc.json', rawDocClone));
      if (docRes.code === 0) diffFailures.push(`mutated document was NOT rejected:\n${docRes.combined}`);
      else if (!docRes.combined.includes(state.docNoteName)) diffFailures.push(`document diff missing '${state.docNoteName}':\n${docRes.combined}`);
    }

    assert.equal(diffFailures.length, 0, `apply diff refusal checks failed:\n${diffFailures.join('\n---\n')}`);
  });

  it('produces zero DB rows, zero visible objects, and zero partial mutations when early new items precede late conflicts or unpublished packs', async () => {
    const { root, state } = await seedRichHub({ includeHistoryAndKnowledge: false, canRunSandboxedPacks: false });
    cleanupQueue.push(() => teardownRoot(root, state.dataDir));

    const exportPath = join(state.scratchHome, 'atomic-base.json');
    await runExportCli(state.dataDir, exportPath, { expectOk: true });
    const def = DeploymentDefinition.parse(JSON.parse(await readFile(exportPath, 'utf8')));
    def.missingConfiguration = [];

    // Early brand-new valid additions (must NOT leak into DB or objects/ if later sections conflict):
    def.accounts.push({ name: 'latefail-alice', role: 'user', disabled: false });
    def.teams.push({ name: '延迟冲突测试组', members: ['latefail-alice'] });
    def.variables.push({ schema: 'variable@1', name: 'LATE_FAIL_EARLY_VAR', value: 'should-never-commit' });
    const earlyDocBytes = Buffer.from('early-doc-should-never-commit-n6\n', 'utf8');
    def.documents.push({
      name: 'late-fail-early-doc',
      sha256: createHash('sha256').update(earlyDocBytes).digest('hex'),
      size: earlyDocBytes.byteLength,
      bytesBase64: earlyDocBytes.toString('base64'),
      mediaType: 'text/plain',
      fileName: 'late-fail-early-doc.txt',
    });
    // Later multiple conflicts + unpublished pack reference (Q3):
    const aliceEntry = def.accounts.find((a) => a.name === 'alice');
    assert.ok(aliceEntry);
    aliceEntry.role = 'admin';
    const plmEntry = def.resources.find((r) => r.definition.name === 'synth-plm');
    assert.ok(plmEntry);
    plmEntry.definition.origins['plm-api'] = RFC5737_PLM_ALT;
    def.packs.push({ ref: 'unpublished-synth-pack@9.9.9', install: true, dependsOn: [] });

    const dbBefore = await inspectDatabaseState(state.dataDir);
    const objectsBefore = await hashDirectoryFiles(join(state.dataDir, 'objects'));
    const vaultBefore = await snapshotVaultAndKeys(state.dataDir);

    const applyRes = await runApplyCli(state.dataDir, await writeJsonFile(state.scratchHome, 'late-conflict.json', def));
    assert.notEqual(applyRes.code, 0, `apply with late conflicts & unpublished pack must fail:\n${applyRes.combined}`);

    const dbAfter = await inspectDatabaseState(state.dataDir);
    const objectsAfter = await hashDirectoryFiles(join(state.dataDir, 'objects'));
    const cliAfter = await readConfigCliSnapshot(state.dataDir);

    assert.equal(cliAfter.users.some((u) => u.name === 'latefail-alice'), false, 'zero-write precheck must not create early account');
    assert.equal(cliAfter.teams.includes('延迟冲突测试组'), false, 'zero-write precheck must not create early team');
    assert.equal(cliAfter.vars.includes('LATE_FAIL_EARLY_VAR'), false, 'zero-write precheck must not create early variable');
    assert.equal(cliAfter.docs.includes('late-fail-early-doc'), false, 'zero-write precheck must not create early document');
    assert.deepEqual(dbAfter.tables, dbBefore.tables, 'DB table row counts must remain strictly unchanged on precheck conflict');
    assert.deepEqual([...objectsAfter.entries()], [...objectsBefore.entries()], 'objects/ visibility/files must remain unchanged on precheck conflict');
    await assertVaultAndKeysUnchanged(state.dataDir, vaultBefore, 'after precheck-refused late conflict');

    assert.ok(applyRes.combined.includes('alice') && applyRes.combined.includes('synth-plm'), `precheck must report all named conflicts together:\n${applyRes.combined}`);
  });
});

describe('Group 5: concurrent preview-to-commit recheck & deadlock-free locking without wall-clock limits (N6 §5 #5)', () => {
  it('detects concurrent mutations between read/precheck and commit without deadlocking or silently overwriting', { timeout: 90_000 }, async () => {
    const { root, state } = await seedRichHub({ includeHistoryAndKnowledge: false, canRunSandboxedPacks: false });
    cleanupQueue.push(() => teardownRoot(root, state.dataDir));

    const exportPath = join(state.scratchHome, 'conc-export.json');
    await runExportCli(state.dataDir, exportPath, { expectOk: true });
    const def = DeploymentDefinition.parse(JSON.parse(await readFile(exportPath, 'utf8')));
    def.missingConfiguration = [];
    def.variables.push({ schema: 'variable@1', name: 'CONC_SHARED_VAR', value: 'from-apply' });
    const applyFile = await writeJsonFile(state.scratchHome, 'conc-apply.json', def);

    // Execute concurrent mutation against the same target Hub in parallel (Completion-ordered, zero elapsed<N assertions).
    const [applyRes, mutRes] = await Promise.all([
      runApplyCli(state.dataDir, applyFile),
      runCli(state.dataDir, ['var', 'set', 'CONC_SHARED_VAR', '--not-secret', '--text', '--reason', 'concurrent competing write'], {
        stdin: 'from-concurrent-cli',
      }),
    ]);

    assert.ok(applyRes.signal === null && mutRes.signal === null, 'concurrent operations must terminate cleanly without signals/deadlock');
    assert.fail(
      `[N6 待合约/实现: ${PENDING_N6_CONTRACTS.previewCommitBarrier}] deterministic preview-to-commit read-set barrier & explicit lock ordering await Codex N6 implementation`,
    );
  });
});

describe('Group 6: domain fault rollback, staged object invisibility & pre-existing object safety (N6 §5 #6)', () => {
  it('preserves existing objects/, hides staged artifact bytes on failure, and blocks replay on ambiguous commit receipts', async () => {
    const { root, state } = await seedRichHub({ includeHistoryAndKnowledge: false, canRunSandboxedPacks: false });
    cleanupQueue.push(() => teardownRoot(root, state.dataDir));

    const objectsBefore = await hashDirectoryFiles(join(state.dataDir, 'objects'));
    const preDoc = await runCli(state.dataDir, ['doc', 'show', state.docNoteName], { expectOk: true });
    assert.ok(preDoc.stdout.includes(state.docNoteSha256));

    // Introduce new document bytes alongside a downstream failure; verify pre-existing objects & named doc remain untouched.
    const exportPath = join(state.scratchHome, 'fault-export.json');
    await runExportCli(state.dataDir, exportPath, { expectOk: true });
    const def = DeploymentDefinition.parse(JSON.parse(await readFile(exportPath, 'utf8')));
    def.missingConfiguration = [];
    const stagedBytes = Buffer.from('staged-rollback-artifact-bytes-n6\n', 'utf8');
    const stagedSha = createHash('sha256').update(stagedBytes).digest('hex');
    def.documents.push({
      name: 'staged-rollback-doc',
      sha256: stagedSha,
      size: stagedBytes.byteLength,
      bytesBase64: stagedBytes.toString('base64'),
      mediaType: 'text/plain',
      fileName: 'staged-rollback-doc.txt',
    });
    assert.ok(def.executors[0], 'fixture must export at least one executor');
    def.executors[0].endpoint = LOOPBACK_EXEC_ALT;

    await runApplyCli(state.dataDir, await writeJsonFile(state.scratchHome, 'fault-apply.json', def));

    const objectsAfter = await hashDirectoryFiles(join(state.dataDir, 'objects'));
    for (const [rel, digest] of objectsBefore.entries()) {
      assert.equal(objectsAfter.get(rel), digest, `pre-existing object file ${rel} must not be deleted or altered on rollback`);
    }
    const stagedShow = await runCli(state.dataDir, ['doc', 'show', 'staged-rollback-doc']);
    assert.notEqual(stagedShow.code, 0, 'failed apply must never leave newly introduced document readable');

    assert.fail(
      `[N6 待合约/实现: ${PENDING_N6_CONTRACTS.stagedObjectBoundary}] domain commit fault injection, uncommitted object invisibility, and ambiguous receipt non-replay guard await owner seams`,
    );
  });
});

describe('Group 7: transactional sync intent persistence & decoupled post-commit status (N6 §5 #7)', () => {
  it('commits configuration and durable sync intent atomically while reporting unstarted/failed sync without falsely rolling back config', async () => {
    const { root, state } = await seedRichHub({ includeHistoryAndKnowledge: false, canRunSandboxedPacks: false });
    cleanupQueue.push(() => teardownRoot(root, state.dataDir));

    const exportPath = join(state.scratchHome, 'sync-intent-export.json');
    await runExportCli(state.dataDir, exportPath, { expectOk: true });
    const def = DeploymentDefinition.parse(JSON.parse(await readFile(exportPath, 'utf8')));
    def.missingConfiguration = [];
    def.variables.push({ schema: 'variable@1', name: 'POST_TX_SYNC_CHECK_VAR', value: 'committed-despite-sync-failure' });
    def.knowledgeSync = [{ product: state.productId, line: null }];

    await runApplyCli(state.dataDir, await writeJsonFile(state.scratchHome, 'sync-intent-apply.json', def));
    const varVal = await runCli(state.dataDir, ['var', 'show', 'POST_TX_SYNC_CHECK_VAR', '--value']);
    assert.equal(varVal.code, 0, `committed config must persist even if post-commit background sync fails:\n${varVal.combined}`);

    assert.fail(
      `[N6 待合约/实现: ${PENDING_N6_CONTRACTS.syncIntentReceipt}] decoupled config-committed vs post-commit sync-intent receipt & worker failure simulation await contracts freeze`,
    );
  });
});

describe('Group 8: strict refusal of unknown/legacy schemas, zero conversion, & historical record byte immutability (N6 §5 #8)', () => {
  it('rejects unknown deployment schema cleanly and keeps historical run/action record digests and bytes bit-for-bit untouched across export/apply', async () => {
    const { root, state } = await seedRichHub({ includeHistoryAndKnowledge: true, canRunSandboxedPacks: false });
    cleanupQueue.push(() => teardownRoot(root, state.dataDir));

    const historyBefore = await snapshotHistoricalRunAndActionRecords(state.dataDir);
    assert.ok(historyBefore.length > 0, 'fixture must contain persisted run/action history records');

    const badSchemaFile = await writeJsonFile(state.scratchHome, 'unknown-schema.json', {
      schema: 'deployment@99',
      accounts: [],
    });
    const unknownSchemaRes = await runApplyCli(state.dataDir, badSchemaFile);
    assert.notEqual(unknownSchemaRes.code, 0, 'unknown deployment schema must be strictly rejected');

    const exportPath = join(state.scratchHome, 'history-check-export.json');
    await runExportCli(state.dataDir, exportPath, { expectOk: true });
    const confirmedPath = join(state.scratchHome, 'history-check-confirmed.json');
    await writeConfirmedApplyManifest(exportPath, confirmedPath);
    await runApplyCli(state.dataDir, confirmedPath, { expectOk: true });

    const historyAfter = await snapshotHistoricalRunAndActionRecords(state.dataDir);
    assert.deepEqual(historyAfter, historyBefore, 'export and apply must leave existing historical run/action bytes and digests untouched');

    assert.fail(
      `[N6 待合约/实现: ${PENDING_N6_CONTRACTS.strictSchemaCutover}] once N6 schema supersedes 'deployment@1', legacy 'deployment@1' must also be strictly rejected without offline conversion`,
    );
  });
});
