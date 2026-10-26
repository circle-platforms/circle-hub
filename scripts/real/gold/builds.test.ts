// Tests of the gold build-candidate script: reads build site listing pages independently of the Hub.
// Strictly imports nothing from hub/ or packs/. Synthetic listing page exercises:
// - Two name families: FAMX and FAMY
// - One alias: an FAMY build with based on resolving to its base FAMX build
// - One unreleased build: no release date (released is null)
// - One build of another version line: excluded when filtering by version line
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { type BuildCandidate, main, parseBuildCandidates, privatePath } from './builds.ts';

// Synthetic HTML listing page with:
// 1. Rel_FAMX_10_6_1_57 (FAMX, released 2026-05-14, command tree)
// 2. Rel_FAMX_10_6_1_56 (FAMX, unreleased, command tree)
// 3. Rel_FAMY_10_6_1_41 (FAMY alias, based on Rel_FAMX_10_6_1_57, released 2026-05-22, no command tree)
// 4. Rel_FAMX_10_7_4_101 (FAMX of another version line 10.7.4, released 2026-01-01)
const SYNTHETIC_LISTING_HTML = `<!DOCTYPE html>
<html>
<head><title>Synthetic Build Listing</title></head>
<body>
<h2>Demo builds</h2>
<hr />
<strong>Packages</strong><br /><br />
<font color=red>Rel_FAMX_10_6_1_57 (build on  2026-05-12 10:20:30 ): Released on 2026-05-14 </font> </br>
<BLOCKQUOTE>
  <A href=/builds/DemoOS-Rel_FAMX_10_6_1_57.array>DemoOS-Rel_FAMX_10_6_1_57.array ( 901M, SHA256: 0f1e... )</A><BR>
  <A href=/builds/command_tree-Rel_FAMX_10_6_1_57.xml>command_tree-Rel_FAMX_10_6_1_57.xml</A><BR>
</BLOCKQUOTE>

Rel_FAMX_10_6_1_56 (build on  2026-05-10 09:00:00 ):  </br>
<BLOCKQUOTE>
  <A href=/builds/DemoOS-Rel_FAMX_10_6_1_56.array>DemoOS-Rel_FAMX_10_6_1_56.array ( 899M, MD5: 0011... )</A><BR>
  <A href=/builds/command_tree-Rel_FAMX_10_6_1_56.xml>command_tree-Rel_FAMX_10_6_1_56.xml</A><BR>
</BLOCKQUOTE>

<font color=red>Rel_FAMY_10_6_1_41 (build on  2026-05-20 11:00:00 ): based on Rel_FAMX_10_6_1_57 Released on 2026-05-22 </font> </br>
<BLOCKQUOTE>
  <A href=/builds/DemoOS-Rel_FAMY_10_6_1_41.array>DemoOS-Rel_FAMY_10_6_1_41.array ( 902M, SHA256: 5555... )</A><BR>
  <A href=/builds/DEMO-MIB-Rel_FAMY_10_6_1_41.txt>DEMO-MIB-Rel_FAMY_10_6_1_41.txt</A><BR>
</BLOCKQUOTE>

<font color=red>Rel_FAMX_10_7_4_101 (build on  2026-01-01 08:00:00 ): Released on 2026-01-02 </font> </br>
<BLOCKQUOTE>
  <A href=/builds/DemoOS-Rel_FAMX_10_7_4_101.array>DemoOS-Rel_FAMX_10_7_4_101.array ( 850M, SHA256: aaaa... )</A><BR>
  <A href=/builds/command_tree-Rel_FAMX_10_7_4_101.xml>command_tree-Rel_FAMX_10_7_4_101.xml</A><BR>
</BLOCKQUOTE>
</body>
</html>`;

let tmpDir: string | undefined;
const writeTemp = (name: string, content: string): string => {
  tmpDir ??= mkdtempSync(join(tmpdir(), 'gold-builds-test-'));
  const filePath = join(tmpDir, name);
  writeFileSync(filePath, content, 'utf8');
  return filePath;
};

after(() => {
  if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true });
});

