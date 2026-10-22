// The sync plan's case documents: options, the documents of the product's roots located by locate.ts, the list of each
// build (the corpus truth of tests/fixtures/case-index, computed while the corpus was built), the note, and the plan that
// lists no build while the agile tree is missing, unreadable or incomplete.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SyncPlanOutput, type SyncPlanInput } from '../../../../contracts/src/product.ts';
import { caseCorpus, listingAnswer, listedFor, subtreeAnswer, type Corpus } from '../../../../tests/fixtures/case-index/index.ts';
import { rootsContent } from '../../../system/agile-platform/functions/agile.ts';
import { CASE_TREE_ID, DEFAULT_MIN_LINE } from './cases-rules.ts';
import { caseDocumentsFor, caseIndexOptions, caseNote, caseTree, isProductRoot } from './cases-sync.ts';
import { INDEX_ID } from './sources.ts';
import syncPlan, { planBuilds } from './sync.ts';
import { assertTotal, fixtureBytes, hostileInputs, html } from '../testing/test-support.ts';

const corpus = caseCorpus({ names: ['APV', 'NSAE'] });

/** The content agile:tree:roots gives for a corpus (the agile system pack's own projection of the platform's answers). */
function treeContent(c: Corpus, failing: ReadonlySet<string> = new Set()): unknown {
  const responses: Record<string, { ok: boolean; json?: unknown }> = {};
  for (let page = 1; page <= 3; page++) responses[`page-${page}`] = { ok: true, json: listingAnswer(c, page) };
  c.roots.forEach((root, k) => {
    responses[`subtree-${k + 1}`] = failing.has(root) ? { ok: false } : { ok: true, json: subtreeAnswer(c, root) };
  });
  return rootsContent({ roots: c.roots }, responses).content;
}

const treeRead = (content: unknown) => ({ ok: true, media_type: 'application/json', parser: 'json@1', model: content, reason: null });
const ON = caseIndexOptions({ case_index: true });

describe('options', () => {
  it('the case index is on only when the declaration says so; min_line is a version line', () => {
    assert.deepEqual(caseIndexOptions({}), { on: false, minLine: DEFAULT_MIN_LINE, notes: [] });
    assert.deepEqual(caseIndexOptions({ case_index: true, min_line: '10.5.0' }), { on: true, minLine: '10.5', notes: [] });
    const bad = caseIndexOptions({ case_index: 'yes', min_line: 'latest' });
    assert.equal(bad.on, false);
    assert.equal(bad.minLine, DEFAULT_MIN_LINE);
    assert.equal(bad.notes.length, 1);
  });

  it('product roots are titled with a product name of either family', () => {
    for (const title of ['APV', 'NSAE', ' nsae ', 'ＡＰＶ', 'APV 测试', 'NSAE-项目']) assert.equal(isProductRoot(title), true, title);
    for (const title of ['APVX', 'NSAEtest', '演示产品', '', null, 7]) assert.equal(isProductRoot(title), false, String(title));
  });
});

