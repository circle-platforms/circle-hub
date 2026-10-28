import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { activeVersion, installRelease, packageVersion, requireTarget, sha256, type Runner } from './operations.ts';
import { buildRelease } from './build-release.ts';
import { inventory, runtimeFor, targetFor, type Manifest } from './integrity.ts';

function binary(): Buffer {
  const header = Buffer.alloc(64), target = targetFor();
  if (target.startsWith('darwin-')) { header.writeUInt32LE(0xfeedfacf); header.writeUInt32LE(target.endsWith('arm64') ? 0x0100000c : 0x01000007, 4); }
  else { Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(header); header.writeUInt16LE(target.endsWith('arm64') ? 183 : 62, 18); }
  return header;
}

function fixture(root: string, version = '0.2.0'): Manifest {
  const app = join(root, 'app'), target = targetFor();
  for (const dir of ['bin', 'scripts/release', 'node_modules/embedded-postgres', `node_modules/@embedded-postgres/${target}/native/bin`]) mkdirSync(join(app, dir), { recursive: true });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'circle-hub', version, devDependencies: { 'embedded-postgres': '18.4.0-beta.17' } }));
  writeFileSync(join(app, 'package-lock.json'), JSON.stringify({ name: 'circle-hub', version, packages: { '': { name: 'circle-hub', version } } }));
  for (const path of ['scripts/release/install-release.ts', 'scripts/release/operations.ts', 'scripts/release/executable.ts', 'scripts/release/integrity.ts', 'scripts/release/node-runtime.json', 'bin/circle-hub', 'node_modules/embedded-postgres/package.json', `node_modules/@embedded-postgres/${target}/native/bin/postgres`]) writeFileSync(join(app, path), 'synthetic');
  writeFileSync(join(app, 'node_modules/embedded-postgres/package.json'), JSON.stringify({ name: 'embedded-postgres', version: '18.4.0-beta.17' }));
  writeFileSync(join(app, `node_modules/@embedded-postgres/${target}/native/bin/postgres`), binary());
  writeFileSync(join(app, `node_modules/@embedded-postgres/${target}/package.json`), JSON.stringify({ name: `@embedded-postgres/${target}`, version: '18.4.0-beta.17' }));
  mkdirSync(join(root, 'runtime')); writeFileSync(join(root, 'runtime/node'), binary());
  const runtime = runtimeFor(target);
  const manifest: Manifest = { schema: 'circle-hub-release/v1', version, target, commit: 'a'.repeat(40), nodeVersion: runtime.version, runtime, files: inventory(root) };
  writeFileSync(join(root, 'release.json'), JSON.stringify(manifest));
  return manifest;
}

const scripted: Runner = async (command, args) => {
  let stdout = '';
  if (command.endsWith('/native/bin/postgres')) stdout = 'postgres (PostgreSQL) 18.4';
  else if (args[0] === '--version') stdout = `v${runtimeFor(targetFor()).version}`;
  else if (args[0] === '-p') stdout = targetFor();
  else if (args.at(-1) === '--version') stdout = JSON.parse(readFileSync(join(dirname(dirname(args[0]!)), 'package.json'), 'utf8')).version;
  else if (args[0] !== '--input-type=module') throw new Error('Unexpected synthetic command');
  return { code: 0, stdout: `${stdout}\n`, stderr: '' };
};

