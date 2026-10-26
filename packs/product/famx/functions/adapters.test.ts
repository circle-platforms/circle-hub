import {STRICT_MANUAL_XML} from '../testing/strict-command-fixture.ts';
import {familyManual} from './adoc/deployment.ts';
// The product@1 entry points of product.json: the sync plan over rounds of pages, the build choice, the three producers,
// checked against the contract shapes (contracts/src/product.ts) and run unchanged in the Hub sandbox.
import assert from 'node:assert/strict';
import {manualRelations} from '../testing/relations.ts';
import {commandCatalog} from './cases-commands.ts';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { ProducerOutput, ProductDeclaration, SelectBuildOutput, SyncPlanOutput, type KnownBuild } from '../../../../contracts/src/product.ts';
import { callPackFunction, osIsolationAvailable } from '../../../../hub/rules/api.ts';
import { fileKey as siteFileKey } from '../../../system/build-site/functions/reads.ts';
import { assertTotal, fixtureBytes, hostileInputs, html, markdown, xml } from '../testing/test-support.ts';
import { documentLines, folderLine, folderNames, documentNameOf} from './documents.ts';
import { fixedBugEntries } from './fixed-bugs.ts';
import { commandTree, manual, releaseNotes } from './producers.ts';
import select, { chooseBuild } from './select.ts';
import { INDEX_ID, fileId, fileKey, listingId } from './sources.ts';
import syncPlan, { isoTime, planBuilds } from './sync.ts';
import { readFileSync } from 'node:fs';

// Use word commands for this adapter fixture; punctuation-reference serialization has its own tests.
const ADAPTER_XML = STRICT_MANUAL_XML.replace('<item name="?">', '<item name="question">');
const PACK_DIR = fileURLToPath(new URL('../', import.meta.url));
const product = ProductDeclaration.parse(JSON.parse(readFileSync(new URL('../product.json', import.meta.url), 'utf8')));

