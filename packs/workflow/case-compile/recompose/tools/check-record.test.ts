import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from './check-record.ts';

const atom = (id: string, kind: string, text: string, after: string[] = []) => ({
  id,
  kind,
  text,
  content: text,
  reference: `src:${'a'.repeat(64)}/kityminder@1/n/${id}`,
  selector: `n/${id}`,
  node_id: id,
  start: 0,
  end: text.length,
  labels: [],
  explicit_labels: [],
  number_label: null,
  after,
});

const item = (id = 'n/case1') => ({
  id,
  fields: {
    case_id: 'ORBIT-1',
    source_ref: 'src:' + 'a'.repeat(64),
    node: id,
    atoms: [atom('a1', 'action', '合成动作'), atom('a2', 'expectation', '合成期望', ['a1'])],
  },
});

const validLite = (id = 'n/case1') => ({
  item: id,
  method: { kind: 'declared', text: '合成方法', sources: ['ref'], basis: '合成依据' },
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

test('check-record supports --help and accepts valid single lite record and directory offline', async () => {
  const help = await runCli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /--file/);

  const root = await mkdtemp(join(tmpdir(), 'rc-check-valid-'));
  try {
    const recDir = join(root, 'records');
    await mkdir(recDir);
    await writeFile(join(recDir, '01.json'), JSON.stringify(validLite('n/case1')), 'utf8');
    await writeFile(join(recDir, '02.json'), JSON.stringify(validLite('n/case2')), 'utf8');

    const runDir = join(root, 'run');
    await mkdir(runDir);
    await writeFile(
      join(runDir, 'run.json'),
      JSON.stringify({ run: 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', items: [item('n/case1'), item('n/case2')] }),
      'utf8',
    );

    const single = await runCli(['--file', join(recDir, '01.json'), '--run', runDir]);
    assert.equal(single.code, 0, single.err);
    assert.equal(single.err, '');
    assert.equal(JSON.parse(single.out).ok, true);

    const dirRes = await runCli(['--file', recDir, '--run', runDir]);
    assert.equal(dirRes.code, 0, dirRes.err);
    const parsed = JSON.parse(dirRes.out);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.checked, 2);
    assert.equal(parsed.passed, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
    await writeFile(join(dupDir, 'a.json'), JSON.stringify(validLite('n/same')), 'utf8');
    await writeFile(join(dupDir, 'b.json'), JSON.stringify(validLite('n/same')), 'utf8');
    const rDup = await runCli(['--file', dupDir]);
    assert.equal(rDup.code, 1);
    assert.match(rDup.err, /^已被占用：/);
    assert.match(rDup.err, /n\/same/);

    // 6. --run completeness check rejects missing frozen case
    const runDir = join(root, 'run');
    await mkdir(runDir);
    await writeFile(
      join(runDir, 'run.json'),
      JSON.stringify({ run: 'run_01bbbbbbbbbbbbbbbbbbbbbbbb', items: [item('n/case1'), item('n/case2')] }),
      'utf8',
    );
    const oneDir = join(root, 'one');
    await mkdir(oneDir);
    await writeFile(join(oneDir, '01.json'), JSON.stringify(validLite('n/case1')), 'utf8');
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
