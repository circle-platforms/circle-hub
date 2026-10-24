import assert from 'node:assert/strict';
import { access, lstat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { layoutAt } from './layout.ts';
import { runCommand, type CommandRunner } from './process.ts';
import { rehearse, treeEntries } from './rehearse.ts';
import { libpqAvailable, LIBPQ_MISSING, removeDir, tempDir, syntheticKeychain, recordingRunner } from './test-support.ts';

const libpq = await libpqAvailable();

// Complete asynchronous availability checks before registering any tests.
const security = '/usr/bin/security';
const hasSecurity = await access(security).then(() => true, () => false);
const keyLossSkip = !libpq ? LIBPQ_MISSING : !hasSecurity ? 'skipped: /usr/bin/security is only on macOS' : false;

test('rehearsal: init, write, back up, destroy, restore, compare in a throwaway root that is removed', { skip: libpq ? false : LIBPQ_MISSING }, async () => {
  const parent = await tempDir();
  try {
    const report = await rehearse({ parent, records: 60, objects: 8 });
    assert.equal(report.ok, true, report.differences.join('\n'));
    assert.deepEqual(report.differences, []);
    assert.equal(report.tables, 2);
    assert.equal(report.rows, 60 + 20, '60 records and an index row for every third');
    assert.equal(report.objects, 8);
    assert.equal(report.vaultFiles, 3);
    // A verified tree, one in quarantine and one still being built: two, two and one file.
    assert.equal(report.packFiles, 5);
    assert.equal(report.role, 'circle_hub');
    // CONNECT, USAGE on public, EXECUTE of the trigger function, SELECT and INSERT on both tables.
    assert.equal(report.privileges, 7);
    // Per table: DELETE, TRUNCATE, DROP, ADD COLUMN, DISABLE TRIGGER; and one CREATE TABLE.
    assert.equal(report.refused, 11);
    assert.equal(report.kept, false);
    assert.ok(report.root.startsWith(parent));
    await assert.rejects(access(report.root), 'the throwaway root is gone, read-only pack trees and all');
  } finally {
    await removeDir(parent);
  }
});

test('rehearsal reports extracted pack trees that changed between the backup and the restore', { skip: libpq ? false : LIBPQ_MISSING }, async () => {
  const parent = await tempDir();
  try {
    // While pg_restore runs, something drops a file into packs/ of the throwaway root (named by the socket directory).
    const runner: CommandRunner = async (command, args, options) => {
      const result = await runCommand(command, args, options);
      const host = args.find((arg) => arg.startsWith('--host='));
      if (basename(command) === 'pg_restore' && args.includes('--single-transaction') && host) {
        await writeFile(join(dirname(host.slice('--host='.length)), 'packs', 'planted'), 'not from the registry', { mode: 0o600 });
      }
      return result;
    };
    const report = await rehearse({ parent, records: 3, objects: 1, runner });
    assert.equal(report.ok, false);
    assert.deepEqual(report.differences, ['解包目录多了 planted']);
    await assert.rejects(access(report.root), 'removed all the same');
  } finally {
    await removeDir(parent);
  }
});

test('rehearsal can keep its root for inspection, extracted pack trees still read-only and outside the backup', { skip: libpq ? false : LIBPQ_MISSING }, async () => {
  const parent = await tempDir();
  try {
    const report = await rehearse({ parent, records: 3, objects: 1, keep: true });
    assert.equal(report.ok, true, report.differences.join('\n'));
    await access(report.backup);
    const layout = layoutAt(report.root);
    const entries = await treeEntries(layout.packs);
    const trees = [...entries].filter(([path, entry]) => !path.startsWith('.') && !path.includes('/') && entry.startsWith('目录'));
    assert.equal(trees.length, 1);
    assert.equal(trees[0]![1], '目录 0500');
    assert.ok([...entries.keys()].some((path) => path.startsWith('.quarantine/')));
    assert.ok([...entries.keys()].some((path) => path.startsWith('.tmp-')));
    await assert.rejects(lstat(join(report.backup, 'packs')), /ENOENT/);
  } finally {
    await removeDir(parent);
  }
});


test('rehearsal loses both isolated keychain items, scans backups and always removes the keychain even with keep', { skip: keyLossSkip }, async () => {
  const parent = await tempDir(); const calls: { args: readonly string[]; input: string }[] = [];
  try {
    const runner: CommandRunner = async (command, args, options) => {
      if (command === security) calls.push({ args, input: options?.input ?? '' });
      return runCommand(command, args, options);
    };
    const report = await rehearse({ parent, records: 3, objects: 1, keep: true, runner });
    assert.equal(report.ok, true, report.differences.join('\n'));
    assert.deepEqual(report.keyLoss, { skipped: false, items: 2, backupHits: 0, remaining: 0, setAsideFiles: 3 });
    const keychain = join(report.root, 'synthetic.keychain-db');
    for (const call of calls) assert.ok(call.args.at(-1) === keychain || (call.args[0] === '-i' && call.input.trimEnd().endsWith(`"${keychain}"`)));
    await assert.rejects(access(keychain));
  } finally { await removeDir(parent); }
});

test('rehearsal refuses a backup containing any secret encoding and never discloses the secret', { skip: keyLossSkip }, async () => {
  const parent = await tempDir(); const values: string[] = [];
  try {
    const runner: CommandRunner = async (command, args, options) => {
      const result = await runCommand(command, args, options);
      if (command === security && args[0] === '-i') {
        const input = options?.input ?? ''; const value = /-w ([0-9a-f]{64})/.exec(input)?.[1];
        const keychain = /"([^"]+)"\s*$/.exec(input)?.[1];
        if (value && keychain) { values.push(value); await writeFile(join(dirname(keychain), 'vault', 'planted'), Buffer.concat([Buffer.from(value.toUpperCase()), Buffer.from(value, 'hex')])); }
      }
      return result;
    };
    const report = await rehearse({ parent, records: 3, objects: 1, runner });
    assert.equal(report.ok, false); assert.ok(report.keyLoss.backupHits >= 1);
    for (const value of values) { assert.ok(!JSON.stringify(report).includes(value)); assert.ok(!JSON.stringify(report).includes(value.toUpperCase())); }
    await assert.rejects(access(join(report.root, 'synthetic.keychain-db')));
  } finally { await removeDir(parent); }
});

