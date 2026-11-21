import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { digestOf } from '../../../hub/records/api.ts';
import { ExportError, parseIndex, readRecordedExport } from './submissions-recorded.ts';

const RUN = 'run_0000000000000000000000000a';
const OTHER = 'run_0000000000000000000000000b';
let dir: string;

async function put(seq: number, kind: string, run: string, body: unknown, index: string[]): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(body));
  await mkdir(join(dir, run), { recursive: true });
  await writeFile(join(dir, run, `${seq}-${kind}.json`), bytes);
  index.push([seq, kind, run, 'demo@1.0.0', '2026-01-02T03:04:05Z', bytes.length, createHash('sha256').update(bytes).digest('hex')].join('\t'));
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'circle-hub-recorded-test-'));
  const index = ['seq\tkind\trun\tpack\tat\tbytes\tsha256'];
  const first = { run: RUN, model: 'm', items: [{ item: 'a' }] };
  const second = { run: RUN, model: 'm', items: [{ item: 'b' }] };
  const unvalidated = { run: OTHER, model: 'm', items: [] };
  await put(10, 'run', RUN, { run: RUN, pack: 'demo@1.0.0' }, index);
  await put(11, 'submission', RUN, first, index);
  await put(12, 'validation_result', RUN, { run: RUN, submission: digestOf(first), acceptance: 'accepted' }, index);
  await put(13, 'result_summary', RUN, { run: RUN }, index);
  await put(14, 'submission', RUN, second, index);
  await put(15, 'validation_result', RUN, { run: RUN, submission: digestOf(first), acceptance: 'accepted' }, index);
  await put(16, 'validation_result', RUN, { run: RUN, submission: digestOf(second), acceptance: 'not_accepted' }, index);
  await put(17, 'validation_result', RUN, { run: RUN, submission: 'f'.repeat(64), acceptance: 'accepted' }, index);
  await put(20, 'run', OTHER, { run: OTHER, pack: 'demo@1.0.0' }, index);
  await put(21, 'submission', OTHER, unvalidated, index);
  await writeFile(join(dir, 'index.tsv'), `${index.join('\n')}\n`);
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('the export folder', () => {
  test('pairs each validation result with its submission by digest and numbers the results of one submission', async () => {
    const recorded = await readRecordedExport(dir);
    assert.deepEqual(recorded.problems, []);
    assert.deepEqual([...recorded.runs.keys()].sort(), [RUN, OTHER]);
    assert.deepEqual(recorded.tasks.map((t) => [t.seq, t.submission?.seq ?? null, t.ordinal]), [[12, 11, 1], [15, 11, 2], [16, 14, 1], [17, null, 0]]);
  });

  test('names the submissions no validation result is for', async () => {
    const recorded = await readRecordedExport(dir);
    assert.deepEqual(recorded.unvalidated.map((e) => e.seq), [21]);
  });

  test('a file is read only after its size and SHA-256 were checked against the index', async () => {
    const recorded = await readRecordedExport(dir);
    const entry = recorded.entries.find((e) => e.seq === 13)!;
    assert.deepEqual(await recorded.read(entry), { run: RUN });
    await assert.rejects(recorded.read({ ...entry, sha256: 'a'.repeat(64) }), (error: unknown) => error instanceof ExportError && error.code === 'integrity');
    await assert.rejects(recorded.read({ ...entry, bytes: entry.bytes + 1 }), (error: unknown) => error instanceof ExportError && error.code === 'integrity');
    await assert.rejects(recorded.read({ ...entry, file: join(RUN, 'nothing.json') }), (error: unknown) => error instanceof ExportError && error.code === 'missing');
  });

  test('a damaged file is a problem of the folder, and its result is not paired', async () => {
    const copy = await mkdtemp(join(tmpdir(), 'circle-hub-recorded-damaged-'));
    try {
      const index = ['seq\tkind\trun\tpack\tat\tbytes\tsha256'];
      const previous = dir;
      dir = copy;
      await put(1, 'submission', RUN, { run: RUN, model: 'm', items: [] }, index);
      await put(2, 'validation_result', RUN, { run: RUN, submission: digestOf({ run: RUN, model: 'm', items: [] }) }, index);
      await writeFile(join(copy, 'index.tsv'), `${index.join('\n')}\n`);
      await writeFile(join(copy, RUN, '2-validation_result.json'), '{"changed":true}');
      dir = previous;
      const recorded = await readRecordedExport(copy);
      assert.equal(recorded.problems.length, 1);
      assert.match(recorded.problems[0], /核对结果 .*2-validation_result\.json.*大小/);
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });

  test('an index that is not the expected one is refused with what is wrong', () => {
    assert.throws(() => parseIndex(''), /是空的/);
    assert.throws(() => parseIndex('seq\tkind\n'), /表头/);
    assert.throws(() => parseIndex('seq\tkind\trun\tpack\tat\tbytes\tsha256\n1\tother\t' + RUN + '\tp\tt\t1\t' + 'a'.repeat(64) + '\n'), /种类 other 不认识/);
    assert.throws(() => parseIndex('seq\tkind\trun\tpack\tat\tbytes\tsha256\nx\trun\t' + RUN + '\tp\tt\t1\t' + 'a'.repeat(64) + '\n'), /格式不对/);
  });
});

describe('the exporter that runs on the Hub host', () => {
  test('names the runs of an index and imports nothing of the Hub: it needs only node and the pg package', async () => {
    const { runsOfIndex } = await import('./export-bundle.ts');
    assert.deepEqual(runsOfIndex(`seq\tkind\trun\tpack\tat\tbytes\tsha256\n1\trun\t${RUN}\tp\tt\t1\t${'a'.repeat(64)}\n2\tsubmission\t${RUN}\tp\tt\t1\t${'b'.repeat(64)}\n3\trun\t${OTHER}\tp\tt\t1\t${'c'.repeat(64)}\n`), [RUN, OTHER]);
    const { readFile } = await import('node:fs/promises');
    for (const file of ['export-bundle.ts', 'submissions-export.ts', 'submissions-bundle-format.ts']) {
      const text = await readFile(new URL(`./${file}`, import.meta.url), 'utf8');
      const imports = [...text.matchAll(/^import[^;]*from '([^']+)'/gm)].map((m) => m[1]);
      assert.ok(imports.every((name) => name.startsWith('node:') || name === 'pg' || name.startsWith('./submissions-')), `${file} imports ${imports.join(', ')}`);
    }
  });
});
