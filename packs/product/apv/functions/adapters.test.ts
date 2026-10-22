// The product@1 entry points of product.json: the sync plan over rounds of pages, the build choice, the three producers,
// checked against the contract shapes (contracts/src/product.ts) and run unchanged in the Hub sandbox.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { ProducerOutput, ProductDeclaration, SelectBuildOutput, SyncPlanOutput, type KnownBuild } from '../../../../contracts/src/product.ts';
import { callPackFunction, osIsolationAvailable } from '../../../../hub/rules/api.ts';
import { fileKey as siteFileKey } from '../../../system/build-site/functions/reads.ts';
import { assertTotal, fixtureBytes, hostileInputs, html, markdown, xml } from '../testing/test-support.ts';
import { documentLines, folderLine, folderNames } from './documents.ts';
import { fixedBugEntries } from './fixed-bugs.ts';
import { commandTree, manual, releaseNotes } from './producers.ts';
import select, { chooseBuild } from './select.ts';
import { INDEX_ID, fileId, fileKey, listingId } from './sources.ts';
import syncPlan, { isoTime, planBuilds } from './sync.ts';
import { readFileSync } from 'node:fs';

const PACK_DIR = fileURLToPath(new URL('../', import.meta.url));
const product = ProductDeclaration.parse(JSON.parse(readFileSync(new URL('../product.json', import.meta.url), 'utf8')));

/** The fixture site by page name: the index, a hub page and four listing pages; every other linked page is a dead link. */
const SITE: Record<string, string> = {
  index: 'index.html',
  apv_10_6_2: 'hub-apv_10_6_2.html',
  rel_apv_10_6_1: 'listing-apv.html',
  rel_nsae_10_6_1: 'listing-nsae.html',
  rel_apv_10_6_2: 'listing-apv-new-line.html',
  rel_nsae_10_6_2: 'listing-nsae-new-line.html',
};

type Read = { ok: boolean; media_type: string | null; parser: string | null; model: unknown; reason: string | null };

function page(id: string): Read {
  const name = id.slice('buildsite:listing:'.length);
  const file = SITE[name];
  return file === undefined
    ? { ok: false, media_type: null, parser: null, model: null, reason: 'HTTP 404' }
    : { ok: true, media_type: 'text/html; charset=ISO-8859-1', parser: 'html@1', model: html(fixtureBytes(file)), reason: null };
}

/** Runs the plan the way the knowledge sync does: read what it asks for, call it again, until it is done. */
function runSync(options: Record<string, unknown> = {}): { rounds: number; output: ReturnType<typeof planBuilds> } {
  const read: Record<string, Read> = { [INDEX_ID]: page(INDEX_ID) };
  for (let round = 1; round <= 6; round++) {
    const output = planBuilds({ round, options, read, known: [] });
    assert.ok(SyncPlanOutput.safeParse(output).success, `round ${round}: ${JSON.stringify(SyncPlanOutput.safeParse(output).error?.issues.slice(0, 3))}`);
    if (output.done) return { rounds: round, output };
    for (const id of output.fetch) {
      assert.ok(!Object.hasOwn(read, id), `${id} is asked for once`);
      read[id] = page(id);
    }
  }
  assert.fail('the plan did not finish in 6 rounds');
}

