import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { versionCommit, versionReuseProblems } from './pack-version.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PACK_PATH = 'packs/workflow/sample/pack.json';

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Synthetic Pack', '-c', 'user.email=pack@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: 'pipe' },
  ).trim();
}

function writePackFiles(root: string, version: string, skill: string, keyGap = ''): void {
  const pack = join(root, 'packs/workflow/sample');
  mkdirSync(pack, { recursive: true });
  writeFileSync(join(pack, 'SKILL.md'), skill);
  const sha256 = createHash('sha256').update(skill).digest('hex');
  const raw = `${JSON.stringify({ schema: 'pack@1', id: 'sample', version, kind: 'workflow', title: 'Sample', description: 'Synthetic', files: [{ path: 'SKILL.md', sha256, size: Buffer.byteLength(skill) }] }, null, 2)}\n`;
  writeFileSync(join(pack, 'pack.json'), keyGap ? raw.replace('"version":', `"version"${keyGap}:`) : raw);
}

function commitPack(root: string, version: string, skill: string, message: string, keyGap = ''): string {
  writePackFiles(root, version, skill, keyGap);
  gitIn(root, 'add', 'packs/workflow/sample/pack.json', 'packs/workflow/sample/SKILL.md');
  gitIn(root, 'commit', '-m', message);
  return gitIn(root, 'rev-parse', 'HEAD');
}

function cloneShallow(src: string, dest: string, depth: number): void {
  execFileSync('git', ['clone', '--no-local', `--depth=${depth}`, pathToFileURL(src).href, dest], { stdio: 'pipe' });
}

test('tracked packs keep the manifest digest of the commit that set their version', () => {
  assert.deepEqual(versionReuseProblems(ROOT), []);
});

test('a listed file change without a version bump is reported from git history', () => {
  const root = mkdtempSync(join(tmpdir(), 'pack-version-'));
  try {
    gitIn(root, 'init', '-b', 'main');
    commitPack(root, '1.0.0', 'one', 'Add the sample pack');
    assert.deepEqual(versionReuseProblems(root), []);
    commitPack(root, '1.0.0', 'two', 'Change the skill without a version bump');
    const problems = versionReuseProblems(root);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /packs\/workflow\/sample\/pack\.json: version 1\.0\.0 is unchanged since [0-9a-f]{12} but manifest digest, SKILL\.md changed/);
    writePackFiles(root, '1.0.1', 'two');
    assert.deepEqual(versionReuseProblems(root), []);
    gitIn(root, 'add', 'packs/workflow/sample/pack.json');
    gitIn(root, 'commit', '-m', 'Bump the sample pack');
    assert.deepEqual(versionReuseProblems(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('depth=1 shallow clone reports a problem when a pack changed without a version bump', () => {
  const base = mkdtempSync(join(tmpdir(), 'pack-version-shallow1-'));
  const src = join(base, 'src');
  const clone = join(base, 'clone');
  mkdirSync(src, { recursive: true });
  try {
    gitIn(src, 'init', '-b', 'main');
    commitPack(src, '1.0.0', 'one', 'Add the sample pack');
    commitPack(src, '1.0.0', 'two', 'Change the skill without a version bump');
    cloneShallow(src, clone, 1);
    const problems = versionReuseProblems(clone);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /packs\/workflow\/sample\/pack\.json:.*shallow boundary/);
    assert.throws(() => versionCommit(clone, PACK_PATH), /shallow boundary/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('depth=2 shallow clone reports a problem when an unbumped pack edit sits at the shallow boundary', () => {
  const base = mkdtempSync(join(tmpdir(), 'pack-version-shallow2-miss-'));
  const src = join(base, 'src');
  const clone = join(base, 'clone');
  mkdirSync(src, { recursive: true });
  try {
    gitIn(src, 'init', '-b', 'main');
    commitPack(src, '1.0.0', 'one', 'Add the sample pack');
    commitPack(src, '1.0.0', 'two', 'Change the skill without a version bump');
    writeFileSync(join(src, 'README.md'), 'unrelated\n');
    gitIn(src, 'add', 'README.md');
    gitIn(src, 'commit', '-m', 'Edit unrelated README');
    cloneShallow(src, clone, 2);
    const problems = versionReuseProblems(clone);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /packs\/workflow\/sample\/pack\.json:.*shallow boundary/);
    assert.throws(() => versionCommit(clone, PACK_PATH), /shallow boundary/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('depth=2 shallow clone passes when the version bump is verifiable within reachable history', () => {
  const base = mkdtempSync(join(tmpdir(), 'pack-version-shallow2-ok-'));
  const src = join(base, 'src');
  const clone = join(base, 'clone');
  mkdirSync(src, { recursive: true });
  try {
    gitIn(src, 'init', '-b', 'main');
    commitPack(src, '1.0.0', 'one', 'Add the sample pack');
    const bumpRev = commitPack(src, '1.0.1', 'two', 'Bump the sample pack');
    cloneShallow(src, clone, 2);
    assert.deepEqual(versionReuseProblems(clone), []);
    assert.equal(versionCommit(clone, PACK_PATH), bumpRev);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('depth=2 shallow clone passes when a pack is newly added after the shallow boundary', () => {
  const base = mkdtempSync(join(tmpdir(), 'pack-version-shallow2-add-'));
  const src = join(base, 'src');
  const clone = join(base, 'clone');
  mkdirSync(src, { recursive: true });
  try {
    gitIn(src, 'init', '-b', 'main');
    writeFileSync(join(src, 'README.md'), 'init\n');
    gitIn(src, 'add', 'README.md');
    gitIn(src, 'commit', '-m', 'Initial commit');
    const addRev = commitPack(src, '1.0.0', 'one', 'Add the sample pack');
    cloneShallow(src, clone, 2);
    assert.deepEqual(versionReuseProblems(clone), []);
    assert.equal(versionCommit(clone, PACK_PATH), addRev);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('git worktree of a shallow clone resolves the shared shallow boundary file', () => {
  const base = mkdtempSync(join(tmpdir(), 'pack-version-shallow-wt-'));
  const src = join(base, 'src');
  const clone = join(base, 'clone');
  const worktree = join(base, 'wt');
  mkdirSync(src, { recursive: true });
  try {
    gitIn(src, 'init', '-b', 'main');
    commitPack(src, '1.0.0', 'one', 'Add the sample pack');
    commitPack(src, '1.0.0', 'two', 'Change the skill without a version bump');
    writeFileSync(join(src, 'README.md'), 'unrelated\n');
    gitIn(src, 'add', 'README.md');
    gitIn(src, 'commit', '-m', 'Edit unrelated README');
    cloneShallow(src, clone, 2);
    gitIn(clone, 'worktree', 'add', '-b', 'wt', worktree);
    const problems = versionReuseProblems(worktree);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /packs\/workflow\/sample\/pack\.json:.*shallow boundary/);
    assert.throws(() => versionCommit(worktree, PACK_PATH), /shallow boundary/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('non-standard JSON formatting around version still detects reuse in full history', () => {
  const root = mkdtempSync(join(tmpdir(), 'pack-version-format-'));
  try {
    gitIn(root, 'init', '-b', 'main');
    commitPack(root, '1.0.0', 'one', 'Add the sample pack with spaced key', ' ');
    commitPack(root, '1.0.0', 'two', 'Change the skill keeping spaced key', ' ');
    const problems = versionReuseProblems(root);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /packs\/workflow\/sample\/pack\.json: version 1\.0\.0 is unchanged since [0-9a-f]{12} but manifest digest, SKILL\.md changed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
