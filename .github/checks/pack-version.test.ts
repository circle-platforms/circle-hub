import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { versionReuseProblems } from './pack-version.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

test('tracked packs keep the manifest digest of the commit that set their version', () => {
  assert.deepEqual(versionReuseProblems(ROOT), []);
});

test('a listed file change without a version bump is reported from git history', () => {
  const root = mkdtempSync(join(tmpdir(), 'pack-version-'));
  const pack = join(root, 'packs/workflow/sample');
  mkdirSync(pack, { recursive: true });
  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'user.name=Synthetic Pack', '-c', 'user.email=pack@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'pipe' });
  };
  const write = (version: string, skill: string): void => {
    writeFileSync(join(pack, 'SKILL.md'), skill);
    const sha256 = createHash('sha256').update(skill).digest('hex');
    writeFileSync(join(pack, 'pack.json'), `${JSON.stringify({ schema: 'pack@1', id: 'sample', version, kind: 'workflow', title: 'Sample', description: 'Synthetic', files: [{ path: 'SKILL.md', sha256, size: Buffer.byteLength(skill) }] }, null, 2)}\n`);
  };
  try {
    git('init', '-b', 'main');
    write('1.0.0', 'one');
    git('add', 'packs/workflow/sample/pack.json', 'packs/workflow/sample/SKILL.md');
    git('commit', '-m', 'Add the sample pack');
    assert.deepEqual(versionReuseProblems(root), []);
    write('1.0.0', 'two');
    git('add', 'packs/workflow/sample/pack.json', 'packs/workflow/sample/SKILL.md');
    git('commit', '-m', 'Change the skill without a version bump');
    const problems = versionReuseProblems(root);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /packs\/workflow\/sample\/pack\.json: version 1\.0\.0 is unchanged since [0-9a-f]{12} but manifest digest, SKILL\.md changed/);
    write('1.0.1', 'two');
    assert.deepEqual(versionReuseProblems(root), []);
    git('add', 'packs/workflow/sample/pack.json');
    git('commit', '-m', 'Bump the sample pack');
    assert.deepEqual(versionReuseProblems(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
