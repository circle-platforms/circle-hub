import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fidelityBrief } from '../functions/fidelity.ts';
import { goodData } from '../functions/test-support.ts';
import { briefFile, verdictFile } from './fidelity-brief.ts';
import { main, type CarryIo } from './carry-plans.ts';

const SOURCE_RUN = 'run_01aaaaaaaaaaaaaaaaaaaaaaaa';
const TARGET_RUN = 'run_01bbbbbbbbbbbbbbbbbbbbbbbb';
const RECORD_A = {
  schema: 'recompose-record@1',
  contract: { intent: { text: '合成意图 A' } },
  atoms: [
    { id: 'a1', kind: 'intent', text: '合成意图 A' },
    { id: 'a2', kind: 'action', text: '配置合成规则 A' },
  ],
  ledgers: {
    original: [{ atom: 'a2', text: '配置合成规则 A' }],
    adapted: [],
    concretizations: [],
    rebindings: [],
  },
};
const VERDICT_A = {
  steps: [{ n: 'a2', verdict: 'preserved', step_indices: [1], rationale: '第 1 步实现原始动作' }],
  disclosure: '合成说明：第 1 步覆盖原始动作。',
};

const shaHex = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

async function runCli(argv: string[], io?: CarryIo): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: await main(argv, io), stdout: out.join(''), stderr: err.join('') };
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
}

function makeSources() {
  return [
    { slot: 'subject', role: 'input', reference: 'src:' + 'a'.repeat(64) },
    { slot: 'contract', role: 'input', reference: 'src:' + 'b'.repeat(64) },
    { slot: 'inventory', role: 'input', reference: 'src:' + 'c'.repeat(64) },
    { slot: 'profile', role: 'input', reference: 'src:' + 'd'.repeat(64) },
  ];
}

function makePlanWithFidelity(itemId: string, record: unknown, mutator?: (data: Record<string, unknown>) => void) {
  const data = goodData() as unknown as Record<string, unknown>;
  if (mutator) mutator(data);
  const brief = fidelityBrief(itemId, record, data)!;
  const withFidelity = {
    ...data,
    fidelity: {
      brief_sha256: brief.brief_sha256,
      ...VERDICT_A,
    },
  };
  return {
    brief,
    plan: {
      item: itemId,
      handling: 'handled',
      slots: { plan: [{ data: withFidelity }] },
    },
  };
}

async function setupWorkspace() {
  const root = await mkdtemp(join(tmpdir(), 'cc-carry-plans-'));
  const sourceDir = join(root, 'run1');
  const targetDir = join(root, 'run2');
  const sourcePlans = join(root, 'plans1');
  const targetPlans = join(root, 'plans2');
  const sourceBriefs = join(root, 'briefs1');
  const targetBriefs = join(root, 'briefs2');
  await mkdir(sourceDir, { recursive: true });
  await mkdir(targetDir, { recursive: true });
  await mkdir(sourcePlans, { recursive: true });
  await mkdir(sourceBriefs, { recursive: true });

  const items = [
    { id: 'doc:c1', fields: { autoid: '100000000000000001', title: '用例1', recomposition: { record: RECORD_A } } },
    { id: 'doc:c2', fields: { autoid: '100000000000000002', title: '用例2', recomposition: { record: RECORD_A } } },
    { id: 'doc:c3', fields: { autoid: '100000000000000003', title: '用例3', recomposition: { record: RECORD_A } } },
    { id: 'doc:c4', fields: { autoid: '100000000000000004', title: '用例4', recomposition: { record: RECORD_A } } },
    { id: 'doc:c5', fields: { autoid: '100000000000000005', title: '用例5', recomposition: { record: RECORD_A } } },
  ];
  const common = { product: 'orbit', build: 'Rel_ORBIT_1', root: 'e'.repeat(64), sources: makeSources() };
  await writeFile(join(sourceDir, 'run.json'), JSON.stringify({ ...common, run: SOURCE_RUN, items }, null, 2));
  await writeFile(
    join(targetDir, 'run.json'),
    JSON.stringify({ ...common, run: TARGET_RUN, parameters: { exclude: ['100000000000000003'] }, items }, null, 2),
  );

  const p1 = makePlanWithFidelity('doc:c1', RECORD_A);
  const p1Bytes = Buffer.from(JSON.stringify(p1.plan, null, 2) + '\n');
  await writeFile(join(sourcePlans, '00.json'), p1Bytes);
  const b1Path = briefFile(sourceBriefs, '00', p1.brief.brief_sha256);
  const v1Path = verdictFile(sourceBriefs, '00', p1.brief.brief_sha256);
  await writeFile(b1Path, JSON.stringify(p1.brief, null, 2) + '\n');
  await writeFile(v1Path, JSON.stringify(VERDICT_A, null, 2) + '\n');

  const p2 = makePlanWithFidelity('doc:c2', RECORD_A);
  await writeFile(join(sourcePlans, '01.json'), JSON.stringify(p2.plan, null, 2) + '\n');

  const p3 = makePlanWithFidelity('doc:c3', RECORD_A);
  await writeFile(join(sourcePlans, '02.json'), JSON.stringify(p3.plan, null, 2) + '\n');

  const p4 = makePlanWithFidelity('doc:c4', RECORD_A);
  (p4.plan.slots.plan[0].data.fidelity as Record<string, unknown>).brief_sha256 = 'f'.repeat(64);
  await writeFile(join(sourcePlans, '03.json'), JSON.stringify(p4.plan, null, 2) + '\n');

  return { root, sourceDir, targetDir, sourcePlans, targetPlans, sourceBriefs, targetBriefs, p1, p1Bytes };
}