test('missing security explicitly skips key loss without weakening backup verification', { skip: libpq ? false : LIBPQ_MISSING }, async () => {
  const parent = await tempDir();
  try {
    const report = await rehearse({ parent, records: 3, objects: 1, security: join(parent, 'absent-security') });
    assert.equal(report.ok, true); assert.equal(report.keyLoss.skipped, true); assert.match(report.keyLoss.reason ?? '', /跳过，不算通过/);
  } finally { await removeDir(parent); }
});

test('c3 vault set aside preserves only sealed files with unique archives and an empty private vault',async()=>{
 const {setAsideVault}=await import('./restore.ts');const {ensureLayout}=await import('./layout.ts');const {readFile,readdir,chmod}=await import('node:fs/promises');
 const root=await tempDir();try{
  const layout=layoutAt(root);await ensureLayout(layout);await writeFile(join(layout.db,'sentinel'),'db');await writeFile(join(layout.objects,'sentinel'),'objects');
  const now=new Date('2026-10-24T00:00:00Z');const paths:string[]=[];
  for(const text of ['sealed-first','sealed-second']){
   await writeFile(join(layout.vault,'sealed'),text);await chmod(layout.vault,0o755);
   const moved=await setAsideVault(layout,now);assert.equal(moved.files,1);assert.ok(moved.path);paths.push(moved.path!);
   assert.equal(await readFile(join(moved.path!,'sealed'),'utf8'),text);assert.deepEqual(await readdir(layout.vault),[]);assert.equal((await lstat(layout.vault)).mode&0o777,0o700);
  }
  assert.notEqual(paths[0],paths[1]);assert.equal(await readFile(join(layout.db,'sentinel'),'utf8'),'db');assert.equal(await readFile(join(layout.objects,'sentinel'),'utf8'),'objects');
 }finally{await removeDir(root);}
});

test('synthetic-keychain rehearsal compares restored data and loses both keys without host tools', { skip: libpq ? false : LIBPQ_MISSING }, async () => {
  const parent = await tempDir();
  const security = join(parent, 'security-stub');
  await writeFile(security, 'Synthetic command placeholder; never executed', { mode: 0o600 });
  let simulated: ReturnType<typeof syntheticKeychain> | undefined;
  const recorded = recordingRunner(call => {
    if (call.command !== security) return undefined;
    if (!simulated) {
      assert.equal(call.args[0], 'create-keychain');
      const file = call.args.at(-1)!;
      assert.ok(file.startsWith(parent + '/'));
      simulated = syntheticKeychain(file, security);
    }
    return simulated.runner(call.command, call.args, call.options);
  });
  try {
    const report = await rehearse({ parent, records: 6, objects: 2, security, runner: recorded.runner });
    assert.equal(report.ok, true, report.differences.join('\n'));
    assert.deepEqual(report.differences, []);
    assert.equal(report.rows, 8);
    assert.equal(report.objects, 2);
    assert.equal(report.vaultFiles, 3);
    assert.equal(report.refused, 11);
    assert.deepEqual(report.keyLoss, { skipped: false, items: 2, backupHits: 0, remaining: 0, setAsideFiles: 3 });
    assert.equal(simulated?.items.size, 0);
    assert.ok(recorded.calls.every(call => call.command !== '/usr/bin/security' && call.command !== '/bin/launchctl'));
    const receipt = JSON.stringify(report);
    for (const call of simulated!.calls) {
      for (const value of (call.options.input ?? '').match(/[0-9a-f]{64}/g) ?? []) assert.ok(!receipt.includes(value));
    }
    await assert.rejects(access(report.root));
  } finally { await removeDir(parent); }
});