function temporary(run: (root: string) => Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hub-release-operations-')));
  return run(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

// These are scripted filesystem/control-flow regressions, not native release acceptance.
const supported = { skip: process.platform === 'win32' ? 'Windows backend is unsupported; installation/build smoke has not been verified' : false };
test('Windows targets fail before build downloads or installation', async () => {
  assert.throws(() => requireTarget('windows-x64'), /Windows/);
  assert.throws(() => requireTarget('windows-arm64'), /Windows/);
  let downloaded = false;
  await assert.rejects(buildRelease({ source: 'unused', output: 'unused', target: 'windows-arm64', download: async () => { downloaded = true; return new Uint8Array(); } }), /Windows/);
  assert.equal(downloaded, false);
});

test('scripted install and upgrade preserve data and roll back failed activation', supported, async () => {
  await temporary(async (root) => {
    const first = join(root, 'first'), second = join(root, 'second'), third = join(root, 'third');
    const a = fixture(first), b = fixture(second, '0.2.1'), c = fixture(third, '0.2.2');
    const prefix = join(root, 'install space'), dataRoot = join(root, 'data'); mkdirSync(dataRoot);
    const sentinel = join(dataRoot, 'encrypted-vault'); writeFileSync(sentinel, 'synthetic encrypted bytes');
    await installRelease(first, { prefix, dataRoot, expected: a, runner: scripted });
    assert.equal(activeVersion(prefix), '0.2.0');
    await installRelease(second, { prefix, dataRoot, expected: b, runner: scripted });
    assert.equal(activeVersion(prefix), '0.2.1');
    await assert.rejects(installRelease(third, { prefix, dataRoot, expected: c, runner: scripted, checkActivation: async () => { throw new Error('synthetic activation failure'); } }), /activation failure/);
    assert.equal(activeVersion(prefix), '0.2.1');
    assert.equal(readFileSync(sentinel, 'utf8'), 'synthetic encrypted bytes');
    assert.equal(existsSync(join(prefix, '.install-lock')), false);
    assert.equal(readFileSync(join(prefix, 'circle-hub'), 'utf8').includes('current.ref'), true);
    assert.equal(existsSync(join(prefix, 'versions/0.2.0/release.json')), true);
  });
});

test('scripted installer refuses tamper, stage mutation, pointer symlinks and data overlap', supported, async () => {
  await temporary(async (root) => {
    const source = join(root, 'source'), manifest = fixture(source), prefix = join(root, 'prefix'), dataRoot = join(root, 'data');
    writeFileSync(join(source, 'extra'), 'unlisted');
    await assert.rejects(installRelease(source, { prefix, dataRoot, expected: manifest, runner: scripted }), /逐文件/);
    assert.equal(existsSync(prefix), false); rmSync(join(source, 'extra'));
    await assert.rejects(installRelease(source, { prefix, dataRoot: join(prefix, 'data'), expected: manifest, runner: scripted }), /独立/);
    const mutating: Runner = async (command, args, options) => {
      if (command.includes('.staging-') && args[0] === '--version') writeFileSync(join(dirname(dirname(command)), 'extra'), 'changed during smoke');
      return scripted(command, args, options);
    };
    await assert.rejects(installRelease(source, { prefix, dataRoot, expected: manifest, runner: mutating }), /逐文件/);
    assert.equal(activeVersion(prefix), undefined);
    assert.equal(existsSync(join(prefix, '.install-lock')), false);
    assert.equal(readdirSync(join(prefix, 'versions')).some((name) => name.startsWith('.staging-')), false);
    writeFileSync(join(root, 'outside-pointer'), '0.2.0\n'); symlinkSync('../outside-pointer', join(prefix, 'current.ref'));
    await assert.rejects(installRelease(source, { prefix, dataRoot, expected: manifest, runner: scripted }), /指针/);
    assert.equal(readFileSync(join(root, 'outside-pointer'), 'utf8'), '0.2.0\n');
  });
});

test('version mismatch is rejected and failed initial activation leaves no active version', supported, async () => {
  await temporary(async (root) => {
    const source = join(root, 'source'), manifest = fixture(source), prefix = join(root, 'prefix'), dataRoot = join(root, 'data');
    const lock = join(source, 'app/package-lock.json'), original = readFileSync(lock);
    writeFileSync(lock, JSON.stringify({ name: 'circle-hub', version: '0.2.1' }));
    assert.throws(() => packageVersion(join(source, 'app')), /版本/); writeFileSync(lock, original);
    const unavailable: Runner = async (command, args, options) => args[0] === '--input-type=module' ? { code: 1, stdout: '', stderr: 'synthetic unavailable isolation' } : scripted(command, args, options);
    await assert.rejects(installRelease(source, { prefix, dataRoot, expected: manifest, runner: unavailable }), /命令执行失败/);
    assert.equal(existsSync(prefix), false);
    const wrongVersion: Runner = async (command, args, options) => args.at(-1) === '--version' && args[0] !== '--version' ? { code: 0, stdout: '0.2.9', stderr: '' } : scripted(command, args, options);
    await assert.rejects(installRelease(source, { prefix, dataRoot, expected: manifest, runner: wrongVersion }), /版本冒烟/);
    assert.equal(existsSync(prefix), false);
    await assert.rejects(installRelease(source, { prefix, dataRoot, expected: manifest, runner: scripted, checkActivation: async () => { throw new Error('initial activation failed'); } }), /initial activation/);
    assert.equal(activeVersion(prefix), undefined);
  });
});

test('scripted native builder verifies download digest, keeps PG install scripts and emits closed inventory', supported, async () => {
  await temporary(async (root) => {
    const seed = join(root, 'seed'); fixture(seed);
    const bytes = Buffer.from('synthetic Node archive'), runtime = { ...runtimeFor(targetFor()), sha256: sha256(bytes) };
    let npmArgs: readonly string[] = [], extractedRuntime = false;
    const builder: Runner = async (command, args, options) => {
      if (command === 'git') return { code: 0, stdout: args.includes('rev-parse') ? 'a'.repeat(40) : args.includes('ls-tree') ? '100644 package.json\0' : '', stderr: '' };
      if (command === 'tar' && args[0] === '-xf') { cpSync(join(seed, 'app'), args[args.indexOf('-C') + 1]!, { recursive: true }); return { code: 0, stdout: '', stderr: '' }; }
      if (command === 'tar' && args[0] === '-xzf') {
        extractedRuntime = true;
        const nodeRoot = join(args[args.indexOf('-C') + 1]!, runtime.archive.replace(/\.tar\.gz$/, ''));
        mkdirSync(join(nodeRoot, 'bin'), { recursive: true }); writeFileSync(join(nodeRoot, 'bin/node'), binary()); writeFileSync(join(nodeRoot, 'LICENSE'), 'synthetic license');
        return { code: 0, stdout: '', stderr: '' };
      }
      if (command === 'tar' && args[0] === '-czf') { writeFileSync(args[1]!, 'synthetic final archive'); return { code: 0, stdout: '', stderr: '' }; }
      if (command === 'npm') { npmArgs = args; assert.notEqual(options.env.HOME, process.env.HOME); assert.equal(readFileSync(options.env.NPM_CONFIG_USERCONFIG!, 'utf8'), ''); return { code: 0, stdout: '', stderr: '' }; }
      return scripted(command, args, options);
    };
    await assert.rejects(buildRelease({ source: root, output: join(root, 'out'), runner: builder, download: async () => Buffer.from('wrong'), runtimeFor: () => runtime }), /摘要/);
    assert.equal(extractedRuntime, false);
    const built = await buildRelease({ source: root, output: join(root, 'out'), runner: builder, download: async () => bytes, runtimeFor: () => runtime });
    assert.deepEqual(npmArgs, ['ci', '--include=dev', '--no-audit', '--no-fund']);
    assert.equal(built.sha256, sha256(readFileSync(built.archive)));
    assert.equal(readFileSync(`${built.archive}.sha256`, 'utf8'), `${built.sha256}  ${built.archive.split('/').at(-1)}\n`);
    assert.ok(built.manifest.files['app/node_modules/embedded-postgres/package.json']);
    await assert.rejects(buildRelease({ source: root, output: join(root, 'out'), runner: builder, download: async () => bytes, runtimeFor: () => runtime }));
    assert.equal(readFileSync(built.archive, 'utf8'), 'synthetic final archive');
  });
});

test('file smoke orchestration uses relocated files, launcher versions, upgrade and tamper rejection', supported, async () => {
  const { smokeRelease } = await import('./smoke-release.ts');
  await temporary(async (root) => {
    const first = join(root, 'first'), second = join(root, 'second');
    const a = fixture(first), b = fixture(second, '0.2.1');
    const launcher: Runner = async (command, args, options) => command.endsWith('/circle-hub')
      ? { code: 0, stdout: `${activeVersion(dirname(command))}\n`, stderr: '' }
      : scripted(command, args, options);
    assert.deepEqual(await smokeRelease({ root: first, expected: a }, { root: second, expected: b }, launcher), { installed: true, upgraded: true, relocated: true, tamperRejected: true, dataPreserved: true });
  });
});

test('concurrent installation cannot remove another installer lock or alter its pointer', supported, async () => {
  await temporary(async (root) => {
    const first = join(root, 'first'), second = join(root, 'second');
    const a = fixture(first), b = fixture(second, '0.2.1'), prefix = join(root, 'install'), dataRoot = join(root, 'data');
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const installing = installRelease(first, { prefix, dataRoot, expected: a, runner: scripted, checkActivation: async () => { enter(); await gate; } });
    try {
      await Promise.race([entered, installing.then(() => { throw new Error('Installer ended before activation gate'); })]);
      await assert.rejects(installRelease(second, { prefix, dataRoot, expected: b, runner: scripted }));
      assert.equal(existsSync(join(prefix, '.install-lock')), true);
      assert.equal(activeVersion(prefix), a.version);
    } finally { release(); await installing; }
    assert.equal(existsSync(join(prefix, '.install-lock')), false);
    await installRelease(second, { prefix, dataRoot, expected: b, runner: scripted });
    assert.equal(activeVersion(prefix), b.version);
  });
});
