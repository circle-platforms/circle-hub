// The endpoint source of review-circle.ts: the owner's environment file (--env-file --provider --section) or the owner's
// Circle configuration (--endpoint-from circle --circle-dir), never both. Tests use fake files in temp dirs; the real
// ~/.circle is never read, and no real review is started. Invented content only (example.invalid, made-up keys).
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { endpointFrom } from './circle-home.ts';
import { endpointLine, endpointSource } from './review-circle.ts';
import { parseEnvText } from './lib/env-file.ts';

const ENV = [
  'SOME_ACTIVE_KEY = active-value-1',
  '# ---- 千问 ----',
  '# ANTHROPIC_BASE_URL = https://qwen.example/anthropic',
  '# ANTHROPIC_API_KEY = qwen-secret-value-BBBB',
  '# ---- 选项 B：DashScope qwen ----',
  '# IST_MODEL = qwen-test-model',
].join('\n');

const CIRCLE_KEY = 'fake-circle-key-1234';
const circleDir = (dir: string): string => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.json'), `${JSON.stringify({ version: 1, auth: { protocol: 'openai', base_url: 'https://glm.example.invalid/v1', model: 'glm-fake-model', api_key_ref: 'api_key' } })}\n`);
  writeFileSync(join(dir, 'credentials.json'), `${JSON.stringify({ api_key: CIRCLE_KEY })}\n`);
  chmodSync(join(dir, 'credentials.json'), 0o600);
  return dir;
};

const scratch = () => mkdtempSync(join(tmpdir(), 'review-circle-test-'));

test('--endpoint-from circle takes the endpoint from the Circle directory', () => {
  const dir = scratch();
  try {
    const lines: string[] = [];
    const source = endpointSource(['--endpoint-from', 'circle', '--circle-dir', circleDir(join(dir, 'conf'))], {}, (l) => lines.push(l));
    assert.equal(source.endpoint.protocol, 'openai');
    assert.equal(source.endpoint.model, 'glm-fake-model');
    assert.equal(source.endpoint.apiKey, CIRCLE_KEY);
    assert.equal(source.envFile, undefined);
    assert.equal(lines.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--circle-dir defaults to .circle under the home of the environment', () => {
  const dir = scratch();
  try {
    circleDir(join(dir, 'home', '.circle'));
    const source = endpointSource(['--endpoint-from', 'circle'], { HOME: join(dir, 'home') });
    assert.equal(source.endpoint.model, 'glm-fake-model');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the circle source and the environment-file source are mutually exclusive', () => {
  const dir = scratch();
  try {
    const envFile = join(dir, 'env');
    writeFileSync(envFile, ENV);
    const circle = ['--endpoint-from', 'circle', '--circle-dir', circleDir(join(dir, 'conf'))];
    assert.throws(() => endpointSource([...circle, '--env-file', envFile], {}), /二选一/);
    assert.throws(() => endpointSource([...circle, '--provider', 'glm'], {}), /二选一/);
    assert.throws(() => endpointSource([...circle, '--section', 'GLM'], {}), /二选一/);
    assert.throws(() => endpointSource(['--endpoint-from', 'wechat', '--circle-dir', join(dir, 'conf')], {}), /--endpoint-from/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the environment-file source is unchanged: provider and model required, section passed through', () => {
  const dir = scratch();
  try {
    const envFile = join(dir, 'env');
    writeFileSync(envFile, ENV);
    const source = endpointSource(['--env-file', envFile, '--provider', 'qwen', '--model', 'qwen-test-model'], {});
    assert.deepEqual(
      { protocol: source.endpoint.protocol, baseUrl: source.endpoint.baseUrl, apiKey: source.endpoint.apiKey, model: source.endpoint.model },
      { protocol: endpointFrom(parseEnvText(ENV), 'qwen', 'qwen-test-model').protocol, baseUrl: 'https://qwen.example/anthropic', apiKey: 'qwen-secret-value-BBBB', model: 'qwen-test-model' },
    );
    assert.equal(source.envFile, envFile);
    assert.equal(source.provider, 'qwen');
    assert.throws(() => endpointSource(['--env-file', envFile, '--model', 'm'], {}), /--provider/);
    assert.throws(() => endpointSource(['--env-file', envFile, '--provider', 'qwen'], {}), /--model/);
    assert.throws(() => endpointSource(['--provider', 'qwen', '--model', 'm'], {}), /--env-file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the screen line shows the protocol, the host, the model and the key length, and nothing else', () => {
  const line = endpointLine({ protocol: 'anthropic', baseUrl: 'https://glm.example.invalid/api/anthropic', model: 'glm-fake-model', apiKey: CIRCLE_KEY, sources: [] });
  assert.match(line, /anthropic/);
  assert.match(line, /glm\.example\.invalid/);
  assert.match(line, /glm-fake-model/);
  assert.match(line, /密钥长度 20/);
  assert.ok(!line.includes(CIRCLE_KEY), 'the key never reaches the screen');
  assert.ok(!line.includes('/api/anthropic'), 'only the host of the address is shown, not its path');
});
