// Host test setup stages only this adapter. The function itself stays inside the unmodified producer sandbox profile.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { DEFAULT_SANDBOX } from '../../../../../hub/knowledge/api.ts';
import { callPackFunction, osIsolationAvailable, SandboxError } from '../../../../../hub/rules/api.ts';
import type { AdocResult } from './types.ts';
import { ENGINE } from './input.ts';

const skip = (await osIsolationAvailable()) ? false : 'OS network isolation unavailable; the producer sandbox is not weakened';
let packDir: string;
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const group = (files: Record<string, string>, attributes = {}) => ({ main: 'book.adoc', revision: '42', attributes, files: Object.fromEntries(Object.entries(files).map(([file, text]) => [file, { text, revision: '42', sha256: hash(text) }])) });
before(async () => {
  packDir = await mkdtemp(join(tmpdir(), 'adoc-stage-'));
  await mkdir(join(packDir, 'adoc'));
  await cp(new URL('./', import.meta.url), join(packDir, 'adoc'), { recursive: true, filter: (source) => !source.endsWith('.test.ts') });
  await writeFile(join(packDir, 'clock.ts'), `export default async function(input: { clock: number; random: number; group: unknown }) {
    const RealDate = Date; globalThis.Date = class extends RealDate { constructor(...args: unknown[]) { super(args.length ? args[0] as string : input.clock); } static now() { return input.clock; } } as DateConstructor;
    Math.random = () => input.random; const { default: compile } = await import('./adoc/index.ts'); return compile(input.group);
  }`);
  await writeFile(join(packDir, 'metrics.ts'), `import compile from './adoc/index.ts'; export default async function(input: unknown) {
    const start = performance.now(); const result = await compile(input);
    const output_bytes = Buffer.byteLength(JSON.stringify(result));
    console.log(JSON.stringify({ output_bytes, elapsed_ms: performance.now() - start, peak_rss_kib: process.resourceUsage().maxRSS, heap_used: process.memoryUsage().heapUsed })); return result;
  }`);
  await writeFile(join(packDir, 'denied.ts'), `export default async function(input: string) {
    if (input === 'network') return fetch('https://192.0.2.1/');
    if (input === 'write') { const fs = await import('node:fs/promises'); return fs.writeFile('synthetic-output', 'x'); }
    const cp = await import('node:child_process'); return cp.execFileSync('synthetic-command');
  }`);
});
after(async () => { if (packDir) await rm(packDir, { recursive: true, force: true }); });
const run = (input: unknown, module = 'adoc/index.ts') => callPackFunction({ packDir, module }, input, DEFAULT_SANDBOX.producer);

test('the vendored engine and license retain the fixed upstream bytes', async () => {
  const bytes = await readFile(new URL('./vendor/core.mjs', import.meta.url));
  assert.equal(bytes.length, 990496); assert.equal(hash(bytes), ENGINE.sha256);
  const license = await readFile(new URL('./vendor/LICENSE.txt', import.meta.url));
  assert.equal(hash(license), '5dc8600d56eb0cae83dcdecde260d5b5568e7a5431fb9a9cf7906d02818bac7e');
  assert.match(license.toString(), /The MIT License/);
});
test('cold sandbox calls under different clocks and random values return identical artifact bytes', { skip }, async () => {
  const input = group({ 'book.adoc': '= Synthetic\n:cmd: demo one\n\nifdef::brand[]\n== Chapter\n\n*{cmd}*\nendif::brand[]\n' }, { brand: '' });
  const a = await run({ group: input, clock: 0, random: 0.1 }, 'clock.ts');
  const b = await run({ group: input, clock: 2524608000000, random: 0.9 }, 'clock.ts');
  assert.equal(a.osIsolation, true); assert.equal(b.osIsolation, true);
  assert.equal(JSON.stringify(a.output), JSON.stringify(b.output)); assert.equal((a.output as AdocResult).ok, true);
  assert.equal(a.stderr, '');
});
test('the same sandbox denies network access, file writes and subprocess creation', { skip }, async () => {
  for (const mode of ['network', 'write', 'spawn']) await assert.rejects(run(mode, 'denied.ts'), (error: unknown) => error instanceof SandboxError && (error.code === 'SANDBOX_VIOLATION' || error.code === 'IMPORT_NOT_DECLARED'));
});
test('a roughly three MiB table-dense group fits the unchanged producer time, memory and output profile', { skip, timeout: 120000 }, async (t) => {
  assert.deepEqual(DEFAULT_SANDBOX.producer, { timeoutMs: 120000, memoryMb: 1024, inputBytes: 128 * 1024 * 1024, outputBytes: 64 * 1024 * 1024 });
  const files: Record<string, string> = { 'book.adoc': '= Synthetic\n\n' + Array.from({ length: 12 }, (_, i) => `include::chapter-${i}.adoc[]`).join('\n') };
  for (let chapter = 0; chapter < 12; chapter++) {
    const lines = [`== Chapter ${chapter}`, '', '[cols="1,1,2",options="header"]', '|===', '|Parameter |Range |Description'];
    let bytes = Buffer.byteLength(lines.join('\n'));
    for (let row = 0; bytes < 256 * 1024; row++) {
      const line = `|parameter_${chapter}_${row} |1-${row + 1} |Synthetic explicit table constraint ${chapter}_${row} for the demo command.`;
      lines.push(line); bytes += Buffer.byteLength(line) + 1;
    }
    lines.push('|===', '', ''); files[`chapter-${chapter}.adoc`] = lines.join('\n');
  }
  const input = group(files), inputBytes = Object.values(files).reduce((sum, text) => sum + Buffer.byteLength(text), 0);
  assert.ok(inputBytes >= 3 * 1024 * 1024);
  const result = await run(input, 'metrics.ts');
  assert.equal(result.osIsolation, true); assert.equal((result.output as AdocResult).ok, true, JSON.stringify(result.output).slice(0, 500));
  const metrics = JSON.parse(result.stdout.trim());
  assert.ok(metrics.peak_rss_kib < (1024 + 192) * 1024);
  const outputBytes = Buffer.byteLength(JSON.stringify(result.output)); assert.equal(metrics.output_bytes, outputBytes); assert.ok(outputBytes < 64 * 1024 * 1024);
  t.diagnostic(JSON.stringify({ input_bytes: inputBytes, wall_ms: result.durationMs, output_bytes: outputBytes, ...metrics }));
});