/** The fixture site by page name: the index, a hub page and four listing pages; every other linked page is a dead link. */
const SITE: Record<string, string> = {
  index: 'index.html',
  famx_10_6_2: 'hub-famx_10_6_2.html',
  rel_famx_10_6_1: 'listing-famx.html',
  rel_famy_10_6_1: 'listing-famy.html',
  rel_famx_10_6_2: 'listing-famx-new-line.html',
  rel_famy_10_6_2: 'listing-famy-new-line.html',
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
    const famx = byName.get('Rel_FAMX_10_6_1_57');
    assert.deepEqual(famx, {
      name: 'Rel_FAMX_10_6_1_57',
      family: 'FAMX',
      line: '10.6.1',
      base: 'Rel_FAMX_10_6_1_57',
      platform: null,
      built_at: '2026-05-12T10:20:30Z',
      released_at: '2026-05-14T00:00:00Z',
      sources: { tree: 'buildsite:file:/builds/command_tree-Rel_FAMX_10_6_1_57.xml', fixed_bugs: 'buildsite:file:/builds/Bugs_Fixed_with_Rel_FAMX_10_6_1_57.html' },
    });
    assert.ok(byName.has('Rel_FAMX_10_6_1_54') && byName.has('Rel_FAMX_10_6_1_40') && byName.has('Rel_FAMX_10_6_1_37'));
    // A red entry without a release date is not released: it carries no sources (name only), not its tree.
    assert.deepEqual([byName.get('Rel_FAMX_10_6_1_38')?.released_at, byName.get('Rel_FAMX_10_6_1_38')?.sources], [null, {}]);
    assert.ok(!byName.has('BrandOS-Rel_FAMY-SY-K_10_6_1_3_2_7'), 'another platform is opt-in');
  });

  it('records an FAMY name without a tree as an alias of the build it is based on, with no sources', () => {
    assert.deepEqual(byName.get('Rel_FAMY_10_6_1_41'), {
      name: 'Rel_FAMY_10_6_1_41',
      family: 'FAMY',
      line: '10.6.1',
      base: 'Rel_FAMX_10_6_1_57',
      platform: null,
      built_at: '2026-05-20T11:00:00Z',
      released_at: '2026-05-22T00:00:00Z',
      sources: {},
    });
    assert.equal(byName.get('Rel_FAMY_10_6_1_33')?.base, 'Rel_FAMX_10_6_1_54');
    assert.equal(byName.get('Rel_FAMY_10_6_1_30')?.base, 'Rel_FAMX_10_6_1_52', 'a base on no page read is still named');
  });

  it('lists the newest build of each line and family even when it is not released, an FAMY name with its own tree as its own base', () => {
    const newest = byName.get('Rel_FAMY_10_7_1_9');
    assert.equal(newest?.released_at, null);
    assert.equal(newest?.base, 'Rel_FAMY_10_7_1_9');
    assert.deepEqual(newest?.sources, { tree: 'buildsite:file:/builds/command_tree-Rel_FAMY_10_7_1_9.xml' });
    assert.ok(byName.has('Rel_FAMX_10_7_1_8') && byName.has('Rel_FAMY_10_7_1_8'));
    // An unreleased build that is not the newest of its line is listed by name only (no sources).
    assert.deepEqual([byName.get('Rel_FAMX_10_6_1_56')?.base, byName.get('Rel_FAMX_10_6_1_56')?.sources], ['Rel_FAMX_10_6_1_56', {}]);
  });

  it('dates: the listed time as UTC, a month-only release on the first of the month', () => {
    assert.equal(byName.get('Rel_FAMX_10_6_1_50')?.released_at, '2026-03-01T00:00:00Z');
    assert.match(output.note ?? '', /只写到月份/);
    assert.deepEqual(isoTime('2026-01-02'), { iso: '2026-01-02T00:00:00Z', partial: false });
    assert.deepEqual(isoTime('nope'), { iso: null, partial: false });
  });

  it('keeps to the lines the caller asks for, and to the pages an include pattern opts in', () => {
    const only = runSync({ lines: ['10.7.1'] }).output;
    assert.ok(only.builds.length > 0 && only.builds.every((b) => b.line === '10.7.1'));
    const platforms = runSync({ include: ['rel_famy_10_6_1_sz_demoos10'] }).output;
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
    assert.deepEqual(rest('Rel_FAMX_10_6_1_56'), {
      name: 'Rel_FAMX_10_6_1_56',
      family: 'FAMX',
      line: '10.6.1',
      base: 'Rel_FAMX_10_6_1_56',
      platform: null,
      built_at: '2026-05-10T09:00:00Z',
      released_at: null,
      sources: {},
    });
    // A duplicate name keeps one copy (the later build time).
    assert.equal(rest('Rel_FAMX_10_6_1_55').built_at, '2026-05-04T21:30:00Z');
    // An unreleased build with a red release mark and no release date, a Beta build without a tree, a build whose
    // valid listed build times are known by name only; malformed times fail explicitly.
    assert.deepEqual([rest('Rel_FAMX_10_6_1_38').base, rest('Rel_FAMX_10_6_1_38').sources], ['Rel_FAMX_10_6_1_38', {}]);
    assert.deepEqual([rest('Beta_FAMX_10_6_1_120').base, rest('Beta_FAMX_10_6_1_120').sources, rest('Beta_FAMX_10_6_1_120').released_at], ['Beta_FAMX_10_6_1_120', {}, null]);
    assert.equal(byName.has('Rel_FAMX_10_6_1_36'), false);
    assert.equal(output.failed_builds?.find(row => row.build.name === 'Rel_FAMX_10_6_1_36')?.reason, 'SOURCE_UNPARSEABLE');
    // An FAMY build without a tree and without a base text stays its own base (a name-only build, not a broken alias).
    assert.deepEqual([rest('Rel_FAMY_10_6_1_12').base, rest('Rel_FAMY_10_6_1_12').sources], ['Rel_FAMY_10_6_1_12', {}]);
    // An unreleased FAMY name with a “based on” text carries that build as its base (the page says so), still name-only.
    assert.deepEqual([rest('Rel_FAMY_10_6_1_40').base, rest('Rel_FAMY_10_6_1_40').sources, rest('Rel_FAMY_10_6_1_40').built_at], ['Rel_FAMX_10_6_1_56', {}, '2026-05-18T09:30:00Z']);
    // A Beta name without a tree carries its built time too.
    assert.equal(rest('Beta_FAMX_10_6_1_120').built_at, '2026-02-11T12:00:00Z');
    // A variant of another platform is not a mainline build: still not listed.
    assert.ok(!byName.has('BrandOS-Rel_FAMY-SY-K_10_6_1_3_2_7.click'), 'another platform is opt-in');
    // The existing choices keep their sources (nothing about them changed).
    assert.ok(Object.keys(byName.get('Rel_FAMX_10_6_1_57')?.sources ?? {}).includes('tree'));
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
    for (const href of ['/builds/command_tree-Rel_FAMX_10_6_1_57.xml', 'http://192.0.2.10/builds/x y.xml', 'a@b%c.html', 'mailto:x@example.invalid', '']) {
      assert.equal(fileKey(href), siteFileKey(href), href);
    }
    assert.equal(listingId('rel_famx_10_6_1'), 'buildsite:listing:rel_famx_10_6_1');
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
    known('Rel_FAMX_10_6_1_57', 'FAMX', '10.6.1', '2026-05-14T00:00:00Z', '2026-05-12T10:20:30Z'),
    known('Rel_FAMY_10_6_1_41', 'FAMY', '10.6.1', '2026-05-22T00:00:00Z', '2026-05-20T11:00:00Z'),
    known('Rel_FAMX_10_6_1_54', 'FAMX', '10.6.1', '2026-04-30T00:00:00Z', '2026-04-28T17:45:01Z'),
    known('Rel_FAMX-SY-K_10_6_1_3_1_9', 'FAMX', '10.6.1', '2026-05-30T00:00:00Z', '2026-05-29T10:00:00Z', 'sy-k'),
    known('Rel_FAMY_10_7_1_9', 'FAMY', '10.7.1', null, '2026-06-10T08:00:00Z'),
    known('Rel_FAMX_10_7_1_7', 'FAMX', '10.7.1', null, '2026-06-01T08:00:00Z'),
  ];

  it('takes the latest released build of the line across both families on the main platform and lists the others', () => {
    const out = chooseBuild({ line: '10.6.1', candidates, request: {} });
    assert.ok(SelectBuildOutput.safeParse(out).success);
    assert.equal(out.build, 'Rel_FAMY_10_6_1_41');
    assert.deepEqual(out.alternatives, ['Rel_FAMX_10_6_1_57', 'Rel_FAMX_10_6_1_54']);
    assert.match(out.basis, /按规则选定版本线 10\.6\.1/);
  });

  it('takes the newest build of a line with no release yet, saying it is not released', () => {
    const out = chooseBuild({ line: '10.7.1', candidates, request: {} });
    assert.equal(out.build, 'Rel_FAMY_10_7_1_9');
    assert.match(out.basis, /未发布/);
    assert.deepEqual(out.alternatives, ['Rel_FAMX_10_7_1_7']);
  });

  it('without a line, the line of the newest released build; nothing to choose gives a build no candidate has', () => {
    assert.equal(chooseBuild({ line: null, candidates, request: {} }).build, 'Rel_FAMY_10_6_1_41');
    const none = chooseBuild({ line: '9.9', candidates, request: {} });
    assert.ok(SelectBuildOutput.safeParse(none).success);
    assert.ok(!candidates.some((c) => c.name === none.build));
    for (const input of hostileInputs()) assert.ok(SelectBuildOutput.safeParse(assertTotal(select, input, 'select')).success);
  });
});

