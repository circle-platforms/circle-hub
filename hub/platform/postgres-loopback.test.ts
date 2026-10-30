// The PostgreSQL build each host uses, the loopback-scram transport Windows needs (no peer authentication there), and a
// real cluster in that transport on this host's own build: macOS and Linux run it in the ordinary unit jobs; the Windows
// runners of the synthetic platform matrix run it on windows-x64 natively and, on ARM64, on the x64 build under emulation.
// Synthetic names and random passwords only; nothing is read from the environment beyond the tool locations.
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { layoutAt } from './layout.ts';
import { binaryPackage, loopbackConf, loopbackHba, loopbackInitdbArguments, LOOPBACK_HOST, managedConf, postgresBuild, quoteConfPath, resolveBinaries } from './postgres.ts';
import { hostToolEnvironment, runCommand, windowsToolEnvironment } from './process.ts';
import { assertClusterDirectory, databasePassword, loopbackConnector, scramKeys, scramVerifier, withSession } from './sql.ts';

const lock = JSON.parse(await readFile(new URL('../../package-lock.json', import.meta.url), 'utf8')) as { packages: Record<string, { os?: string[]; cpu?: string[]; version?: string }> };

test('each host maps to the embedded-postgres build it can run, and Windows names its package and executables correctly', () => {
  assert.deepEqual(postgresBuild('darwin', 'arm64'), {
    package: '@embedded-postgres/darwin-arm64', executables: { initdb: 'initdb', pg_ctl: 'pg_ctl', postgres: 'postgres' },
    architecture: 'arm64', emulated: false, transport: 'unix-socket-peer',
  });
  assert.equal(postgresBuild('linux', 'x64').package, '@embedded-postgres/linux-x64');
  assert.equal(postgresBuild('linux', 'arm64').transport, 'unix-socket-peer');
  const windows = { package: '@embedded-postgres/windows-x64', executables: { initdb: 'initdb.exe', pg_ctl: 'pg_ctl.exe', postgres: 'postgres.exe' }, architecture: 'x64', transport: 'loopback-scram' };
  assert.deepEqual(postgresBuild('win32', 'x64'), { ...windows, emulated: false });
  // No Windows ARM64 build exists upstream: the x64 build runs under emulation (owner decision of 2026-10-30).
  assert.deepEqual(postgresBuild('win32', 'arm64'), { ...windows, emulated: true });
  for (const arch of ['ia32', 'arm']) assert.throws(() => postgresBuild('win32', arch), /没有可用的 PostgreSQL 构建/);
  assert.equal(binaryPackage(), postgresBuild(process.platform, process.arch).package);
});

test('every selected build is a package the lockfile pins, with the operating system and architecture it is built for', () => {
  const targets: [NodeJS.Platform, string][] = [['darwin', 'x64'], ['darwin', 'arm64'], ['linux', 'x64'], ['linux', 'arm64'], ['win32', 'x64'], ['win32', 'arm64']];
  for (const [platform, arch] of targets) {
    const build = postgresBuild(platform, arch);
    const entry = lock.packages[`node_modules/${build.package}`];
    assert.ok(entry, `${build.package} is in package-lock.json`);
    assert.equal(entry.version, lock.packages['node_modules/embedded-postgres']!.version);
    assert.deepEqual(entry.os, [platform]);
    assert.deepEqual(entry.cpu, [build.architecture]);
    // npm ci installs a package only where its cpu field matches: that is why the emulated build needs postgres-hybrid.ts.
    assert.equal(entry.cpu![0] !== arch, build.emulated);
  }
});

test('the binaries of a Windows build are its .exe files; the extensionless names of the old lookup are not accepted', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hub-pg-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'node_modules', '@embedded-postgres', 'windows-x64', 'native', 'bin');
  await mkdir(bin, { recursive: true });
  for (const name of ['initdb', 'pg_ctl', 'postgres']) await writeFile(join(bin, name), 'synthetic');
  await assert.rejects(resolveBinaries(root, postgresBuild('win32', 'x64')), /找不到 PostgreSQL 二进制（@embedded-postgres\/windows-x64/);
  await assert.rejects(resolveBinaries(root, postgresBuild('win32', 'arm64')), (error: Error & { hint?: string }) => /postgres-hybrid\.ts/.test(error.hint ?? ''));
  for (const name of ['initdb.exe', 'pg_ctl.exe', 'postgres.exe']) await writeFile(join(bin, name), 'synthetic');
  assert.deepEqual(await resolveBinaries(root, postgresBuild('win32', 'arm64')), { initdb: join(bin, 'initdb.exe'), pg_ctl: join(bin, 'pg_ctl.exe'), postgres: join(bin, 'postgres.exe') });
});