describe('the sync plan', () => {
  const { rounds, output } = runSync();
  const byName = new Map(output.builds.map((b) => [b.name, b]));

  it('walks index -> hub pages -> listing pages and finishes', () => {
    assert.equal(rounds, 3);
    assert.match(output.note ?? '', /读不出的列表页/);
  });

  it('lists the released builds of the main platform of both name families, with their sources by role', () => {
    const apv = byName.get('Rel_APV_10_6_1_57');
    assert.deepEqual(apv, {
      name: 'Rel_APV_10_6_1_57',
      family: 'APV',
      line: '10.6.1',
      base: 'Rel_APV_10_6_1_57',
      platform: null,
      built_at: '2026-05-12T10:20:30Z',
      released_at: '2026-05-14T00:00:00Z',
      sources: { tree: 'buildsite:file:/builds/command_tree-Rel_APV_10_6_1_57.xml', fixed_bugs: 'buildsite:file:/builds/Bugs_Fixed_with_Rel_APV_10_6_1_57.html' },
    });
    assert.ok(byName.has('Rel_APV_10_6_1_54') && byName.has('Rel_APV_10_6_1_40') && byName.has('Rel_APV_10_6_1_37'));
    // A red entry without a release date is not released: it carries no sources (name only), not its tree.
    assert.deepEqual([byName.get('Rel_APV_10_6_1_38')?.released_at, byName.get('Rel_APV_10_6_1_38')?.sources], [null, {}]);
    assert.ok(!byName.has('BrandOS-Rel_NSAE-HG-K_10_6_1_3_2_7'), 'another platform is opt-in');
  });

  it('records an NSAE name without a tree as an alias of the build it is based on, with no sources', () => {
    assert.deepEqual(byName.get('Rel_NSAE_10_6_1_41'), {
      name: 'Rel_NSAE_10_6_1_41',
      family: 'NSAE',
      line: '10.6.1',
      base: 'Rel_APV_10_6_1_57',
      platform: null,
      built_at: '2026-05-20T11:00:00Z',
      released_at: '2026-05-22T00:00:00Z',
      sources: {},
    });
    assert.equal(byName.get('Rel_NSAE_10_6_1_33')?.base, 'Rel_APV_10_6_1_54');
    assert.equal(byName.get('Rel_NSAE_10_6_1_30')?.base, 'Rel_APV_10_6_1_52', 'a base on no page read is still named');
  });

  it('lists the newest build of each line and family even when it is not released, an NSAE name with its own tree as its own base', () => {
    const newest = byName.get('Rel_NSAE_10_7_1_9');
    assert.equal(newest?.released_at, null);
    assert.equal(newest?.base, 'Rel_NSAE_10_7_1_9');
    assert.deepEqual(newest?.sources, { tree: 'buildsite:file:/builds/command_tree-Rel_NSAE_10_7_1_9.xml' });
    assert.ok(byName.has('Rel_APV_10_7_1_8') && byName.has('Rel_NSAE_10_7_1_8'));
    // An unreleased build that is not the newest of its line is listed by name only (no sources).
    assert.deepEqual([byName.get('Rel_APV_10_6_1_56')?.base, byName.get('Rel_APV_10_6_1_56')?.sources], ['Rel_APV_10_6_1_56', {}]);
  });

  it('dates: the listed time as UTC, a month-only release on the first of the month', () => {
    assert.equal(byName.get('Rel_APV_10_6_1_50')?.released_at, '2026-03-01T00:00:00Z');
    assert.match(output.note ?? '', /只写到月份/);
    assert.deepEqual(isoTime('2026-01-02'), { iso: '2026-01-02T00:00:00Z', partial: false });
    assert.deepEqual(isoTime('nope'), { iso: null, partial: false });
  });

  it('keeps to the lines the caller asks for, and to the pages an include pattern opts in', () => {
    const only = runSync({ lines: ['10.7.1'] }).output;
    assert.ok(only.builds.length > 0 && only.builds.every((b) => b.line === '10.7.1'));
    const platforms = runSync({ include: ['rel_nsae_10_6_1_ft_kylinv10'] }).output;
    assert.ok(platforms.builds.length >= output.builds.length);
    const nothing = planBuilds({ round: 1, options: {}, read: { [INDEX_ID]: { ok: false, media_type: null, parser: null, model: null, reason: 'HTTP 404' } }, known: [] });
    assert.deepEqual([nothing.done, nothing.builds, nothing.fetch], [true, [], []]);
  });

  it('lists every remaining mainline build of both families as a name-only build: name, family, line, dates, base itself, no sources', () => {
    // The real-data finding: a line holds dozens of builds (unreleased, Beta, superseded); the knowledge base knew
    // only those with roots. Every mainline build of a read page is now listed; the rest carry only their name.
    const rest = (name: string) => {
      const build = byName.get(name);
      assert.ok(build, `${name} is listed`);
      return build;
    };
    // An unreleased build with a tree that is not the newest of its line: known by name only — with the built time
    // the page lists, and the base the page's “based on” names (absent: itself).
    assert.deepEqual(rest('Rel_APV_10_6_1_56'), {
      name: 'Rel_APV_10_6_1_56',
      family: 'APV',
      line: '10.6.1',
      base: 'Rel_APV_10_6_1_56',
      platform: null,
      built_at: '2026-05-10T09:00:00Z',
      released_at: null,
      sources: {},
    });
    // A duplicate name keeps one copy (the later build time).
    assert.equal(rest('Rel_APV_10_6_1_55').built_at, '2026-05-04T21:30:00Z');
    // An unreleased build with a red release mark and no release date, a Beta build without a tree, a build whose
    // listed build time is malformed: all known by name only.
    assert.deepEqual([rest('Rel_APV_10_6_1_38').base, rest('Rel_APV_10_6_1_38').sources], ['Rel_APV_10_6_1_38', {}]);
    assert.deepEqual([rest('Beta_APV_10_6_1_120').base, rest('Beta_APV_10_6_1_120').sources, rest('Beta_APV_10_6_1_120').released_at], ['Beta_APV_10_6_1_120', {}, null]);
    assert.deepEqual([rest('Rel_APV_10_6_1_36').base, rest('Rel_APV_10_6_1_36').built_at], ['Rel_APV_10_6_1_36', null]);
    // An NSAE build without a tree and without a base text stays its own base (a name-only build, not a broken alias).
    assert.deepEqual([rest('Rel_NSAE_10_6_1_12').base, rest('Rel_NSAE_10_6_1_12').sources], ['Rel_NSAE_10_6_1_12', {}]);
    // An unreleased NSAE name with a “based on” text carries that build as its base (the page says so), still name-only.
    assert.deepEqual([rest('Rel_NSAE_10_6_1_40').base, rest('Rel_NSAE_10_6_1_40').sources, rest('Rel_NSAE_10_6_1_40').built_at], ['Rel_APV_10_6_1_56', {}, '2026-05-18T09:30:00Z']);
    // A Beta name without a tree carries its built time too.
    assert.equal(rest('Beta_APV_10_6_1_120').built_at, '2026-02-11T12:00:00Z');
    // A variant of another platform is not a mainline build: still not listed.
    assert.ok(!byName.has('BrandOS-Rel_NSAE-HG-K_10_6_1_3_2_7.click'), 'another platform is opt-in');
    // The existing choices keep their sources (nothing about them changed).
    assert.ok(Object.keys(byName.get('Rel_APV_10_6_1_57')?.sources ?? {}).includes('tree'));
  });

  it('is total on hostile input and its output is always sync-plan-output@1', () => {
    for (const input of hostileInputs()) {
      const out = assertTotal(syncPlan, input, 'sync');
      assert.ok(SyncPlanOutput.safeParse(out).success);
    }
  });
});

