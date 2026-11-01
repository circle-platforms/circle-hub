// The installer's real unpack-to-deploy shell flow, with real tarballs and synthetic CLI/service effects in a scratch root.
// No package installation, PostgreSQL, credentials, launchd or systemd is involved.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readlink, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

const OLD = 'a'.repeat(40), NEXT = 'b'.repeat(40);
const NAME = 'circle-hub-0.2.0-darwin-arm64';

async function upgradeFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'circle-hub-install-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'data'), runtime = join(data, 'runtime'), work = join(root, 'work');
  const oldBundle = join(runtime, 'bundles', NAME), oldRelease = join(data, 'releases', OLD.slice(0, 12));
  const events = join(root, 'events.jsonl');
  await mkdir(join(data, 'config'), { recursive: true });
  await writeFile(join(data, 'config', 'platform.json'), '{}');
  await mkdir(join(oldRelease, 'bin'), { recursive: true });
  await writeFile(join(oldRelease, 'release.json'), JSON.stringify({ commit: OLD }));
  await writeFile(join(oldRelease, 'bin', 'circle-hub'), 'console.log("previous-release-running");\n');
  await symlink('releases/' + OLD.slice(0, 12), join(data, 'current'));
  const cli = `import {readFileSync,writeFileSync,appendFileSync,mkdirSync,readlinkSync,unlinkSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2), data=process.env.CIRCLE_HUB_DATA_DIR;
if((args[0]==='key'||args[0]==='tls')&&args[1]==='status')process.exit(0);
if(args[0]!=='deploy')process.exit(2);
const bundle=args[args.indexOf('--bundle')+1], node=args[args.indexOf('--node')+1];
const commit=JSON.parse(readFileSync(join(bundle,'bundle.json'),'utf8')).commit;
const before={runtimeNode:readlinkSync(join(data,'runtime','node')),current:readlinkSync(join(data,'current'))};
const release=join(data,'releases',commit.slice(0,12));mkdirSync(join(release,'bin'),{recursive:true});
writeFileSync(join(release,'release.json'),JSON.stringify({commit}));
writeFileSync(join(release,'bin','circle-hub'),'console.log("next-release-running");');
unlinkSync(join(data,'current'));symlinkSync('releases/'+commit.slice(0,12),join(data,'current'));
const failed=process.env.SYNTHETIC_DEPLOY_FAIL==='1';
if(failed){unlinkSync(join(data,'current'));symlinkSync(before.current,join(data,'current'));}
// Match the deployment host: recovery starts the previous release with the Node path passed to deploy.
const started=spawnSync(node,[join(data,'current','bin','circle-hub')],{encoding:'utf8',env:process.env});
appendFileSync(process.env.SYNTHETIC_EVENTS,JSON.stringify({commit,node,bundle,before,started:started.status,output:started.stdout})+'\\n');
process.exit(failed?17:(started.status??1));
`;
  const bundle = async (dir: string, commit: string) => {
    await mkdir(join(dir, 'app', 'bin'), { recursive: true });
    await mkdir(join(dir, 'node', 'bin'), { recursive: true });
    await writeFile(join(dir, 'bundle.json'), JSON.stringify({ version: '0.2.0', commit }));
    await writeFile(join(dir, 'app', 'package.json'), '{"type":"module"}');
    await writeFile(join(dir, 'app', 'bin', 'circle-hub'), cli);
    await writeFile(join(dir, 'node', 'bin', 'node'), `#!/bin/sh\n# Synthetic runtime ${commit}\nexec "$SYNTHETIC_NODE" "$@"\n`, { mode: 0o755 });
  };
  await bundle(oldBundle, OLD);
  await symlink('bundles/' + NAME + '/node', join(runtime, 'node'));
  const source = join(root, 'source');
  await bundle(join(source, NAME), NEXT);
  await mkdir(work);
  const archive = spawnSync('tar', ['-c', '-z', '-f', join(work, NAME + '.tar.gz'), '-C', source, NAME], { encoding: 'utf8' });
  assert.equal(archive.status, 0, archive.stderr);
  const script = await readFile(new URL('../../install.sh', import.meta.url), 'utf8');
  const marker = script.indexOf('\n# BEGIN bundle staging');
  const start = marker < 0 ? script.indexOf('\nsay "解开发布包到') : marker;
  const end = script.indexOf('\nsay "安装命令 circle-hub');
  assert.ok(start > 0 && end > start);
  const cleanup = script.match(/^trap .+ EXIT$/m)?.[0]; assert.ok(cleanup);
  const run = (fail = false) => {
    const runWork = mkdtempSync(join(root, 'run-'));
    copyFileSync(join(work, NAME + '.tar.gz'), join(runWork, NAME + '.tar.gz'));
    return spawnSync('bash', ['-c', `set -euo pipefail
say() { printf '%s\\n' "$*"; }
fail() { printf '错误：%s\\n' "$*" >&2; exit 1; }
as_hub() { "$@"; }
run_as_hub() { "$@"; }
hub() { "$NODE" "$SETUP_HUB" "$@"; }
commit_in() { sed -n 's/.*"commit": *"\\([0-9a-f]*\\)".*/\\1/p' "$1" | head -n1; }
ensure_administrator() { :; }
HUB_INSTALL_UNPACK=""
${cleanup}
${script.slice(start, end)}`], {
    encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH, DATA: data, RUNTIME: runtime, BUNDLE: oldBundle, BUNDLE_DIR_NAME: NAME,
      NODE: join(runtime, 'node', 'bin', 'node'), SETUP_HUB: join(oldBundle, 'app', 'bin', 'circle-hub'),
      WORK: runWork, NAME: NAME + '.tar.gz', OS: 'darwin', DRY_RUN: '0', LIBPQ_BIN: '',
      CIRCLE_HUB_DATA_DIR: data, SYNTHETIC_NODE: process.execPath, SYNTHETIC_EVENTS: events, SYNTHETIC_DEPLOY_FAIL: fail ? '1' : '0' },
    });
  };
  const recorded = async () => readFile(events, 'utf8').then(text => text.trim().split('\n').map(line => JSON.parse(line)), () => []);
  return { data, runtime, oldBundle, oldRelease, run, recorded };
}

