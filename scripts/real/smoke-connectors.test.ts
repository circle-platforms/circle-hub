import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, appendFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { test } from 'node:test';
import { responseStrings, runSmoke, type SmokeCommand } from './smoke-connectors.ts';

const text = 'Synthetic confidential response "quoted"\nsecond line';
const key = 'synthetic-request-key';
const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
test('extracts JSON values and HTML text, excluding digests, short values and request-key echoes', () => {
  assert.deepEqual(responseStrings(JSON.stringify({ title: text, nested: ['short', 'd'.repeat(64), key] }), key), [text]);
  assert.deepEqual(responseStrings('<h1>Synthetic confidential title</h1>\n<p>Another synthetic paragraph</p>', key), ['Synthetic confidential title', 'Another synthetic paragraph']);
});

async function scenario(mode: 'clean' | 'command' | 'escaped' | 'service' | 'failure' | 'export' | 'rotate' | 'corrupt', html = false) {
  const dir = await mkdtemp(join(tmpdir(), 'smoke-synthetic-')); const logs = join(dir, 'logs'); await mkdir(logs);
  const outLog = join(logs, 'hub.out.log'); const errLog = join(logs, 'hub.err.log');
  await writeFile(outLog, `${text}\n`); await writeFile(errLog, ''); // Old content is outside this smoke window.
  const bytes = html ? `<h1>${text}</h1><p>${key}</p>` : JSON.stringify({ title: text, request: key }); const sha = digest(bytes);
  const printed: string[] = []; const exported: string[] = [];
  const run: SmokeCommand = async (args) => {
    if (args[0] === 'resource') {
      assert.deepEqual(args, ['resource', 'read', 'res_synthetic', 'document', key]);
      if (mode === 'service') await appendFile(errLog, JSON.stringify({ message: text }));
      if (mode === 'rotate') await writeFile(outLog, '');
      if (mode === 'failure') return { code: 1, stdout: `demo-system@1.0.0/document：失败（SOURCE_UNAVAILABLE）\n读清单 ${'a'.repeat(64)}\n`, stderr: text };
      return { code: 0, stdout: `demo-system@1.0.0/document：读取完成\n产物 original ${sha} ${Buffer.byteLength(bytes)} 字节\n读清单 ${'a'.repeat(64)}\n`, stderr: mode === 'command' ? text : mode === 'escaped' ? JSON.stringify(text) : key };
    }
    assert.equal(args[0], 'original'); assert.equal(args[1], 'export');
    const target = args[args.indexOf('--out') + 1]; exported.push(target);
    assert.equal((await stat(dirname(target))).mode & 0o777, 0o700);
    if (mode === 'export') return { code: 1, stdout: '', stderr: text };
    await writeFile(target, mode === 'corrupt' ? `${bytes}extra` : bytes, { mode: 0o600 }); return { code: 0, stdout: '', stderr: '' };
  };
  try {
    const results = await runSmoke({ logs, reads: [`res_synthetic:document:${key}`], run, print: (line) => printed.push(line) });
    for (const target of exported) await assert.rejects(access(target));
    const output = printed.join('\n'); assert.ok(!output.includes(text)); assert.ok(!output.includes(key)); assert.ok(!output.includes(JSON.stringify(text)));
    assert.equal(printed.length, 1); assert.match(output, /demo-system@1\.0\.0\/document/);
    return results[0];
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('clean output passes, preexisting log content and key echoes do not count', async () => {
  const html = await scenario('clean', true); assert.equal(html.ok, true);
  const result = await scenario('clean'); assert.equal(result.ok, true); assert.equal(result.hits.command, 0); assert.equal(result.hits.service, 0); assert.equal(result.artifacts, 1);
});
test('raw and JSON-escaped command leaks and new service-log leaks fail without printing matches', async () => {
  for (const mode of ['command', 'escaped', 'service'] as const) for (const html of [false, true]) {
    const result = await scenario(mode, html); assert.equal(result.ok, false); assert.ok(result.hits.command + result.hits.service > 0);
  }
});
test('read failure, export failure and rotated logs are failures, never an empty successful check', async () => {
  for (const mode of ['failure', 'export', 'rotate', 'corrupt'] as const) assert.equal((await scenario(mode)).ok, false);
});
