import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { frozenRunFixture, writeFrozenRun, type FrozenRunFixture } from '../../testing/recompose-frozen.ts';
import { main } from './check-record.ts';

const PACK_DIR = fileURLToPath(new URL('../', import.meta.url));

/** One lite record of a frozen item: the method cites the item's first original sentence by its reference, as the Hub requires. */
type Row = { [key: string]: any };
const lite = (row: Row, method: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  item: row.id,
  method: { kind: 'declared', text: '合成方法', sources: [row.fields.atoms[0].reference], basis: '合成依据', ...method },
  ...extra,
});

async function runCli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await main(argv);
    return { code, out: out.join(''), err: err.join('') };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

async function withFrozenRun<T>(run: (dir: { root: string; runDir: string; recDir: string; frozen: FrozenRunFixture }) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'rc-check-frozen-'));
  try {
    const runDir = join(root, 'run');
    const recDir = join(root, 'records');
    await mkdir(recDir);
    const frozen = await writeFrozenRun(runDir);
    return await run({ root, runDir, recDir, frozen });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('check-record supports --help and accepts valid single lite record and directory against the frozen run', async () => {
  const help = await runCli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /--file/);

  await withFrozenRun(async ({ runDir, recDir, frozen }) => {
    await writeFile(join(recDir, '01.json'), JSON.stringify(lite(frozen.items[0])), 'utf8');
    await writeFile(join(recDir, '02.json'), JSON.stringify(lite(frozen.items[1])), 'utf8');

    const single = await runCli(['--file', join(recDir, '01.json'), '--run', runDir]);
    assert.equal(single.code, 0, single.err + single.out);
    assert.equal(single.err, '');
    assert.equal(JSON.parse(single.out).ok, true);

    const dirRes = await runCli(['--file', recDir, '--run', runDir]);
    assert.equal(dirRes.code, 0, dirRes.err + dirRes.out);
    const parsed = JSON.parse(dirRes.out);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.checked, 2);
    assert.equal(parsed.passed, 2);
    assert.equal(parsed.hub_checks.ran, true);
    assert.deepEqual(parsed.hub_checks.checks, ['record', 'full_set']);
  });
});