describe('parseBuildCandidates', () => {
  test('extracts builds of the version line with two families, resolves aliases, handles unreleased, and excludes other lines', () => {
    const candidates = parseBuildCandidates(SYNTHETIC_LISTING_HTML, '10.6.1');

    // Expected 3 candidates under line 10.6.1; Rel_FAMX_10_7_4_101 must be excluded.
    assert.equal(candidates.length, 3);

    const byName = new Map<string, BuildCandidate>(candidates.map((c) => [c.name, c]));

    // 1. FAMX released build
    const afamx57 = byName.get('Rel_FAMX_10_6_1_57');
    assert.ok(afamx57, 'Rel_FAMX_10_6_1_57 should be present');
    assert.equal(afamx57.family, 'FAMX');
    assert.equal(afamx57.base, 'Rel_FAMX_10_6_1_57');
    assert.equal(afamx57.released, '2026-05-14');

    // 2. FAMX unreleased build
    const afamx56 = byName.get('Rel_FAMX_10_6_1_56');
    assert.ok(afamx56, 'Rel_FAMX_10_6_1_56 should be present');
    assert.equal(afamx56.family, 'FAMX');
    assert.equal(afamx56.base, 'Rel_FAMX_10_6_1_56');
    assert.equal(afamx56.released, null);

    // 3. FAMY alias build: based on Rel_FAMX_10_6_1_57, no command tree
    const famy41 = byName.get('Rel_FAMY_10_6_1_41');
    assert.ok(famy41, 'Rel_FAMY_10_6_1_41 should be present');
    assert.equal(famy41.family, 'FAMY');
    assert.equal(famy41.base, 'Rel_FAMX_10_6_1_57');
    assert.equal(famy41.released, '2026-05-22');

    // 4. Other version line excluded
    assert.ok(!byName.has('Rel_FAMX_10_7_4_101'), 'build from another version line must be excluded');
  });

  test('every candidate carries the built time of the page and the based-on base', () => {
    const candidates = parseBuildCandidates(SYNTHETIC_LISTING_HTML, '10.6.1');
    const byName = new Map(candidates.map((c) => [c.name, c]));
    assert.equal(byName.get('Rel_FAMX_10_6_1_57')?.built, '2026-05-12T10:20:30');
    assert.equal(byName.get('Rel_FAMX_10_6_1_56')?.built, '2026-05-10T09:00:00');
    assert.equal(byName.get('Rel_FAMY_10_6_1_41')?.built, '2026-05-20T11:00:00');
  });

  test('a build whose header carries no readable build time gets built null and still lists', () => {
    const html = `
      Rel_FAMX_10_6_1_57 (build on 2026-05-12 10:20:30 ): Released on 2026-05-14
      <BLOCKQUOTE><A href=/builds/command_tree-Rel_FAMX_10_6_1_57.xml>tree</A></BLOCKQUOTE>
      Rel_FAMX_10_6_1_55 (build on 2026-13-40 10:00:00 ):
      <BLOCKQUOTE><A href=/builds/command_tree-Rel_FAMX_10_6_1_55.xml>tree</A></BLOCKQUOTE>
    `;
    const candidates = parseBuildCandidates(html, '10.6.1');
    const byName = new Map(candidates.map((c) => [c.name, c]));
    assert.equal(byName.get('Rel_FAMX_10_6_1_55')?.built, null);
  });

  test('an own-tree FAMY build is its own base despite based on, while tree-less aliases still follow their chain', () => {
    const html = `
      Rel_FAMX_10_8_2_91 (build on 2026-09-01 10:00:00 ): Released on 2026-09-02
      <BLOCKQUOTE><A href="http://192.0.2.71/command_tree-Rel_FAMX_10_8_2_91.xml">tree</A></BLOCKQUOTE>
      Rel_FAMY_10_8_2_92 (build on 2026-09-03 10:00:00 ): based on Rel_FAMX_10_8_2_91 Released on 2026-09-04
      <BLOCKQUOTE><A href="http://192.0.2.71/command_tree-Rel_FAMY_10_8_2_92.xml">own tree</A></BLOCKQUOTE>
      Rel_FAMY_10_8_2_93 (build on 2026-09-05 10:00:00 ): based on Rel_FAMX_10_8_2_91
      Rel_FAMY_10_8_2_94 (build on 2026-09-06 10:00:00 ): based on Rel_FAMY_10_8_2_92
    `;
    const candidates = parseBuildCandidates(html, '10.8.2');
    const byName = new Map(candidates.map(candidate => [candidate.name, candidate]));
    assert.equal(candidates.length, 4);
    assert.equal(byName.get('Rel_FAMY_10_8_2_92')?.base, 'Rel_FAMY_10_8_2_92');
    assert.equal(byName.get('Rel_FAMY_10_8_2_93')?.base, 'Rel_FAMX_10_8_2_91');
    assert.equal(byName.get('Rel_FAMY_10_8_2_94')?.base, 'Rel_FAMY_10_8_2_92');
    assert.equal(candidates.filter(candidate => candidate.base !== candidate.name).length, 2);
  });

  test('resolves alias chains when base build points to another alias or base', () => {
    const htmlWithChain = `
      Rel_FAMX_10_6_1_57 (build on 2026-05-12 10:20:30 ): Released on 2026-05-14
      <BLOCKQUOTE><A href=/builds/command_tree-Rel_FAMX_10_6_1_57.xml>tree</A></BLOCKQUOTE>
      Rel_FAMY_10_6_1_41 (build on 2026-05-20 11:00:00 ): based on Rel_FAMX_10_6_1_57 Released on 2026-05-22
      Rel_FAMY_10_6_1_42 (build on 2026-05-21 11:00:00 ): based on Rel_FAMY_10_6_1_41 Released on 2026-05-23
    `;
    const candidates = parseBuildCandidates(htmlWithChain, '10.6.1');
    const c42 = candidates.find((c) => c.name === 'Rel_FAMY_10_6_1_42');
    assert.ok(c42);
    assert.equal(c42.base, 'Rel_FAMX_10_6_1_57');
  });
});