test('carry-plans selectively carries verified unchanged plans and fidelity artifacts with post-write SHA-256 verification', async () => {
  const w = await setupWorkspace();
  const prevCwd = process.cwd();
  process.chdir(w.root);
  try {
    const res = await runCli([
      '--source', 'run1',
      '--target', 'run2',
      '--source-plans', 'plans1',
      '--plans', 'plans2',
      '--source-briefs', 'briefs1',
      '--briefs', 'briefs2',
      '--rework', '100000000000000002',
    ]);
    assert.equal(res.code, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.schema, 'carry-plans@1');
    assert.equal(out.source_run, SOURCE_RUN);
    assert.equal(out.target_run, TARGET_RUN);
    assert.deepEqual(out.skipped.rework, ['100000000000000002']);
    assert.deepEqual(out.skipped.excluded, ['100000000000000003']);
    assert.deepEqual(out.needs_recheck, ['plans2/03.json']);

    assert.equal(out.carried.length, 2);
    const c1Entry = out.carried.find((c: Record<string, unknown>) => c.item === 'doc:c1');
    assert.ok(c1Entry);
    assert.equal(c1Entry.fidelity, 'reused');
    assert.equal(c1Entry.sha256, shaHex(w.p1Bytes));
    assert.equal(c1Entry.verified, true);
    assert.equal(c1Entry.brief_verified, true);
    assert.equal(c1Entry.verdict_verified, true);
    assert.deepEqual(await readFile(join(w.targetPlans, '00.json')), w.p1Bytes);

    const c4Entry = out.carried.find((c: Record<string, unknown>) => c.item === 'doc:c4');
    assert.ok(c4Entry);
    assert.equal(c4Entry.fidelity, 'stripped');
    assert.equal(c4Entry.verified, true);
    const c4Disk = JSON.parse(await readFile(join(w.targetPlans, '03.json'), 'utf8'));
    assert.equal(c4Disk.slots.plan[0].data.fidelity, undefined, 'stale fidelity must be stripped');
    assert.equal(c4Entry.sha256, shaHex(await readFile(join(w.targetPlans, '03.json'))));

    assert.deepEqual((await readdir(w.targetPlans)).sort(), ['00.json', '03.json']);
    const briefFiles = (await readdir(w.targetBriefs)).sort();
    assert.equal(briefFiles.length, 2);
    assert.ok(briefFiles.some((n) => n.endsWith('.brief.json')));
    assert.ok(briefFiles.some((n) => n.endsWith('.verdict.json')));
  } finally {
    process.chdir(prevCwd);
    await rm(w.root, { recursive: true, force: true });
  }
});

