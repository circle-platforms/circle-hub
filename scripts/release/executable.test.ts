import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyExecutableTarget } from './executable.ts';
import type { Target } from './integrity.ts';

test('executable header inspection rejects wrong CPU, OS, truncation and scripts', () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-executable-'));
  try {
    const path = join(root, 'binary');
    for (const target of ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'] as Target[]) {
      const header = Buffer.alloc(64);
      if (target.startsWith('linux-')) { Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(header); header.writeUInt16LE(target.endsWith('arm64') ? 183 : 62, 18); }
      else { header.writeUInt32LE(0xfeedfacf); header.writeUInt32LE(target.endsWith('arm64') ? 0x0100000c : 0x01000007, 4); }
      writeFileSync(path, header);
      verifyExecutableTarget(path, target);
      for (const wrong of ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'windows-x64', 'windows-arm64'] as Target[]) if (wrong !== target) assert.throws(() => verifyExecutableTarget(path, wrong), /目标架构/);
    }
    for (const bytes of [Buffer.alloc(0), Buffer.from([0xcf, 0xfa, 0xed]), Buffer.from('#!/bin/sh\necho fake\n')]) {
      writeFileSync(path, bytes);
      assert.throws(() => verifyExecutableTarget(path, 'darwin-arm64'), /目标架构/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
