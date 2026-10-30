// The Windows ARM64 hybrid install of the lockfile's x64 PostgreSQL build, with a synthetic package: `npm pack` is scripted
// (it copies a tarball made here), the system tar really extracts it, and the executables are synthetic PE headers. The real
// download and the emulated start are runner checks (the platform matrix's windows-11-arm job); nothing here claims them.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HYBRID_RECORD, installHybridPostgres, integrityMatches, lockedPackage, npmCommand, PE_MACHINE_X64, peMachine, systemTar } from './postgres-hybrid.ts';
import { postgresBuild, resolveBinaries } from './postgres.ts';
import { hostToolEnvironment, runCommand, type CommandRunner } from './process.ts';

const NAME = '@embedded-postgres/windows-x64';
const VERSION = '18.4.0-beta.17';

/** A minimal PE image: MZ, e_lfanew at 0x3c, "PE\0\0", then the machine field. */
function pe(machine: number): Buffer {
  const bytes = Buffer.alloc(0x100);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.writeUInt32LE(0x00004550, 0x80);
  bytes.writeUInt16LE(machine, 0x84);
  return bytes;
}

async function syntheticRelease(t: { after(fn: () => Promise<void>): void }, machine = PE_MACHINE_X64, name = NAME) {
  const root = await mkdtemp(join(tmpdir(), 'hub-pg-hybrid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(join(source, 'package', 'native', 'bin'), { recursive: true });
  await writeFile(join(source, 'package', 'package.json'), JSON.stringify({ name, version: VERSION, os: ['win32'], cpu: ['x64'] }));
  await writeFile(join(source, 'package', 'native', 'pg-symlinks.json'), '[]');
  for (const exe of ['initdb.exe', 'pg_ctl.exe', 'postgres.exe']) await writeFile(join(source, 'package', 'native', 'bin', exe), pe(machine));
  const tarball = join(root, 'synthetic.tgz');
  const packed = await runCommand(systemTar(), ['-czf', tarball, '-C', source, 'package'], { env: hostToolEnvironment() });
  assert.equal(packed.code, 0, packed.stderr);
  const integrity = `sha512-${createHash('sha512').update(await readFile(tarball)).digest('base64')}`;
  const release = join(root, 'release');
  await mkdir(join(release, 'node_modules'), { recursive: true });
  const lock = { lockfileVersion: 3, packages: { [`node_modules/${NAME}`]: { version: VERSION, integrity, os: ['win32'], cpu: ['x64'], optional: true } } };
  await writeFile(join(release, 'package-lock.json'), JSON.stringify(lock));
  const calls: string[][] = [];
  // Scripted npm: `pack <spec> --pack-destination <dir>` leaves the synthetic tarball there; every other tool really runs.
  const runner: CommandRunner = async (command, args, options) => {
    if (command === 'scripted-npm') {
      calls.push([...args]);
      const destination = args[args.indexOf('--pack-destination') + 1]!;
      await copyFile(tarball, join(destination, 'embedded-postgres-windows-x64-18.4.0-beta.17.tgz'));
      return { code: 0, stdout: '[]', stderr: '' };
    }
    return runCommand(command, args, options);
  };
  return { root, release, runner, calls, integrity, tarball };
}

const hybrid = (release: string, runner: CommandRunner) => installHybridPostgres({
  root: release, platform: 'win32', arch: 'arm64', runner, npm: { command: 'scripted-npm', args: [] }, tar: systemTar(), env: process.env,
});

test('the lockfile pins the Windows x64 build the hybrid installs, by exact version and SHA-512', async () => {
  const lock = JSON.parse(await readFile(new URL('../../package-lock.json', import.meta.url), 'utf8'));
  const locked = lockedPackage(lock, NAME);
  assert.equal(locked.version, lock.packages['node_modules/embedded-postgres'].version);
  assert.match(locked.integrity, /^sha512-/);
  assert.throws(() => lockedPackage({ packages: {} }, NAME), /确切版本/);
  assert.throws(() => lockedPackage({ packages: { [`node_modules/${NAME}`]: { version: VERSION, integrity: 'sha1-abc' } } }, NAME), /SHA-512/);
  assert.equal(integrityMatches(Buffer.from('synthetic'), `sha512-${createHash('sha512').update('synthetic').digest('base64')}`), true);
  assert.equal(integrityMatches(Buffer.from('other'), `sha512-${createHash('sha512').update('synthetic').digest('base64')}`), false);
});

test('PE machine types are read from the image header; anything else is unrecognised', () => {
  assert.equal(peMachine(pe(PE_MACHINE_X64)), 0x8664);
  assert.equal(peMachine(pe(0xaa64)), 0xaa64);
  assert.equal(peMachine(Buffer.from('#!/bin/sh\n')), undefined);
  const truncated = pe(PE_MACHINE_X64).subarray(0, 0x82);
  assert.equal(peMachine(truncated), undefined);
});

test('npm runs without a shell: on Windows as npm-cli.js beside node.exe, elsewhere from PATH', () => {
  assert.deepEqual(npmCommand('linux'), { command: 'npm', args: [] });
  const windows = npmCommand('win32', 'C:\\node\\node.exe');
  assert.equal(windows.command, 'C:\\node\\node.exe');
  assert.equal(windows.args.length, 1);
  assert.match(windows.args[0]!, /node_modules[\\/]npm[\\/]bin[\\/]npm-cli\.js$/);
  assert.equal(systemTar('darwin'), '/usr/bin/tar');
  assert.equal(systemTar('win32', { SystemRoot: 'C:\\Windows' }), 'C:\\Windows\\System32\\tar.exe');
});

test('only an emulated build is installed this way; native hosts are refused before anything runs', async () => {
  let ran = false;
  const runner: CommandRunner = async () => { ran = true; return { code: 0, stdout: '', stderr: '' }; };
  for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'arm64'], ['linux', 'x64']] as const) {
    await assert.rejects(installHybridPostgres({ root: tmpdir(), platform, arch, runner }), /不需要 x64 模拟/);
  }
  await assert.rejects(installHybridPostgres({ root: tmpdir(), platform: 'win32', arch: 'ia32', runner }), /没有可用的 PostgreSQL 构建/);
  assert.equal(ran, false);
});

