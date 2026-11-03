import assert from 'node:assert/strict';
import { access, lstat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { layoutAt } from './layout.ts';
import { runCommand, type CommandRunner } from './process.ts';
import { rehearse, treeEntries } from './rehearse.ts';
import { libpqAvailable, LIBPQ_MISSING, removeDir, tempDir, recordingRunner } from './test-support.ts';

const libpq = await libpqAvailable();

// Decision 137: the key files are the same on every platform, so key loss is rehearsed wherever libpq is installed.
test('rehearsal loses both private key files and proves backups contain neither; keep leaves no key file behind', { skip: libpq ? false : LIBPQ_MISSING }, async () => {
  const parent = await tempDir();
  try {
    const report = await rehearse({ parent, records: 3, objects: 1, keep: true });
    assert.equal(report.ok, true, report.differences.join('\n'));
    assert.deepEqual(report.keyLoss, { items: 2, backupHits: 0, remaining: 0, setAsideFiles: 3 });
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual(await readdir(join(report.root, 'keys')), []);
  } finally { await removeDir(parent); }
});

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


test('rehearsal refuses a backup containing any secret encoding and never discloses the secret', { skip: libpq ? false : LIBPQ_MISSING }, async () => {
  const parent = await tempDir(); const values: string[] = [];
  try {
    // Just before pg_dump runs, the key files' values are planted in the vault, raw and as upper-case hexadecimal.
    const runner: CommandRunner = async (command, args, options) => {
      if (basename(command) === 'pg_dump' && values.length === 0) {
        const { readdir, readFile } = await import('node:fs/promises');
        const [root] = (await readdir(parent)).filter((name) => name.startsWith('chr-'));
        const keys = join(parent, root!, 'keys');
        for (const name of await readdir(keys)) {
          const value = (await readFile(join(keys, name))).toString('hex');
          values.push(value);
          await writeFile(join(parent, root!, 'vault', `planted-${values.length}`), Buffer.concat([Buffer.from(value.toUpperCase()), Buffer.from(value, 'hex')]));
        }
      }
      return runCommand(command, args, options);
    };
    const report = await rehearse({ parent, records: 3, objects: 1, runner });
    assert.equal(values.length, 2);
    assert.equal(report.ok, false); assert.ok(report.keyLoss.backupHits >= 2);
    assert.ok(report.differences.includes('备份文件含密钥的值，不能采用'));
    for (const value of values) { assert.ok(!JSON.stringify(report).includes(value)); assert.ok(!JSON.stringify(report).includes(value.toUpperCase())); }
    await assert.rejects(access(report.root));
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

test('rehearsal compares restored data and loses both keys without any host tool but PostgreSQL', { skip: libpq ? false : LIBPQ_MISSING }, async () => {
  const parent = await tempDir();
  const recorded = recordingRunner();
  try {
    const report = await rehearse({ parent, records: 6, objects: 2, runner: recorded.runner });
    assert.equal(report.ok, true, report.differences.join('\n'));
    assert.deepEqual(report.differences, []);
    assert.equal(report.rows, 8);
    assert.equal(report.objects, 2);
    assert.equal(report.vaultFiles, 3);
    assert.equal(report.refused, 11);
    assert.deepEqual(report.keyLoss, { items: 2, backupHits: 0, remaining: 0, setAsideFiles: 3 });
    assert.ok(recorded.calls.every((call) => !['security', 'launchctl', 'systemctl'].includes(basename(call.command))));
    await assert.rejects(access(report.root));
  } finally { await removeDir(parent); }
});