const knownBuild = known('Rel_FAMX_10_6_1_57', 'FAMX', '10.6.1', '2026-05-14T00:00:00Z', '2026-05-12T10:20:30Z');
const slot = (parser: string, model: unknown) => ({ sha256: 'b'.repeat(64), media_type: 'text/plain', parser, model });

describe('the producers', () => {
  it('command tree: definitions at /commands/<words> with typed overloads', () => {
    const out = commandTree({ build: knownBuild, slots: { tree: slot('xml@1', xml(ADAPTER_XML)) }, params: {} });
    const recovered = commandTree({build: knownBuild, slots: {tree: slot('xml@1', xml(fixtureBytes('command-tree.xml')))}, params: {}});
    assert.ok(recovered.entries.length > 5, 'the repaired synthetic XML is authoritative again');
    const malformed = commandTree({build: knownBuild, slots: {tree: slot('xml@1', xml('<commands><item name="demo" help_string="a "bad" description"/></commands>'))}, params: {}});
    assert.deepEqual(malformed.entries, []);
    assert.ok(malformed.warnings.some(warning => warning.includes('缺完整权威 XML') && warning.includes('下一步')));
    assert.ok(ProducerOutput.safeParse(out).success, JSON.stringify(ProducerOutput.safeParse(out).error?.issues.slice(0, 2)));
    assert.ok(out.entries.length > 5 && out.entries.every((e) => e.kind === 'definition' && e.path?.startsWith('/commands/')));
    assert.deepEqual(commandTree({ build: knownBuild, slots: { tree: null }, params: {} }), { entries: [], warnings: ['没有命令树'] });
    assert.match(commandTree({ build: knownBuild, slots: { tree: slot('json@1', {}) }, params: {} }).warnings[0], /不是 XML/);
  });

  it('manual: signatures are definitions, the text behaviours, every fragment names its slot', () => {
    const model = markdown(fixtureBytes('manual.md'));
    const out = manual({ build: knownBuild, slots: { cli: slot('markdown@1', model), app: null, tree: slot('xml@1', xml(ADAPTER_XML)) }, params: {} });
    assert.ok(ProducerOutput.safeParse(out).success);
    assert.ok(out.entries.some((e) => e.kind === 'definition') && out.entries.some((e) => e.kind === 'behaviour'));
    for (const entry of out.entries) assert.equal(entry.kind, entry.data.form === 'signature' ? 'definition' : 'behaviour');
    assert.ok(out.entries.every((e) => e.fragments.every((f) => f.slot === 'cli')));
    assert.ok((out.unplaced ?? []).every((u) => u.fragment.slot === 'cli'));
    assert.ok(out.warnings.includes('没有应用手册'));
  });

  it('manual: hangs signatures at /commands only when the command exists, and records the literals as written', () => {
    const model = markdown(fixtureBytes('manual.md'));
    const tree = slot('xml@1', xml(ADAPTER_XML));
    const out = manual({ build: knownBuild, slots: { cli: slot('markdown@1', model), app: null, tree }, params: {} });
    // These are explicitly declared complete signatures, including probe and enable.
    const probe = out.entries.find(e => e.data.form === 'signature' && e.data.signature === 'demo probe <name> {tcp|udp} [<port>][<timeout>]');
    assert.equal(probe?.path, '/commands/demo/probe');
    assert.ok(out.entries.some(e => e.path === '/commands/enable' && e.data.form === 'signature'));
    // Preserve raw mentions in their source blocks; prose is not a command declaration (R4).
    const example = out.entries.find(e => e.fragments[0].selector === 'b/13/基本配置');
    assert.equal(example?.statement, 'Box(config)#demo route static 192.0.2.0 255.255.255.0 192.0.2.1 permanent');
    const mention = out.entries.find(e => e.fragments[0].selector === 'b/1/引言');
    assert.equal(mention?.statement, '调度算法见 `demo pool mode` 命令。');
    const note = out.entries.find(e => e.fragments[0].selector === 'b/7/基本配置');
    assert.ok(note?.statement.includes('demo pool create'));
    const facts = manualRelations(out, commandCatalog(xml(ADAPTER_XML)).catalog);
    assert.deepEqual(facts.drift.map(group => group.literal), ['Box(config)#demo route static 192.0.2.0 255.255.255.0 192.0.2.1 permanent'], 'only the whole unparsed structural example line drifts; no prompt stripping or prose extraction');
    assert.ok(!out.warnings.some((warning) => warning.includes('漂移')));
    // Without the tree slot no unchecked command path is created.
    const without = manual({ build: knownBuild, slots: { cli: slot('markdown@1', model), app: null }, params: {} });
    assert.ok(without.warnings.some((w) => w.includes('命令树不可用') && w.includes('签名留在章节节点') && w.includes('xml@1')), without.warnings.join('\n'));
    assert.ok(without.entries.every((e) => (e.path ?? '').startsWith('/manual/')), 'no synthetic /commands path without a usable tree');
  });

  it('release notes: a status gap is local; only structured original status establishes fixed', () => {
    const page=html('<html><body><a href="?m=bug&amp;f=view&amp;id=61001">已修复 61001</a><p>61002: 仅正文</p></body></html>');
    const fromPage=releaseNotes({build:knownBuild,slots:{notes:slot('html@1',page)}});assert.ok(ProducerOutput.safeParse(fromPage).success);assert.equal(fromPage.incomplete,undefined);assert.deepEqual(fromPage.entries.map(row=>[row.data.bug,row.data.status,row.data.declaration_status]),[['61001',null,'undeclared']]);
    const fromRaw=releaseNotes({build:knownBuild,slots:{notes:slot('markdown@1',markdown(fixtureBytes('release-note.md')))}});assert.equal(fromRaw.incomplete,undefined);assert.ok(fromRaw.entries.every(row=>row.data.status===null&&row.data.declaration_status==='undeclared'));
    const declared={schema:'release-notes@2',complete:true,product:'FAMX',build:knownBuild.name,defects:[{bug:'61001',status:'fixed',text:'原始结构声明'}]};
    const native=releaseNotes({build:knownBuild,slots:{notes:slot('json@1',declared)}});assert.ok(ProducerOutput.safeParse(native).success);assert.equal(native.entries[0].data.status,'fixed');assert.equal(native.entries[0].data.declaration_status,'declared');
  });

  it('are total on hostile input and their output is always producer-output@1', () => {
    for (const input of hostileInputs()) {
      for (const fn of [commandTree, manual, releaseNotes]) assert.ok(ProducerOutput.safeParse(assertTotal(fn, input, fn.name)).success, fn.name);
    }
  });
});

