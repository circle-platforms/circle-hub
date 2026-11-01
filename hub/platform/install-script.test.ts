// install.sh (decision 76) without touching the machine: its syntax under bash, and --dry-run plans for macOS and Linux
// on both architectures, which say every step and change nothing; refusals for other systems and architectures and for
// contradictory options. The real installation runs in .github/workflows/release.yml on a fresh runner. The helpers of
// tools/build-bundle.ts are checked here too.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { access, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUNDLED_NODE, hydratePostgresLinks, nodeTarball, npmTarget, shasumOf } from '../../tools/build-bundle.ts';

const SCRIPT = fileURLToPath(new URL('../../install.sh', import.meta.url));

/** Execute the installer's actual settings-to-bootstrap flow with a synthetic CLI, without machine setup or services. */
async function administratorFixture(t: TestContext) {
  const dir=await mkdtemp(join(tmpdir(),'circle-hub-install-admin-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const source=await readFile(SCRIPT,'utf8');
  const functions=source.split('# BEGIN administrator bootstrap\n')[1]?.split('# END administrator bootstrap')[0];
  assert.ok(functions,'the isolated bootstrap functions exist');
  const start=source.indexOf('\nSETTINGS="${DATA}/config/platform.json"'),end=source.indexOf('\nsay "安装命令 circle-hub');
  assert.ok(start>0&&end>start);const main=source.slice(start,end);
  const cli=join(dir,'synthetic-cli.mjs'), calls=join(dir,'calls.jsonl');
  await mkdir(join(dir,'config'));await writeFile(join(dir,'config','platform.json'),'{}');
  await mkdir(join(dir,'current'));await writeFile(join(dir,'current','release.json'),'{}');
  await writeFile(join(dir,'users.json'),'[]');
  await writeFile(cli,`import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
const root=process.env.CIRCLE_HUB_DATA_DIR, args=process.argv.slice(2);
if((args[0]==='key'||args[0]==='tls')&&args[1]==='status')process.exit(0);
if(args.join(' ')==='user list --json'){
  if(process.env.SYNTHETIC_QUERY_ERROR==='1')process.exit(1);
  process.stdout.write(process.env.SYNTHETIC_BAD_LIST==='1'?'invalid':readFileSync(join(root,'users.json'),'utf8'));
}else if(args[0]==='init-admin'&&args[2]==='--password-stdin'){
  const input=readFileSync(0,'utf8');appendFileSync(join(root,'calls.jsonl'),JSON.stringify({args,input})+'\\n');
  if(process.env.SYNTHETIC_INIT_ERROR==='1')process.exit(1);
  writeFileSync(join(root,'users.json'),JSON.stringify([{name:args[1],role:'admin'}]));
  console.log('管理员已创建');
}else process.exit(2);
`);
  return {dir,calls,run:(options:{name?:string;stdin?:boolean;input?:string;interactive?:boolean;env?:NodeJS.ProcessEnv;after?:string}={})=>{
    const script=`set -euo pipefail\n${functions}
say() { printf '%s\\n' "$*"; }
fail() { printf '错误：%s\\n' "$*" >&2; exit 1; }
as_hub() { "$@"; }
hub() { as_hub "$NODE" "$SETUP_HUB" "$@"; }
run_as_hub() { as_hub "$@"; }
commit_in() { printf 'synthetic-current'; }
installer_has_terminal() { return ${options.interactive?0:1}; }
${options.interactive?'installer_prompt_admin() { HUB_INSTALL_ADMIN_NAME="synthetic-prompt-admin"; HUB_INSTALL_ADMIN_PASSWORD="synthetic-prompt-password"; }':''}
${main}
${options.after??''}`;
    const result=spawnSync('bash',['-c',script],{encoding:'utf8',timeout:10_000,input:options.input??'',env:{
      PATH:process.env.PATH,DATA:dir,BUNDLE:dir,NODE:process.execPath,SETUP_HUB:cli,DRY_RUN:'0',HUB_INSTALL_ADMIN_NAME:options.name??'',
      HUB_INSTALL_PASSWORD_STDIN:options.stdin?'1':'0',...options.env}});
    return {code:result.status??-1,out:result.stdout,err:result.stderr};
  }};
}

test('administrator bootstrap retries after init-admin failed with settings already present and leaves existing accounts alone',async t=>{
  const f=await administratorFixture(t), password='synthetic-installer-password';
  const failed=f.run({name:'synthetic-admin',stdin:true,input:password+'\n',env:{SYNTHETIC_INIT_ERROR:'1'}});
  assert.equal(failed.code,1);assert.match(failed.err,/管理员初始化未完成.*circle-hub init-admin.*circle-hub setup-code/);
  await access(join(f.dir,'config','platform.json'));
  const retry=f.run({interactive:true});assert.equal(retry.code,0,retry.err);
  const calls=(await readFile(f.calls,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(calls.length,2);assert.deepEqual(calls[1],{args:['init-admin','synthetic-prompt-admin','--password-stdin'],input:'synthetic-prompt-password\n'});
  assert.ok(!JSON.stringify(calls[0].args).includes(password));assert.ok(!failed.out.includes(password));
  const existing=f.run({stdin:true,input:'synthetic-unused-password\n',after:'IFS= read -r remaining; printf "stdin-left=%s\\n" "$remaining"'});
  assert.equal(existing.code,0,existing.err);assert.match(existing.out,/stdin-left=synthetic-unused-password\n$/);
  assert.ok(!existing.out.includes('管理员已创建'));
  assert.equal((await readFile(f.calls,'utf8')).trim().split('\n').length,2,'an existing administrator is never reinitialized');
});

test('administrator bootstrap without a terminal names both recovery commands and supports an explicit username',async t=>{
  const f=await administratorFixture(t);
  const refused=f.run();assert.equal(refused.code,1);assert.match(refused.err,/没有终端.*--admin-user.*circle-hub init-admin.*circle-hub setup-code/);
  await assert.rejects(access(f.calls));
  const explicit=f.run({name:'synthetic-admin'});assert.equal(explicit.code,0,explicit.err);
  assert.deepEqual(JSON.parse((await readFile(f.calls,'utf8')).trim()),{args:['init-admin','synthetic-admin','--password-stdin'],input:'\n'});
});

test('administrator bootstrap refuses unreadable account listings instead of assuming there is no administrator',async t=>{
  const f=await administratorFixture(t);
  for(const env of [{SYNTHETIC_QUERY_ERROR:'1'},{SYNTHETIC_BAD_LIST:'1'}]){
    const refused=f.run({name:'synthetic-admin',env});assert.equal(refused.code,1);assert.match(refused.err,/管理员账户|管理员账户列表/);
    await assert.rejects(access(f.calls));
  }
});

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

test('fresh installation plans username and password initialization without putting a password in argv', () => {
  const {code,out,err}=install(['--dry-run','--version','0.3.0','--admin-user','synthetic-admin','--password-stdin'],'Darwin');
  assert.equal(code,0,err);
  assert.match(out,/管理员用户名和可选密码/);
  assert.match(out,/标准输入.*init-admin --password-stdin/);
  assert.doesNotMatch(out,/设置码（24 小时内有效）/);
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
