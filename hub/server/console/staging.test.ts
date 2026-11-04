// The staging store of 发布任务包: a stage belongs to the administrator who staged it, ends at its expiry (on access and by
// its timer), when the store is full for the oldest one, when it is removed or taken and when the store closes; its
// directory goes with it (a taken one when its step is done), and a directory offered to a closed store or without a
// readable pack.json is removed at once.
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { manifestDigest } from '../../runs/api.ts';
import { installTraceSink, type SpanRow } from '../../telemetry/api.ts';
import { PackStaging, STAGE_TTL_MS, stagedDigest } from './staging.ts';

const MANIFEST = { id: 'synthetic-pack', version: '1.0.0', kind: 'workflow', files: [] };

async function unpacked(manifest: unknown = MANIFEST): Promise<{ root: string; dir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'circle-hub-staging-test-'));
  const dir = join(root, 'tree', 'pack');
  await mkdir(dir, { recursive: true });
  if (manifest !== null) await writeFile(join(dir, 'pack.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2));
  return { root, dir };
}

const gone = (path: string) => assert.rejects(access(path), `${path} is removed`);
/** The timer's removal is asynchronous: wait for it with a bound instead of one fixed delay, which a busy runner can outlast. */
async function eventuallyGone(path: string, deadlineMs = 2000): Promise<void> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    try { await access(path); } catch { return; }
    await sleep(20);
  }
  await gone(path);
}

test('a stage is the staging administrator\'s alone and names the pack digest of its pack.json', async () => {
  const staging = new PackStaging();
  const tree = await unpacked();
  const stage = await staging.add('usr_a', tree);
  assert.ok(stage);
  assert.equal(stage.pack, 'synthetic-pack');
  assert.equal(stage.version, '1.0.0');
  assert.equal(stage.digest, manifestDigest(MANIFEST), 'the digest is that of the canonical manifest, whatever its formatting');
  assert.equal((await stagedDigest(tree.dir))?.digest, stage.digest);
  assert.equal(stage.expires - stage.created, STAGE_TTL_MS);
  assert.match(stage.id, /^[A-Za-z0-9_-]{24}$/);
  assert.equal((await staging.open(stage.id, 'usr_a'))?.dir, tree.dir);
  assert.equal(await staging.open(stage.id, 'usr_b'), null);
  assert.equal(await staging.open('unknown', 'usr_a'), null);
  assert.deepEqual(staging.list('usr_a').map((s) => s.id), [stage.id]);
  assert.deepEqual(staging.list('usr_b'), []);
  await staging.remove(stage.id);
  await gone(tree.root);
  assert.equal(await staging.open(stage.id, 'usr_a'), null);
  await staging.remove(stage.id);

  // The 发布 step takes its stage: a second request with the same id finds nothing, the directory stays until done.
  const next = await unpacked();
  const kept = (await staging.add('usr_a', next))!;
  assert.equal(await staging.take(kept.id, 'usr_b'), null, 'someone else cannot take it');
  const taken = await staging.take(kept.id, 'usr_a');
  assert.equal(taken?.dir, next.dir);
  assert.equal(await staging.take(kept.id, 'usr_a'), null);
  assert.deepEqual(staging.list('usr_a'), []);
  await access(next.dir);
  await staging.clear();
  await access(next.dir);
  await taken!.done();
  await gone(next.root);
});

test('an expired stage is removed when it is next opened, and by its timer when nobody opens it', async () => {
  let now = 1_000_000;
  const clocked = new PackStaging(() => now);
  const tree = await unpacked();
  const stage = (await clocked.add('usr_a', tree))!;
  now += STAGE_TTL_MS;
  assert.deepEqual(clocked.list('usr_a'), [], 'an expired stage is not listed');
  assert.equal(await clocked.open(stage.id, 'usr_a'), null);
  await gone(tree.root);

  const quick = new PackStaging(Date.now, { ttlMs: 20 });
  const other = await unpacked();
  assert.ok(await quick.add('usr_a', other));
  await eventuallyGone(other.root);
});

test('a full store ends its oldest stage; a closed one keeps nothing, and a directory without pack.json is not kept', async () => {
  const staging = new PackStaging(Date.now, { max: 2 });
  const trees = [await unpacked(), await unpacked(), await unpacked()];
  const stages = [];
  for (const tree of trees) stages.push((await staging.add('usr_a', tree))!);
  await gone(trees[0].root);
  assert.equal(await staging.open(stages[0].id, 'usr_a'), null);
  assert.deepEqual(staging.list('usr_a').map((s) => s.id), [stages[1].id, stages[2].id]);

  const unreadable = await unpacked('{ not json');
  assert.equal(await staging.add('usr_a', unreadable), null);
  await gone(unreadable.root);
  const missing = await unpacked(null);
  assert.equal(await staging.add('usr_a', missing), null);
  await gone(missing.root);

  await staging.clear();
  for (const tree of trees.slice(1)) await gone(tree.root);
  assert.deepEqual(staging.list('usr_a'), []);
  const late = await unpacked();
  assert.equal(await staging.add('usr_a', late), null, 'a closed store keeps nothing');
  await gone(late.root);
});

test('the cleanup of an expired stage is a background trace of its own', async (t) => {
  const rows: SpanRow[] = [];
  t.after(installTraceSink({ push: (row) => rows.push(row) }));
  const quick = new PackStaging(Date.now, { ttlMs: 20 });
  const tree = await unpacked();
  assert.ok(await quick.add('usr_a', tree));
  await eventuallyGone(tree.root);
  for (let round = 0; round < 100 && rows.length === 0; round += 1) await sleep(10);
  assert.deepEqual(rows.map((row) => [row.name, row.origin, row.is_root]), [['clean-staging', 'background', true]]);
});
