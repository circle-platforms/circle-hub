// Checks of the docs package against the repository: see docs-rules.ts for what each rule means.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
// The generated vocabulary itself (architecture section 2 names it as the source of labels); it needs only zod, so a
// mid-edit elsewhere in contracts/src cannot stop these checks.
import { AXES } from '../../contracts/generated/vocabulary.ts';
import {
  decisionSourceProblems,
  isHistorical,
  linkProblems,
  localPathProblems,
  pendingSummaryProblems,
  REPOSITORY,
  vocabularyTableProblems,
  type Pending,
  type Site,
} from './docs-rules.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

function walk(dir: string, skip: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    if (skip(name)) continue;
    const path = `${dir}/${name}`;
    if (statSync(join(ROOT, path)).isDirectory()) out.push(...walk(path, skip));
    else out.push(path);
  }
  return out;
}

/** The exclude list of docs/_config.yml, matched the way Jekyll matches it (prefix of the path relative to docs/). */
function siteExcludes(): string[] {
  const block = /^exclude:\n((?:[ \t]+.*\n|\n)+)/m.exec(read('docs/_config.yml'));
  assert.ok(block, 'docs/_config.yml has an exclude list');
  return [...block[1].matchAll(/^\s+-\s+(\S+)\s*$/gm)].map((m) => m[1]);
}

const EXCLUDES = siteExcludes();
// Jekyll skips names that start with _ or . (its own folders, vendor bundles) besides the exclude list.
const jekyllSkips = (name: string): boolean => name.startsWith('_') || name.startsWith('.') || name === 'vendor';

const REPO_SITE: Site = {
  kind(path) {
    const full = join(ROOT, path);
    if (!existsSync(full)) return undefined;
    return statSync(full).isDirectory() ? 'dir' : 'file';
  },
  published(path) {
    if (!path.startsWith('docs/') || !existsSync(join(ROOT, path))) return false;
    const inside = path.slice('docs/'.length);
    if (inside.split('/').some(jekyllSkips)) return false;
    return !EXCLUDES.some((entry) => inside.startsWith(entry));
  },
};

const PUBLISHED_PAGES = walk('docs', jekyllSkips).filter((p) => p.endsWith('.md') && REPO_SITE.published(p));
const CURRENT_PAGES = PUBLISHED_PAGES.filter((p) => !isHistorical(read(p)));

describe('links the docs site can serve', () => {
  const fake: Site = {
    kind: (path) => (['docs/a.md', 'docs/hidden.md', 'contracts/model.json', 'LICENSE'].includes(path) ? 'file' : path === 'docs/sub' ? 'dir' : undefined),
    published: (path) => path === 'docs/a.md',
  };

  it('refuses a relative link that leaves docs/, a missing target, an excluded page and a link to a file main will not have', () => {
    const page = [
      '[model](../contracts/model.json)',
      '[gone](missing.md)',
      '[hidden](hidden.md)',
      '[no page](sub/)',
      `[typo](${REPOSITORY}/blob/main/contracts/modle.json)`,
      '[site root](/design/)',
    ].join('\n');
    const problems = linkProblems('docs/index.md', page, fake);
    assert.equal(problems.length, 6, problems.join('\n'));
    assert.match(problems[0], /leaves docs\/.*blob\/main\/contracts\/model\.json/);
  });

  it('accepts pages, anchors, other sites, absolute links to files on main, and anything in code', () => {
    const page = [
      '[page](a.md#part) [here](#top) [web](https://example.com/x)',
      `[model](${REPOSITORY}/blob/main/contracts/model.json) [license](${REPOSITORY}/blob/main/LICENSE)`,
      '`[not a link](../outside.md)`',
      '```',
      '[not a link either](../outside.md)',
      '```',
    ].join('\n');
    assert.deepEqual(linkProblems('docs/index.md', page, fake), []);
  });

  it('finds the current published pages and leaves out the records', () => {
    assert.ok(CURRENT_PAGES.includes('docs/index.md'));
    assert.ok(CURRENT_PAGES.includes('docs/design/generic-model.md'));
    assert.ok(!CURRENT_PAGES.includes('docs/server-s2-progress.md'), 'historical pages keep their original links');
    assert.ok(!PUBLISHED_PAGES.includes('docs/README.md'), 'docs/README.md is the GitHub index and not on the site');
  });

  for (const page of CURRENT_PAGES) {
    it(`${page}: every link works on the site`, () => {
      assert.deepEqual(linkProblems(page, read(page), REPO_SITE), []);
    });
  }
});

