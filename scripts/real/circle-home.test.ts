import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HUB_TOOLS, INTERNAL_TOOLS_ALLOWED, SERVER_NAME, TOKEN_SECRET, circleEndpoint, endpointFrom, main, parseArgs, writeHome } from './circle-home.ts';
import { parseEnvText } from './lib/env-file.ts';

// Invented content: section names follow the owner's file layout, every value is made up.
const ENV = [
  'SOME_ACTIVE_KEY = active-value-1',
  '# ---- GLM ----',
  '# ANTHROPIC_API_KEY = glm-secret-value-AAAA',
  '# ANTHROPIC_BASE_URL = https://glm.example/api/anthropic',
  '# ---- 千问 ----',
  '# ANTHROPIC_BASE_URL = https://qwen.example/anthropic',
  '# ANTHROPIC_API_KEY = qwen-secret-value-BBBB',
  '# ---- 选项 B：DashScope qwen ----',
  '# IST_MODEL = qwen-test-model',
  '# ---- OpenAI 兼容 ----',
  '# OPENAI_BASE_URL = https://openai-like.example/v1',
  '# OPENAI_API_KEY = openai-secret-value-CCCC',
].join('\n');

const scratch = () => mkdtempSync(join(tmpdir(), 'circle-home-test-'));
const entries = parseEnvText(ENV);

test('the provider section gives the Anthropic pair and the model from the matching section', () => {
  const qwen = endpointFrom(entries, 'qwen');
  assert.equal(qwen.protocol, 'anthropic');
  assert.equal(qwen.baseUrl, 'https://qwen.example/anthropic');
  assert.equal(qwen.apiKey, 'qwen-secret-value-BBBB');
  assert.equal(qwen.model, 'qwen-test-model');
  assert.ok(qwen.sources.every((s) => !s.includes('secret') && !s.includes('example')), 'sources name keys and lines only');
});

test('a provider without a model name needs --model', () => {
  assert.throws(() => endpointFrom(entries, 'glm'), /--model/);
  assert.equal(endpointFrom(entries, 'glm', 'glm-test').model, 'glm-test');
});

test('a section without a usable pair fails without echoing content', () => {
  assert.throws(() => endpointFrom(entries, 'qwen', 'm', 'no-such-section'), (e: Error) => /没有可用的地址和密钥对/.test(e.message) && !/secret/.test(e.message));
});

test('the OpenAI-compatible pair is used when a section has no Anthropic pair', () => {
  const e = endpointFrom(entries, 'qwen', 'm', 'OpenAI');
  assert.equal(e.protocol, 'openai');
  assert.equal(e.apiKey, 'openai-secret-value-CCCC');
});