describe('main CLI', () => {
  test('reads --page and writes --out JSON with exit code 0', async () => {
    const pagePath = writeTemp('test-listing.html', SYNTHETIC_LISTING_HTML);
    const outPath = join(tmpDir!, 'out.json');

    const code = await main(['--page', pagePath, '--line', '10.6.1', '--out', outPath]);
    assert.equal(code, 0);

    const written = JSON.parse(readFileSync(outPath, 'utf8')).candidates as BuildCandidate[];
    assert.equal(statSync(outPath).mode & 0o777, 0o600);
    assert.equal(await main(['--page', pagePath, '--line', '10.6.1', '--out', outPath]), 1);
    assert.equal(written.length, 3);
    assert.deepEqual(
      written.map((c) => c.name),
      ['Rel_FAMX_10_6_1_57', 'Rel_FAMX_10_6_1_56', 'Rel_FAMY_10_6_1_41'],
    );
  });

  test('returns 2 when required CLI arguments are missing', async () => {
    const code = await main(['--page', 'page.html']);
    assert.equal(code, 2);
  });

  test('returns 1 when page file does not exist', async () => {
    const code = await main(['--page', 'nonexistent-page.html', '--line', '10.6.1', '--out', 'out.json']);
    assert.equal(code, 2);
  });
});

describe('multiple listing pages and private output', () => {
  test('merges families before resolving cross-page alias chains and deduplicates names', async t => {
    const first = 'Rel_FAMX_10_8_1_11 (build on 2026-08-01 10:00:00 ):\n<BLOCKQUOTE><A href="command_tree.xml">tree</A></BLOCKQUOTE>';
    const second = 'Rel_FAMY_10_8_1_12 (build on unknown ): based on Rel_FAMX_10_8_1_11\nRel_FAMY_10_8_1_13 (build on 2026-08-02 10:00:00 ): based on Rel_FAMY_10_8_1_12';
    assert.equal(parseBuildCandidates([first], '10.8.1').length, 1);
    assert.equal(parseBuildCandidates([first, first, second], '10.8.1').length, 3, 'duplicate pages do not duplicate builds');
    assert.notEqual(parseBuildCandidates([second], '10.8.1').length, parseBuildCandidates([first, second], '10.8.1').length, 'the last page alone must not satisfy the two-page fixture');
    const page1 = writeTemp('family-one.html', first), page2 = writeTemp('family-two.html', second);
    const out = join(tmpDir!, 'multi.json');
    const screen: string[] = [];
    t.mock.method(process.stdout, 'write', (text: string | Uint8Array) => { screen.push(String(text)); return true; });
    assert.equal(await main(['--page', page1, '--page', page2, '--line', '10.8.1', '--out', out]), 0);
    const gold = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(gold.line, '10.8.1');
    assert.equal(gold.candidates.length, 3);
    assert.equal(gold.candidates.find((c: BuildCandidate) => c.name.endsWith('_13')).base, 'Rel_FAMX_10_8_1_11');
    assert.match(screen.join(''), /候选 3 个，FAMX 1、FAMY 2、别名 2、没有制作时间 1/);
    assert.ok(!screen.join('').includes('Rel_'));
  });
});