test('the installer deploys the same version with a different commit without changing the running runtime first', async t => {
  const f = await upgradeFixture(t), oldNode = await readFile(join(f.oldBundle, 'node', 'bin', 'node'), 'utf8');
  const installed = f.run(); assert.equal(installed.status, 0, installed.stderr);
  const events = await f.recorded(); assert.equal(events.length, 1, 'the new commit must reach deploy');
  const event = events[0]; assert.equal(event.commit, NEXT);
  assert.equal(event.before.runtimeNode, 'bundles/' + NAME + '/node');
  assert.equal(event.before.current, 'releases/' + OLD.slice(0, 12));
  assert.equal(event.bundle, join(f.runtime, 'bundles', NAME + '-' + NEXT));
  assert.equal(event.node, join(event.bundle, 'node', 'bin', 'node'));
  assert.equal(event.started, 0); assert.equal(event.output, 'next-release-running\n');
  assert.equal(await readFile(join(f.oldBundle, 'node', 'bin', 'node'), 'utf8'), oldNode);
  assert.equal(JSON.parse(await readFile(join(f.oldBundle, 'bundle.json'), 'utf8')).commit, OLD);
  assert.equal(await readlink(join(f.runtime, 'node')), 'bundles/' + NAME + '-' + NEXT + '/node');
  const repeated = f.run(); assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /这一版已经在运行，不重新部署/);
  assert.equal((await f.recorded()).length, 1, 'the same commit still skips deployment');
  assert.deepEqual((await readdir(join(f.runtime, 'bundles'))).sort(), [NAME, NAME + '-' + NEXT].sort());
});

test('a failed same-version deployment retains a working Node for recovery and leaves the legacy runtime link unchanged', async t => {
  const f = await upgradeFixture(t);
  const installed = f.run(true); assert.equal(installed.status, 17, installed.stderr);
  const events = await f.recorded(); assert.equal(events.length, 1);
  assert.equal(events[0].commit, NEXT); assert.equal(events[0].started, 0);
  assert.equal(events[0].output, 'previous-release-running\n');
  assert.equal(events[0].before.runtimeNode, 'bundles/' + NAME + '/node');
  assert.equal(await readlink(join(f.runtime, 'node')), 'bundles/' + NAME + '/node');
  assert.equal(await readlink(join(f.data, 'current')), 'releases/' + OLD.slice(0, 12));
  await access(events[0].node);
  assert.equal(JSON.parse(await readFile(join(f.oldRelease, 'release.json'), 'utf8')).commit, OLD);
  const restarted = spawnSync(join(f.runtime, 'node', 'bin', 'node'), [join(f.oldRelease, 'bin', 'circle-hub')], {
    encoding: 'utf8', env: { SYNTHETIC_NODE: process.execPath },
  });
  assert.equal(restarted.status, 0, restarted.stderr); assert.equal(restarted.stdout, 'previous-release-running\n');
  const retry = f.run(); assert.equal(retry.status, 0, retry.stderr);
  assert.equal((await f.recorded()).length, 2);
});
