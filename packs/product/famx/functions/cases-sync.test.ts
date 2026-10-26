// The sync plan's case documents: options, the documents of the product's roots located by locate.ts, the list of each
// build (the corpus truth of tests/fixtures/case-index, computed while the corpus was built), the note, and the plan that
// lists no build while the agile tree is missing, unreadable or incomplete.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SyncPlanOutput, type SyncPlanInput } from '../../../../contracts/src/product.ts';
import { caseCorpus, listingAnswer, listedFor, subtreeAnswer, type Corpus } from '../../../../tests/fixtures/case-index/index.ts';
import { rootsContent } from '../../../system/agile-platform/functions/agile.ts';
import { CASE_TREE_ID, DEFAULT_MIN_LINE } from './cases-rules.ts';
import { caseDocumentsFor, caseIndexOptions, caseNote, caseTree, isProductRoot, uncoveredDocuments } from './cases-sync.ts';
import { INDEX_ID } from './sources.ts';
import syncPlan, { planBuilds } from './sync.ts';
import { assertTotal, fixtureBytes, hostileInputs, html } from '../testing/test-support.ts';

const corpus = caseCorpus({ names: ['FAMX', 'FAMY'] });

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
    assert.deepEqual(caseIndexOptions({ case_index: true, min_line: '10.6.150' }), { on: true, minLine: '10.6.150', notes: [] });
    const bad = caseIndexOptions({ case_index: 'yes', min_line: 'latest' });
    assert.equal(bad.on, false);
    assert.equal(bad.minLine, DEFAULT_MIN_LINE);
    assert.equal(bad.notes.length, 1);
  });

  it('a product root is titled with a declared product name, compared exactly', () => {
    // U23 (owner, 2026-10-24): no case, width or synonym folding, and no surrounding words. A root titled with anything
    // else is not the product root; the author renames it or the pack declares the form.
    for (const title of ['FAMX', 'FAMY']) assert.equal(isProductRoot(title), true, title);
    for (const title of [' famy ', 'famy', 'ＡＰＶ', 'FAMX 测试', 'FAMY-项目', 'FAMXX', 'FAMYtest', '演示产品', '', null, 7]) {
      assert.equal(isProductRoot(title), false, String(title));
    }
    assert.equal(isProductRoot('famx', ['famx']), true, 'the declared names decide, exactly');
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
    assert.deepEqual(tree.counts.productRoots, ['FAMX', 'FAMY'], 'both name families');
    assert.equal(tree.counts.otherRoots, 1);
    assert.equal(tree.counts.otherDocuments, corpus.truth.filter((d) => !d.product).length);
    assert.equal(tree.counts.noLine.count, corpus.truth.filter((d) => d.unlisted === 'no_line').length);
    assert.equal(tree.counts.beforeMinLine.count, corpus.truth.filter((d) => d.unlisted === 'before_min_line').length);
    assert.equal(tree.counts.badId.count, 1, 'the leaf whose id the platform cannot serve');
    assert.equal(tree.counts.emptyFolders.count, corpus.emptyFolders.length);
    assert.deepEqual([...tree.counts.emptyFolders.examples].sort(), [...corpus.emptyFolders].sort());
    assert.ok(tree.counts.noLine.examples.length > 0);
    assert.equal(tree.counts.beforeMinLine.count,0,'null imposes no lower bound');
    const bounded=caseTree({[CASE_TREE_ID]:treeRead(treeContent(corpus))},caseIndexOptions({case_index:true,min_line:'10.6.142'}));
    assert.equal(bounded.status,'ready');if(bounded.status==='ready')assert.equal(bounded.counts.beforeMinLine.count,20,'an explicit synthetic floor still exercises earlier-document exclusion');
    for (const id of corpus.emptyFolders) assert.ok(!tree.documents.some((doc) => doc.id === id), id);
  });

  it('a build lists the documents of its line and the earlier ones from min_line on, new ones last', () => {
    if (tree.status !== 'ready') return;
    for (const line of ['10.6.142', '10.6.4', '10.6.150', '10.6.1', '10.6.2', '10.7', '10.6.141', '9.9']) {
      assert.deepEqual(caseDocumentsFor(tree.documents, line).ids, listedFor(corpus, line).map((id) => `agile:case:${id}`), line);
    }
    // A build line the tree never dates has no train month, so it lists only documents of that same line.
    assert.deepEqual(caseDocumentsFor(tree.documents, '10.7.1').ids, []);
    const later = caseTree({ [CASE_TREE_ID]: treeRead(treeContent(corpus)) }, caseIndexOptions({ case_index: true, min_line: '10.6.150' }));
    if (later.status === 'ready') assert.deepEqual(caseDocumentsFor(later.documents, '10.6.1').ids, listedFor(corpus, '10.6.1', '10.6.150').map((id) => `agile:case:${id}`));
    // A document added later has a larger id: the list it joins keeps every id before it where it was.
    const grown = structuredClone(corpus);
    const add = (nodes: Corpus['trees'][string]): boolean => {
      for (const node of nodes) {
        if (node.label.startsWith('006：10.6.1')) {
          node.children.push({ label: '新文档', id: '951000', cases: [], children: [] });
          node.cases.push('951000');
          return true;
        }
        if (add(node.children)) {
          node.cases.push('951000');
          return true;
        }
      }
      return false;
    };
    assert.equal(add(grown.trees['7812']), true);
    const again = caseTree({ [CASE_TREE_ID]: treeRead(treeContent(grown)) }, ON);
    if (again.status === 'ready') {
      const before = caseDocumentsFor(tree.documents, '10.6.1').ids;
      const after = caseDocumentsFor(again.documents, '10.6.1').ids;
      assert.deepEqual(after.slice(0, before.length), before);
      assert.deepEqual(after.slice(before.length), ['agile:case:951000']);
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
    assert.match(note, /不列 \d+ 个会列出用例文档的构建/);
  });
});

