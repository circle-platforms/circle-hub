import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { maintainInstallation, recordInstallation, RECEIPT } from './guard-installation.ts';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'guard-installation-'));
  mkdirSync(join(home, 'hooks')); mkdirSync(join(home, 'skills'));
  const bundle = { 'hooks/entry.mjs': 'original', 'hooks.json': '{}' };
  for (const [file, content] of Object.entries(bundle)) writeFileSync(join(home, file), content);
  writeFileSync(join(home, 'hooks/ALLOWED.md'), 'original rules');
  writeFileSync(join(home, 'skills/run.cli.json'), '{"schema":"tool-cli@2","stdin":[],"options":[]}');
  recordInstallation(home, 'ops', bundle);
  return { home, bundle, close: () => rmSync(home, { recursive: true, force: true }) };
}

test('maintenance verifies guard, full rule text and every installed skill byte together', () => {
  const f = fixture();
  try {
    maintainInstallation(f.home, 'ops', f.bundle, 'original rules', 'verify');
    const receipt = JSON.parse(readFileSync(join(f.home, RECEIPT), 'utf8'));
    assert.ok(receipt.skills['skills/run.cli.json']);
    writeFileSync(join(f.home, 'skills/run.cli.json'), '{}');
    assert.throws(() => maintainInstallation(f.home, 'ops', f.bundle, 'original rules', 'verify'), /技能安装已变化/);
  } finally { f.close(); }
});

test('updates reject local rule or executable edits before replacing any managed file', () => {
  for (const file of ['hooks/entry.mjs', 'hooks/ALLOWED.md']) {
    const f = fixture();
    try {
      writeFileSync(join(f.home, file), 'operator edit');
      assert.throws(() => maintainInstallation(f.home, 'ops', { ...f.bundle, 'hooks/entry.mjs': 'next' }, 'next rules', 'update'), /未覆盖/);
      assert.equal(readFileSync(join(f.home, file), 'utf8'), 'operator edit');
    } finally { f.close(); }
  }
});

test('reviewed old baseline permits update and the new receipt verifies it', () => {
  const f = fixture();
  try {
    const baseline = join(f.home, 'reviewed-baseline.json');
    writeFileSync(baseline, readFileSync(join(f.home, RECEIPT)));
    rmSync(join(f.home, RECEIPT));
    assert.throws(() => maintainInstallation(f.home, 'ops', f.bundle, 'original rules', 'update'), /ENOENT/);
    const next = { ...f.bundle, 'hooks/entry.mjs': 'next' };
    maintainInstallation(f.home, 'ops', next, 'next rules', 'update', baseline);
    maintainInstallation(f.home, 'ops', next, 'next rules', 'verify');
  } finally { f.close(); }
});

test('updates reject symlinked managed input without following its bytes', () => {
  const f = fixture();
  try {
    const target = join(f.home, 'outside'); writeFileSync(target, 'original');
    rmSync(join(f.home, 'hooks/entry.mjs')); symlinkSync(target, join(f.home, 'hooks/entry.mjs'));
    assert.throws(() => maintainInstallation(f.home, 'ops', f.bundle, 'original rules', 'update'), /符号链接/);
    assert.equal(readFileSync(target, 'utf8'), 'original');
  } finally { f.close(); }
});