test('the lockfile build is fetched, checked, extracted with the system tar and recorded; a second run keeps it', async (t) => {
  const { release, runner, calls, integrity } = await syntheticRelease(t);
  const first = await hybrid(release, runner);
  assert.equal(first.installed, true);
  assert.deepEqual(calls, [['pack', `${NAME}@${VERSION}`, '--pack-destination', calls[0]![3]!, '--json', '--ignore-scripts']]);
  const directory = join(release, 'node_modules', '@embedded-postgres', 'windows-x64');
  assert.equal(first.directory, directory);
  const recorded = JSON.parse(await readFile(join(directory, HYBRID_RECORD), 'utf8'));
  assert.deepEqual(recorded, { format: 'circle-hub-postgres-build@1', package: NAME, version: VERSION, integrity, architecture: 'x64', host: 'win32-arm64', emulated: true });
  // resolveBinaries of the emulated build now finds the executables; no staging directory is left behind.
  const binaries = await resolveBinaries(release, postgresBuild('win32', 'arm64'));
  assert.equal(binaries.postgres, join(directory, 'native', 'bin', 'postgres.exe'));
  assert.deepEqual((await readdir(join(release, 'node_modules'))).filter((name) => name.startsWith('.')), []);
  const second = await hybrid(release, runner);
  assert.equal(second.installed, false);
  assert.equal(calls.length, 1);
});

test('a tarball that differs from the lockfile, a non-x64 executable or foreign content in place installs nothing', async (t) => {
  const tampered = await syntheticRelease(t);
  const lock = JSON.parse(await readFile(join(tampered.release, 'package-lock.json'), 'utf8'));
  lock.packages[`node_modules/${NAME}`].integrity = `sha512-${createHash('sha512').update('another build').digest('base64')}`;
  await writeFile(join(tampered.release, 'package-lock.json'), JSON.stringify(lock));
  await assert.rejects(hybrid(tampered.release, tampered.runner), /SHA-512 不一致/);
  assert.deepEqual(await readdir(join(tampered.release, 'node_modules')), []);

  const arm = await syntheticRelease(t, 0xaa64);
  await assert.rejects(hybrid(arm.release, arm.runner), /不是 x64 Windows 程序（机器类型 0xaa64）/);
  assert.deepEqual(await readdir(join(arm.release, 'node_modules')), []);

  const renamed = await syntheticRelease(t, PE_MACHINE_X64, '@embedded-postgres/windows-arm64');
  await assert.rejects(hybrid(renamed.release, renamed.runner), /名称或版本不符/);

  const foreign = await syntheticRelease(t);
  await mkdir(join(foreign.release, 'node_modules', '@embedded-postgres', 'windows-x64'), { recursive: true });
  await assert.rejects(hybrid(foreign.release, foreign.runner), /不是锁文件固定的 x64 构建；不覆盖/);
  assert.equal(foreign.calls.length, 0);
});