describe('the version lines of documents', () => {
  it('maps manual folders of both names and version tokens in names to one line', () => {
    assert.equal(folderLine('rel_famx_10_6_4'), '10.6.4');
    assert.equal(folderLine('rel_famy_10_6_4'), '10.6.4');
    assert.equal(folderLine('rel_famx_10_7_0'), '10.7');
    assert.equal(folderLine('rel_other_10_9'), null);
    assert.deepEqual(folderNames('10.7'), ['rel_famx_10_7', 'rel_famx_10_7_0', 'rel_famy_10_7', 'rel_famy_10_7_0']);
    // famx-documents@1: a version association comes from a document's own name, never from prose. The declared name form
    // is the base name without an `@<revision>` suffix and without a text extension, and the whole remainder must be an
    // optional product name, a separator, an optional `v` and two to four dotted numbers.
    assert.deepEqual(documentLines(documentNameOf('spec/FAMY_10.6.4.md')), [{ line: '10.6.4', family: 'FAMY', token: 'FAMY_10.6.4' }]);
    assert.deepEqual(documentLines(documentNameOf('spec/FAMX V10.7.0@draft.md')).map((d) => d.line), ['10.7']);
    assert.deepEqual(documentLines(documentNameOf('spec/FAMX-10_7.md')).map((d) => d.line), ['10.7']);
    assert.equal(documentNameOf('spec/FAMX 10_7@draft.md'), 'FAMX 10_7');
    assert.deepEqual(documentLines('FAMY_10.6.4 会话保持说明'), [], 'a title is prose and is not scanned');
    assert.deepEqual(documentLines('FAMX V10.7.0 与 10_6_4 的差异'), [], 'several versions in one text are no declaration');
    assert.deepEqual(documentLines('192.0.2.10 与 2026.05.10 与 10.6.4.17'), [], 'addresses, dates and build numbers are no lines');
  });
});