test('carry-plans fails closed on mismatched build/root/sources, changed item spec, collisions, symlinks, escapes, or SHA readback mismatch', async () => {
  const w = await setupWorkspace();
  const prevCwd = process.cwd();
  process.chdir(w.root);
  try {
    const run2BadBuild = JSON.parse(await readFile(join(w.targetDir, 'run.json'), 'utf8'));
    run2BadBuild.build = 'Rel_ORBIT_2';
    await writeFile(join(w.targetDir, 'run.json'), JSON.stringify(run2BadBuild));
    const badBuild = await runCli(['--source', 'run1', '--target', 'run2', '--source-plans', 'plans1', '--plans', 'plans_bad_build']);
    assert.equal(badBuild.code, 1);
    assert.match(badBuild.stderr, /build|构建/);
    await assert.rejects(readdir(join(w.root, 'plans_bad_build')));

    run2BadBuild.build = 'Rel_ORBIT_1';
    run2BadBuild.product = 'other-product';
    await writeFile(join(w.targetDir, 'run.json'), JSON.stringify(run2BadBuild));
    const badProd = await runCli(['--source', 'run1', '--target', 'run2', '--source-plans', 'plans1', '--plans', 'plans_bad_product']);
    assert.equal(badProd.code, 1);
    assert.match(badProd.stderr, /product|产品/);

    run2BadBuild.product = 'orbit';
    run2BadBuild.root = '9'.repeat(64);
    await writeFile(join(w.targetDir, 'run.json'), JSON.stringify(run2BadBuild));
    assert.equal((await runCli(['--source', 'run1', '--target', 'run2', '--source-plans', 'plans1', '--plans', 'plans_bad_root'])).code, 1);

    run2BadBuild.root = 'e'.repeat(64);
    run2BadBuild.sources[1].reference = 'src:' + '0'.repeat(64);
    await writeFile(join(w.targetDir, 'run.json'), JSON.stringify(run2BadBuild));
    assert.equal((await runCli(['--source', 'run1', '--target', 'run2', '--source-plans', 'plans1', '--plans', 'plans_bad_src'])).code, 1);

    run2BadBuild.sources = makeSources();
    run2BadBuild.parameters = { scope: { words: '只要 1 号', cases: ['100000000000000001', '100000000000000004'] } };
    run2BadBuild.items[3].fields.recomposition = { record: { ...RECORD_A, atoms: [...RECORD_A.atoms, { id: 'a3', kind: 'action', text: '新增动作' }] } };
    await writeFile(join(w.targetDir, 'run.json'), JSON.stringify(run2BadBuild));
    const scoped = await runCli(['--source', 'run1', '--target', 'run2', '--source-plans', 'plans1', '--plans', 'plans_scoped']);
    assert.equal(scoped.code, 0, scoped.stderr);
    const scopedOut = JSON.parse(scoped.stdout);
    assert.deepEqual(scopedOut.skipped.spec_changed, ['100000000000000004']);
    assert.ok(scopedOut.skipped.out_of_scope.includes('100000000000000002'));
    assert.deepEqual((await readdir(join(w.root, 'plans_scoped'))).sort(), ['00.json']);

    const collision = await runCli(['--source', 'run1', '--target', 'run2', '--source-plans', 'plans1', '--plans', 'plans_scoped']);
    assert.equal(collision.code, 1);
    assert.match(collision.stderr, /^已被占用：.*已存在/);

    await symlink(join(w.sourcePlans, '00.json'), join(w.sourcePlans, 'link.json'));
    const symRes = await runCli(['--source', 'run1', '--target', 'run2', '--source-plans', 'plans1', '--plans', 'plans_sym']);
    assert.equal(symRes.code, 1);
    assert.match(symRes.stderr, /符号链接/);
    await rm(join(w.sourcePlans, 'link.json'));

    const escapeRes = await runCli(['--source', 'run1', '--target', 'run2', '--source-plans', 'plans1', '--plans', '../outside']);
    assert.equal(escapeRes.code, 1);
    assert.match(escapeRes.stderr, /超出当前工作目录/);

    const tamperedIo: CarryIo = {
      readBack: async () => Buffer.from('tampered'),
    };
    const shaFail = await runCli(['--source', 'run1', '--target', 'run2', '--source-plans', 'plans1', '--plans', 'plans_sha_fail'], tamperedIo);
    assert.equal(shaFail.code, 1);
    assert.match(shaFail.stderr, /^暂时不可用：.*SHA-256/);
  } finally {
    process.chdir(prevCwd);
    await rm(w.root, { recursive: true, force: true });
  }
});
