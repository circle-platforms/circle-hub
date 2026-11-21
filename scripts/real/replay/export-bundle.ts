import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { exportBundle } from './submissions-export.ts';

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

export function runsOfIndex(text: string): string[] {
  const runs = new Set<string>();
  for (const line of text.split('\n').slice(1)) {
    const run = line.split('\t')[2];
    if (run !== undefined && /^run_[0-9a-z]{26}$/.test(run)) runs.add(run);
  }
  return [...runs].sort();
}

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      'pg-host': { type: 'string' }, 'pg-port': { type: 'string' }, 'pg-user': { type: 'string' }, 'pg-database': { type: 'string' }, objects: { type: 'string' }, out: { type: 'string' },
      index: { type: 'string' }, run: { type: 'string', multiple: true }, cutoff: { type: 'string' }, 'all-objects': { type: 'boolean' }, 'dry-run': { type: 'boolean' }, 'exclude-kind': { type: 'string', multiple: true }, source: { type: 'string' },
    },
  });
  for (const name of ['pg-host', 'pg-port', 'pg-user', 'pg-database', 'objects', 'out'] as const) if (values[name] === undefined) fail(`--${name} 必给`);
  const runs = new Set(values.run ?? []);
  if (values.index !== undefined) for (const run of runsOfIndex(await readFile(values.index, 'utf8'))) runs.add(run);
  if (runs.size === 0) fail('--index <index.tsv> 或 --run <运行号> 至少给一个');
  const database = { host: values['pg-host']!, port: Number(values['pg-port']), user: values['pg-user']!, database: values['pg-database']! };
  const client = new pg.Client({ ...database, ssl: false });
  await client.connect();
  const cutoff = values.cutoff === undefined ? Number((await client.query<{ max: string }>('SELECT max(seq) FROM records')).rows[0].max) : Number(values.cutoff);
  await client.end();
  const manifest = await exportBundle({
    database,
    objectsRoot: values.objects!,
    out: values.out!,
    cutoff,
    runs: [...runs],
    ...(values['all-objects'] === true ? { allObjects: true } : {}),
    ...(values['dry-run'] === true ? { dryRun: true } : {}),
    ...(values['exclude-kind'] === undefined ? {} : { excludeKinds: values['exclude-kind'] }),
    ...(values.source === undefined ? {} : { source: values.source }),
    log: (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`),
  });
  process.stdout.write(`${JSON.stringify({ cutoff_seq: manifest.cutoff_seq, runs: manifest.runs.length, tables: Object.fromEntries(Object.entries(manifest.tables).map(([name, table]) => [name, table.rows])), kinds: manifest.kinds, objects: manifest.objects.count, object_bytes: manifest.objects.bytes, missing_objects: manifest.objects.missing.length, withheld: manifest.withheld.map((w) => w.table), notes: manifest.notes }, null, 1)}\n`);
  return manifest.objects.missing.length > 0 ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