test('rejects repository paths and symlinks back into a checkout', () => {
  assert.throws(() => privatePath(new URL('./forbidden.json', import.meta.url).pathname));
  const link = join(tmpDir!, 'repo-link');
  symlinkSync(new URL('../../../', import.meta.url).pathname, link, 'dir');
  assert.throws(() => privatePath(join(link, 'forbidden.json')));
});

test('rejects a lexical repository path even when its symlink points outside', () => {
  const base = writeTemp('guard-placeholder', '');
  const fake = join(tmpDir!, 'synthetic-checkout');
  mkdirSync(fake); mkdirSync(join(fake, '.git'));
  symlinkSync(tmpDir!, join(fake, 'outside'), 'dir');
  assert.throws(() => privatePath(join(fake, 'outside', 'outside-result.json')));
  assert.ok(base);
});

test('location review 11: read refusals identify the page ordinal without printing its path', async t => {
  const screen: string[] = [];
  t.mock.method(process.stderr, 'write', (value: string | Uint8Array) => { screen.push(String(value)); return true; });
  const first = writeTemp('readable-page.html', SYNTHETIC_LISTING_HTML), missing = join(tmpDir!, 'private-source-name.html');
  assert.equal(await main(['--page', first, '--page', missing, '--line', '10.8.1', '--out', join(tmpDir!, 'never-created.json')]), 2);
  assert.match(screen.join(''), /第 2 个 --page.*读不到/); assert.ok(!screen.join('').includes('private-source-name'));
});

const PLATFORM_BUILDS = ['Rel_FAMX-SY-K_10_6_1_58', 'Beta_FAMY-SZ-Demoos10_10_6_1_59'];
const platformRows = PLATFORM_BUILDS.map(name => `${name} (build on 2026-05-23 10:00:00 ): Released on 2026-05-24\n<BLOCKQUOTE><A href="command_tree-${name}.xml">tree</A></BLOCKQUOTE>`).join('\n');
const MIXED_MAINLINE = SYNTHETIC_LISTING_HTML.replace('</body>', platformRows + '\n</body>');
const namesOf = (candidates: BuildCandidate[]) => candidates.map(candidate => candidate.name).sort();
const MAINLINE_NAMES = ['Rel_FAMX_10_6_1_57', 'Rel_FAMX_10_6_1_56', 'Rel_FAMY_10_6_1_41'].sort();