describe('the declared functions in the Hub sandbox', { skip: (await osIsolationAvailable()) ? false : 'no OS network isolation on this machine (sandbox-exec)' }, () => {
  const calls: Array<{ fn: { module: string; export?: string }; input: unknown; direct: (input: unknown) => unknown }> = [
    { fn: product.sync!.plan, input: { round: 1, options: {}, read: { [INDEX_ID]: page(INDEX_ID) }, known: [] }, direct: syncPlan },
    { fn: product.select_build!, input: { line: '10.6.1', candidates: [knownBuild], request: {} }, direct: select },
    { fn: product.producers[0].function, input: { build: knownBuild, slots: { tree: slot('xml@1', xml(fixtureBytes('command-tree.xml'))) }, params: {} }, direct: commandTree },
    ...(['FAMX','FAMY'] as const).map(family=>({fn:product.producers.find(p=>p.id==='manual-'+family.toLowerCase())!.function,input:{build:knownBuild,slots:{cli:slot('markdown@1',markdown(fixtureBytes('manual.md'))),app:null},params:{family,root:null,main:'book.adoc',attributes:{[family]:{}}}},direct:(input:unknown)=>familyManual(input as Parameters<typeof familyManual>[0])})),
    { fn: { module: 'functions/producers.ts', export: 'releaseNotes' }, input: { build: knownBuild, slots: { notes: slot('markdown@1', markdown(fixtureBytes('release-note.md'))) }, params: {} }, direct: releaseNotes },
  ];
  for (const call of calls) {
    it(`${call.fn.module}#${call.fn.export ?? 'default'} gives the same answer as the direct call`, async () => {
      const result = await callPackFunction({ packDir: PACK_DIR, module: call.fn.module, export: call.fn.export }, call.input, { timeoutMs: 20_000 });
      assert.equal(result.osIsolation, true);
      assert.deepEqual(result.output, JSON.parse(JSON.stringify(await call.direct(call.input))));
    });
  }
});

  it('aggregates command-tree warnings and keeps an invalid catalog unknown rather than declaring drift', () => {
    const args = Array.from({ length: 210 }, (_, i) => `<arg name="arg${i}" optional="maybe" help_string="h"/>`).join('');
    const treeXml = `<commands><scope type="global"><menu name="demo"><item name="probe" help_string="p"><arguments>${args}</arguments></item></menu></scope></commands>`;
    const slots = { tree: slot('xml@1', xml(treeXml)), cli: slot('markdown@1', markdown('**demo gone** *\\<x\\>*\n\n说明。\n')) };
    const out = manual({ build: knownBuild, slots: { ...slots, app: null }, params: {} });
    const drift=manualRelations(out,commandCatalog(xml(treeXml)).catalog).drift;
    assert.deepEqual(drift, [], 'an invalid optional declaration is not an authoritative absence');
    assert.ok(out.entries.every(entry => entry.data.form !== 'signature' && !entry.path?.startsWith('/commands/')));
    const oneInvalid = xml('<commands><scope type="global"><menu name="demo"><item name="probe"><arguments><arg name="arg0" optional="maybe"/></arguments></item></menu></scope></commands>');
    const singleManual = manual({build: knownBuild, slots: {...slots, tree: slot('xml@1', oneInvalid), app: null}, params: {}});
    assert.deepEqual(out.warnings, singleManual.warnings, 'manual diagnostics do not grow with repeated invalid fields');
    const treeOut = commandTree({ build: knownBuild, params: {}, slots: { tree: slot('xml@1', xml(treeXml)) } });
    assert.equal(treeOut.diagnostics?.filter(diagnostic => diagnostic.attribute === 'optional').length, 210);
    assert.ok(treeOut.diagnostics?.every(diagnostic => diagnostic.command_parse_status === 'parameters_unchecked' && diagnostic.next_action.length > 0));
    assert.ok(treeOut.warnings.length <= 2, 'one structural summary plus one actionable warning');
    assert.ok(treeOut.warnings.some(warning => warning.includes('同类 210 处')));
    const distinctXml = `<commands><scope type="global"><menu name="demo"><item name="probe" help_string="p"><arguments>${Array.from({ length: 210 }, (_, i) => `<arg name="arg${i}" optional="maybe${i}" help_string="h"/>`).join('')}</arguments></item></menu></scope></commands>`;
    const distinctOut = commandTree({ build: knownBuild, params: {}, slots: { tree: slot('xml@1', xml(distinctXml)) } });
    assert.equal(distinctOut.diagnostics?.filter(diagnostic => diagnostic.attribute === 'optional').length, 210);
    assert.ok(distinctOut.warnings.length <= 2, 'distinct invalid values still share the same structural attribute');
    assert.ok(distinctOut.warnings.some(warning => warning.includes('同类 210 处')));
  });