describe('the source ids', () => {
  it('are the build-site pack\'s ids, link for link', () => {
    for (const href of ['/builds/command_tree-Rel_APV_10_6_1_57.xml', 'http://192.0.2.10/builds/x y.xml', 'a@b%c.html', 'mailto:x@example.invalid', '']) {
      assert.equal(fileKey(href), siteFileKey(href), href);
    }
    assert.equal(listingId('rel_apv_10_6_1'), 'buildsite:listing:rel_apv_10_6_1');
    assert.equal(fileId('/a/\ud800.xml'), null);
  });
});

const known = (name: string, family: string, line: string, released: string | null, built: string, platform: string | null = null): KnownBuild => ({
  name,
  family,
  line,
  base: name,
  platform,
  built_at: built,
  released_at: released,
  sources: {},
  root: 'a'.repeat(64),
});

describe('the build choice', () => {
  const candidates = [
    known('Rel_APV_10_6_1_57', 'APV', '10.6.1', '2026-05-14T00:00:00Z', '2026-05-12T10:20:30Z'),
    known('Rel_NSAE_10_6_1_41', 'NSAE', '10.6.1', '2026-05-22T00:00:00Z', '2026-05-20T11:00:00Z'),
    known('Rel_APV_10_6_1_54', 'APV', '10.6.1', '2026-04-30T00:00:00Z', '2026-04-28T17:45:01Z'),
    known('Rel_APV-HG-K_10_6_1_3_1_9', 'APV', '10.6.1', '2026-05-30T00:00:00Z', '2026-05-29T10:00:00Z', 'hg-k'),
    known('Rel_NSAE_10_7_1_9', 'NSAE', '10.7.1', null, '2026-06-10T08:00:00Z'),
    known('Rel_APV_10_7_1_7', 'APV', '10.7.1', null, '2026-06-01T08:00:00Z'),
  ];

  it('takes the latest released build of the line across both families on the main platform and lists the others', () => {
    const out = chooseBuild({ line: '10.6.1', candidates, request: {} });
    assert.ok(SelectBuildOutput.safeParse(out).success);
    assert.equal(out.build, 'Rel_NSAE_10_6_1_41');
    assert.deepEqual(out.alternatives, ['Rel_APV_10_6_1_57', 'Rel_APV_10_6_1_54']);
    assert.match(out.basis, /按规则选定版本线 10\.6\.1/);
  });

  it('takes the newest build of a line with no release yet, saying it is not released', () => {
    const out = chooseBuild({ line: '10.7.1', candidates, request: {} });
    assert.equal(out.build, 'Rel_NSAE_10_7_1_9');
    assert.match(out.basis, /未发布/);
    assert.deepEqual(out.alternatives, ['Rel_APV_10_7_1_7']);
  });

  it('without a line, the line of the newest released build; nothing to choose gives a build no candidate has', () => {
    assert.equal(chooseBuild({ line: null, candidates, request: {} }).build, 'Rel_NSAE_10_6_1_41');
    const none = chooseBuild({ line: '9.9', candidates, request: {} });
    assert.ok(SelectBuildOutput.safeParse(none).success);
    assert.ok(!candidates.some((c) => c.name === none.build));
    for (const input of hostileInputs()) assert.ok(SelectBuildOutput.safeParse(assertTotal(select, input, 'select')).success);
  });
});