describe('platform candidates require page opt-in', () => {
  test('a mainline listing defaults to the main platform even when it links platform builds', () => {
    assert.deepEqual(namesOf(parseBuildCandidates(MIXED_MAINLINE, '10.6.1')), MAINLINE_NAMES);
  });
  test('a main-platform prefix or suffix is not a platform tag', () => {
    const name = 'DemoOS-Beta_FAMX_10_6_1_64.click';
    assert.deepEqual(namesOf(parseBuildCandidates(`${name} (build on 2026-05-27 10:00:00 ):`, '10.6.1')), [name]);
  });
  test('an opted-in platform alias still resolves its declared main-platform base across pages', () => {
    const alias = 'Rel_FAMY-SY-K_10_6_1_65';
    const pages = [{ name: 'main.html', html: SYNTHETIC_LISTING_HTML }, {
      name: 'platform.html', html: `${alias} (build on 2026-05-28 10:00:00 ): based on Rel_FAMX_10_6_1_57 Released on 2026-05-29`,
    }];
    assert.deepEqual(namesOf(parseBuildCandidates(pages, '10.6.1')), MAINLINE_NAMES);
    assert.equal(parseBuildCandidates(pages, '10.6.1', { include: ['platform.html'] }).find(candidate => candidate.name === alias)?.base, 'Rel_FAMX_10_6_1_57');
  });
  test('a case-insensitive page-name glob opts in platform builds from that page', () => {
    const candidates = parseBuildCandidates([{ name: 'rel_famx_10_6_1.html', html: MIXED_MAINLINE }], '10.6.1', { include: ['REL_FAMX_10_6_?.HTML'] });
    assert.deepEqual(namesOf(candidates), [...MAINLINE_NAMES, ...PLATFORM_BUILDS].sort());
    const platform = candidates.find(candidate => candidate.name === PLATFORM_BUILDS[0])!;
    assert.equal(platform.base, platform.name);
    assert.equal(platform.built, '2026-05-23T10:00:00');
    assert.equal(platform.released, '2026-05-24');
  });
  test('a build-name pattern does not opt in the page carrying that build', () => {
    assert.deepEqual(namesOf(parseBuildCandidates([{ name: 'rel_famx_10_6_1.html', html: MIXED_MAINLINE }], '10.6.1', { include: ['*SY-K*'] })), MAINLINE_NAMES);
  });
  test('opt-in stays local to its page and excludes take precedence for the whole page', () => {
    const extra = 'Rel_FAMX-ZX-Demoos11_10_6_1_63 (build on 2026-05-25 10:00:00 ): Released on 2026-05-26';
    const pages = [{ name: 'rel_famx_10_6_1.html', html: MIXED_MAINLINE }, { name: 'rel_famy_10_6_1.html', html: extra }];
    assert.deepEqual(namesOf(parseBuildCandidates(pages, '10.6.1', { include: ['rel_famx*'] })), [...MAINLINE_NAMES, ...PLATFORM_BUILDS].sort());
    assert.deepEqual(namesOf(parseBuildCandidates(pages, '10.6.1', { include: ['*'], exclude: ['REL_FAMX*'] })), ['Rel_FAMX-ZX-Demoos11_10_6_1_63']);
    assert.deepEqual(parseBuildCandidates(pages, '10.6.1', { include: ['*'], exclude: ['*'] }), []);
  });
  test('a non-opted-in newer copy cannot supply metadata for an opted-in platform build', () => {
    const pages = [{ name: 'included.html', html: MIXED_MAINLINE }, { name: 'other.html', html: MIXED_MAINLINE.replaceAll('2026-05-23', '2026-06-23') }];
    for (const order of [pages, [...pages].reverse()]) {
      const selected = parseBuildCandidates(order, '10.6.1', { include: ['included.html'] });
      assert.equal(selected.find(candidate => candidate.name === PLATFORM_BUILDS[0])?.built, '2026-05-23T10:00:00');
      assert.deepEqual(namesOf(selected), [...MAINLINE_NAMES, ...PLATFORM_BUILDS].sort());
    }
  });
  test('page globs treat regexp punctuation literally and still enforce the target version line', () => {
    const page = { name: 'main[1].html', html: MIXED_MAINLINE };
    assert.deepEqual(namesOf(parseBuildCandidates([page], '10.6.1', { include: ['main[1].html'] })), [...MAINLINE_NAMES, ...PLATFORM_BUILDS].sort());
    assert.deepEqual(namesOf(parseBuildCandidates([page], '10.6.1', { include: ['main?.html'] })), MAINLINE_NAMES);
    assert.deepEqual(parseBuildCandidates([page], '10.9.1', { include: ['*'] }), []);
  });
  test('page selection rejects unidentified inputs instead of silently granting a global platform opt-in', () => {
    assert.throws(() => parseBuildCandidates(MIXED_MAINLINE, '10.6.1', { include: ['*'] }), /页名/);
    assert.throws(() => parseBuildCandidates([{ name: '', html: MIXED_MAINLINE }], '10.6.1', { include: ['*'] }), /页名/);
  });
});

test('CLI include/exclude globs use page filenames and keep output private and count-only', async t => {
  const page = writeTemp('rel_famx_10_6_1.html', MIXED_MAINLINE);
  const screen: string[] = [];
  t.mock.method(process.stdout, 'write', (value: string | Uint8Array) => { screen.push(String(value)); return true; });
  for (const [suffix, flags, expected] of [
    ['default', [], 3],
    ['included', ['--include', 'REL_FAMX_10_6_?.HTML'], 5],
    ['repeated', ['--include', 'missing*', '--include', 'rel_famx*'], 5],
    ['excluded', ['--include', '*', '--exclude', 'rel_famx*'], 0],
    ['wrong-page', ['--include', '*SY-K*'], 3],
  ] as const) {
    const out = join(tmpDir!, `platform-${suffix}.json`);
    assert.equal(await main(['--page', page, ...flags, '--line', '10.6.1', '--out', out]), 0);
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).candidates.length, expected);
    assert.equal(statSync(out).mode & 0o777, 0o600);
  }
  assert.ok(!screen.join('').includes('Rel_'));
  assert.ok(!screen.join('').includes(tmpDir!));
});
