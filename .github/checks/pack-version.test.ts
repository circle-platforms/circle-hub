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
    writeFileSync(join(secondDir, 'SKILL.md'), 'beta');

    // Malformed JSON on disk for the first pack must be reported as a problem, not crash before checking the second pack.
    writeFileSync(join(root, PACK_PATH), '{broken json');
    let problems = versionReuseProblems(root);
    assert.equal(problems.length, 2);
    assert.match(problems[0], /^packs\/workflow\/other\/pack\.json:.*SKILL\.md changed$/);
    assert.match(problems[1], /^packs\/workflow\/sample\/pack\.json:/);

    // Unstaged deletion on disk of a tracked pack.json must also be reported as a problem without throwing ENOENT.
    rmSync(join(root, PACK_PATH));
    problems = versionReuseProblems(root);
    assert.equal(problems.length, 2);
    assert.match(problems[0], /^packs\/workflow\/other\/pack\.json:.*SKILL\.md changed$/);
    assert.match(problems[1], /^packs\/workflow\/sample\/pack\.json:/);

    // Invalid manifest JSON committed in HEAD must also be reported in problems rather than crashing.
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

test('shallow clones fail closed when only a listed file changed at or before the boundary', () => {
  const base = mkdtempSync(join(tmpdir(), 'pack-version-shallow-listed-'));
  try {
    const src = join(base, 'src');
    const depth1 = join(base, 'depth1');
    const depth2 = join(base, 'depth2');
    mkdirSync(src, { recursive: true });
    gitIn(src, 'init', '-b', 'main');
    commitPack(src, '1.0.0', 'one', 'Add sample pack');
    writeFileSync(join(src, 'packs/workflow/sample/SKILL.md'), 'two-without-manifest-edit');
    gitIn(src, 'add', 'packs/workflow/sample/SKILL.md');
    gitIn(src, 'commit', '-m', 'Edit skill without touching pack.json');

    // depth=1 truncates right at the SKILL.md-only commit; pack.json is treated as boundary-added and fails closed.
    cloneShallow(src, depth1, 1);
    const problems1 = versionReuseProblems(depth1);
    assert.equal(problems1.length, 1);
    assert.match(problems1[0], /shallow boundary/);

    writeFileSync(join(src, 'README.md'), 'unrelated');
    gitIn(src, 'add', 'README.md');
    gitIn(src, 'commit', '-m', 'Unrelated commit');
    // depth=2 puts the SKILL.md-only commit on the shallow boundary.
    cloneShallow(src, depth2, 2);
    const problems2 = versionReuseProblems(depth2);
    assert.equal(problems2.length, 1);
    assert.match(problems2[0], /shallow boundary/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('shallow-since clones pass only when both the introducing commit and its parent are present', () => {
  const base = mkdtempSync(join(tmpdir(), 'pack-version-shallow-since-'));
  try {
    const src = join(base, 'src');
    const cutAtBump = join(base, 'cut-at-bump');
    const keepsParent = join(base, 'keeps-parent');
    mkdirSync(src, { recursive: true });
    gitIn(src, 'init', '-b', 'main');

    const commitDated = (date: string, msg: string) => {
      execFileSync(
        'git',
        ['-c', 'user.name=Synthetic Pack', '-c', 'user.email=pack@example.com', '-c', 'commit.gpgsign=false', 'commit', '-m', msg],
        { cwd: src, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: 'pipe' },
      );
    };

    writePackFiles(src, '0.9.0', 'zero');
    gitIn(src, 'add', 'packs/workflow/sample/pack.json', 'packs/workflow/sample/SKILL.md');
    commitDated('2020-01-01T00:00:00Z', 'Initial 0.9.0');

    writePackFiles(src, '1.0.0', 'one');
    gitIn(src, 'add', 'packs/workflow/sample/pack.json', 'packs/workflow/sample/SKILL.md');
    commitDated('2021-01-01T00:00:00Z', 'Bump to 1.0.0');

    writePackFiles(src, '1.0.1', 'two');
    gitIn(src, 'add', 'packs/workflow/sample/pack.json', 'packs/workflow/sample/SKILL.md');
    commitDated('2022-01-01T00:00:00Z', 'Bump to 1.0.1');

    // Cutoff omits 1.0.0 parent so 1.0.1 lands on the shallow boundary and must fail closed.
    execFileSync('git', ['clone', '--no-local', '--shallow-since=2021-06-01T00:00:00Z', pathToFileURL(src).href, cutAtBump], { stdio: 'pipe' });
    const cutProblems = versionReuseProblems(cutAtBump);
    assert.equal(cutProblems.length, 1);
    assert.match(cutProblems[0], /shallow boundary/);

    // Cutoff keeps both 1.0.1 and its 1.0.0 parent, so introducing commit is provable.
    execFileSync('git', ['clone', '--no-local', '--shallow-since=2020-06-01T00:00:00Z', pathToFileURL(src).href, keepsParent], { stdio: 'pipe' });
    assert.deepEqual(versionReuseProblems(keepsParent), []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('dirty working tree and staged listed-file edits without a bump fail in full and verifiable shallow clones', () => {
  const base = mkdtempSync(join(tmpdir(), 'pack-version-dirty-'));
  try {
    const src = join(base, 'src');
    const shallow = join(base, 'shallow');
    mkdirSync(src, { recursive: true });
    gitIn(src, 'init', '-b', 'main');
    commitPack(src, '0.9.0', 'zero', 'Add 0.9.0');
    commitPack(src, '1.0.0', 'one', 'Bump to 1.0.0');

    cloneShallow(src, shallow, 2);
    assert.deepEqual(versionReuseProblems(shallow), []);

    // Unstaged working tree edit to a listed file without bumping pack.json.
    writeFileSync(join(shallow, 'packs/workflow/sample/SKILL.md'), 'dirty-unstaged');
    const unstagedProblems = versionReuseProblems(shallow);
    assert.equal(unstagedProblems.length, 1);
    assert.match(unstagedProblems[0], /version 1\.0\.0 is unchanged since [0-9a-f]{12} but SKILL\.md changed/);

    // Staged edit to the listed file without bumping pack.json.
    gitIn(shallow, 'add', 'packs/workflow/sample/SKILL.md');
    const stagedProblems = versionReuseProblems(shallow);
    assert.equal(stagedProblems.length, 1);
    assert.match(stagedProblems[0], /version 1\.0\.0 is unchanged since [0-9a-f]{12} but SKILL\.md changed/);

    // Full repo behaves identically for unstaged/staged dirty edits.
    writeFileSync(join(src, 'packs/workflow/sample/SKILL.md'), 'dirty-full');
    assert.equal(versionReuseProblems(src).length, 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('merge commits detect listed-file reuse and fail closed across shallow boundaries', () => {
  const base = mkdtempSync(join(tmpdir(), 'pack-version-merge-'));
  try {
    const src = join(base, 'src');
    const shallow = join(base, 'shallow');
    mkdirSync(src, { recursive: true });
    gitIn(src, 'init', '-b', 'main');
    commitPack(src, '1.0.0', 'one', 'Add sample 1.0.0');
    gitIn(src, 'checkout', '-b', 'side');
    writeFileSync(join(src, 'packs/workflow/sample/SKILL.md'), 'side-edit-without-bump');
    gitIn(src, 'add', 'packs/workflow/sample/SKILL.md');
    gitIn(src, 'commit', '-m', 'Modify SKILL.md on side branch');
    gitIn(src, 'checkout', 'main');
    writeFileSync(join(src, 'README.md'), 'main');
    gitIn(src, 'add', 'README.md');
    gitIn(src, 'commit', '-m', 'Advance main');
    gitIn(src, 'merge', '--no-ff', 'side', '-m', 'Merge side into main');

    const fullProblems = versionReuseProblems(src);
    assert.equal(fullProblems.length, 1);
    assert.match(fullProblems[0], /version 1\.0\.0 is unchanged since [0-9a-f]{12} but SKILL\.md changed/);

    cloneShallow(src, shallow, 2);
    const shallowProblems = versionReuseProblems(shallow);
    assert.equal(shallowProblems.length, 1);
    assert.match(shallowProblems[0], /shallow boundary/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('renaming a listed file inside a pack without bumping version fails across shallow boundaries too', () => {
  const base = mkdtempSync(join(tmpdir(), 'pack-version-rename-'));
  try {
    const src = join(base, 'src');
    const shallow = join(base, 'shallow');
    mkdirSync(src, { recursive: true });
    gitIn(src, 'init', '-b', 'main');
    commitPack(src, '1.0.0', 'one', 'Add sample 1.0.0');

    const packDir = join(src, 'packs/workflow/sample');
    const content = 'one';
    rmSync(join(packDir, 'SKILL.md'));
    writeFileSync(join(packDir, 'GUIDE.md'), content);
    const sha256 = createHash('sha256').update(content).digest('hex');
    writeFileSync(
      join(packDir, 'pack.json'),
      `${JSON.stringify({ schema: 'pack@1', id: 'sample', version: '1.0.0', kind: 'workflow', title: 'Sample', description: 'Synthetic', files: [{ path: 'GUIDE.md', sha256, size: Buffer.byteLength(content) }] }, null, 2)}\n`,
    );
    gitIn(src, 'add', '-A', 'packs/workflow/sample');
    gitIn(src, 'commit', '-m', 'Rename SKILL.md to GUIDE.md keeping 1.0.0');

    const fullProblems = versionReuseProblems(src);
    assert.equal(fullProblems.length, 1);
    assert.match(fullProblems[0], /version 1\.0\.0 is unchanged since [0-9a-f]{12} but manifest digest, GUIDE\.md changed/);

    cloneShallow(src, shallow, 1);
    const shallowProblems = versionReuseProblems(shallow);
    assert.equal(shallowProblems.length, 1);
    assert.match(shallowProblems[0], /shallow boundary/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