const knownBuild = known('Rel_APV_10_6_1_57', 'APV', '10.6.1', '2026-05-14T00:00:00Z', '2026-05-12T10:20:30Z');
const slot = (parser: string, model: unknown) => ({ sha256: 'b'.repeat(64), media_type: 'text/plain', parser, model });

describe('the producers', () => {
  it('command tree: definitions at /commands/<words> with typed overloads', () => {
    const out = commandTree({ build: knownBuild, slots: { tree: slot('xml@1', xml(fixtureBytes('command-tree.xml'))) }, params: {} });
    assert.ok(ProducerOutput.safeParse(out).success, JSON.stringify(ProducerOutput.safeParse(out).error?.issues.slice(0, 2)));
    assert.ok(out.entries.length > 5 && out.entries.every((e) => e.kind === 'definition' && e.path?.startsWith('/commands/')));
    assert.deepEqual(commandTree({ build: knownBuild, slots: { tree: null }, params: {} }), { entries: [], warnings: ['没有命令树'] });
    assert.match(commandTree({ build: knownBuild, slots: { tree: slot('json@1', {}) }, params: {} }).warnings[0], /不是 XML/);
  });

  it('manual: signatures are definitions, the text behaviours, every fragment names its slot', () => {
    const model = markdown(fixtureBytes('manual.md'));
    const out = manual({ build: knownBuild, slots: { cli: slot('markdown@1', model), app: null }, params: {} });
    assert.ok(ProducerOutput.safeParse(out).success);
    assert.ok(out.entries.some((e) => e.kind === 'definition') && out.entries.some((e) => e.kind === 'behaviour'));
    for (const entry of out.entries) assert.equal(entry.kind, entry.data.form === 'signature' ? 'definition' : 'behaviour');
    assert.ok(out.entries.every((e) => e.fragments.every((f) => f.slot === 'cli')));
    assert.ok((out.unplaced ?? []).every((u) => u.fragment.slot === 'cli'));
    assert.ok(out.warnings.includes('没有应用手册'));
  });

  it('release notes: defects of the build from the site\'s fixed-bug list or a release note', () => {
    const page = html('<html><body><table><tr><th>Bug ID</th><th>Summary</th></tr><tr><td><a href=x?id=61001>61001</a></td><td>HA 切换后状态不对</td></tr><tr><td>61002</td><td>权重为 0 时调度异常</td></tr></table><p>61003: 拼写错误</p></body></html>');
    const fromPage = releaseNotes({ build: knownBuild, slots: { notes: slot('html@1', page) }, params: {} });
    assert.ok(ProducerOutput.safeParse(fromPage).success);
    assert.deepEqual(fromPage.entries.map((e) => [e.kind, e.data.bug, e.fragments[0].selector, e.applicability]), [
      ['defect', '61001', 'a/0', { builds: ['Rel_APV_10_6_1_57'] }],
      ['defect', '61002', 'b/4-5', { builds: ['Rel_APV_10_6_1_57'] }],
      ['defect', '61003', 'b/6', { builds: ['Rel_APV_10_6_1_57'] }],
    ]);
    const fromNote = releaseNotes({ build: knownBuild, slots: { notes: slot('markdown@1', markdown(fixtureBytes('release-note.md'))) }, params: {} });
    assert.ok(ProducerOutput.safeParse(fromNote).success);
    assert.ok(fromNote.entries.length > 5 && fromNote.entries.every((e) => e.kind === 'defect' && e.path === null));
    assert.deepEqual(fixedBugEntries({ blocks: [] }, null), { entries: [], warnings: ['修复缺陷清单里没有认出缺陷编号'] });
  });

  it('are total on hostile input and their output is always producer-output@1', () => {
    for (const input of hostileInputs()) {
      for (const fn of [commandTree, manual, releaseNotes]) assert.ok(ProducerOutput.safeParse(assertTotal(fn, input, fn.name)).success, fn.name);
    }
  });
});

