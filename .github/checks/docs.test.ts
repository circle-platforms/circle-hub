// Checks of the docs package against the repository: see docs-rules.ts for what each rule means.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, lstatSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
// The generated vocabulary itself (architecture section 2 names it as the source of labels); it needs only zod, so a
// mid-edit elsewhere in contracts/src cannot stop these checks.
import { AXES } from '../../contracts/generated/vocabulary.ts';
import {
  trackedFileText,
  buildNameProblems,
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

// Git's inventory covers code, tests, ops, dot-directories and extensionless text without scanning dependencies or build output.
const TRACKED_TEXT = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0')
  .filter((path) => path && !path.startsWith('foundation/') && !path.startsWith('references/'))
  .flatMap((path) => {
    let byteDigest: string | undefined;
    const text = trackedFileText(join(ROOT, path), bytes => { byteDigest = createHash('sha256').update(bytes).digest('hex'); });
    return text === null ? [] : [{ path, text, byteDigest }];
  });

describe('tracked blobs are never skipped because of NULs or symbolic links', () => {
  it('checks NUL-bearing Markdown and UTF-16 ASCII shapes as text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-hygiene-nul-'));
    try {
      const path = join(dir, 'fixture.md');
      const home = '/' + 'Users/operator/project';
      const build = ['Rel', 'Synthetic', '10', '4', '2'].join('_');
      writeFileSync(path, Buffer.from(home + '\n' + build, 'utf16le'));
      let byteDigest: string | undefined;
      const text = trackedFileText(path, bytes => { byteDigest = createHash('sha256').update(bytes).digest('hex'); })!;
      assert.equal(byteDigest, createHash('sha256').update(readFileSync(path)).digest('hex'));
      assert.notEqual(byteDigest, createHash('sha256').update(text).digest('hex'));
      assert.equal(localPathProblems('fixture.md', text).length, 1);
      assert.equal(buildNameProblems('fixture.md', text).length, 1);
      assert.ok(!text.includes('\0'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('checks a dangling symlink target without following it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-hygiene-link-'));
    try {
      const path = join(dir, 'fixture.md');
      const target = '/' + 'Users/operator/missing';
      symlinkSync(target, path);
      assert.equal(trackedFileText(path), target);
      assert.equal(localPathProblems('fixture.md', trackedFileText(path)!).length, 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('no machine paths in repository text', () => {
  it('reports user homes, root and variable-data paths with their line numbers', () => {
    const paths = ['/' + 'Users/operator/repo', '/' + 'home/operator/repo', '/' + 'root/work', '/' + 'var/private/work', 'file://' + '/' + 'Users/operator/repo', '~' + '/Public/work', 'C:' + String.fromCharCode(92) + 'Users' + String.fromCharCode(92) + 'operator'];
    for (const file of ['docs/page.md', 'hub/example.ts', 'tests/example.test.ts', 'ops/example.sh']) {
      const problems = localPathProblems(file, 'header\n' + paths.join('\n'));
      assert.equal(problems.length, paths.length, file);
      assert.ok(problems[0].startsWith(`${file}:2:`));
    }
  });

  it('finds mounted homes, macOS private variable paths and escaped Windows homes', () => {
    const slash = String.fromCharCode(92);
    const paths = [
      '/' + 'mnt/c/' + 'Users/operator/project', '/' + 'c/' + 'Users/operator/project',
      '/' + 'System/Volumes/Data/' + 'Users/operator/project', '/' + 'mnt/' + 'home/operator/project',
      '/' + 'private/' + 'var/folders/ab/synthetic/T/tmp',
      ...['C:', 'c:'].flatMap(drive => [1, 2].map(n => drive + slash.repeat(n) + 'Users' + slash.repeat(n) + 'operator')),
    ];
    for (const path of paths) assert.equal(localPathProblems('hub/example.ts', path).length, 1, path);
  });

  it('recognizes Windows Users casing and forward slashes without case-folding POSIX paths', () => {
    const slash = String.fromCharCode(92);
    for (const path of ['c:' + slash + 'users' + slash + 'operator/project', 'C:' + slash + 'USERS' + slash + 'operator', 'C:' + '/' + 'users/operator/project', 'c:' + slash.repeat(2) + 'uSeRs' + slash.repeat(2) + 'operator']) {
      assert.equal(localPathProblems('code/example.ts', path).length, 1, path);
    }
    assert.deepEqual(localPathProblems('docs/example.md', '/' + 'users/operator/project'), []);
    assert.deepEqual(localPathProblems('docs/example.md', 'https://example.com/users/operator/project'), []);
  });

  it('ignores network URLs without hiding file URLs or an adjacent local path', () => {
    for (const text of ['see https://example.com/home/docs/start', 'https://api.example.com/v1/Users/42/profile', '`https://example.com/home/docs`', '[page](https://example.com/home/docs)']) {
      assert.deepEqual(localPathProblems('docs/example.md', text), [], text);
    }
    assert.equal(localPathProblems('docs/example.md', 'file://' + '/' + 'home/operator/x').length, 1);
    assert.equal(localPathProblems('docs/example.md', 'https://example.com/home/docs ' + '/' + 'home/operator/x').length, 1);
  });

  it('rejects local homes hidden behind non-network and loopback URL forms', () => {
    const home='/'+'Users/synthetic/project';
    const probes=[
      'http://127.0.0.1:7521/open?path='+home,
      'pip install git+file://'+'/'+'home/synthetic/repo',
      'txmt://open?url=file://'+home,
      'open vscode://file'+home,
      'at http://localhost:5173/@fs'+home,
      'http://[::1]:7521'+home,
      'https://example.com/open?path='+home,
      'https://example.com/#'+home,
      'https://example.com/@fs'+home,
    ];
    for(const value of probes)assert.equal(localPathProblems('docs/example.md',value).length,1,value);
    for(const scheme of ['http','https','ftp','ftps'])assert.deepEqual(localPathProblems('docs/example.md',scheme+'://example.com'+'/'+'home/docs'),[]);
  });

  it('accepts network URL paths adjoining prose and punctuation without hiding adjacent machine paths', () => {
    for(const value of ['参见https://example.com/home/docs/start','链接：https://api.example.com/v1/Users/42/profile','文档（https://example.com/home/docs）','URL:https://example.com/home/docs','|https://example.com/home/docs|','name,https://example.com/home/docs','**https://example.com/home/docs**'])assert.deepEqual(localPathProblems('docs/example.md',value),[],value);
    for(const prefix of ['[x](https://example.com)','参见https://example.com，'])assert.equal(localPathProblems('docs/example.md',prefix+'/'+'home/synthetic/project').length,1,prefix);
  });

  it('requires a drive-letter boundary while keeping file URL and quoted Windows homes checked', () => {
    for(const value of ["router.on('GET:/users/:id', h)",'method=GET path:/users/42 status=200','rsync -a backup:/users/shared/ .'])assert.deepEqual(localPathProblems('code/example.ts',value),[],value);
    const slash=String.fromCharCode(92);
    for(const value of ['file:///c:'+'/'+'users/synthetic','"C:'+slash+'users'+slash+'synthetic"'])assert.equal(localPathProblems('code/example.ts',value).length,1,value);
  });

  it('does not carry a URL exemption across following non-ASCII prose', () => {
    for(const value of ['访问https://example.com/后在'+'/'+'home/synthetic/repo'+'下运行','打开http://192.0.2.1:8000/再看'+'/'+'Users/synthetic/project'])assert.equal(localPathProblems('docs/example.md',value).length,1,value);
  });

  it('detects Windows homes attached to compiler and archive switches', () => {
    const slash=String.fromCharCode(92),home='C:'+slash+'Users'+slash+'synthetic'+slash;
    for(const value of ['gcc -I'+home+'include a.c','7z x a.7z -o'+home+'out','cl /Fo'+home+'obj'+slash+' a.c'])assert.equal(localPathProblems('hub/example.test.ts',value).length,1,value);
  });

  it('keeps normalized local hosts out of network URL exemptions', () => {
    const home='/'+'Users/synthetic/project';
    for(const host of ['0.0.0.0:8000','127.1:8000','localhost.:8000','app.localhost:5173','[0:0:0:0:0:0:0:1]:8000','[::]:8000','[::ffff:127.0.0.1]:8000','reader@localhost:8000','[not-an-ip]:8000'])assert.equal(localPathProblems('docs/example.md','http://'+host+home).length,1,host);
    for(const host of ['example.com','192.0.2.1:8000','[2001:db8::1]:8000'])assert.deepEqual(localPathProblems('docs/example.md','http://'+host+home),[],host);
  });

  it('accepts only explicit synthetic fixtures in their named tests and generic tool paths', () => {
    for (const [file, path] of [
      ['hub/platform/layout.test.ts', '/' + 'Users/someone/repo'],
      ['hub/platform/launchd.test.ts', '/' + 'Users/someone/repo'],
      ['hub/platform/environment.test.ts', '/' + 'Users/x'],
      ['contracts/src/tool-shapes.test.ts', '/' + 'Users/alice/review'],
      ['hub/records/scan.test.ts', '/' + 'home/synthetic/project'],
      ['hub/records/scan.test.ts', '/' + 'home/user'],
      ['hub/config/config.test.ts', '/' + 'var/log/hub'],
    ]) {
      assert.deepEqual(localPathProblems(file, path), []);
      assert.equal(localPathProblems('hub/other.test.ts', path).length, 1);
      assert.equal(localPathProblems(file, path.replace(/(someone|alice|synthetic|user|hub|x)(?=\/|$)/, '$1-other')).length, 1);
    }
    assert.deepEqual(localPathProblems('x.md', 'tool config lives in ~/.claude/skills and ~/... or ~/…; ~/Library/LaunchAgents; /usr/bin/node; /srv/mirror; /old/root/backups; /moved/var/cache; replace(/~/g, token)'), []);
  });

  it('accepts the upstream synthetic example only at its pinned vendor path and byte digest', () => {
    const file = 'packs/product/famx/functions/adoc/vendor/core.mjs';
    const text = readFileSync(join(ROOT, file), 'utf8');
    const digest = createHash('sha256').update(text).digest('hex');
    assert.deepEqual(localPathProblems(file, text, digest), []);
    assert.ok(localPathProblems(file, text, createHash('sha256').update(text + '\0').digest('hex')).length > 0);
    assert.ok(localPathProblems('packs/product/other/functions/vendor/core.mjs', text, digest).length > 0);
    assert.ok(localPathProblems(file, text + '\n', digest).length > 0);
    assert.ok(localPathProblems(file, text + '\n/' + 'Users/operator/project', digest).length > 0);
  });

  it('covers docs, root Markdown, CI, code and tests without reading the frozen archives', () => {
    for (const path of ['AGENTS.md', 'docs/index.md', '.github/workflows/checks.yml', 'hub/server/units.test.ts', 'scripts/real/gold/regression-doc.test.ts', 'tests/acceptance/26-review-report.test.ts']) {
      assert.ok(TRACKED_TEXT.some((entry) => entry.path === path), path);
    }
    assert.ok(TRACKED_TEXT.every(({ path }) => !/^(foundation|references)\//.test(path)));
  });

  it('no tracked text has an unapproved machine path', () => {
    assert.deepEqual(TRACKED_TEXT.flatMap(({ path, text, byteDigest }) => localPathProblems(path, text, byteDigest)), []);
  });
});

describe('no protected build names in repository text', () => {
  it('reports both prefixes and every protected minor line with any name family', () => {
    for (const prefix of ['Rel', 'Beta']) for (let minor = 0; minor <= 5; minor++) {
      const name = [prefix, 'SampleFamily', '10', minor, '7', 'build'].join('_');
      assert.deepEqual(buildNameProblems('ops/sample.txt', 'header\n' + name), [
        `ops/sample.txt:2: protected build name ${JSON.stringify(name)}`,
      ]);
    }
  });

  it('reports protected build names in any case and without a patch suffix', () => {
    for (const prefix of ['rel', 'REL', 'bEtA']) for (let minor = 0; minor <= 5; minor++) {
      for (const parts of [[prefix, 'Synthetic', '10', String(minor)], [prefix, 'Synthetic', '10', String(minor), '2']]) {
        const name = parts.join('_');
        assert.equal(buildNameProblems('ops/sample.txt', name).length, 1, name);
      }
    }
    for (const name of [['rel', 'Synthetic', '10', '6', '0'], ['BETA', 'Synthetic', '11', '5', '0'], ['rel', 'Synthetic', '10', '50']].map(p => p.join('_'))) {
      assert.deepEqual(buildNameProblems('ops/sample.txt', name), []);
    }
  });

  it('accepts other lines, dotted labels, placeholders and the frozen archives', () => {
    for (const name of [ ['Rel', 'Sample', '10', '6', '0'].join('_'), ['Beta', 'Sample', '11', '0', '0'].join('_'), '10.6.2', 'Rel_<family>_<line>_<build>' ]) {
      assert.deepEqual(buildNameProblems('ops/sample.txt', name), []);
    }
    const protectedName = ['Rel', 'Sample', '10', '0', '0'].join('_');
    for (const file of ['foundation/sample.txt', 'references/sample.txt']) {
      assert.deepEqual(buildNameProblems(file, protectedName), []);
      assert.deepEqual(localPathProblems(file, '/' + 'root/work'), []);
    }
    assert.equal(buildNameProblems('hub/sample.ts', protectedName).length, 1);
  });

  it('no tracked text outside the frozen archives has a protected build name', () => {
    assert.deepEqual(TRACKED_TEXT.flatMap(({ path, text }) => buildNameProblems(path, text)), []);
  });
});