test('a loopback-scram configuration listens on 127.0.0.1 only, has no Unix socket and keeps the socket logging settings', () => {
  const text = loopbackConf('/srv/hub/logs/postgres', 54329);
  const lines = text.split('\n');
  for (const line of ["listen_addresses = '127.0.0.1'", 'port = 54329', "unix_socket_directories = ''", "password_encryption = 'scram-sha-256'", "log_directory = '/srv/hub/logs/postgres'"]) assert.ok(lines.includes(line), line);
  assert.equal(LOOPBACK_HOST, '127.0.0.1');
  // Logging and time zone lines are the socket configuration's, so the two cannot drift apart.
  const shared = (conf: string) => conf.split('\n').filter((line) => /^(?:logging_collector|log_filename|log_truncate_on_rotation|log_rotation_|timezone|log_timezone)/.test(line));
  assert.deepEqual(shared(text), shared(managedConf(layoutAt('/srv/hub'), 54329)));
  assert.equal(shared(text).length, 7);
  // The server reads backslash escapes in quoted values: a Windows path keeps its separators only when they are doubled.
  assert.ok(loopbackConf('C:\\hub data\\logs\\postgres', 5432).includes("log_directory = 'C:\\\\hub data\\\\logs\\\\postgres'"));
  assert.equal(quoteConfPath("C:\\o'k"), "'C:\\\\o''k'");
  assert.throws(() => quoteConfPath('a\nb'), /控制字符/);
  for (const port of [0, 65536, 1.5, Number.NaN]) assert.throws(() => loopbackConf('/srv/hub/logs/postgres', port), /端口无效/);
});

test('loopback pg_hba allows only the superuser role everywhere and the application role on the Hub database, by SCRAM', () => {
  assert.equal(loopbackHba('hub_owner', 'circle_hub', 'circle_hub'), [
    '# Managed by circle-hub and rewritten at every start; do not edit.',
    "# TCP on 127.0.0.1 only, SCRAM with each role's own password; everything else is rejected.",
    'host   all   "hub_owner"   127.0.0.1/32   scram-sha-256',
    'host   "circle_hub"   "circle_hub"   127.0.0.1/32   scram-sha-256',
    'host   all   all   0.0.0.0/0   reject',
    'host   all   all   ::/0   reject',
    '',
  ].join('\n'));
  const rules = loopbackHba('hub_owner', 'circle_hub', 'circle_hub').split('\n').filter((line) => line !== '' && !line.startsWith('#'));
  for (const rule of rules) {
    const fields = rule.split(/\s+/);
    assert.equal(fields[0], 'host', rule);
    assert.ok(['scram-sha-256', 'reject'].includes(fields.at(-1)!), rule);
  }
  for (const bad of ['a"b', 'a b', '']) assert.throws(() => loopbackHba(bad, 'circle_hub', 'circle_hub'), /角色名/);
  assert.throws(() => loopbackHba('hub_owner', 'circle_hub', 'a.b'), /数据库名/);
});

test('loopback initdb reads the superuser password from a file and allows neither peer nor socket logins', () => {
  const args = loopbackInitdbArguments('/srv/hub/db', 'hub_owner', '/srv/hub/run/initdb-password');
  assert.deepEqual(args, ['--pgdata=/srv/hub/db', '--username=hub_owner', '--auth-local=reject', '--auth-host=scram-sha-256', '--pwfile=/srv/hub/run/initdb-password', '--encoding=UTF8', '--locale=C', '--no-instructions']);
  assert.throws(() => loopbackInitdbArguments('/srv/hub/db', 'x y', '/f'), /角色名/);
});