describe('the version lines of documents', () => {
  it('maps manual folders of both names and version tokens in names to one line', () => {
    assert.equal(folderLine('rel_apv_10_6_4'), '10.6.4');
    assert.equal(folderLine('rel_nsae_10_6_4'), '10.6.4');
    assert.equal(folderLine('rel_apv_10_5_0'), '10.5');
    assert.equal(folderLine('rel_other_10_5'), null);
    assert.deepEqual(folderNames('10.5'), ['rel_apv_10_5', 'rel_apv_10_5_0', 'rel_nsae_10_5', 'rel_nsae_10_5_0']);
    assert.deepEqual(documentLines('NSAE_10.6.4 会话保持说明'), [{ line: '10.6.4', family: 'NSAE', token: 'NSAE_10.6.4' }]);
    assert.deepEqual(documentLines('APV V10.5.0 与 10_6_4 的差异').map((d) => d.line), ['10.5', '10.6.4']);
    assert.deepEqual(documentLines('192.0.2.10 与 2026.05.10 与 10.6.4.17'), [], 'addresses, dates and build numbers are no lines');
  });
});

describe('the declared functions in the Hub sandbox', { skip: (await osIsolationAvailable()) ? false : 'no OS network isolation on this machine (sandbox-exec)' }, () => {
  const calls: Array<{ fn: { module: string; export?: string }; input: unknown; direct: (input: unknown) => unknown }> = [
    { fn: product.sync!.plan, input: { round: 1, options: {}, read: { [INDEX_ID]: page(INDEX_ID) }, known: [] }, direct: syncPlan },
    { fn: product.select_build!, input: { line: '10.6.1', candidates: [knownBuild], request: {} }, direct: select },
    { fn: product.producers[0].function, input: { build: knownBuild, slots: { tree: slot('xml@1', xml(fixtureBytes('command-tree.xml'))) }, params: {} }, direct: commandTree },
    { fn: product.producers[1].function, input: { build: knownBuild, slots: { cli: slot('markdown@1', markdown(fixtureBytes('manual.md'))), app: null }, params: {} }, direct: manual },
    { fn: product.producers[2].function, input: { build: knownBuild, slots: { notes: slot('markdown@1', markdown(fixtureBytes('release-note.md'))) }, params: {} }, direct: releaseNotes },
  ];
  for (const call of calls) {
    it(`${call.fn.module}#${call.fn.export ?? 'default'} gives the same answer as the direct call`, async () => {
      const result = await callPackFunction({ packDir: PACK_DIR, module: call.fn.module, export: call.fn.export }, call.input, { timeoutMs: 20_000 });
      assert.equal(result.osIsolation, true);
      assert.deepEqual(result.output, JSON.parse(JSON.stringify(call.direct(call.input))));
    });
  }
});