test('writeHome writes private files, keeps the token out of settings and refuses to overwrite', () => {
  const dir = scratch();
  try {
    const endpoint = endpointFrom(entries, 'qwen');
    const home = join(dir, 'home');
    const written = writeHome({ envFile: '/x/owner-env-notes', home, provider: 'qwen', hubUrl: 'http://127.0.0.1:7420/mcp' }, endpoint, 'hub-token-value');
    for (const f of written.files) assert.equal(statSync(join(home, f)).mode & 0o777, 0o600, f);
    assert.equal(statSync(home).mode & 0o777, 0o700);
    assert.equal(statSync(written.workdir).mode & 0o777, 0o700);
    const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
    assert.deepEqual(settings.auth, { protocol: 'anthropic', base_url: 'https://qwen.example/anthropic', model: 'qwen-test-model', api_key_ref: 'api_key' });
    assert.deepEqual(settings.mcp_servers, [{ name: SERVER_NAME, url: 'http://127.0.0.1:7420/mcp', transport: 'streamable_http', headers: { Authorization: `Bearer \${secret:${TOKEN_SECRET}}` } }]);
    assert.deepEqual(settings.credential_files, ['owner-env-notes']);
    assert.deepEqual(settings.trusted_folders, [written.workdir]);
    const text = readFileSync(join(home, 'settings.json'), 'utf8');
    assert.ok(!text.includes('hub-token-value') && !text.includes('qwen-secret-value-BBBB'), 'settings.json holds neither the token nor the key');
    assert.equal(JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8')).api_key, 'qwen-secret-value-BBBB');
    assert.equal(JSON.parse(readFileSync(join(home, 'secrets.json'), 'utf8')).secrets[TOKEN_SECRET], 'hub-token-value');
    assert.throws(() => writeHome({ envFile: 'f', home, provider: 'qwen', hubUrl: 'http://127.0.0.1:7420/mcp' }, endpoint, 't'), /不覆盖/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the hook allows exactly the six Hub tools and the todo list and denies everything else, including unreadable input', () => {
  const dir = scratch();
  try {
    const endpoint = endpointFrom(entries, 'qwen');
    writeHome({ envFile: 'f', home: join(dir, 'home'), provider: 'qwen', hubUrl: 'http://127.0.0.1:7420/mcp' }, endpoint, 't');
    const hook = join(dir, 'home', 'hooks', 'hub-only.mjs');
    const decide = (stdin: string) => {
      const r = spawnSync(process.execPath, [hook], { input: stdin, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout).decision;
    };
    for (const t of HUB_TOOLS) assert.equal(decide(JSON.stringify({ event: 'before_tool', tool_name: `${SERVER_NAME}_${t}` })), 'allow', t);
    for (const t of INTERNAL_TOOLS_ALLOWED) assert.equal(decide(JSON.stringify({ event: 'before_tool', tool_name: t })), 'allow', t);
    for (const t of ['bash', 'webfetch', 'websearch', 'write_file', 'read_file', `${SERVER_NAME}_other`, `hubx_start_run`]) {
      assert.equal(decide(JSON.stringify({ event: 'before_tool', tool_name: t })), 'deny', t);
    }
    assert.equal(decide('not json'), 'deny');
    assert.equal(decide(''), 'deny');
    const hooks = JSON.parse(readFileSync(join(dir, 'home', 'hooks.json'), 'utf8'));
    assert.equal(hooks.hooks.before_tool.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('main prints names, lengths and nothing secret, and needs the token in the environment', () => {
  const dir = scratch();
  try {
    const envFile = join(dir, 'owner-env-notes');
    writeFileSync(envFile, ENV);
    const lines: string[] = [];
    const args = ['--env-file', envFile, '--home', join(dir, 'home'), '--provider', 'qwen'];
    assert.equal(main(args, {}, (l) => lines.push(l)), 1);
    assert.match(lines.join('\n'), /HUB_REAL_TOKEN/);
    lines.length = 0;
    assert.equal(main(args, { HUB_REAL_TOKEN: 'hub-token-value' }, (l) => lines.push(l)), 0);
    const shown = lines.join('\n');
    assert.match(shown, /qwen-test-model/);
    assert.match(shown, /密钥长度 \d+/);
    for (const secret of ['qwen-secret-value-BBBB', 'hub-token-value', 'qwen.example']) assert.ok(!shown.includes(secret), `the screen must not show ${secret}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('argument errors name the problem and never a value', () => {
  assert.throws(() => parseArgs(['--provider', 'other', '--env-file', 'a', '--home', 'b']), /glm 或 qwen/);
  assert.throws(() => parseArgs(['--provider', 'qwen', '--home', 'b']), /--env-file/);
  assert.throws(() => parseArgs(['bad']), /参数不对/);
});

// circleEndpoint: the endpoint of a Circle data directory (fake settings.json and credentials.json in a temp dir; the real
// ~/.circle is never read by a test). Invented content: the address is in example.invalid, the key is made up.
const CIRCLE_KEY = 'fake-circle-key-1234';
const CIRCLE_SETTINGS = { version: 1, auth: { protocol: 'anthropic', base_url: 'https://glm.example.invalid/api', model: 'glm-fake-model', api_key_ref: 'api_key' } };

function fakeCircleDir(dir: string, settings: unknown = CIRCLE_SETTINGS, credentials: unknown = { api_key: CIRCLE_KEY }, mode = 0o600): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.json'), `${JSON.stringify(settings)}\n`);
  writeFileSync(join(dir, 'credentials.json'), `${JSON.stringify(credentials)}\n`);
  chmodSync(join(dir, 'credentials.json'), mode);
  return dir;
}

const throwsWithout = (block: () => unknown, pattern: RegExp): void => {
  try {
    block();
  } catch (error) {
    const message = (error as Error).message;
    assert.match(message, pattern);
    assert.ok(!message.includes(CIRCLE_KEY), 'the error must not carry the key');
    return;
  }
  assert.fail(`expected an error matching ${pattern}`);
};

test('circleEndpoint reads settings auth and the referenced key, and says only file and key names', () => {
  const dir = scratch();
  try {
    fakeCircleDir(dir);
    const endpoint = circleEndpoint(dir);
    assert.equal(endpoint.protocol, 'anthropic');
    assert.equal(endpoint.baseUrl, 'https://glm.example.invalid/api');
    assert.equal(endpoint.model, 'glm-fake-model');
    assert.equal(endpoint.apiKey, CIRCLE_KEY);
    assert.ok(endpoint.sources.length >= 2 && endpoint.sources.every((s) => /settings\.json|credentials\.json/.test(s) && !s.includes(CIRCLE_KEY) && !s.includes('example.invalid')), 'sources name files and keys only');
    assert.equal(circleEndpoint(dir, { model: 'other-model' }).model, 'other-model');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('circleEndpoint fails on a missing file, a missing field or an unreadable shape, naming only file and key names', () => {
  const dir = scratch();
  try {
    mkdirSync(dir, { recursive: true });
    throwsWithout(() => circleEndpoint(dir), /settings\.json/);
    throwsWithout(() => circleEndpoint(fakeCircleDir(join(dir, 'a'), { version: 1 })), /auth/);
    throwsWithout(() => circleEndpoint(fakeCircleDir(join(dir, 'b'), { ...CIRCLE_SETTINGS, auth: { ...CIRCLE_SETTINGS.auth, protocol: 'wechat' } })), /protocol/);
    throwsWithout(() => circleEndpoint(fakeCircleDir(join(dir, 'c'), { ...CIRCLE_SETTINGS, auth: { ...CIRCLE_SETTINGS.auth, base_url: 'not a url' } })), /base_url/);
    throwsWithout(() => circleEndpoint(fakeCircleDir(join(dir, 'd'), { ...CIRCLE_SETTINGS, auth: { protocol: 'anthropic', base_url: CIRCLE_SETTINGS.auth.base_url, api_key_ref: 'api_key' } })), /model|模型/);
    throwsWithout(() => circleEndpoint(fakeCircleDir(join(dir, 'e'), { ...CIRCLE_SETTINGS, auth: { ...CIRCLE_SETTINGS.auth, api_key_ref: 'vault:main' } })), /api_key_ref/);
    throwsWithout(() => circleEndpoint(fakeCircleDir(join(dir, 'f'), undefined, { token: CIRCLE_KEY })), /api_key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('circleEndpoint warns when the credentials file is looser than 0600 and reads it anyway', () => {
  const dir = scratch();
  try {
    const lines: string[] = [];
    const endpoint = circleEndpoint(fakeCircleDir(join(dir, 'open'), undefined, undefined, 0o644), { warn: (l) => lines.push(l) });
    assert.equal(endpoint.apiKey, CIRCLE_KEY);
    assert.ok(lines.some((l) => /0600/.test(l)), 'a looser mode is warned about');
    lines.length = 0;
    circleEndpoint(fakeCircleDir(join(dir, 'tight')), { warn: (l) => lines.push(l) });
    assert.equal(lines.length, 0, 'a 0600 file is not warned about');
    for (const line of lines) assert.ok(!line.includes(CIRCLE_KEY));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeHome names the environment file as a protected file only when there is one', () => {
  const dir = scratch();
  try {
    const endpoint = endpointFrom(entries, 'qwen');
    const home = join(dir, 'home');
    writeHome({ home, hubUrl: 'http://127.0.0.1:7420/mcp' }, endpoint, 't');
    const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
    assert.ok(!('credential_files' in settings), 'no environment file means no protected file entry');
    assert.equal(settings.auth.model, 'qwen-test-model');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
