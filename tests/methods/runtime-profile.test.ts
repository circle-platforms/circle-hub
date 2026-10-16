import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, mkdir, writeFile, readFile, rm, stat, chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {attachDevelopmentRuntime} from '../../scripts/runtime-profile.ts';

const script = fileURLToPath(new URL('../../scripts/runtime-profile.ts', import.meta.url));

async function fakeCircle(root: string, version = '1.7.0'): Promise<{bin: string; commit: string}> {
  await mkdir(join(root, 'dist'), {recursive: true});
  const bin = join(root, 'dist', 'cli.js');
  await writeFile(bin, `process.stdout.write(${JSON.stringify(version + '\n')});\n`);
  await chmod(bin, 0o755);
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', root, '-c', 'user.email=synthetic@example.com', '-c', 'user.name=synthetic', ...args], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init');
  git('add', 'dist/cli.js');
  git('commit', '-m', 'Synthetic runtime');
  const commit = git('rev-parse', 'HEAD');
  return {bin, commit};
}

function runProfile(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): {status: number | null; stdout: string; stderr: string} {
  const result = spawnSync(process.execPath, [script, ...args], {cwd, encoding: 'utf8', env: {...process.env, ...env}});
  return {status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '')};
}

test('runtime:profile writes a mode 0600 development file outside the repository and does not print the key', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hub-runtime-profile-'));
  const outside = await mkdtemp(join(tmpdir(), 'hub-runtime-profile-out-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  t.after(() => rm(outside, {recursive: true, force: true}));
  const {bin, commit} = await fakeCircle(root);
  const out = join(outside, 'runtime.json');
  const result = runProfile(['--out', out, '--circle-bin', bin, '--circle-commit', commit, '--model-url', 'http://127.0.0.1:9/v1'], root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /A model API key was generated/);
  assert.match(result.stdout, /CIRCLE_RUNTIME_CONFIG=/);
  assert.ok(!result.stdout.includes('api_key'));
  const profile = JSON.parse(await readFile(out, 'utf8')) as {circleBin: string; circleCommit: string; circleVersion: string; model: {api_key: string; base_url: string; kind: string; protocol: string; model: string}};
  assert.equal(profile.circleCommit, commit);
  assert.equal(profile.circleVersion, '1.7.0');
  assert.equal(profile.model.kind, 'scripted');
  assert.equal(profile.model.protocol, 'openai');
  assert.equal(profile.model.model, 'scripted-fixture');
  assert.equal(profile.model.base_url, 'http://127.0.0.1:9/v1');
  assert.equal(profile.model.api_key.length, 64);
  assert.ok(!result.stdout.includes(profile.model.api_key));
  assert.ok(!result.stderr.includes(profile.model.api_key));
  assert.equal((await stat(out)).mode & 0o777, 0o600);
});

test('runtime:profile rejects a commit mismatch, an in-repository output, and missing arguments', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hub-runtime-profile-'));
  const outside = await mkdtemp(join(tmpdir(), 'hub-runtime-profile-out-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  t.after(() => rm(outside, {recursive: true, force: true}));
  const {bin, commit} = await fakeCircle(root);
  const mismatch = runProfile(['--out', join(outside, 'runtime.json'), '--circle-bin', bin, '--circle-commit', 'a'.repeat(40), '--model-url', 'http://127.0.0.1:9/v1'], root);
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /checkout HEAD does not match circleCommit/);
  const inside = runProfile(['--out', join(root, 'runtime.json'), '--circle-bin', bin, '--circle-commit', commit, '--model-url', 'http://127.0.0.1:9/v1'], root);
  assert.notEqual(inside.status, 0);
  assert.match(inside.stderr, /Set --out to a file outside the repository/);
  const missing = runProfile([], root);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /runtime-profile.development.example.json/);
});

test('dev:stack attaches a runtime profile only from explicit development inputs', async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'hub-runtime-attach-'));
  t.after(() => rm(scratch, {recursive: true, force: true}));
  const absent = await attachDevelopmentRuntime(scratch, {});
  assert.equal(absent.configured, false);
  assert.match(absent.notice ?? '', /npm run runtime:profile/);
  const preset = await attachDevelopmentRuntime(scratch, {CIRCLE_RUNTIME_CONFIG: 'already-set'});
  assert.equal(preset.configured, true);
  assert.equal(preset.notice, undefined);
  const root = await mkdtemp(join(tmpdir(), 'hub-runtime-attach-repo-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const {bin, commit} = await fakeCircle(root);
  const env: NodeJS.ProcessEnv = {CIRCLE_BIN: bin, CIRCLE_COMMIT: commit, CIRCLE_HUB_DEV_MODEL_URL: 'http://127.0.0.1:9/v1'};
  const attached = await attachDevelopmentRuntime(scratch, env);
  assert.equal(attached.configured, true);
  assert.equal(env.CIRCLE_RUNTIME_CONFIG, join(scratch, 'runtime.json'));
  assert.ok(!attached.notice?.includes(bin));
  const emptyBin = await attachDevelopmentRuntime(scratch, {CIRCLE_BIN: '', CIRCLE_COMMIT: commit, CIRCLE_HUB_DEV_MODEL_URL: 'http://127.0.0.1:9/v1', CIRCLE_RUNTIME_CONFIG: ''});
  assert.equal(emptyBin.configured, false);
});