describe('vocabulary tables equal the generated vocabulary', () => {
  const axes = AXES as unknown as Record<string, { label: string; values: readonly { code: string; label: string }[] }>;

  it('reports a stale row', () => {
    assert.deepEqual(vocabularyTableProblems('| `partition` | 分区 | 已交付、已拒收、已隔离 |', 'zh', axes), [
      'partition: values 已交付、已拒收、已隔离, generated 已交付、已拒收、已隔离、未完成',
    ]);
    assert.deepEqual(vocabularyTableProblems('| `nature` | 本性 | 事实、判断、未知 |', 'zh', axes), ['nature: label "本性", generated "性质"']);
    assert.deepEqual(vocabularyTableProblems('| `nature` | `fact`, `unknown`, `judgment` |', 'en', axes), [
      'nature: codes fact, unknown, judgment, generated fact, judgment, unknown',
    ]);
    assert.deepEqual(vocabularyTableProblems('| `verdicts` | x | y |', 'zh', axes), ['verdicts: not a vocabulary axis']);
    assert.deepEqual(vocabularyTableProblems('no table', 'zh', axes), ['no vocabulary table row found']);
  });

  it('docs/design/generic-model.md', () => {
    assert.deepEqual(vocabularyTableProblems(read('docs/design/generic-model.md'), 'zh', axes), []);
  });

  it('docs/design/en/generic-model.md', () => {
    assert.deepEqual(vocabularyTableProblems(read('docs/design/en/generic-model.md'), 'en', axes), []);
  });
});

describe('decided and deferred pending items match the model', () => {
  const pending = (JSON.parse(read('contracts/model.json')) as { pendingDecisions: Pending[] }).pendingDecisions;
  const sample: Pending[] = [
    { item: '甲', status: '已定' },
    { item: '乙', status: '暂缓' },
  ];

  it('reports a page that calls every item decided', () => {
    assert.deepEqual(pendingSummaryProblems('模型的 2 项待定已全部按推荐定下。', 'zh', sample), [
      'the page does not state how many pending items are decided and how many deferred',
    ]);
    assert.deepEqual(pendingSummaryProblems('模型的 2 项待定都按推荐处理：2 项已定，0 项暂缓（乙）。', 'zh', sample), [
      'states 2 decided, the model has 1',
      'states 0 deferred, the model has 1',
    ]);
    assert.deepEqual(pendingSummaryProblems('模型的 2 项待定都按推荐处理：1 项已定，1 项按推荐暂缓。', 'zh', sample), ['does not name the deferred item "乙"']);
    assert.deepEqual(pendingSummaryProblems('All 2 pending items were settled: 1 are decided and 1 are deferred.', 'en', sample), []);
  });

  for (const [page, lang] of [
    ['docs/design/generic-model.md', 'zh'],
    ['docs/design/en/generic-model.md', 'en'],
    ['docs/hub-r4-progress.md', 'zh'],
  ] as const) {
    it(page, () => {
      assert.deepEqual(pendingSummaryProblems(read(page), lang, pending), []);
    });
  }
});

describe('recorded decisions name their source', () => {
  it('reports a decision without a source', () => {
    assert.deepEqual(decisionSourceProblems('## 决定\n\n1. **甲**（来源：模型）：…\n2. **乙**：…\n\n## 其他\n'), ['decision 2 names no source (来源：…)']);
  });

  it('docs/hub-r4-progress.md', () => {
    assert.deepEqual(decisionSourceProblems(read('docs/hub-r4-progress.md')), []);
  });
});

describe('no local paths in the files the docs package owns', () => {
  it('reports home directories and paths below them, not tool locations', () => {
    const home = '~' + '/Public/work';
    const user = '/' + 'Users/someone/repo';
    assert.equal(localPathProblems('x.md', `a ${home} b\nc ${user}`).length, 2);
    assert.deepEqual(localPathProblems('x.md', 'tool config lives in ~/.claude/skills and ~/... or ~/…'), []);
  });

  const owned = [
    ...walk('docs', (name) => name === 'vendor' || name === '_site' || name === '.bundle'),
    ...readdirSync(ROOT).filter((name) => name.endsWith('.md')),
    ...walk('.github', () => false),
  ].filter((path) => /\.(md|ya?ml|ts|json|html|txt)$/.test(path));

  it('covers the owned files', () => {
    assert.ok(owned.includes('AGENTS.md') && owned.includes('docs/index.md') && owned.includes('.github/workflows/checks.yml'));
  });

  it('none has a local path', () => {
    assert.deepEqual(owned.flatMap((path) => localPathProblems(path, read(path))), []);
  });
});
