// install.sh (decision 76) without touching the machine: its syntax under bash, and --dry-run plans for macOS and Linux
// on both architectures, which say every step and change nothing; refusals for other systems and architectures and for
// contradictory options. The real installation runs in .github/workflows/release.yml on a fresh runner. The helpers of
// tools/build-bundle.ts are checked here too.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUNDLED_NODE, hydratePostgresLinks, nodeTarball, npmTarget, shasumOf } from '../../tools/build-bundle.ts';

const SCRIPT = fileURLToPath(new URL('../../install.sh', import.meta.url));

function install(args: string[], os: string, arch = 'arm64', extra: NodeJS.ProcessEnv = {}): { code: number; out: string; err: string } {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(tmpdir(), 'circle-hub-synthetic-home'), CIRCLE_HUB_INSTALL_OS: os, CIRCLE_HUB_INSTALL_ARCH: arch, CIRCLE_HUB_DATA_DIR: '/srv/synthetic-hub', ...extra },
  });
  return { code: result.status ?? -1, out: result.stdout, err: result.stderr };
}

test('install.sh is valid bash', () => {
  const result = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('a macOS dry run plans init with HTTPS, key, tls and a bundle deploy with the bundled Node, and changes nothing', () => {
  const { code, out, err } = install(['--dry-run', '--version', '0.3.0'], 'Darwin');
  assert.equal(code, 0, err);
  assert.match(out, /circle-hub-0\.3\.0-darwin-arm64\.tar\.gz/);
  assert.match(out, /releases\/download\/v0\.3\.0\/SHA256SUMS/);
  assert.match(out, /init --environment production --port 7420 --https-port 7443/);
  assert.match(out, /key init/);
  assert.match(out, /tls init/);
  assert.match(out, /deploy --bundle \/srv\/synthetic-hub\/runtime\/bundles\/circle-hub-0\.3\.0-darwin-arm64 --node \/srv\/synthetic-hub\/runtime\/node\/bin\/node/);
  assert.match(out, /https:\/\/127\.0\.0\.1:7443\/console\//);
  assert.doesNotMatch(out, /useradd|apparmor_parser/, 'no Linux step on macOS');
});

test('a Linux dry run plans the service account, lingering, the sandbox tools, the AppArmor policy and an internal HTTPS address', () => {
  const { code, out, err } = install(['--dry-run', '--version', '0.3.0', '--https-host', '192.0.2.20', '--hostname', 'hub.example'], 'Linux', 'x86_64');
  assert.equal(code, 0, err);
  assert.match(out, /circle-hub-0\.3\.0-linux-x64\.tar\.gz/);
  assert.match(out, /useradd --system --home-dir \/var\/lib\/circle-hub/);
  assert.match(out, /loginctl enable-linger circle-hub/);
  assert.match(out, /apparmor_parser -r/);
  assert.match(out, /CIRCLE_HUB_ALLOWED_HOSTS=192\.0\.2\.20,hub\.example/);
  assert.match(out, /--https-port 7443 --https-host 192\.0\.2\.20/);
  assert.match(out, /https:\/\/192\.0\.2\.20:7443\/console\//);
});

test('other systems, other architectures and contradictory options are refused before anything happens', () => {
  for (const [os, arch, pattern] of [['FreeBSD', 'arm64', /只支持 macOS 和 Linux/], ['MINGW64_NT-10.0', 'x86_64', /只支持 macOS 和 Linux/], ['Linux', 'i686', /不支持的处理器架构/]] as const) {
    const { code, err } = install(['--dry-run', '--version', '0.3.0'], os, arch);
    assert.equal(code, 1);
    assert.match(err, pattern);
  }
  for (const [args, pattern] of [
    [['--hostname', 'hub.example'], /--hostname 要和 --https-host 一起用/],
    [['--https-host', '127.0.0.1'], /内网 IP/],
    [['--port', '7443'], /不能相同/],
    [['--environment', 'staging'], /环境类别/],
    [['--frobnicate'], /不认识的选项/],
  ] as const) {
    const { code, err } = install(['--dry-run', '--version', '0.3.0', ...args], 'Darwin');
    assert.equal(code, 1, args.join(' '));
    assert.match(err, pattern);
  }
});

test('CIRCLE_HUB_LIBPQ_BIN names PostgreSQL 18 client tools installed elsewhere; another major version or a relative path is refused', async (t) => {
  const clientTools = async (major: number): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'circle-hub-libpq-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    for (const tool of ['pg_dump', 'pg_restore']) await writeFile(join(dir, tool), `#!/bin/sh\necho '${tool} (PostgreSQL) ${major}.6'\n`, { mode: 0o755 });
    return dir;
  };
  const pg18 = await clientTools(18);
  for (const [os, arch] of [['Darwin', 'arm64'], ['Linux', 'x86_64']] as const) {
    const { code, out, err } = install(['--dry-run', '--version', '0.3.0'], os, arch, { CIRCLE_HUB_LIBPQ_BIN: pg18 });
    assert.equal(code, 0, err);
    const deploy = out.split('\n').find((line) => line.includes(' deploy --bundle '));
    assert.ok(deploy?.includes(`env CIRCLE_HUB_LIBPQ_BIN=${pg18} `), deploy);
    assert.doesNotMatch(out, /brew install libpq|postgresql-client-18/, `${os}: the named tools are used, nothing is installed for them`);
  }
  for (const [dir, pattern] of [[await clientTools(17), /没有 PostgreSQL 18 的 pg_dump 和 pg_restore/], ['relative/bin', /要是绝对路径/]] as const) {
    const { code, err } = install(['--dry-run', '--version', '0.3.0'], 'Darwin', 'arm64', { CIRCLE_HUB_LIBPQ_BIN: dir });
    assert.equal(code, 1, dir);
    assert.match(err, pattern);
  }
});

test('the bundle build names the npm target, the Node tarball and its listed SHA-256', () => {
  assert.deepEqual(npmTarget('linux-arm64'), { os: 'linux', cpu: 'arm64' });
  assert.deepEqual(npmTarget('darwin-x64'), { os: 'darwin', cpu: 'x64' });
  assert.equal(nodeTarball('v24.21.0', 'darwin-arm64'), 'node-v24.21.0-darwin-arm64.tar.gz');
  assert.match(BUNDLED_NODE, /^v24\./);
  const list = `${'a'.repeat(64)}  node-v24.21.0-darwin-arm64.tar.gz\n${'b'.repeat(64)}  node-v24.21.0-linux-x64.tar.gz\n`;
  assert.equal(shasumOf(list, 'node-v24.21.0-linux-x64.tar.gz'), 'b'.repeat(64));
  assert.equal(shasumOf(list, 'node-v24.21.0-linux-arm64.tar.gz'), null);
});

test('the PostgreSQL library links are made when npm skipped the postinstall, kept when right, refused when wrong', async (t) => {
  const app = await mkdtemp(join(tmpdir(), 'circle-hub-hydrate-'));
  t.after(() => rm(app, { recursive: true, force: true }));
  const lib = join(app, 'node_modules', '@embedded-postgres', 'linux-x64', 'native', 'lib');
  await mkdir(lib, { recursive: true });
  await writeFile(join(lib, 'libz.so.1.3.1'), 'synthetic');
  await writeFile(join(lib, '..', 'pg-symlinks.json'), JSON.stringify([{ source: 'native/lib/libz.so.1.3.1', target: 'native/lib/libz.so.1' }, { source: 'native/lib/libz.so.1.3.1', target: 'native/lib/libz.so' }]));
  assert.equal(await hydratePostgresLinks(app, 'linux-x64'), 2);
  assert.equal(await readlink(join(lib, 'libz.so.1')), 'libz.so.1.3.1');
  assert.equal(await hydratePostgresLinks(app, 'linux-x64'), 0, 'links that are already right stay');
  await rm(join(lib, 'libz.so'));
  await symlink('elsewhere', join(lib, 'libz.so'));
  await assert.rejects(hydratePostgresLinks(app, 'linux-x64'), /应为 libz\.so\.1\.3\.1/);
});