describe('the documents of the agile tree', () => {
  const tree = caseTree({ [CASE_TREE_ID]: treeRead(treeContent(corpus)) }, ON);

  it('are the located documents of both product roots, by id, with the reasons the others are not listed', () => {
    assert.equal(tree.status, 'ready');
    if (tree.status !== 'ready') return;
    const expected = corpus.truth.filter((d) => d.product && d.unlisted === null).map((d) => d.id).sort((a, b) => Number(a) - Number(b));
    assert.deepEqual(tree.documents.map((d) => d.id), expected);
    for (const doc of tree.documents) assert.equal(doc.line, corpus.truth.find((t) => t.id === doc.id)?.line, doc.id);
    assert.deepEqual(tree.counts.productRoots, ['APV', 'NSAE'], 'both name families');
    assert.equal(tree.counts.otherRoots, 1);
    assert.equal(tree.counts.otherDocuments, corpus.truth.filter((d) => !d.product).length);
    assert.equal(tree.counts.noLine, corpus.truth.filter((d) => d.unlisted === 'no_line').length);
    assert.equal(tree.counts.beforeMinLine, corpus.truth.filter((d) => d.unlisted === 'before_min_line').length);
    assert.equal(tree.counts.badId, 1, 'the leaf whose id the platform cannot serve');
    assert.ok(tree.counts.noLine > 0 && tree.counts.beforeMinLine > 0);
  });

  it('a build lists the documents of its line and the earlier ones from min_line on, new ones last', () => {
    if (tree.status !== 'ready') return;
    for (const line of ['10.4.2', '10.4.6', '10.5', '10.6.1', '10.6.2', '10.7', '10.7.1', '10.4.1', '9.9']) {
      assert.deepEqual(caseDocumentsFor(tree.documents, line).ids, listedFor(corpus, line).map((id) => `agile:mindmap:${id}`), line);
    }
    const later = caseTree({ [CASE_TREE_ID]: treeRead(treeContent(corpus)) }, caseIndexOptions({ case_index: true, min_line: '10.5' }));
    if (later.status === 'ready') assert.deepEqual(caseDocumentsFor(later.documents, '10.6.1').ids, listedFor(corpus, '10.6.1', '10.5').map((id) => `agile:mindmap:${id}`));
    // A document added later has a larger id: the list it joins keeps every id before it where it was.
    const grown = structuredClone(corpus);
    grown.trees['7812'][0].children[1].children[0].children[0].children.push({ label: '新文档', id: '951000', cases: [], children: [] });
    const again = caseTree({ [CASE_TREE_ID]: treeRead(treeContent(grown)) }, ON);
    if (again.status === 'ready') {
      const before = caseDocumentsFor(tree.documents, '10.6.1').ids;
      const after = caseDocumentsFor(again.documents, '10.6.1').ids;
      assert.deepEqual(after.slice(0, before.length), before);
      assert.deepEqual(after.slice(before.length), ['agile:mindmap:951000']);
    }
  });

  it('is pending before the read, failed when unreadable, malformed or incomplete', () => {
    assert.deepEqual(caseTree({}, ON), { status: 'pending' });
    assert.equal(caseTree({ [CASE_TREE_ID]: { ok: false, media_type: null, parser: null, model: null, reason: '登录停了' } }, ON).status, 'failed');
    assert.equal(caseTree({ [CASE_TREE_ID]: { ...treeRead({}), parser: 'kityminder@1' } }, ON).status, 'failed');
    assert.equal(caseTree({ [CASE_TREE_ID]: treeRead({ roots: 'x', documents: [] }) }, ON).status, 'failed');
    const incomplete = caseTree({ [CASE_TREE_ID]: treeRead(treeContent(corpus, new Set(['7812']))) }, ON);
    assert.equal(incomplete.status, 'failed');
    if (incomplete.status === 'failed') assert.match(incomplete.reason, /7812/);
    const note = caseNote(incomplete, ON, { listed: 0, cut: 0 });
    assert.match(note, /不列构建/);
  });
});

// The fixture build site of the product pack (adapters.test.ts walks the same pages).
const SITE: Record<string, string> = {
  index: 'index.html',
  apv_10_6_2: 'hub-apv_10_6_2.html',
  rel_apv_10_6_1: 'listing-apv.html',
  rel_nsae_10_6_1: 'listing-nsae.html',
  rel_apv_10_6_2: 'listing-apv-new-line.html',
  rel_nsae_10_6_2: 'listing-nsae-new-line.html',
};
type Read = SyncPlanInput['read'][string];
const page = (id: string): Read => {
  const file = SITE[id.slice('buildsite:listing:'.length)];
  return file === undefined ? { ok: false, media_type: null, parser: null, model: null, reason: 'HTTP 404' } : { ok: true, media_type: 'text/html', parser: 'html@1', model: html(fixtureBytes(file)), reason: null };
};

