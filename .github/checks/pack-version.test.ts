import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { publishedBaseline, versionReuseProblems } from './pack-version.ts';

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

test('tracked packs pass against published baseline and on-disk checksums', () => {
  assert.deepEqual(versionReuseProblems(ROOT), []);
});

test('baseline with release/* tag selects nearest ancestor release/* tag and ignores non-release or off-branch tags', () => {
  const root = mkdtempSync(join(tmpdir(), 'pack-version-tag-'));
  try {
    gitIn(root, 'init', '-b', 'main');
    const c1 = commitPack(root, '0.9.0', 'zero', 'Add 0.9.0');
    gitIn(root, 'tag', 'v0.9.0');

    const c2 = commitPack(root, '1.0.0', 'one', 'Release 1.0.0');
    gitIn(root, 'tag', '-a', 'release/2026-11-14', '-m', 'Synthetic annotated release');

    gitIn(root, 'checkout', '-b', 'other');
    commitPack(root, '1.0.1', 'other-branch', 'Tag another release on unrelated branch');
    gitIn(root, 'tag', 'release/2026-11-99');

    gitIn(root, 'checkout', 'main');
    const c3 = commitPack(root, '1.0.1', 'two', 'Unpublished bump after release');

    assert.equal(publishedBaseline(root), c2);
    assert.notEqual(publishedBaseline(root), c1);
    assert.notEqual(publishedBaseline(root), c3);
    assert.deepEqual(versionReuseProblems(root), []);

    // Adding a newer release/* tag in HEAD ancestry moves the baseline forward to that commit.
    gitIn(root, 'tag', 'release/2026-11-15');
    assert.equal(publishedBaseline(root), c3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('baseline without release/* tags falls back to merge-base with the default branch', () => {
  const base = mkdtempSync(join(tmpdir(), 'pack-version-notag-'));
  try {
    const originRepo = join(base, 'origin');
    const localRepo = join(base, 'local');
    mkdirSync(originRepo, { recursive: true });
    gitIn(originRepo, 'init', '-b', 'main');
    const c1 = commitPack(originRepo, '1.0.0', 'one', 'Initial pack on main');
    gitIn(originRepo, 'tag', 'non-release-tag');

    // Create a local branch before advancing origin/main so merge-base differs from both tips.
    gitIn(originRepo, 'branch', 'feature', c1);
    commitPack(originRepo, '1.0.1', 'main-advance', 'Advance main past branch point');

    execFileSync('git', ['clone', '--no-local', pathToFileURL(originRepo).href, localRepo], { stdio: 'pipe' });
    gitIn(localRepo, 'checkout', 'feature');
    writeFileSync(join(localRepo, 'NOTES.md'), 'feature note\n');
    gitIn(localRepo, 'add', 'NOTES.md');
    gitIn(localRepo, 'commit', '-m', 'Unrelated commit on feature');

    assert.equal(publishedBaseline(localRepo), c1);
    assert.deepEqual(versionReuseProblems(localRepo), []);

    // When local main is stale behind origin/main, fallback prefers the newer origin/main merge-base.
    gitIn(localRepo, 'branch', '-f', 'main', c1);
    const originTip = gitIn(originRepo, 'rev-parse', 'main');
    gitIn(localRepo, 'checkout', '-b', 'off-origin-tip', originTip);
    assert.equal(publishedBaseline(localRepo), originTip);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('repository with neither release/* tags nor a resolvable default branch fails closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'pack-version-nodefault-'));
  try {
    gitIn(root, 'init', '-b', 'topic-a');
    commitPack(root, '1.0.0', 'one', 'Commit on topic-a');
    gitIn(root, 'checkout', '-b', 'topic-b');
    commitPack(root, '1.0.1', 'two', 'Commit on topic-b');

    assert.throws(() => publishedBaseline(root), /cannot determine published baseline: no release\/\* tag or default branch found/);
    const problems = versionReuseProblems(root);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /cannot determine published baseline: no release\/\* tag or default branch found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('editing content twice after baseline with a single version bump passes when final manifest matches bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'pack-version-twice-'));
  try {
    gitIn(root, 'init', '-b', 'main');
    commitPack(root, '1.0.0', 'one', 'Baseline 1.0.0');
    gitIn(root, 'tag', 'release/1.0.0');

    gitIn(root, 'checkout', '-b', 'work');
    commitPack(root, '1.0.1', 'two', 'First unpublished edit keeping new version 1.0.1');
    commitPack(root, '1.0.1', 'three', 'Second unpublished edit keeping same new version 1.0.1');
    assert.deepEqual(versionReuseProblems(root), []);

    // Editing content further without updating pack.json checksums still fails even on an unpublished version.
    writeFileSync(join(root, 'packs/workflow/sample/SKILL.md'), 'four-unsigned');
    const unsignedProblems = versionReuseProblems(root);
    assert.equal(unsignedProblems.length, 1);
    assert.match(unsignedProblems[0], /manifest checksums do not match disk for SKILL\.md/);

    // Once re-signed at the same unpublished version 1.0.1, it passes again.
    writePackFiles(root, '1.0.1', 'four-signed');
    assert.deepEqual(versionReuseProblems(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('keeping baseline version with different content fails across tag, merge-base, spacing, rename and revert', () => {
  const root = mkdtempSync(join(tmpdir(), 'pack-version-frozen-'));
  try {
    gitIn(root, 'init', '-b', 'main');
    commitPack(root, '1.0.0', 'one', 'Release 1.0.0', ' ');
    gitIn(root, 'tag', 'release/1.0.0');

    // 1. Committed change after release/* tag keeping baseline version 1.0.0 (even with spaced key formatting).
    gitIn(root, 'checkout', '-b', 'reused-on-branch');
    commitPack(root, '1.0.0', 'two', 'Change content without bumping after release tag', ' ');
    let problems = versionReuseProblems(root);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /packs\/workflow\/sample\/pack\.json: version 1\.0\.0 is unchanged since [0-9a-f]{12} but manifest digest, SKILL\.md changed/);

    // 2. Bumping to 1.0.1 then reverting back to frozen baseline version 1.0.0 with new content also fails.
    commitPack(root, '1.0.1', 'two-bumped', 'Temporary bump');
    commitPack(root, '1.0.0', 'three-reverted-version', 'Revert version back to baseline 1.0.0');
    problems = versionReuseProblems(root);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /version 1\.0\.0 is unchanged since [0-9a-f]{12} but manifest digest, SKILL\.md changed/);

    // 3. Same-version file rename fails against baseline.
    gitIn(root, 'checkout', '-b', 'rename-from-base', 'release/1.0.0');
    const packDir = join(root, 'packs/workflow/sample');
    rmSync(join(packDir, 'SKILL.md'));
    writeFileSync(join(packDir, 'GUIDE.md'), 'one');
    const sha256 = createHash('sha256').update('one').digest('hex');
    writeFileSync(
      join(packDir, 'pack.json'),
      `${JSON.stringify({ schema: 'pack@1', id: 'sample', version: '1.0.0', kind: 'workflow', title: 'Sample', description: 'Synthetic', files: [{ path: 'GUIDE.md', sha256, size: Buffer.byteLength('one') }] }, null, 2)}\n`,
    );
    gitIn(root, 'add', '-A', 'packs/workflow/sample');
    gitIn(root, 'commit', '-m', 'Rename listed file keeping baseline version');
    problems = versionReuseProblems(root);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /version 1\.0\.0 is unchanged since [0-9a-f]{12} but manifest digest, GUIDE\.md changed/);

    // 4. Same-version modification against default-branch merge-base when no release/* tag is an ancestor.
    gitIn(root, 'checkout', '--orphan', 'untagged-main');
    gitIn(root, 'rm', '-rf', '.');
    commitPack(root, '2.0.0', 'base', 'Initial untagged main');
    gitIn(root, 'branch', '-f', 'main', 'HEAD');
    gitIn(root, 'checkout', '-b', 'feature-reuse');
    commitPack(root, '2.0.0', 'modified', 'Reuse version from main merge-base');
    problems = versionReuseProblems(root);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /version 2\.0\.0 is unchanged since [0-9a-f]{12} but manifest digest, SKILL\.md changed/);

    // 5. Dirty unstaged and staged listed-file edits on disk keeping baseline version fail.
    gitIn(root, 'checkout', 'main');
    writeFileSync(join(root, 'packs/workflow/sample/SKILL.md'), 'dirty-unstaged');
    assert.equal(versionReuseProblems(root).length, 1);
    gitIn(root, 'add', 'packs/workflow/sample/SKILL.md');
    assert.equal(versionReuseProblems(root).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('deleted or invalid tracked pack.json reports problems instead of throwing and still checks other packs', () => {
  const root = mkdtempSync(join(tmpdir(), 'pack-version-invalid-'));
  try {
    gitIn(root, 'init', '-b', 'main');
    commitPack(root, '1.0.0', 'one', 'Add sample pack');
    const secondDir = join(root, 'packs/workflow/other');
    mkdirSync(secondDir, { recursive: true });
    writeFileSync(join(secondDir, 'SKILL.md'), 'alpha');
    const shaAlpha = createHash('sha256').update('alpha').digest('hex');
    writeFileSync(
      join(secondDir, 'pack.json'),
      `${JSON.stringify({ schema: 'pack@1', id: 'other', version: '1.0.0', kind: 'workflow', title: 'Other', description: 'Synthetic', files: [{ path: 'SKILL.md', sha256: shaAlpha, size: Buffer.byteLength('alpha') }] }, null, 2)}\n`,
    );
    gitIn(root, 'add', 'packs/workflow/other/pack.json', 'packs/workflow/other/SKILL.md');
    gitIn(root, 'commit', '-m', 'Add second pack');
    gitIn(root, 'tag', 'release/1.0.0');
    writeFileSync(join(secondDir, 'SKILL.md'), 'beta');

    writeFileSync(join(root, PACK_PATH), '{broken json');
    let problems = versionReuseProblems(root);
    assert.equal(problems.length, 2);
    assert.match(problems[0], /^packs\/workflow\/other\/pack\.json:.*SKILL\.md changed$/);
    assert.match(problems[1], /^packs\/workflow\/sample\/pack\.json:/);

    rmSync(join(root, PACK_PATH));
    problems = versionReuseProblems(root);
    assert.equal(problems.length, 2);
    assert.match(problems[0], /^packs\/workflow\/other\/pack\.json:.*SKILL\.md changed$/);
    assert.match(problems[1], /^packs\/workflow\/sample\/pack\.json:/);

    writeFileSync(join(root, PACK_PATH), '{broken head json');
    gitIn(root, 'add', PACK_PATH);
    gitIn(root, 'commit', '-m', 'Commit broken manifest');
    problems = versionReuseProblems(root);
    assert.equal(problems.length, 2);
    assert.match(problems[0], /^packs\/workflow\/other\/pack\.json:.*SKILL\.md changed$/);
    assert.match(problems[1], /^packs\/workflow\/sample\/pack\.json: invalid JSON/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('shallow clones fail closed across boundaries and pass when a release/* baseline is provably inside depth', () => {
  const base = mkdtempSync(join(tmpdir(), 'pack-version-shallow-'));
  try {
    const src = join(base, 'src');
    const depth1 = join(base, 'depth1');
    const depth2 = join(base, 'depth2');
    const worktree = join(base, 'wt');
    mkdirSync(src, { recursive: true });
    gitIn(src, 'init', '-b', 'main');
    commitPack(src, '1.0.0', 'one', 'Initial pack');
    const releaseRev = commitPack(src, '1.1.0', 'two', 'Release 1.1.0');
    gitIn(src, 'tag', 'release/1.1.0');
    commitPack(src, '1.1.1', 'three', 'Post-release edit');

    // depth=1 truncates before release/1.1.0 so baseline cannot be proven (main checkout and worktree both fail closed).
    cloneShallow(src, depth1, 1);
    const problems1 = versionReuseProblems(depth1);
    assert.equal(problems1.length, 1);
    assert.match(problems1[0], /shallow boundary/);
    assert.throws(() => publishedBaseline(depth1), /shallow boundary/);

    gitIn(depth1, 'worktree', 'add', '-b', 'wt', worktree);
    const wtProblems = versionReuseProblems(worktree);
    assert.equal(wtProblems.length, 1);
    assert.match(wtProblems[0], /shallow boundary/);

    // depth=2 includes release/1.1.0 and every commit above it.
    cloneShallow(src, depth2, 2);
    assert.equal(publishedBaseline(depth2), releaseRev);
    assert.deepEqual(versionReuseProblems(depth2), []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
