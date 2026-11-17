import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  docSetProblems,
  docSetProblemsFromSnapshot,
  isJekyllSkipped,
  isValidDocsPath,
  loadDocSet,
  parseDocSet,
  parseDocSetExceptions,
  parseSiteExcludes,
} from './doc-set.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function makeTempGitRepo(): {
  root: string;
  write: (relPath: string, content: string) => void;
  git: (...args: string[]) => void;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), 'doc-set-'));
  const git = (...args: string[]): void => {
    execFileSync(
      'git',
      ['-c', 'user.name=Synthetic Docs', '-c', 'user.email=docs@example.com', '-c', 'commit.gpgsign=false', ...args],
      { cwd: root, stdio: 'pipe' },
    );
  };
  const write = (relPath: string, content: string): void => {
    const full = join(root, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  git('init', '-b', 'main');
  return {
    root,
    write,
    git,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('doc-set check on the repository', () => {
  it('tracked docs/ files match doc-set.json with no unlisted files or unapproved historical banners', () => {
    assert.deepEqual(docSetProblems(ROOT), []);
  });

  it('loadDocSet returns valid published, kept_internal and historical lists matching the repo', () => {
    const docSet = loadDocSet(ROOT);
    const excludes = parseSiteExcludes(readFileSync(join(ROOT, 'docs/_config.yml'), 'utf8'));
    assert.ok(docSet.published.includes('docs/index.md'));
    assert.ok(!docSet.published.includes('docs/README.md'));
    assert.ok(docSet.kept_internal.includes('docs/README.md'));
    assert.ok(docSet.kept_internal.includes('docs/_config.yml'));
    assert.ok(docSet.published.every((path) => path.endsWith('.md') && !isJekyllSkipped(path.slice('docs/'.length), excludes)));
  });
});

describe('doc-set pure rules', () => {
  it('accepts a clean snapshot matching doc-set.json', () => {
    const docSet = {
      published: ['docs/index.md', 'docs/guide.md'],
      kept_internal: ['docs/_config.yml', 'docs/README.md'],
    };
    const snapshot = {
      files: ['docs/index.md', 'docs/guide.md', 'docs/_config.yml', 'docs/README.md'],
      historicalFiles: [],
      siteExcludes: ['README.md'],
    };
    assert.deepEqual(docSetProblemsFromSnapshot(snapshot, docSet), []);
  });

  it('rejects an extra unlisted file under docs/', () => {
    const docSet = {
      published: ['docs/index.md'],
      kept_internal: ['docs/_config.yml'],
    };
    const snapshot = {
      files: ['docs/index.md', 'docs/_config.yml', 'docs/extra.md'],
      historicalFiles: [],
    };
    const problems = docSetProblemsFromSnapshot(snapshot, docSet);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^docs\/extra\.md: unlisted file under docs\//);
  });

  it('rejects missing declared files from published and kept_internal', () => {
    const docSet = {
      published: ['docs/index.md', 'docs/missing-page.md'],
      kept_internal: ['docs/_config.yml', 'docs/missing-asset.json'],
    };
    const snapshot = {
      files: ['docs/index.md', 'docs/_config.yml'],
      historicalFiles: [],
    };
    const problems = docSetProblemsFromSnapshot(snapshot, docSet);
    assert.equal(problems.length, 2);
    assert.match(problems[0], /^docs\/missing-page\.md: listed in \.github\/checks\/doc-set\.json \(published\) but missing/);
    assert.match(problems[1], /^docs\/missing-asset\.json: listed in \.github\/checks\/doc-set\.json \(kept_internal\) but missing/);
  });

  it('rejects bad prefixes, non-canonical paths, overlaps, duplicates and Jekyll exclusions', () => {
    for (const bad of ['README.md', 'hub/index.ts', '/docs/a.md', 'docs/', 'docs/sub/', 'docs/../AGENTS.md', 'docs/./a.md', 'docs//a.md', 'docs\\a.md']) {
      assert.equal(isValidDocsPath(bad), false, bad);
      const parsed = parseDocSet({ published: [bad], kept_internal: [] });
      assert.equal(parsed.problems.length, 1, bad);
      assert.match(parsed.problems[0], /canonical repo-relative path under docs\//);
    }

    assert.match(parseDocSet({ published: ['docs/tokens.json'], kept_internal: [] }).problems[0], /must end with \.md/);
    assert.match(parseDocSet({ published: ['docs/_includes/nav.md'], kept_internal: [] }).problems[0], /excluded from the docs site/);
    assert.match(parseDocSet({ published: ['docs/README.md'], kept_internal: [] }, ['README.md']).problems[0], /excluded from the docs site/);
    assert.match(parseDocSet({ published: ['docs/a.md', 'docs/a.md'], kept_internal: [] }).problems[0], /duplicate published entry/);
    assert.match(parseDocSet({ published: ['docs/a.md'], kept_internal: ['docs/a.md'] }).problems[0], /both published and kept_internal/);
    assert.match(parseDocSet({ published: [], kept_internal: ['docs/guide.md'] }, ['README.md']).problems[0], /kept_internal page docs\/guide\.md is not excluded/);
    assert.match(parseDocSet({ published: ['docs/a.md'], kept_internal: [], extraKey: [] }).problems[0], /unknown key "extraKey"/);
    assert.match(parseDocSet({ published: [], kept_internal: [], historical: ['docs/other.md'] }).problems[0], /must also be listed in published or kept_internal/);
  });

  it('enforces the historical banner rule and detects stale historical declarations', () => {
    const docSet = {
      published: ['docs/old.md'],
      kept_internal: [],
    };
    const snapshot = {
      files: ['docs/old.md'],
      historicalFiles: ['docs/old.md'],
    };
    const problems = docSetProblemsFromSnapshot(snapshot, docSet);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^docs\/old\.md: opens with a historical or superseded banner/);

    assert.deepEqual(
      docSetProblemsFromSnapshot(snapshot, { ...docSet, historical: ['docs/old.md'] }),
      [],
    );

    const stale = docSetProblemsFromSnapshot(
      { files: ['docs/old.md'], historicalFiles: [] },
      { ...docSet, historical: ['docs/old.md'] },
    );
    assert.equal(stale.length, 1);
    assert.match(stale[0], /^docs\/old\.md: listed in \.github\/checks\/doc-set\.json \(historical\) but does not open/);
  });

  it('validates bidirectional consistency with exceptions.json and ignores other checks', () => {
    const docSet = {
      published: ['docs/index.md'],
      kept_internal: [],
    };
    const exceptions = {
      exceptions: [
        {
          check: 'package-boundaries',
          path: 'hub/runs/engine/a.ts',
          what: 'hub/dispatch',
          reason: 'pending C4',
          removeWhen: 'C4',
        },
        {
          check: 'doc-set',
          path: 'docs/temp.md',
          what: 'unlisted',
          reason: 'pending deletion',
          removeWhen: 'G2',
        },
        {
          check: 'doc-set',
          path: 'docs/temp.md',
          what: 'historical',
          reason: 'pending deletion',
          removeWhen: 'G2',
        },
      ],
    };

    assert.deepEqual(
      docSetProblemsFromSnapshot(
        { files: ['docs/index.md', 'docs/temp.md'], historicalFiles: ['docs/temp.md'] },
        docSet,
        exceptions,
      ),
      [],
    );

    // Also supports a top-level array in exceptions.json.
    assert.deepEqual(
      docSetProblemsFromSnapshot(
        { files: ['docs/index.md', 'docs/temp.md'], historicalFiles: ['docs/temp.md'] },
        docSet,
        exceptions.exceptions,
      ),
      [],
    );

    // Removing the file makes both doc-set exceptions stale.
    const stale = docSetProblemsFromSnapshot(
      { files: ['docs/index.md'], historicalFiles: [] },
      docSet,
      exceptions,
    );
    assert.equal(stale.length, 2);
    assert.match(stale[0], /^docs\/temp\.md: stale doc-set exception \(unlisted\)/);
    assert.match(stale[1], /^docs\/temp\.md: stale doc-set exception \(historical\)/);

    // Bad prefix or unsupported what in exceptions.json is rejected.
    const badExceptions = parseDocSetExceptions([
      { check: 'doc-set', path: 'README.md', what: 'unlisted', reason: 'r', removeWhen: 'G2' },
      { check: 'doc-set', path: 'docs/a.md', what: 'other', reason: 'r', removeWhen: 'G2' },
    ]);
    assert.equal(badExceptions.problems.length, 2);
    assert.match(badExceptions.problems[0], /canonical repo-relative path under docs\//);
    assert.match(badExceptions.problems[1], /must be "unlisted" or "historical"/);
  });
});

describe('doc-set integration on temporary git repositories', () => {
  it('detects unlisted files, deleted declared files, historical banners and stale exceptions on disk', () => {
    const repo = makeTempGitRepo();
    try {
      repo.write('docs/_config.yml', 'exclude:\n  - README.md\n');
      repo.write('docs/README.md', '# Docs index\n');
      repo.write('docs/index.md', '# Home\n');
      repo.write(
        '.github/checks/doc-set.json',
        JSON.stringify({ published: ['docs/index.md'], kept_internal: ['docs/README.md', 'docs/_config.yml'] }, null, 2),
      );
      repo.git('add', '.');
      repo.git('commit', '-m', 'Initial docs');
      assert.deepEqual(docSetProblems(repo.root), []);

      // Adding a new tracked file under docs/ without registering it fails.
      repo.write('docs/extra.md', '> **历史文档**：old note\n');
      repo.git('add', 'docs/extra.md');
      const extraProblems = docSetProblems(repo.root);
      assert.equal(extraProblems.length, 2);
      assert.match(extraProblems[0], /^docs\/extra\.md: unlisted file under docs\//);
      assert.match(extraProblems[1], /^docs\/extra\.md: opens with a historical or superseded banner/);

      // Registering both hits in exceptions.json passes.
      repo.write(
        '.github/checks/exceptions.json',
        JSON.stringify(
          [
            { check: 'doc-set', path: 'docs/extra.md', what: 'unlisted', reason: 'pending G2', removeWhen: 'G2' },
            { check: 'doc-set', path: 'docs/extra.md', what: 'historical', reason: 'pending G2', removeWhen: 'G2' },
          ],
          null,
          2,
        ),
      );
      assert.deepEqual(docSetProblems(repo.root), []);

      // Deleting a declared file on disk without updating doc-set.json fails.
      rmSync(join(repo.root, 'docs/index.md'));
      const missingProblems = docSetProblems(repo.root);
      assert.equal(missingProblems.length, 1);
      assert.match(missingProblems[0], /^docs\/index\.md: listed in \.github\/checks\/doc-set\.json \(published\) but missing/);
    } finally {
      repo.cleanup();
    }
  });
});