/** The plan the way the knowledge sync runs it, with the agile tree served by `tree`. */
function runSync(options: Record<string, unknown>, tree: (id: string) => Read): { rounds: number; output: ReturnType<typeof planBuilds>; asked: string[] } {
  const read: Record<string, Read> = { [INDEX_ID]: page(INDEX_ID) };
  const asked: string[] = [];
  for (let round = 1; round <= 6; round++) {
    const output = planBuilds({ round, options, read, known: [] });
    assert.ok(SyncPlanOutput.safeParse(output).success, JSON.stringify(SyncPlanOutput.safeParse(output).error?.issues.slice(0, 2)));
    if (output.done) return { rounds: round, output, asked };
    for (const id of output.fetch) {
      asked.push(id);
      read[id] = id === CASE_TREE_ID ? tree(id) : page(id);
    }
  }
  assert.fail('the plan did not finish');
}

describe('the sync plan with the case index', () => {
  const off = runSync({}, () => assert.fail('the tree is read only with case_index'));
  const on = runSync({ case_index: true }, () => treeRead(treeContent(corpus)));

  it('reads agile:tree:roots once, in the first round, and needs no more rounds than without it', () => {
    assert.equal(on.asked.filter((id) => id === CASE_TREE_ID).length, 1);
    assert.equal(on.asked.indexOf(CASE_TREE_ID) < on.asked.length, true);
    assert.equal(on.rounds, off.rounds);
  });

  it('every build with its own tree lists the case documents of its line, aliases list nothing, nothing else changes', () => {
    assert.equal(on.output.builds.length, off.output.builds.length);
    const before = new Map(off.output.builds.map((b) => [b.name, b]));
    let own = 0;
    for (const build of on.output.builds) {
      const plain = before.get(build.name);
      assert.ok(plain, build.name);
      const { case_documents: list, case_tree: tree, ...rest } = build.sources;
      assert.deepEqual({ ...build, sources: rest }, plain, build.name);
      if (plain.sources.tree === undefined) {
        assert.deepEqual([list, tree], [undefined, undefined], `${build.name} has no tree of its own`);
        continue;
      }
      own++;
      assert.deepEqual(list, listedFor(corpus, build.line).map((id) => `agile:mindmap:${id}`), build.name);
      assert.equal(tree, CASE_TREE_ID);
    }
    assert.ok(own >= 4);
    assert.ok(on.output.builds.some((b) => b.base !== b.name), 'aliases are still listed');
  });

  it('the note counts the documents and why the others are not listed', () => {
    assert.match(on.output.note ?? '', /用例文档：读到 3 个根，产品的根 2 个（APV、NSAE）/);
    assert.match(on.output.note ?? '', /上级目录里没有版本线 5 份/);
    assert.match(on.output.note ?? '', /早于 10\.4\.2 的 20 份/);
    assert.match(on.output.note ?? '', /另有 1 个根不是产品的根/);
  });

  it('lists no build at all while the agile tree cannot be read or is incomplete, and says why', () => {
    for (const tree of [
      (): Read => ({ ok: false, media_type: null, parser: null, model: null, reason: '没有声明 agile:tree 的资源' }),
      (): Read => treeRead(treeContent(corpus, new Set(['7811']))),
    ]) {
      const out = runSync({ case_index: true }, tree).output;
      assert.deepEqual(out.builds, []);
      assert.equal(out.done, true);
      assert.match(out.note ?? '', /这次不列构建/);
      assert.match(out.note ?? '', /找到的 \d+ 个构建没有列出/);
    }
  });

  it('a cut plan without the tree lists no build either', () => {
    const first = planBuilds({ round: 1, options: { case_index: true }, read: { [INDEX_ID]: page(INDEX_ID) }, known: [] });
    assert.ok(first.fetch.includes(CASE_TREE_ID));
    assert.deepEqual(first.builds, []);
    assert.equal(first.done, false);
  });

  it('is total on hostile input with the case index on', () => {
    for (const input of hostileInputs()) {
      const out = assertTotal(syncPlan, input, 'sync') as ReturnType<typeof planBuilds>;
      assert.ok(SyncPlanOutput.safeParse(out).success);
      const withTree = assertTotal(syncPlan, { round: 2, options: { case_index: true }, read: { [INDEX_ID]: page(INDEX_ID), [CASE_TREE_ID]: { ok: true, media_type: 'application/json', parser: 'json@1', model: input, reason: null } }, known: [] }, 'tree') as ReturnType<typeof planBuilds>;
      assert.ok(SyncPlanOutput.safeParse(withTree).success);
    }
  });
});