// The fixture build site of the product pack (adapters.test.ts walks the same pages).
const SITE: Record<string, string> = {
  index: 'index.html',
  famx_10_6_2: 'hub-famx_10_6_2.html',
  rel_famx_10_6_1: 'listing-famx.html',
  rel_famy_10_6_1: 'listing-famy.html',
  rel_famx_10_6_2: 'listing-famx-new-line.html',
  rel_famy_10_6_2: 'listing-famy-new-line.html',
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
    const firstRound = planBuilds({ round: 1, options: { case_index: true }, read: { [INDEX_ID]: page(INDEX_ID) }, known: [] });
    assert.ok(firstRound.fetch.includes(CASE_TREE_ID));
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
      // A build line the agile tree does not date (the site's 10.7.1; the corpus line is 10.7) lists no case document.
      const expected = corpus.truth.some((doc) => doc.line === build.line) ? listedFor(corpus, build.line).map((id) => `agile:case:${id}`) : [];
      assert.deepEqual(list ?? [], expected, build.name);
      if (expected.length === 0) assert.equal(tree, undefined, build.name);
      else assert.equal(tree, CASE_TREE_ID, build.name);
    }
    assert.ok(own >= 4);
    assert.ok(on.output.builds.some((b) => b.base !== b.name), 'aliases are still listed');
  });

  it('the note counts the documents and why the others are not listed', () => {
    assert.match(on.output.note ?? '', /用例文档：读到 3 个根，产品的根 2 个（FAMX、FAMY）/);
    assert.match(on.output.note ?? '', /上级目录里没有版本线 5 份/);
    assert.doesNotMatch(on.output.note ?? '', /早于/);
    assert.match(on.output.note ?? '', /另有 1 个根不是产品的根/);
    assert.match(on.output.note ?? '', /空目录 2 个/);
  });

  it('counts a located line no listed build covers, and names an example', () => {
    const ready = caseTree({ [CASE_TREE_ID]: treeRead(treeContent(corpus)) }, ON);
    assert.equal(ready.status, 'ready');
    if (ready.status !== 'ready') return;
    const uncovered = uncoveredDocuments(ready.documents, ['10.6.1']);
    const byLine = new Map(uncovered.map((row) => [row.line, row]));
    assert.ok((byLine.get('10.6.2')?.count ?? 0) > 0 && (byLine.get('10.6.2')?.examples.length ?? 0) > 0);
    assert.ok((byLine.get('10.7')?.count ?? 0) > 0);
    const note = caseNote(ready, ON, { listed: 0, cut: 0, uncovered });
    assert.match(note, /版本线 10\.6\.2 没有列出的构建/);
    assert.match(note, /例如/);
  });

  it('lists no build at all while the agile tree cannot be read or is incomplete, and says why', () => {
    for (const tree of [
      (): Read => ({ ok: false, media_type: null, parser: null, model: null, reason: '没有声明 agile:tree 的资源' }),
      (): Read => treeRead(treeContent(corpus, new Set(['7811']))),
    ]) {
      const out = runSync({ case_index: true }, tree).output;
      assert.ok(out.builds.every((build) => build.sources.tree === undefined), 'a build that would list case documents is withheld');
      assert.ok(out.builds.length > 0, 'a build with no command tree is still listed');
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

  it('orders lines by the release-train date, not by the dotted number', () => {
    const documents = [
      { id: '1', line: '10.6.150', at: '2024-01-01' },
      { id: '2', line: '10.6.4', at: '2026-06-01' },
    ];
    assert.deepEqual(caseDocumentsFor(documents, '10.6.4').ids, ['agile:case:1', 'agile:case:2']);
    assert.deepEqual(caseDocumentsFor(documents, '10.6.150').ids, ['agile:case:1']);
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

it('an invalid active case-index floor withholds case-bearing builds even when the tree is ready',()=>{
  for(const min_line of ['latest','','   ','10_6','10.6.x']){
    const options=caseIndexOptions({case_index:true,min_line});
    const ready=caseTree({[CASE_TREE_ID]:treeRead(treeContent(corpus))},options);
    assert.equal(ready.status,'failed');
    const output=runSync({case_index:true,min_line},()=>treeRead(treeContent(corpus))).output;
    assert.ok(output.builds.every(build=>Object.keys(build.sources).length===0),'no case-bearing own tree is regenerated');
    assert.match(output.note??'',/未套用下限/);
    assert.match(output.note??'',/这次不列/);
    assert.match(output.note??'',/circle-hub var set FAMX_MIN_LINE --file/);
    assert.doesNotMatch(output.note??'',/不设下限/);
  }
});
it('a dotted deployment floor is accepted independently of the repository example-line policy',()=>{
  const earlier=[String(10),String(6-1),String(2)].join('.');
  assert.deepEqual(caseIndexOptions({case_index:true,min_line:earlier}),{on:true,minLine:earlier,notes:[]});
});
