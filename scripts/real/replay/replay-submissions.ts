// Replays recorded submissions through the Hub's own validation and compares each result with the record.
//
//   node scripts/real/replay/replay-submissions.ts run --mode faithful|candidate --export <dir> --out <dir> [--bundle <dir>]
//        [--repo <tree>] [--commit <id>] [--windows <file>] [--run <id>]... [--seq <n>]... [--limit <n>] [--max-record-bytes <n>]
//   node scripts/real/replay/replay-submissions.ts report --out <dir> --export <dir> [--bundle <dir>] --mode <mode> <part.json>...
//   node scripts/real/replay/replay-submissions.ts packs --export <dir> [--repo <tree>]
//   node scripts/real/replay/replay-submissions.ts export-bundle …    (the same as export-bundle.ts, which runs on the Hub's host)
//   node scripts/real/replay/replay-submissions.ts verify-bundle --bundle <dir>
//
// Every path is given on the command line; nothing about a system is written here. The export folder and the bundle are read
// only. `run` is meant to be started with `node --import ./scripts/real/replay/submissions-net-guard.mjs` (the wrapper does).
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { main as exportMain } from './export-bundle.ts';
import { openBundle } from './submissions-bundle.ts';
import { matchPacks } from './submissions-packs.ts';
import { readRecordedExport } from './submissions-recorded.ts';
import { renderDetails, summarize, type ReportMeta } from './submissions-report.ts';
import { openOptionalBundle, runReplay, type Mode, type RunReport, type Window } from './submissions-run.ts';

const TREE = fileURLToPath(new URL('../../../', import.meta.url));

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

const log = (line: string): void => {
  process.stderr.write(`${new Date().toISOString()} ${line}\n`);
};

async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      mode: { type: 'string' }, export: { type: 'string' }, bundle: { type: 'string' }, out: { type: 'string' }, repo: { type: 'string' }, commit: { type: 'string' },
      windows: { type: 'string' }, run: { type: 'string', multiple: true }, seq: { type: 'string', multiple: true }, limit: { type: 'string' }, 'max-record-bytes': { type: 'string' },
    },
  });
  if (values.mode !== 'faithful' && values.mode !== 'candidate') fail('--mode faithful|candidate');
  if (values.export === undefined || values.out === undefined) fail('--export <dir> 和 --out <dir> 必给');
  const repo = values.repo ?? TREE;
  const commit = values.commit ?? execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const windows = values.windows === undefined ? undefined : (JSON.parse(await readFile(values.windows, 'utf8')) as Window[]);
  const recorded = await readRecordedExport(values.export);
  if (recorded.problems.length > 0) fail(`导出目录有问题：\n${recorded.problems.join('\n')}`);
  const bundle = await openOptionalBundle(values.bundle);
  const report = await runReplay({
    mode: values.mode as Mode,
    recorded,
    bundle,
    repo,
    commit,
    ...(windows === undefined ? {} : { windows }),
    only: {
      ...(values.run === undefined ? {} : { runs: values.run }),
      ...(values.seq === undefined ? {} : { seqs: values.seq.map(Number) }),
      ...(values.limit === undefined ? {} : { limit: Number(values.limit) }),
    },
    ...(values['max-record-bytes'] === undefined ? {} : { limits: { maxRecordBytes: Number(values['max-record-bytes']) } }),
    log,
  });
  await mkdir(values.out, { recursive: true });
  await writeFile(join(values.out, 'part.json'), `${JSON.stringify(report, null, 1)}\n`);
  const counts = { same: 0, changed: 0, not_replayable: 0 };
  for (const outcome of report.outcomes) counts[outcome.status] += 1;
  log(`提交 ${commit.slice(0, 12)}：相同 ${counts.same}，不同 ${counts.changed}，不能回放 ${counts.not_replayable}，不属于这棵树或未选中 ${report.skipped}`);
  // 1: something is different; 4: nothing could be replayed at all (the data is missing): that is neither a pass nor a failure.
  return counts.changed > 0 ? 1 : counts.same === 0 && counts.not_replayable > 0 ? 4 : 0;
}

async function report(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { mode: { type: 'string' }, export: { type: 'string' }, bundle: { type: 'string' }, out: { type: 'string' }, note: { type: 'string' } } });
  if (values.mode !== 'faithful' && values.mode !== 'candidate') fail('--mode faithful|candidate');
  if (values.out === undefined || values.export === undefined || positionals.length === 0) fail('--out、--export 和至少一个 part.json 必给');
  const parts = await Promise.all(positionals.map(async (path) => JSON.parse(await readFile(path, 'utf8')) as RunReport));
  const meta: ReportMeta = { mode: values.mode, created_at: new Date().toISOString(), export_dir: values.export, bundle_dir: values.bundle ?? null, ...(values.note === undefined ? {} : { note: values.note }) };
  const summary = summarize(parts, meta);
  await mkdir(values.out, { recursive: true });
  await writeFile(join(values.out, 'summary.json'), `${JSON.stringify(summary, null, 1)}\n`);
  await writeFile(join(values.out, 'details.md'), renderDetails(summary, parts));
  process.stdout.write(`${JSON.stringify(summary.totals)}\n`);
  return 0;
}

async function packs(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { export: { type: 'string' }, repo: { type: 'string' } } });
  if (values.export === undefined) fail('--export <dir> 必给');
  const recorded = await readRecordedExport(values.export);
  const wanted = new Map<string, { pack: string; digest: string }>();
  for (const entry of recorded.runs.values()) {
    const body = (await recorded.read(entry)) as { pack?: string; pack_digest?: string };
    if (body.pack !== undefined && body.pack_digest !== undefined) wanted.set(`${body.pack}\0${body.pack_digest}`, { pack: body.pack, digest: body.pack_digest });
  }
  for (const match of await matchPacks(values.repo ?? TREE, [...wanted.values()])) process.stdout.write(`${match.pack}\t${match.digest}\t${match.status}\t${match.found ?? ''}\n`);
  return 0;
}

async function verify(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { bundle: { type: 'string' } } });
  if (values.bundle === undefined) fail('--bundle <dir> 必给');
  const bundle = await openBundle(values.bundle);
  const { recordDigest, normalizeTime } = await import('../../../hub/records/api.ts');
  let bad = 0;
  let markers = 0;
  let rows = 0;
  for await (const row of bundle.rows('records')) {
    rows += 1;
    const body = JSON.parse(String(row.body)) as { personal_payload?: unknown; record?: unknown } | null;
    const digest = recordDigest({ kind: String(row.kind), schema: String(row.schema), provenance: String(row.provenance), created_at: normalizeTime(new Date(String(row.created_at)).toISOString(), 'created_at'), body });
    if (digest === row.digest) continue;
    if (typeof body?.personal_payload === 'string' && body.record === row.digest) markers += 1;
    else bad += 1;
  }
  process.stdout.write(`${JSON.stringify({ records: rows, digest_mismatches: bad, personal_markers: markers, objects: bundle.manifest.objects.count, missing_objects: bundle.manifest.objects.missing.length })}\n`);
  return bad > 0 ? 1 : 0;
}

const [command, ...rest] = process.argv.slice(2);
const commands: Record<string, (argv: string[]) => Promise<number>> = { run, report, packs, 'export-bundle': exportMain, 'verify-bundle': verify };
if (command === undefined || commands[command] === undefined) fail(`用法：replay-submissions.ts ${Object.keys(commands).join('|')} …（见文件头）`);
process.exitCode = await commands[command](rest);
