// Tests of the gold build-candidate script: reads build site listing pages independently of the Hub.
// Strictly imports nothing from hub/ or packs/. Synthetic listing page exercises:
// - Two name families: APV and NSAE
// - One alias: an NSAE build with based on resolving to its base APV build
// - One unreleased build: no release date (released is null)
// - One build of another version line: excluded when filtering by version line
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { type BuildCandidate, main, parseBuildCandidates, privatePath } from './builds.ts';

// Synthetic HTML listing page with:
// 1. Rel_APV_10_6_1_57 (APV, released 2026-05-14, command tree)
// 2. Rel_APV_10_6_1_56 (APV, unreleased, command tree)
// 3. Rel_NSAE_10_6_1_41 (NSAE alias, based on Rel_APV_10_6_1_57, released 2026-05-22, no command tree)
// 4. Rel_APV_10_7_4_101 (APV of another version line 10.7.4, released 2026-01-01)
const SYNTHETIC_LISTING_HTML = `<!DOCTYPE html>
<html>
<head><title>Synthetic Build Listing</title></head>
<body>
<h2>Demo builds</h2>
<hr />
<strong>Packages</strong><br /><br />
<font color=red>Rel_APV_10_6_1_57 (build on  2026-05-12 10:20:30 ): Released on 2026-05-14 </font> </br>
<BLOCKQUOTE>
  <A href=/builds/DemoOS-Rel_APV_10_6_1_57.array>DemoOS-Rel_APV_10_6_1_57.array ( 901M, SHA256: 0f1e... )</A><BR>
  <A href=/builds/command_tree-Rel_APV_10_6_1_57.xml>command_tree-Rel_APV_10_6_1_57.xml</A><BR>
</BLOCKQUOTE>

Rel_APV_10_6_1_56 (build on  2026-05-10 09:00:00 ):  </br>
<BLOCKQUOTE>
  <A href=/builds/DemoOS-Rel_APV_10_6_1_56.array>DemoOS-Rel_APV_10_6_1_56.array ( 899M, MD5: 0011... )</A><BR>
  <A href=/builds/command_tree-Rel_APV_10_6_1_56.xml>command_tree-Rel_APV_10_6_1_56.xml</A><BR>
</BLOCKQUOTE>

<font color=red>Rel_NSAE_10_6_1_41 (build on  2026-05-20 11:00:00 ): based on Rel_APV_10_6_1_57 Released on 2026-05-22 </font> </br>
<BLOCKQUOTE>
  <A href=/builds/DemoOS-Rel_NSAE_10_6_1_41.array>DemoOS-Rel_NSAE_10_6_1_41.array ( 902M, SHA256: 5555... )</A><BR>
  <A href=/builds/DEMO-MIB-Rel_NSAE_10_6_1_41.txt>DEMO-MIB-Rel_NSAE_10_6_1_41.txt</A><BR>
</BLOCKQUOTE>

<font color=red>Rel_APV_10_7_4_101 (build on  2026-01-01 08:00:00 ): Released on 2026-01-02 </font> </br>
<BLOCKQUOTE>
  <A href=/builds/DemoOS-Rel_APV_10_7_4_101.array>DemoOS-Rel_APV_10_7_4_101.array ( 850M, SHA256: aaaa... )</A><BR>
  <A href=/builds/command_tree-Rel_APV_10_7_4_101.xml>command_tree-Rel_APV_10_7_4_101.xml</A><BR>
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

    // Expected 3 candidates under line 10.6.1; Rel_APV_10_7_4_101 must be excluded.
    assert.equal(candidates.length, 3);

    const byName = new Map<string, BuildCandidate>(candidates.map((c) => [c.name, c]));

    // 1. APV released build
    const apv57 = byName.get('Rel_APV_10_6_1_57');
    assert.ok(apv57, 'Rel_APV_10_6_1_57 should be present');
    assert.equal(apv57.family, 'APV');
    assert.equal(apv57.base, 'Rel_APV_10_6_1_57');
    assert.equal(apv57.released, '2026-05-14');

    // 2. APV unreleased build
    const apv56 = byName.get('Rel_APV_10_6_1_56');
    assert.ok(apv56, 'Rel_APV_10_6_1_56 should be present');
    assert.equal(apv56.family, 'APV');
    assert.equal(apv56.base, 'Rel_APV_10_6_1_56');
    assert.equal(apv56.released, null);

    // 3. NSAE alias build: based on Rel_APV_10_6_1_57, no command tree
    const nsae41 = byName.get('Rel_NSAE_10_6_1_41');
    assert.ok(nsae41, 'Rel_NSAE_10_6_1_41 should be present');
    assert.equal(nsae41.family, 'NSAE');
    assert.equal(nsae41.base, 'Rel_APV_10_6_1_57');
    assert.equal(nsae41.released, '2026-05-22');

    // 4. Other version line excluded
    assert.ok(!byName.has('Rel_APV_10_7_4_101'), 'build from another version line must be excluded');
  });

  test('every candidate carries the built time of the page and the based-on base', () => {
    const candidates = parseBuildCandidates(SYNTHETIC_LISTING_HTML, '10.6.1');
    const byName = new Map(candidates.map((c) => [c.name, c]));
    assert.equal(byName.get('Rel_APV_10_6_1_57')?.built, '2026-05-12T10:20:30');
    assert.equal(byName.get('Rel_APV_10_6_1_56')?.built, '2026-05-10T09:00:00');
    assert.equal(byName.get('Rel_NSAE_10_6_1_41')?.built, '2026-05-20T11:00:00');
  });

  test('a build whose header carries no readable build time gets built null and still lists', () => {
    const html = `
      Rel_APV_10_6_1_57 (build on 2026-05-12 10:20:30 ): Released on 2026-05-14
      <BLOCKQUOTE><A href=/builds/command_tree-Rel_APV_10_6_1_57.xml>tree</A></BLOCKQUOTE>
      Rel_APV_10_6_1_55 (build on 2026-13-40 10:00:00 ):
      <BLOCKQUOTE><A href=/builds/command_tree-Rel_APV_10_6_1_55.xml>tree</A></BLOCKQUOTE>
    `;
    const candidates = parseBuildCandidates(html, '10.6.1');
    const byName = new Map(candidates.map((c) => [c.name, c]));
    assert.equal(byName.get('Rel_APV_10_6_1_55')?.built, null);
  });

  test('resolves alias chains when base build points to another alias or base', () => {
    const htmlWithChain = `
      Rel_APV_10_6_1_57 (build on 2026-05-12 10:20:30 ): Released on 2026-05-14
      <BLOCKQUOTE><A href=/builds/command_tree-Rel_APV_10_6_1_57.xml>tree</A></BLOCKQUOTE>
      Rel_NSAE_10_6_1_41 (build on 2026-05-20 11:00:00 ): based on Rel_APV_10_6_1_57 Released on 2026-05-22
      Rel_NSAE_10_6_1_42 (build on 2026-05-21 11:00:00 ): based on Rel_NSAE_10_6_1_41 Released on 2026-05-23
    `;
    const candidates = parseBuildCandidates(htmlWithChain, '10.6.1');
    const c42 = candidates.find((c) => c.name === 'Rel_NSAE_10_6_1_42');
    assert.ok(c42);
    assert.equal(c42.base, 'Rel_APV_10_6_1_57');
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
      ['Rel_APV_10_6_1_57', 'Rel_APV_10_6_1_56', 'Rel_NSAE_10_6_1_41'],
    );
  });

  test('returns 2 when required CLI arguments are missing', async () => {
    const code = await main(['--page', 'page.html']);
    assert.equal(code, 2);
  });

  test('returns 1 when page file does not exist', async () => {
    const code = await main(['--page', 'nonexistent-page.html', '--line', '10.6.1', '--out', 'out.json']);
    assert.equal(code, 1);
  });
});

describe('multiple listing pages and private output', () => {
  test('merges families before resolving cross-page alias chains and deduplicates names', async t => {
    const first = 'Rel_APV_10_8_1_11 (build on 2026-08-01 10:00:00 ):\n<BLOCKQUOTE><A href="command_tree.xml">tree</A></BLOCKQUOTE>';
    const second = 'Rel_NSAE_10_8_1_12 (build on unknown ): based on Rel_APV_10_8_1_11\nRel_NSAE_10_8_1_13 (build on 2026-08-02 10:00:00 ): based on Rel_NSAE_10_8_1_12';
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
    assert.equal(gold.candidates.find((c: BuildCandidate) => c.name.endsWith('_13')).base, 'Rel_APV_10_8_1_11');
    assert.match(screen.join(''), /候选 3 个，APV 1、NSAE 2、别名 2、没有制作时间 1/);
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