test('SCRAM keys match the RFC 7677 exchange, and a verifier has PostgreSQL format for a hexadecimal key-store password', () => {
  // RFC 7677 section 3: user "user", password "pencil", salt W22ZaJ0SNY7soEsUEjb6gQ==, 4096 iterations.
  const { storedKey, serverKey } = scramKeys('pencil', Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64'), 4096);
  const nonce = 'rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0';
  const auth = `n=user,r=rOprNGfwEbeRWgbNEkqO,r=${nonce},s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,c=biws,r=${nonce}`;
  assert.equal(createHmac('sha256', serverKey).update(auth).digest('base64'), '6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=');
  const signature = createHmac('sha256', storedKey).update(auth).digest();
  // ClientProof = ClientKey XOR ClientSignature, and StoredKey = H(ClientKey): recover ClientKey from the RFC's proof.
  const proof = Buffer.from('dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=', 'base64');
  const clientKey = Buffer.from(proof.map((byte, index) => byte ^ signature[index]!));
  assert.deepEqual(createHash('sha256').update(clientKey).digest(), storedKey);
  const password = databasePassword(new Uint8Array(32).fill(0xab));
  assert.equal(password, 'ab'.repeat(32));
  const salt = new Uint8Array(16).fill(7);
  const verifier = scramVerifier(password, salt);
  assert.match(verifier, /^SCRAM-SHA-256\$4096:BwcHBwcHBwcHBwcHBwcHBw==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/);
  assert.equal(scramVerifier(password, salt), verifier);
  assert.notEqual(scramVerifier(password), scramVerifier(password));
  for (const bad of ['pencil', 'AB'.repeat(32), 'ab'.repeat(31), `${'ab'.repeat(32)}\n`]) assert.throws(() => scramVerifier(bad), /口令格式不对/);
  assert.throws(() => scramVerifier(password, new Uint8Array(8)), /盐/);
  assert.throws(() => scramVerifier(password, salt, 1000), /迭代/);
  assert.throws(() => databasePassword(new Uint8Array(31)), /32 字节/);
});

test('the Windows tool environment carries the system locations only, whatever their case, and requires SystemRoot', () => {
  const env = windowsToolEnvironment({
    SystemRoot: 'C:\\Windows', SYSTEMDRIVE: 'C:', ComSpec: 'C:\\Windows\\system32\\cmd.exe', Temp: 'C:\\Temp', TMP: 'C:\\Temp',
    Path: 'D:\\synthetic-tools\\bin;C:\\Windows', PGPASSWORD: 'synthetic-secret', PGHOST: 'synthetic', USERPROFILE: 'C:\\Windows\\ServiceProfiles\\synthetic',
    GITHUB_TOKEN: 'synthetic-secret',
  });
  assert.deepEqual(env, {
    SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', PATH: 'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem', TZ: 'UTC',
    SystemDrive: 'C:', ComSpec: 'C:\\Windows\\system32\\cmd.exe', TEMP: 'C:\\Temp', TMP: 'C:\\Temp',
  });
  assert.throws(() => windowsToolEnvironment({ PATH: 'C:\\Windows' }), /SystemRoot/);
  assert.throws(() => windowsToolEnvironment({ SystemRoot: 'C:\\Windows;C:\\x' }), /SystemRoot/);
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK_HOST, resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const refusedWith = (code: string) => (error: unknown) => (error as { code?: string }).code === code;

test('a real loopback-scram cluster admits exactly its two roles with their own SCRAM passwords and nothing else', { timeout: 180_000 }, async (t) => {
  // The host's own build: darwin and linux natively, windows-x64 natively or under x64 emulation on ARM64.
  const build = postgresBuild();
  const binaries = await resolveBinaries(undefined, build);
  const root = await mkdtemp(join(tmpdir(), 'hub-loopback-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const db = join(root, 'db');
  const run = join(root, 'run');
  const logs = join(root, 'logs');
  await mkdir(run, { mode: 0o700 });
  await mkdir(join(logs, 'postgres'), { recursive: true, mode: 0o700 });
  const env = hostToolEnvironment();
  const [admin, role, database] = ['hub_owner', 'circle_hub', 'circle_hub_loopback'];
  const adminPassword = databasePassword(randomBytes(32));
  const applicationPassword = databasePassword(randomBytes(32));
  const passwordFile = join(run, 'initdb-password');
  await writeFile(passwordFile, `${adminPassword}\n`, { mode: 0o600, flag: 'wx' });
  let initdb;
  try {
    initdb = await runCommand(binaries.initdb, loopbackInitdbArguments(db, admin, passwordFile), { env, timeoutMs: 300_000 });
  } finally {
    await rm(passwordFile, { force: true });
  }
  assert.equal(initdb.code, 0, initdb.stderr || initdb.stdout);
  assert.doesNotMatch(initdb.stdout + initdb.stderr, new RegExp(adminPassword));
  await appendFile(join(db, 'postgresql.conf'), "\n# circle-hub managed settings\ninclude 'circle-hub.conf'\n");
  const port = await freePort();
  await writeFile(join(db, 'circle-hub.conf'), loopbackConf(join(logs, 'postgres'), port), { mode: 0o600 });
  await writeFile(join(db, 'pg_hba.conf'), loopbackHba(admin, role, database), { mode: 0o600 });
  const startLog = join(logs, 'postgres-start.log');
  const started = await runCommand(binaries.pg_ctl, ['start', '-D', db, '-l', startLog, '-w', '-t', '90', '-s'], { env, timeoutMs: 150_000 });
  assert.equal(started.code, 0, `${started.stderr}\n${await readFile(startLog, 'utf8').catch(() => '')}`);
  t.after(async () => {
    await runCommand(binaries.pg_ctl, ['stop', '-D', db, '-m', 'fast', '-w', '-t', '90', '-s'], { env, timeoutMs: 150_000 });
  });
  const owner = loopbackConnector({ port, user: admin, password: async () => adminPassword });
  const otherPassword = databasePassword(randomBytes(32));
  await withSession(owner, 'postgres', async (session) => {
    await assertClusterDirectory(session, db);
    await assert.rejects(assertClusterDirectory(session, join(root, 'another-db')), /不是这个数据根的集群/);
    const setting = async (name: string) => String((await session.query(`SHOW ${name}`))[0]![name]);
    assert.equal(await setting('listen_addresses'), LOOPBACK_HOST);
    assert.equal(await setting('unix_socket_directories'), '');
    assert.equal(await setting('password_encryption'), 'scram-sha-256');
    assert.equal(await setting('log_directory'), join(logs, 'postgres'));
    // The server's own verifier for a synthetic password equals ours for its salt and iterations.
    const probe = databasePassword(randomBytes(32));
    await session.query(`CREATE ROLE hub_probe LOGIN PASSWORD '${probe}'`);
    const [stored] = await session.query("SELECT rolpassword FROM pg_catalog.pg_authid WHERE rolname = 'hub_probe'");
    const match = /^SCRAM-SHA-256\$(\d+):([^$]+)\$/.exec(String(stored!.rolpassword));
    assert.ok(match, 'the server stores a SCRAM verifier');
    assert.equal(scramVerifier(probe, Buffer.from(match[2]!, 'base64'), Number(match[1])), stored!.rolpassword);
    await session.query('DROP ROLE hub_probe');
    // The application role is created from a verifier: the server stores it unchanged and never sees the plaintext.
    const verifier = scramVerifier(applicationPassword);
    await session.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${verifier}'`);
    const [application] = await session.query('SELECT rolpassword FROM pg_catalog.pg_authid WHERE rolname = $1', [role]);
    assert.equal(application!.rolpassword, verifier);
    await session.query(`CREATE DATABASE ${database}`);
    await session.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
    await session.query(`GRANT CONNECT ON DATABASE ${database} TO ${role}`);
    await session.query(`CREATE ROLE hub_intruder LOGIN PASSWORD '${scramVerifier(otherPassword)}'`);
  });
  const as = (user: string, password: string) => loopbackConnector({ port, user, password: async () => password });
  await withSession(as(role, applicationPassword), database, async (session) => {
    assert.equal((await session.query('SELECT current_user AS who'))[0]!.who, role);
  });
  // Refused: a wrong password (28P01), the application role on another database and any other role (pg_hba, 28000).
  await assert.rejects(withSession(as(role, otherPassword), database, async () => {}), refusedWith('28P01'));
  await assert.rejects(withSession(as(admin, otherPassword), 'postgres', async () => {}), refusedWith('28P01'));
  await assert.rejects(withSession(as(role, applicationPassword), 'postgres', async () => {}), refusedWith('28000'));
  await assert.rejects(withSession(as('hub_intruder', otherPassword), database, async () => {}), refusedWith('28000'));
  // A password that is not a key-store password is refused before anything is sent.
  await assert.rejects(withSession(as(role, 'not-a-key-store-password'), database, async () => {}), /口令格式不对/);
  // No Unix socket: unix_socket_directories is empty (above), and the run directory stays empty once initdb's file is gone.
  assert.deepEqual(await readdir(run), []);
});
