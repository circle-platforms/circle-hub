import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { appendPrivateLine, checkAppendable, writeNewPrivateFile } from './files.ts';

const dirs: string[] = [];
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'jev-files-test-'));
  dirs.push(dir);
  return dir;
}
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code;
  }
  return undefined;
};

describe('writeNewPrivateFile', () => {
  it('creates the file and its folders, private to the owner', async () => {
    const dir = await scratch();
    const path = join(dir, 'a', 'b', 'file.json');
    await writeNewPrivateFile(path, '{"a":1}\n');
    assert.equal(await readFile(path, 'utf8'), '{"a":1}\n');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, 'a', 'b'))).mode & 0o077, 0, 'the folders made are closed to others');
  });

  it('takes bytes as well as text', async () => {
    const dir = await scratch();
    const path = join(dir, 'bytes.bin');
    await writeNewPrivateFile(path, new Uint8Array([1, 2, 3]));
    assert.deepEqual([...(await readFile(path))], [1, 2, 3]);
  });

  it('never writes over a file, a folder or a link', async () => {
    const dir = await scratch();
    const file = join(dir, 'taken.txt');
    await writeFile(file, 'old');
    assert.equal(await codeOf(writeNewPrivateFile(file, 'new')), 'EEXIST');
    assert.equal(await readFile(file, 'utf8'), 'old');
    await mkdir(join(dir, 'folder'));
    assert.equal(await codeOf(writeNewPrivateFile(join(dir, 'folder'), 'new')), 'EEXIST');
    await symlink(file, join(dir, 'link'));
    assert.equal(await codeOf(writeNewPrivateFile(join(dir, 'link'), 'new')), 'EEXIST');
    await symlink(join(dir, 'nowhere'), join(dir, 'dangling'));
    assert.equal(await codeOf(writeNewPrivateFile(join(dir, 'dangling'), 'new')), 'EEXIST');
    assert.equal(await readFile(file, 'utf8'), 'old');
  });
});

describe('appendPrivateLine', () => {
  it('adds lines, each ended by one newline, to a file it creates private to the owner', async () => {
    const dir = await scratch();
    const path = join(dir, 'x', 'audit.jsonl');
    await appendPrivateLine(path, '{"n":1}');
    await appendPrivateLine(path, '{"n":2}\n');
    await appendPrivateLine(path, '{"n":3}');
    assert.equal(await readFile(path, 'utf8'), '{"n":1}\n{"n":2}\n{"n":3}\n');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });

  it('adds to a file that is there and does not change what it holds', async () => {
    const dir = await scratch();
    const path = join(dir, 'audit.jsonl');
    await writeFile(path, 'first\n', { mode: 0o640 });
    await appendPrivateLine(path, 'second');
    assert.equal(await readFile(path, 'utf8'), 'first\nsecond\n');
  });

  it('refuses a link and a folder', async () => {
    const dir = await scratch();
    const real = join(dir, 'real');
    await writeFile(real, '');
    await symlink(real, join(dir, 'link'));
    await mkdir(join(dir, 'folder'));
    assert.equal(await codeOf(appendPrivateLine(join(dir, 'link'), 'x')), 'ELOOP');
    assert.equal(await codeOf(appendPrivateLine(join(dir, 'folder'), 'x')), 'EISDIR');
    assert.equal(await readFile(real, 'utf8'), '');
  });

  it('does not take a path below a file', async () => {
    const dir = await scratch();
    await writeFile(join(dir, 'file'), '');
    assert.ok(['ENOTDIR', 'EEXIST'].includes((await codeOf(appendPrivateLine(join(dir, 'file', 'inside'), 'x'))) ?? ''));
  });
});

describe('checkAppendable', () => {
  it('creates an empty file and writes nothing into one that is there', async () => {
    const dir = await scratch();
    const path = join(dir, 'sub', 'audit.jsonl');
    await checkAppendable(path);
    assert.equal(await readFile(path, 'utf8'), '');
    await appendPrivateLine(path, 'kept');
    await checkAppendable(path);
    assert.equal(await readFile(path, 'utf8'), 'kept\n');
  });

  it('refuses what an append would refuse', async () => {
    const dir = await scratch();
    const real = join(dir, 'real');
    await writeFile(real, '');
    await symlink(real, join(dir, 'link'));
    await mkdir(join(dir, 'folder'));
    assert.equal(await codeOf(checkAppendable(join(dir, 'link'))), 'ELOOP');
    assert.equal(await codeOf(checkAppendable(join(dir, 'folder'))), 'EISDIR');
    assert.ok(['ENOTDIR', 'EEXIST'].includes((await codeOf(checkAppendable(join(real, 'inside')))) ?? ''));
  });
});
