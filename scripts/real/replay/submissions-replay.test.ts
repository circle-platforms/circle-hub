// The replay of recorded validations through the real assembly of the Hub, end to end on synthetic data: a Hub with a synthetic
// pack runs a submission (accepted, and one that is not); a bundle and a recorded export are written from its database; the
// replay loads the bundle into a scratch database as of each validation and calls the same submitResult the tool calls. The
// replay of the faithful kind must come out the same, a changed record must be told as changed, a damaged bundle must be
// refused, and a candidate pack that is stricter must change what it should. One PostgreSQL cluster serves both sides.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { osIsolationAvailable } from '../../../hub/rules/api.ts';
import { writePack } from '../../../hub/runs/api.ts';
import { SITE_PACK, reviewPack, syncSiteFiles, writeTestPacks } from '../../../hub/server/assemble/test-packs.ts';
import { createTestHub, type TestHub } from '../../../hub/server/testing-real.ts';
import { startPostgres, type TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { exportBundle, openBundle } from './submissions-bundle.ts';
import { matchPacks, findPackDirectories } from './submissions-packs.ts';
import { readRecordedExport } from './submissions-recorded.ts';
import { preflight } from './submissions-preflight.ts';
import { runReplay } from './submissions-run.ts';

const skip = (await osIsolationAvailable()) ? false : 'operating-system isolation for pack functions (sandbox-exec) is not available here';

let postgres: TemporaryPostgres;
let scratch: string;
let hub: TestHub;
let run: string;
let bundleDir: string;
let exportDir: string;
let candidateRepo: string;

const node = (id: string, text: string, children: unknown[] = [], data: Record<string, unknown> = {}) => ({ data: { id, text, ...data }, children });
const MAP = {
  root: node('r1', '合成脑图', [
    node('c1', '用例一', [node('e1', '期望一')], { priority: 1, resource: ['功能'] }),
    node('c2', '用例二', [node('e2', '期望二')], { priority: 1, resource: ['功能'] }),
  ]),
  template: 'default',
  theme: 'fresh-blue',
  version: '1.4.43',
};

/** The recorded export folder of a run, written from the bundle exactly as the real export writes it from a database. */
async function writeRecordedExport(bundleDirectory: string, out: string, runId: string): Promise<void> {
  const bundle = await openBundle(bundleDirectory);
  const lines = ['seq\tkind\trun\tpack\tat\tbytes\tsha256'];
  let pack = '';
  for await (const row of bundle.rows('records')) {
    const kind = String(row.kind);
    if (!['run', 'submission', 'validation_result', 'result_summary'].includes(kind)) continue;
    const body = JSON.parse(String(row.body)) as { run?: string; pack?: string; received?: { run?: string } };
    if ((body.run ?? body.received?.run) !== runId) continue;
    if (kind === 'run') pack = body.pack ?? '';
    const bytes = Buffer.from(String(row.body));
    await mkdir(join(out, runId), { recursive: true });
    await writeFile(join(out, runId, `${row.seq}-${kind}.json`), bytes);
    lines.push([row.seq, kind, runId, pack, new Date(String(row.created_at)).toISOString().replace(/\.\d+Z$/, 'Z'), bytes.length, createHash('sha256').update(bytes).digest('hex')].join('\t'));
  }
  await writeFile(join(out, 'index.tsv'), `${lines.join('\n')}\n`);
}

/** Rewrites one recorded file (and its index line) after a change, as a changed record would look. */
async function changeRecorded(dir: string, run: string, kind: string, change: (body: Record<string, unknown>) => void, which: 'first' | 'last' = 'first'): Promise<void> {
  const index = (await readFile(join(dir, 'index.tsv'), 'utf8')).split('\n');
  const matching = index.flatMap((line, i) => (line.split('\t')[1] === kind ? [i] : []));
  const at = which === 'first' ? matching[0] : matching[matching.length - 1];
  const cells = index[at].split('\t');
  const path = join(dir, run, `${cells[0]}-${kind}.json`);
  const body = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  change(body);
  const bytes = Buffer.from(JSON.stringify(body));
  await writeFile(path, bytes);
  cells[5] = String(bytes.length);
  cells[6] = createHash('sha256').update(bytes).digest('hex');
  index[at] = cells.join('\t');
  await writeFile(join(dir, 'index.tsv'), index.join('\n'));
}

before(async () => {
  if (skip !== false) return;
  postgres = await startPostgres();
  scratch = await mkdtemp(join(tmpdir(), 'circle-hub-replay-test-'));
  // A real Hub over synthetic packs: a product pack whose knowledge is synced from a stub build site (a real tree, composition,
  // sources and builds in the database), and a workflow pack the run below is of.
  const repository = join(scratch, 'repository');
  await writeTestPacks(repository);
  hub = await createTestHub({ postgres, repositoryRoot: repository, buildSite: syncSiteFiles() });
  await hub.addResource({ system_pack: SITE_PACK, name: '合成构建站', environment: 'shared', origins: { 'build-site': hub.stubs!.buildSite.origin } });
  const synced = await hub.knowledgeSync('DEMO');
  assert.equal(synced.error, null);
  assert.ok(synced.counts.produced >= 1, 'a knowledge tree was produced');
  const alice = await hub.createUser('甲');
  await hub.assignPack(alice.principal, 'demo-check');
  const client = await hub.client(alice.token, { sessionId: 'replay-test-session' });
  try {
    const uploaded = await client.call('upload_file', { file_path: Buffer.from(JSON.stringify(MAP)).toString('base64'), name: 'map.json' });
    const started = await client.call('start_run', { pack: 'demo-check', inputs: { map: { reference: uploaded.structuredContent.reference } } });
    assert.equal(started.isError, false, JSON.stringify(started.structuredContent));
    const startedRun = started.structuredContent.run as { run: string; items: Array<{ id: string }> };
    run = startedRun.run;
    const [first, second] = startedRun.items.map((item) => item.id);
    // 1: a code the pack does not know (not accepted); 2: a valid one (accepted); 3: the same as 2 again (the stored result is answered).
    const bad = await client.call('submit_result', { run, model: 'scripted-replay-1', items: [{ item: first, handling: 'handled', slots: { notes: [{ text: '一条意见', code: 'no-such-code' }] } }, { item: second, handling: 'handled', slots: { notes: [] } }] });
    assert.equal(bad.structuredContent.acceptance, 'not_accepted');
    const good = await client.call('submit_result', { run, model: 'scripted-replay-1', items: [{ item: first, handling: 'handled', slots: { notes: [{ text: '缺少边界值的用例', code: 'gap' }] } }, { item: second, handling: 'handled', slots: { notes: [] } }] });
    assert.equal(good.structuredContent.acceptance, 'accepted');
  } finally {
    await client.close();
  }
  const db = new pg.Client({ ...postgres.config, database: hub.records.database.database, password: hub.records.database.password });
  await db.connect();
  const cutoff = Number((await db.query<{ max: string }>('SELECT max(seq) FROM records')).rows[0].max);
  await db.end();
  bundleDir = join(scratch, 'bundle');
  await exportBundle({ database: hub.records.database, objectsRoot: join(hub.records.dataDir, 'objects'), out: bundleDir, cutoff, runs: [run], source: 'synthetic' });
  exportDir = join(scratch, 'export');
  await writeRecordedExport(bundleDir, exportDir, run);
  // A candidate tree: the same pack id at a higher version whose first requirement asks for two expected results of every case.
  const stricter = reviewPack('1.0.1');
  const titles = stricter.files['tables/titles.json'] as { rules: Array<{ fields: Array<{ path: string; minItems?: number }> }> };
  titles.rules[0].fields.find((field) => field.path === '/fields/expected')!.minItems = 2;
  // Its samples say the same: a case with two expected results is a good one.
  const good = stricter.files['samples/positive/titles-good.json'] as { subject: { items: Array<{ fields: { expected: string[] } }> } };
  good.subject.items[0].fields.expected = ['结果', '结果二'];
  const bad = stricter.files['samples/negative/titles-bad.json'] as { subject: { items: Array<{ fields: { expected: string[] } }> } };
  for (const item of bad.subject.items) item.fields.expected = ['结果', '结果二'];
  candidateRepo = join(scratch, 'candidate');
  await writePack(join(candidateRepo, 'packs', 'workflow', 'demo-check'), stricter);
});

after(async () => {
  await hub?.close();
  await postgres?.stop();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

describe('a bundle of a synthetic Hub', { skip }, () => {
  test('holds the records and the objects of the run, with every digest checkable, and withholds what must not leave the Hub', async () => {
    const bundle = await openBundle(bundleDir);
    assert.equal(bundle.manifest.schema, 'replay-bundle@1');
    assert.ok(bundle.manifest.runs.includes(run));
    for (const kind of ['run', 'submission', 'validation_result', 'pack_version', 'source_artifact']) assert.ok((bundle.manifest.kinds[kind] ?? 0) > 0, `${kind} records are in the bundle`);
    assert.equal(bundle.manifest.objects.missing.length, 0);
    assert.ok(bundle.manifest.objects.count > 0);
    const users: Array<Record<string, unknown>> = [];
    for await (const row of bundle.rows('users')) users.push(row);
    assert.ok(users.length >= 2);
    assert.ok(users.every((row) => !('password_hash' in row)), 'the password hash is not exported');
    assert.ok(bundle.manifest.withheld.some((w) => w.table === 'tokens'), 'tokens are named as withheld');
    assert.equal(bundle.manifest.tables.tokens, undefined);
  });

  test('a plan exports nothing and counts what an export would hold', async () => {
    const out = join(scratch, 'plan');
    const manifest = await exportBundle({ database: hub.records.database, objectsRoot: join(hub.records.dataDir, 'objects'), out, cutoff: 1_000_000, runs: [run], dryRun: true });
    assert.ok(manifest.tables.records.rows > 0);
    assert.equal(await readFile(join(out, 'manifest.json'), 'utf8').then(() => true, () => false), false, 'nothing was written');
  });

  test('a record kind can be left out on request, and the manifest says so', async () => {
    const kinds = Object.keys((await openBundle(bundleDir)).manifest.kinds);
    const left = kinds.find((kind) => kind === 'claim') ?? kinds[kinds.length - 1];
    const manifest = await exportBundle({ database: hub.records.database, objectsRoot: join(hub.records.dataDir, 'objects'), out: join(scratch, 'plan-excluded'), cutoff: 1_000_000, runs: [run], dryRun: true, excludeKinds: [left] });
    assert.equal(manifest.kinds[left], undefined);
    assert.ok(manifest.notes.some((note) => note.includes(left) && note.includes('不导出')));
  });
});

describe('the faithful replay', { skip }, () => {
  test('every validation of the run comes out the same, through the real submit path, with the normalizations listed', async () => {
    const recorded = await readRecordedExport(exportDir);
    assert.ok(recorded.tasks.length >= 2);
    const report = await runReplay({ mode: 'faithful', recorded, bundle: await openBundle(bundleDir), repo: process.cwd(), commit: 'HEAD', requireOsIsolation: true, postgres });
    assert.deepEqual(report.outcomes.map((o) => o.status), recorded.tasks.map(() => 'same'), JSON.stringify(report.outcomes.map((o) => [o.seq, o.status, o.reason, o.comparison?.diffs.slice(0, 3)]), null, 1));
    for (const outcome of report.outcomes) {
      assert.deepEqual(outcome.comparison?.normalizations.map((n) => [n.id, n.recorded, n.replayed]).slice(0, 1), [['trace', 1, 1]]);
    }
  });
});

describe('what a replay says when the record or the data is not what it was', { skip }, () => {
  test('a recorded result that differs is changed, with the field, the item and the two values', async () => {
    const dir = join(scratch, 'export-changed');
    await cp(exportDir, dir, { recursive: true });
    await changeRecorded(dir, run, 'validation_result', (body) => {
      body.acceptance = 'not_accepted';
      (body.rounds as { used: number }).used = 1;
    }, 'last');
    const recorded = await readRecordedExport(dir);
    const report = await runReplay({ mode: 'faithful', recorded, bundle: await openBundle(bundleDir), repo: process.cwd(), commit: 'HEAD', postgres });
    const changed = report.outcomes.filter((o) => o.status === 'changed');
    assert.equal(changed.length, 1, JSON.stringify(report.outcomes.map((o) => [o.seq, o.status, o.reason])));
    assert.deepEqual(changed[0].comparison?.diffs.map((d) => [d.field, d.path, d.recorded, d.replayed]), [['acceptance', '/acceptance', 'not_accepted', 'accepted'], ['rounds', '/rounds/used', 1, 0]]);
  });

  test('without a bundle nothing is replayed, and each validation says why', async () => {
    const recorded = await readRecordedExport(exportDir);
    const report = await runReplay({ mode: 'faithful', recorded, bundle: null, repo: process.cwd(), commit: 'HEAD' });
    assert.ok(report.outcomes.length > 0);
    assert.ok(report.outcomes.every((o) => o.status === 'not_replayable' && o.reason?.code === 'no_bundle'));
  });

  test('a bundle with a record changed after it was exported is refused by its digest', async () => {
    const damaged = join(scratch, 'bundle-damaged');
    await cp(bundleDir, damaged, { recursive: true });
    const file = join(damaged, 'tables', 'records.jsonl');
    const lines = (await readFile(file, 'utf8')).split('\n');
    const at = lines.findIndex((line) => line.includes('"kind":"submission"'));
    const row = JSON.parse(lines[at]) as { body: string };
    row.body = row.body.replace('一条意见', '另一条意见');
    lines[at] = JSON.stringify(row);
    await writeFile(file, lines.join('\n'));
    const report = await runReplay({ mode: 'faithful', recorded: await readRecordedExport(exportDir), bundle: await openBundle(damaged), repo: process.cwd(), commit: 'HEAD', postgres });
    assert.ok(report.outcomes.length > 0);
    assert.ok(report.outcomes.every((o) => o.status === 'not_replayable' && o.reason?.code === 'bundle_damaged'), JSON.stringify(report.outcomes.map((o) => [o.status, o.reason])));
  });

  test('a validation whose action is not in the bundle is not replayed: the session it was made in is unknown', async () => {
    const trimmed = join(scratch, 'bundle-no-actions');
    await cp(bundleDir, trimmed, { recursive: true });
    const file = join(trimmed, 'tables', 'records.jsonl');
    const lines = (await readFile(file, 'utf8')).split('\n').filter((line) => line === '' || !(JSON.parse(line) as { kind: string; body: string }).body.includes('"action":"validate"'));
    await writeFile(file, lines.join('\n'));
    const report = await runReplay({ mode: 'faithful', recorded: await readRecordedExport(exportDir), bundle: await openBundle(trimmed), repo: process.cwd(), commit: 'HEAD', postgres });
    assert.ok(report.outcomes.every((o) => o.status === 'not_replayable' && o.reason?.code === 'no_call_facts'), JSON.stringify(report.outcomes.map((o) => [o.status, o.reason])));
  });

  test('faithful windows leave a validation to the tree of the release that stored it', async () => {
    const recorded = await readRecordedExport(exportDir);
    const windows = [{ commit: 'aaaaaaaaaa', from: '2000-01-01T00:00:00Z', to: null }];
    const report = await runReplay({ mode: 'faithful', recorded, bundle: null, repo: process.cwd(), commit: 'bbbbbbbbbb', windows });
    assert.equal(report.outcomes.length, 0);
    assert.equal(report.skipped, recorded.tasks.length);
    const own = await runReplay({ mode: 'faithful', recorded, bundle: null, repo: process.cwd(), commit: 'aaaaaaaaaa1234', windows });
    assert.equal(own.outcomes.length, recorded.tasks.length);
    assert.ok(own.outcomes.every((o) => o.release === 'aaaaaaaaaa'));
  });
});

describe('the packs of a tree', { skip }, () => {
  test('a pack of a tree has the Hub\'s digest of its staged files; a recorded version is the same, different or absent', async () => {
    const directories = await findPackDirectories(candidateRepo);
    assert.deepEqual(directories.map((d) => [d.id, d.version]), [['demo-check', '1.0.1']]);
    const [match] = await matchPacks(candidateRepo, [{ pack: 'demo-check@1.0.1', digest: 'f'.repeat(64) }]);
    assert.equal(match.status, 'different');
    assert.match(String(match.found), /^[0-9a-f]{64}$/);
    const same = await matchPacks(candidateRepo, [{ pack: 'demo-check@1.0.1', digest: String(match.found) }, { pack: 'demo-check@1.0.0', digest: 'a'.repeat(64) }]);
    assert.deepEqual(same.map((m) => m.status), ['same', 'absent']);
  });
});

describe('the candidate replay', { skip }, () => {
  test('a candidate whose pack is the one the run was started with changes nothing', async () => {
    const same = join(scratch, 'candidate-same');
    await writePack(join(same, 'packs', 'workflow', 'demo-check'), reviewPack());
    const report = await runReplay({ mode: 'candidate', recorded: await readRecordedExport(exportDir), bundle: await openBundle(bundleDir), repo: same, commit: 'candidate', postgres });
    assert.deepEqual(report.outcomes.map((o) => o.status), report.outcomes.map(() => 'same'), JSON.stringify(report.outcomes.map((o) => [o.seq, o.status, o.reason, o.comparison?.diffs.slice(0, 3)])));
    assert.ok(report.outcomes.every((o) => o.rebound === undefined), 'the pack is the same, so there is no rebinding');
    assert.ok(report.packs.every((p) => p.status === 'same'));
  });

  test('a candidate with a stricter pack binds the run to it and the change is told, field by field, apart from the binding itself', async () => {
    const report = await runReplay({ mode: 'candidate', recorded: await readRecordedExport(exportDir), bundle: await openBundle(bundleDir), repo: candidateRepo, commit: 'candidate', postgres });
    const statuses = report.outcomes.map((o) => o.status);
    assert.ok(statuses.includes('changed'), JSON.stringify(report.outcomes.map((o) => [o.seq, o.status, o.reason, o.notes.slice(0, 3)])));
    for (const outcome of report.outcomes) {
      assert.deepEqual(outcome.rebound, { from: 'demo-check@1.0.0', to: 'demo-check@1.0.1' });
      assert.ok(outcome.comparison?.normalizations.some((n) => n.id === 'locks.pack' && n.recorded === 1 && n.replayed === 1), 'the binding is a listed normalization');
    }
    const changed = report.outcomes.find((o) => o.status === 'changed')!;
    assert.ok(changed.comparison!.diffs.length > 0);
    assert.ok(changed.comparison!.diffs.every((d) => !d.path.startsWith('/locks/pack')), 'the pack binding is not reported as a difference');
  });

  test('with the recorded packs only the Hub code is the candidate\'s: a stricter pack in the tree changes nothing', async () => {
    const report = await runReplay({ mode: 'candidate', packs: 'recorded', recorded: await readRecordedExport(exportDir), bundle: await openBundle(bundleDir), repo: candidateRepo, commit: 'candidate', postgres });
    assert.deepEqual(report.outcomes.map((o) => o.status), report.outcomes.map(() => 'same'));
    assert.ok(report.outcomes.every((o) => o.rebound === undefined));
  });

  test('a candidate tree without the pack of a run says so for that run', async () => {
    const empty = join(scratch, 'candidate-empty');
    await mkdir(join(empty, 'packs'), { recursive: true });
    const report = await runReplay({ mode: 'candidate', recorded: await readRecordedExport(exportDir), bundle: await openBundle(bundleDir), repo: empty, commit: 'candidate', postgres });
    assert.ok(report.outcomes.every((o) => o.status === 'not_replayable' && o.reason?.code === 'pack_not_in_commit'));
  });
});

describe('the check of a bundle before a replay', { skip }, () => {
  test('a complete bundle has everything the recorded run names', async () => {
    const report = await preflight(await readRecordedExport(exportDir), await openBundle(bundleDir));
    assert.deepEqual(report.gaps, []);
    assert.ok(report.counts.packs > 0 && report.counts.users >= 2 && report.counts.objects > 0 && report.counts.with_call >= 2);
  });

  test('a bundle without the actions, the pack records and the principal says what is missing, once each', async () => {
    const trimmed = join(scratch, 'bundle-trimmed');
    await cp(bundleDir, trimmed, { recursive: true });
    const records = join(trimmed, 'tables', 'records.jsonl');
    const kept = (await readFile(records, 'utf8')).split('\n').filter((line) => {
      if (line === '') return true;
      const row = JSON.parse(line) as { kind: string; body: string };
      return row.kind !== 'pack_version' && !row.body.includes('"action":"validate"');
    });
    await writeFile(records, kept.join('\n'));
    await writeFile(join(trimmed, 'tables', 'users.jsonl'), '');
    const report = await preflight(await readRecordedExport(exportDir), await openBundle(trimmed));
    const kinds = report.gaps.map((g) => g.what);
    assert.ok(kinds.includes('validation'), 'the actions are missing');
    assert.ok(kinds.includes('pack'), 'the pack records are missing');
    assert.ok(kinds.includes('principal'), 'the runner is missing');
    assert.equal(new Set(report.gaps.filter((g) => g.what === 'pack').map((g) => g.detail)).size, report.gaps.filter((g) => g.what === 'pack').length, 'each pack is named once');
  });
});
