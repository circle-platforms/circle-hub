import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { verifyCliInvocations, verifyCliManifest } from './verify-tool-cli.ts';

function fixture(stdin: string[], source: string) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-tool-cli-')); mkdirSync(join(dir, 'tools'));
  const files = { 'tools/probe.ts': source, 'tools/probe.cli.json': JSON.stringify({ schema: 'tool-cli@2', stdin, options: [] }) };
  for (const [file, bytes] of Object.entries(files)) writeFileSync(join(dir, file), bytes);
  writeFileSync(join(dir, 'pack.json'), JSON.stringify({ files: Object.entries(files).map(([path, text]) => ({ path, size: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') })) }));
  return { dir, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test('staged declared tools are probed with literal synthetic argv and exact stdin arity', () => {
  const f = fixture(['%FIRST%', '%SECOND%'], "import{readFileSync}from'node:fs';const n=readFileSync(0,'utf8').trim().split('\\n').filter(Boolean).length;process.stdout.write(String(n));process.exitCode=n===2?0:2;");
  try {
    assert.deepEqual(verifyCliInvocations(f.dir, new Set(), { 'tools/probe.ts': [{ argv: [], cwd: f.dir, subcommand: null, stdinValues: ['synthetic-one', 'synthetic-two'], complete: { status: 0, stdout: '2' }, empty: { status: 2, stdout: '0' } }] }), { declarations: 1, invocations: 1, processes: 2 });
    assert.throws(() => verifyCliInvocations(f.dir, new Set(), { 'tools/probe.ts': [{ argv: [], cwd: f.dir, subcommand: null, stdinValues: ['one'], complete: { status: 0 } }] }), /arity/);
  } finally { f.close(); }
});

test('static declaration verification never executes inspected module source', () => {
  const f = fixture([], "throw Error('source must never execute during manifest verification');");
  try {
    assert.equal(verifyCliManifest(f.dir, new Set()).size, 1);
    assert.throws(() => verifyCliInvocations(f.dir, new Set(), {}), /missing synthetic invocation/);
    writeFileSync(join(f.dir, 'tools/probe.cli.json'), '{}');
    assert.throws(() => verifyCliManifest(f.dir, new Set()), /size mismatch|digest mismatch/);
  } finally { f.close(); }
});

test('zero-input declarations remain executable and tampered symlink entries fail before probes', () => {
  const f = fixture([], "process.stdout.write('ok');");
  try {
    assert.equal(verifyCliInvocations(f.dir, new Set(), { 'tools/probe.ts': [{ argv: [], cwd: f.dir, subcommand: null, stdinValues: [], complete: { status: 0, stdout: 'ok' } }] }).processes, 1);
    const saved = readFileSync(join(f.dir, 'tools/probe.ts')); rmSync(join(f.dir, 'tools/probe.ts')); writeFileSync(join(f.dir, 'outside.ts'), saved); symlinkSync(join(f.dir, 'outside.ts'), join(f.dir, 'tools/probe.ts'));
    assert.throws(() => verifyCliManifest(f.dir, new Set()), /symlinks/);
  } finally { f.close(); }
});