test('check-record rejects bad UTF-8, broken JSON, full schema misuse, missing item/method, duplicate item, incomplete run, and symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rc-check-bad-'));
  try {
    // 1. Invalid UTF-8 bytes
    const badUtf8 = join(root, 'bad-utf8.json');
    await writeFile(badUtf8, Buffer.from([0x7b, 0xff, 0xfe, 0x7d]));
    const rUtf8 = await runCli(['--file', badUtf8]);
    assert.equal(rUtf8.code, 1);
    assert.match(rUtf8.err, /^参数无效：/);
    assert.match(rUtf8.out, /UTF-8/);

    // 2. Broken JSON syntax
    const badJson = join(root, 'broken.json');
    await writeFile(badJson, '{"item": "n/1",', 'utf8');
    const rJson = await runCli(['--file', badJson]);
    assert.equal(rJson.code, 1);
    assert.match(rJson.err, /^参数无效：/);
    assert.match(rJson.out, /JSON/);

    // 3. Full schema misuse (recompose-record@1 / handling)
    const fullSchema = join(root, 'full.json');
    await writeFile(
      fullSchema,
      JSON.stringify({
        item: 'n/case1',
        schema: 'recompose-record@1',
        handling: 'handled',
        method: { kind: 'declared' },
      }),
      'utf8',
    );
    const rFull = await runCli(['--file', fullSchema]);
    assert.equal(rFull.code, 1);
    assert.match(rFull.out, /不得使用完整的 recompose-record@1 结构/);

    // 4. Missing item or missing/bad method or non-array states
    const noItem = join(root, 'no-item.json');
    await writeFile(noItem, JSON.stringify({ method: { kind: 'declared' } }), 'utf8');
    assert.equal((await runCli(['--file', noItem])).code, 1);

    const noMethod = join(root, 'no-method.json');
    await writeFile(noMethod, JSON.stringify({ item: 'n/case1' }), 'utf8');
    const rNoMethod = await runCli(['--file', noMethod]);
    assert.equal(rNoMethod.code, 1);
    assert.match(rNoMethod.out, /method/);

    const badKind = join(root, 'bad-kind.json');
    await writeFile(badKind, JSON.stringify({ item: 'n/case1', method: { kind: 'guess' } }), 'utf8');
    assert.equal((await runCli(['--file', badKind])).code, 1);

    // 5. Duplicate item across two files in directory -> category '已被占用'
    const dupDir = join(root, 'dup');
    await mkdir(dupDir);
    const same = { item: 'n/same', method: { kind: 'declared', text: '合成方法', sources: ['ref'], basis: '合成依据' } };
    await writeFile(join(dupDir, 'a.json'), JSON.stringify(same), 'utf8');
    await writeFile(join(dupDir, 'b.json'), JSON.stringify(same), 'utf8');
    const rDup = await runCli(['--file', dupDir]);
    assert.equal(rDup.code, 1);
    assert.match(rDup.err, /^已被占用：/);
    assert.match(rDup.err, /n\/same/);

    // 6. --run completeness check rejects missing frozen case
    const runDir = join(root, 'run');
    const frozen = await writeFrozenRun(runDir);
    const oneDir = join(root, 'one');
    await mkdir(oneDir);
    await writeFile(join(oneDir, '01.json'), JSON.stringify(lite(frozen.items[0])), 'utf8');
    const rMissingCase = await runCli(['--file', oneDir, '--run', runDir]);
    assert.equal(rMissingCase.code, 1);
    assert.match(rMissingCase.out, /还有 1 条原始用例没有重组后的用例/);

    // 7. Missing file and symlink refused
    const rMissing = await runCli(['--file', join(root, 'does-not-exist.json')]);
    assert.equal(rMissing.code, 1);
    assert.match(rMissing.err, /^不存在：/);

    const linkPath = join(root, 'link.json');
    await symlink(noItem, linkPath);
    const rLink = await runCli(['--file', linkPath]);
    assert.equal(rLink.code, 1);
    assert.match(rLink.err, /^参数无效：.*符号链接/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The failure of run 33 (round 33): the model cited the original sentences by their words. check-record said ok, the Hub refused
// every one of them. The local check now runs the Hub's own `record` check on the frozen run, so the refusal comes before submit.
test('a method source written as the original sentence is refused locally, once for each value, with the Hub check\'s own words', async () => {
  await withFrozenRun(async ({ runDir, recDir, frozen }) => {
    const [first, second] = frozen.items;
    const words = first.fields.atoms.map((atom: { text: string }) => atom.text);
    await writeFile(join(recDir, '01.json'), JSON.stringify(lite(first, { sources: words })), 'utf8');
    await writeFile(join(recDir, '02.json'), JSON.stringify(lite(second)), 'utf8');

    const result = await runCli(['--file', recDir, '--run', runDir]);
    assert.equal(result.code, 1, result.out);
    const report = JSON.parse(result.out);
    assert.equal(report.ok, false);
    assert.equal(report.failed, 1);
    assert.deepEqual(report.items.map((entry: { ok: boolean }) => entry.ok), [false, true]);
    assert.equal(report.problems.length, words.length, JSON.stringify(report.problems));
    for (const [index, value] of words.entries()) {
      const problem = report.problems[index];
      assert.equal(problem.file, '01.json');
      assert.equal(problem.item, first.id);
      assert.equal(problem.check, 'record');
      assert.equal(problem.verdict, 'unknown');
      assert.equal(problem.code, 'missing_input');
      assert.ok(problem.message.includes(value), problem.message);
    }
    assert.match(result.err, /^参数无效：/);
  });
});

test('a record that cites the original sentences by their references, and the locked tree by tree references, passes the same check', async () => {
  await withFrozenRun(async ({ runDir, recDir, frozen }) => {
    const [first, second] = frozen.items;
    await writeFile(join(recDir, '01.json'), JSON.stringify(lite(first, { sources: first.fields.atoms.map((atom: { reference: string }) => atom.reference) })), 'utf8');
    const tree = `tree:${frozen.root}/commands/widget/health/interval@${'1'.repeat(64)}`;
    await writeFile(join(recDir, '02.json'), JSON.stringify(lite(second, { sources: [tree] })), 'utf8');
    const result = await runCli(['--file', recDir, '--run', runDir]);
    assert.equal(result.code, 0, result.out);
    assert.equal(JSON.parse(result.out).ok, true);
  });
});

test('a field outside the closed set the pack declares is refused before the Hub refuses the whole record, at its place and with what is allowed', async () => {
  await withFrozenRun(async ({ runDir, recDir, frozen }) => {
    const [first, second] = frozen.items;
    await writeFile(join(recDir, '01.json'), JSON.stringify(lite(first, {}, { slots: [{ atom: 'a2', knowledge_location: 'has_knowledge', evidence: [], proposal: null }] })), 'utf8');
    await writeFile(join(recDir, '02.json'), JSON.stringify(lite(second, { sources: ['不是引用的原句文字'] })), 'utf8');
    const result = await runCli(['--file', recDir, '--run', runDir]);
    assert.equal(result.code, 1, result.out);
    const report = JSON.parse(result.out);
    const refused = report.problems.filter((problem: Row) => problem.check === 'slots');
    assert.equal(refused.length, 1, JSON.stringify(report.problems));
    assert.equal(refused[0].code, 'SUBMISSION_SCHEMA_VIOLATION');
    assert.equal(refused[0].item, first.id);
    assert.equal(refused[0].pointer, '/slots/record/0/data/expectation_slots/0/knowledge_location');
    assert.ok(refused[0].message.includes('slots（记录里的 /expectation_slots/0/knowledge_location）：写的是 "has_knowledge"'), refused[0].message);
    assert.ok(refused[0].message.includes('"has_verification_knowledge" | "recomposable_from_elsewhere" | "genuinely_missing"'), refused[0].message);
    // The Hub still checks the other case, and so does the local check; the whole-run check says why it did not run.
    assert.ok(report.problems.some((problem: Row) => problem.check === 'record' && problem.item === second.id));
    assert.deepEqual(report.hub_checks.not_run.map((row: Row) => row.check), ['quotes', 'full_set']);
  });
});

test('without --run the report says the Hub checks did not run, so a green shape check is not read as the Hub\'s acceptance', async () => {
  await withFrozenRun(async ({ recDir, frozen }) => {
    const first = frozen.items[0];
    await writeFile(join(recDir, '01.json'), JSON.stringify(lite(first, { sources: ['不是引用的原句文字'] })), 'utf8');
    const result = await runCli(['--file', join(recDir, '01.json')]);
    assert.equal(result.code, 0, result.out);
    const report = JSON.parse(result.out);
    assert.equal(report.ok, true);
    assert.equal(report.hub_checks.ran, false);
    assert.match(report.hub_checks.why, /--run/);
    assert.deepEqual(report.hub_checks.checks, []);
  });
});

test('every check of checks.json is run locally or reported as not run, so a new Hub check cannot go unnoticed', async () => {
  await withFrozenRun(async ({ runDir, recDir, frozen }) => {
    await writeFile(join(recDir, '01.json'), JSON.stringify(lite(frozen.items[0])), 'utf8');
    await writeFile(join(recDir, '02.json'), JSON.stringify(lite(frozen.items[1])), 'utf8');
    const report = JSON.parse((await runCli(['--file', recDir, '--run', runDir])).out);
    const declared: string[] = JSON.parse(await readFile(join(PACK_DIR, 'checks.json'), 'utf8')).checks.map((check: { id: string }) => check.id);
    const accounted: string[] = [...report.hub_checks.checks, ...report.hub_checks.not_run.map((row: { check: string }) => row.check)];
    assert.deepEqual([...accounted].sort(), [...declared].sort());
    for (const row of report.hub_checks.not_run) assert.ok(typeof row.why === 'string' && row.why.length > 0, JSON.stringify(row));
  });
});

test('the download must carry the locked command tree of the same run, or the check refuses instead of guessing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rc-check-tree-'));
  try {
    const frozen = frozenRunFixture();
    const recDir = join(root, 'records');
    await mkdir(recDir);
    await writeFile(join(recDir, '01.json'), JSON.stringify(lite(frozen.items[0])), 'utf8');
    await writeFile(join(recDir, '02.json'), JSON.stringify(lite(frozen.items[1])), 'utf8');

    const noTree = join(root, 'no-tree');
    await mkdir(noTree);
    await writeFile(join(noTree, 'run.json'), JSON.stringify(frozen.run));
    const missing = await runCli(['--file', recDir, '--run', noTree]);
    assert.equal(missing.code, 1);
    assert.match(missing.err, /^不存在：/);
    assert.match(missing.err, /knowledge\/nodes\.jsonl/);
    assert.match(missing.err, /download-run\.ts/);

    const other = join(root, 'other-run');
    await writeFrozenRun(other, { ...frozen, nodes: frozen.nodes.replace(frozen.run.run, 'run_01bbbbbbbbbbbbbbbbbbbbbbbb') });
    const wrong = await runCli(['--file', recDir, '--run', other]);
    assert.equal(wrong.code, 1);
    assert.match(wrong.err, /^参数无效：/);
    assert.match(wrong.err, /knowledge\/nodes\.jsonl/);
    assert.ok(wrong.err.includes(frozen.run.run), wrong.err);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
