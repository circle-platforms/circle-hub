import {kityminderParser} from "../../../../hub/testing/parsers.ts";
// The case producer against the corpus truth of tests/fixtures/case-index (every case of every listed document, in the
// batches the Hub cuts: hub/knowledge listBatches), the metamorphic checks (another document id changes only the key,
// reordered cases change nothing, a document twice doubles nothing, an entry depends on its own document only), the
// honest unknown when the Hub hands part of a batch, hostile input, the scale of one batch, and the Hub sandbox.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { ProducerOutput, type ProducedEntry } from '../../../../contracts/src/product.ts';
import { listBatches } from '../../../../hub/knowledge/api.ts';

import { callPackFunction, osIsolationAvailable } from '../../../../hub/rules/api.ts';
import {
  CATALOG_A,
  CATALOG_B,
  CASE_COMMAND_TABLE,
  caseCorpus,
  commandPath,
  commandTreeXml,
  documentBytes,
  listedFor,
  listingAnswer,
  subtreeAnswer,
  type Command,
  type Corpus,
  type KmDocument,
  type KmNode,
} from '../../../../tests/fixtures/case-index/index.ts';
import { rootsContent } from '../../../system/agile-platform/functions/agile.ts';
import { caseStatement, cases, elementDocuments, listedIds, storable } from './cases.ts';
import { commandCatalog } from './cases-commands.ts';
import { commandIdentity, commandLines } from './commands.ts';
import { stripPrefix } from './locate.ts';
import { tagDeclaration } from './cases-rules.ts';
import { CASE_TREE_ID } from './cases-rules.ts';
import { assertTotal, hostileInputs, internalWarnings, xml } from '../testing/test-support.ts';

const PACK_DIR = fileURLToPath(new URL('../', import.meta.url));
const product = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../product.json', import.meta.url), 'utf8')) as { producers: Array<{ id: string; inputs: Record<string, { batch?: number }>; params?: { batch?: number } }> };
const declared = product.producers.find((p) => p.id === 'cases');
// Per-use production has no batch producer declaration; exercise explicit Hub batches.
const BATCH = 50;

const corpus = caseCorpus({ names: ['FAMX', 'FAMY'] });
const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

function treeContent(c: Corpus): unknown {
  const responses: Record<string, { ok: boolean; json?: unknown }> = {};
  for (let page = 1; page <= 3; page++) responses[`page-${page}`] = { ok: true, json: listingAnswer(c, page) };
  c.roots.forEach((root, k) => (responses[`subtree-${k + 1}`] = { ok: true, json: subtreeAnswer(c, root) }));
  return rootsContent({ roots: c.roots }, responses).content;
}

const treeSlot = (catalog: readonly Command[]) => {
  const text = commandTreeXml(catalog);
  return { sha256: sha(text), media_type: 'application/xml', parser: 'xml@1', model: xml(text) };
};
const foldersSlot = (c: Corpus) => {
  const content = treeContent(c);
  return { sha256: sha(JSON.stringify(content)), media_type: 'application/json', parser: 'json@1', model: content };
};
type Element = { sha256: string; media_type: string; parser: string; model: unknown; external?: string };
const element = (doc: KmDocument): Element => {
  const bytes = documentBytes(doc);
  return { sha256: sha(bytes), media_type: 'application/json', parser: 'kityminder@1', model: kityminderParser.parse(bytes).model };
};

const buildOf = (line: string, ids: string[]) => ({
  name: `Rel_FAMX_${line.replaceAll('.', '_')}_7`,
  family: 'FAMX',
  line,
  base: `Rel_FAMX_${line.replaceAll('.', '_')}_7`,
  platform: null,
  built_at: '2026-09-01T10:00:00Z',
  released_at: '2026-09-03T00:00:00Z',
  sources: { tree: 'buildsite:file:/builds/tree.xml', case_documents: ids, case_tree: CASE_TREE_ID },
  root: null,
});

/** Everything the producer gives for a build of a line, called the way the Hub calls it (whole batches, list order). */
function produceBuild(c: Corpus, line: string, catalog: readonly Command[] = CATALOG_A): { entries: ProducedEntry[]; warnings: string[]; calls: number } {
  const ids = listedFor(c, line).map((id) => `agile:mindmap:${id}`);
  const build = buildOf(line, ids);
  const slots = { tree: treeSlot(catalog), folders: foldersSlot(c) };
  const entries: ProducedEntry[] = [];
  const warnings: string[] = [];
  const batches = listBatches(ids, BATCH);
  for (const batch of batches) {
    const lists = { documents: batch.externals.map((external) => ({ ...element(c.documents[external.slice('agile:mindmap:'.length)]), external })) };
    const out = cases({ build, slots, lists, batch: { index: batch.index, of: batch.of }, params: declared?.params ?? {} });
    const checked = ProducerOutput.safeParse(out);
    assert.ok(checked.success, JSON.stringify(checked.error?.issues.slice(0, 2)));
    assert.deepEqual(internalWarnings(out), []);
    entries.push(...out.entries);
    warnings.push(...out.warnings);
  }
  return { entries, warnings, calls: batches.length };
}

/** The entries the corpus truth says a build of this line must have, in the producer's order. */
function expectedEntries(c: Corpus, line: string, catalog: 'a' | 'b' = 'a'): unknown[] {
  const out: unknown[] = [];
  const truth = new Map(c.truth.map((d) => [d.id, d]));
  const tree = treeSlot(catalog === 'a' ? CATALOG_A : CATALOG_B);
  const grammar = commandCatalog(tree.model, tree.sha256).catalog;
  for (const id of listedFor(c, line)) {
    const doc = truth.get(id)!;
    const bytes = documentBytes(c.documents[id]);
    const nodes = (element(c.documents[id]).model as {nodes: Array<{selector: string; text: string; data: Record<string, unknown>; children: number[]}>}).nodes;
    const caseSelectors = new Set(doc.cases.map(k => k.selector));
    for (const k of doc.cases) {
      const node = nodes.find(node => node.selector === k.selector)!;
      const children = node.children.map(index => nodes[index]);
      // Authored child branches are operations; leaf-only layouts use the case's own lines.
      const branches = children.filter(child => child.children.length > 0 && !caseSelectors.has(child.selector));
      const stepTexts = branches.length ? branches.map(child => child.text) : k.expected_count > 0 ? commandLines(k.title).map(line => line.text).filter(Boolean) : [];
      const declaration = tagDeclaration(node.data.resource);
      const expectedTexts: string[] = [];
      const leaves = (child: typeof node): void => {
        if (caseSelectors.has(child.selector) || child.data.priority === 3) return;
        if (!child.children.length) expectedTexts.push(child.text);
        else child.children.forEach(index => leaves(nodes[index]));
      };
      children.forEach(leaves);
      const identities = (texts: string[]) => texts.flatMap(text => commandLines(text).flatMap(line => {
        const identity = commandIdentity(grammar, line.text); return identity ? [identity] : [];
      }));
      const stepIdentities = identities(stepTexts);
      const paths = k.commands[catalog].map(commandPath).sort();
      const filed = paths.length === 0 ? [null] : paths;
      const data = {
        document: id,
        node: k.node,
        title: k.title,
        path_labels: k.path_labels,
        priority: k.priority,
        tags: k.tags,
        negative: declaration.negative,
        test_type_status: declaration.status,
        test_types: declaration.types,
        tag_ids: declaration.ids,
        tag_valid: declaration.valid,
        resource_empty: node.data.resource === undefined || (Array.isArray(node.data.resource) && node.data.resource.length === 0),
        resource: node.data.resource ?? null,
        tag_declaration: declaration,
        ...(!k.tags.some(tag => tag.trim().length > 0) ? {tags_note:'正负向和测试类型未声明'} : {}),
        expected_count: k.expected_count,
        has_expected: k.has_expected,
        source_sha256: sha(bytes),
        case_location: `src:${sha(bytes)}/kityminder@1/${k.selector}`,
        steps_count: stepTexts.length,
        step_texts: stepTexts,
        step_command_identities: stepIdentities,
        unparsed_steps: stepTexts.filter(text => {const lines = commandLines(text); return !lines.length || identities([text]).length !== lines.length;}).length,
        commands: paths,
        command_identities: identities([k.title, ...k.path_labels, ...branches.map(child => child.text), ...expectedTexts]),
        command_tree_root: tree.sha256,
        // Corpus prose identifiers are not whole author-declared story:/bug: fields (R6).
        stories: [],
        defects: [],
        line: doc.line,
        train: doc.train,
        module: doc.train === null ? null : doc.ancestors.map(stripPrefix)[doc.ancestors.map(stripPrefix).indexOf(doc.train) + 1] ?? null,
        autoid: k.autoid,
      };
      for (const path of filed) out.push({ kind: 'case', path, statement: caseStatement(data), data, fragments: [{ slot: 'documents', source: sha(bytes), parser: 'kityminder@1', selector: k.selector }], applicability: null });
    }
  }
  return out;
}

// A failed giant-array diff can consume gigabytes synchronously. Check every full row,
// including length, but bound the diagnostic to the first mismatching entry.
function assertEntries(actual: readonly unknown[], expected: readonly unknown[]): void {
  assert.equal(actual.length, expected.length);
  expected.forEach((entry, index) => assert.deepEqual(actual[index], entry, `entry ${index}`));
}

describe('the declaration', () => {
  it("the producer is no longer declared in product.json (the owner's 10-24 revision: cases are fed per use)", () => {
    assert.equal(declared, undefined);
  });
});

describe('the case entries of the corpus', () => {
  const run = produceBuild(corpus, '10.6.4');

  it('are exactly the truth: one entry per case and resolved command, every field as the corpus built it', () => {
    const expected = expectedEntries(corpus, '10.6.4');
    assert.equal(run.entries.length, expected.length);
    for (let k = 0; k < expected.length; k++) assert.deepEqual(run.entries[k], expected[k], `entry ${k}`);
    assert.ok(run.calls >= 5);
    assert.ok(run.entries.length > 2000);
  });

  it('every case of a listed document is counted: indexed, without a command phrase, or not resolving', () => {
    const listed = new Set(listedFor(corpus, '10.6.4'));
    const all = corpus.truth.filter((d) => listed.has(d.id)).flatMap((d) => d.cases);
    const indexed = all.filter((k) => k.commands.a.length > 0).length;
    let counted = 0;
    let named = 0;
    let none = 0;
    let unresolved = 0;
    for (const warning of run.warnings) {
      const head = /(\d+) 份文档、(\d+) 个用例；(\d+) 个用例按命令归档/.exec(warning);
      if (head === null) continue;
      counted += Number(head[2]);
      named += Number(head[3]);
      none += Number(/(\d+) 个的标题、上级节点、步骤和预期行里没有能提取的命令短语/.exec(warning)?.[1] ?? 0);
      unresolved += Number(/(\d+) 个提取到的命令短语在这个构建的命令目录里都解析不出/.exec(warning)?.[1] ?? 0);
    }
    assert.equal(counted, all.length);
    assert.equal(named, indexed);
    assert.equal(none + unresolved, all.length - indexed);
    assert.ok(none + unresolved > 0, 'all unfiled cases disclose the exact parser outcome; no heuristic phrase categories required');
    const examples = run.warnings.join('\n').match(/「[^」]*」/g) ?? [];
    assert.ok(examples.length > 0);
    for (const warning of run.warnings) assert.ok((warning.match(/「/g) ?? []).length <= 20, 'at most 20 examples per call');
  });

  it('against the later catalog the removed command files nothing and the rest is the same', () => {
    const later = produceBuild(corpus, '10.6.4', CATALOG_B);
    assertEntries(later.entries, expectedEntries(corpus, '10.6.4', 'b'));
    assert.ok(!later.entries.some((e) => e.path === '/commands/relay/encrypt/mode'));
    assert.ok(run.entries.some((e) => e.path === '/commands/relay/encrypt/mode'));
  });

  it('a build of an earlier line has the entries of its own list only', () => {
    assertEntries(produceBuild(corpus, '10.6.1').entries, expectedEntries(corpus, '10.6.1'));
  });
});

/** The entries of a single document called with its external id (an element that says which document it is). */
function oneDocument(c: Corpus, id: string, document: KmDocument = c.documents[id], external = `agile:mindmap:${id}`): ProducedEntry[] {
  const build = buildOf('10.6.1', [external]);
  const out = cases({ build, slots: { tree: treeSlot(CATALOG_A), folders: foldersSlot(c) }, lists: { documents: [{ ...element(document), external }] }, batch: { index: 0, of: 1 }, params: { batch: BATCH } });
  assert.ok(ProducerOutput.safeParse(out).success);
  return out.entries;
}

const canonical = (entries: readonly ProducedEntry[]): string[] => entries.map((e) => JSON.stringify(e)).sort();

describe('metamorphic checks', () => {
  const sample = listedFor(corpus, '10.6.1').filter((id) => corpus.truth.find((d) => d.id === id)!.cases.every((k) => k.selector.startsWith('n/'))).slice(0, 12);

  it('the same document under another id: every entry is the same but its key (document and statement)', () => {
    const moved = structuredClone(corpus);
    for (const id of sample) {
      const truth = corpus.truth.find((d) => d.id === id)!;
      // The copy sits in the same folders under another id.
      const parentOf = (nodes: Corpus['trees'][string]): boolean => {
        for (const node of nodes) {
          const at = node.children.findIndex((c) => c.id === id);
          if (at >= 0) {
            node.children.push({ ...node.children[at], id: `9${id}` });
            return true;
          }
          if (parentOf(node.children)) return true;
        }
        return false;
      };
      assert.ok(parentOf(moved.trees[truth.root]));
      moved.documents[`9${id}`] = corpus.documents[id];
    }
    for (const id of sample) {
      const before = oneDocument(corpus, id);
      const after = oneDocument(moved, `9${id}`, corpus.documents[id]);
      assert.ok(before.length > 0 || after.length === 0);
      const rekey = (entry: ProducedEntry): ProducedEntry => {
        const data = { ...(entry.data as Record<string, unknown>), document: id };
        return { ...entry, data, statement: caseStatement(data) };
      };
      assert.deepEqual(after.map(rekey), before, id);
    }
  });

  it('another title in the agile tree without ids changes nothing', () => {
    const renamed = structuredClone(corpus);
    const id = corpus.truth.find((d) => d.product && d.cases.length > 0 && d.cases.every((k) => k.defects.length === 0 && k.stories.length === 0))?.id;
    assert.ok(id, 'the corpus has a document whose cases carry no requirement or defect id');
    const rename = (nodes: Corpus['trees'][string]): void => {
      for (const node of nodes) {
        if (node.id === id) node.label = '改过名字的文档';
        rename(node.children);
      }
    };
    for (const root of renamed.roots) rename(renamed.trees[root]);
    assert.deepEqual(oneDocument(renamed, id), oneDocument(corpus, id));
  });

  it('reordering keeps case content while rebinding every source identity to the new bytes', () => {
    for (const id of sample) {
      const reordered = structuredClone(corpus.documents[id]);
      const reverse = (node: KmNode): void => {
        node.children.reverse();
        node.children.forEach(reverse);
      };
      reverse(reordered.root);
      const before = oneDocument(corpus, id);
      const after = oneDocument(corpus, id, reordered).map((e) => {
        const newSha = sha(documentBytes(reordered));
        assert.equal(e.data.source_sha256, newSha);
        assert.equal(e.data.case_location, `src:${newSha}/kityminder@1/${e.fragments[0].selector}`);
        assert.ok(e.fragments.every(fragment => fragment.source === newSha));
        const oldSha = before[0].data.source_sha256 as string;
        const data = {...e.data, source_sha256: oldSha, case_location: `src:${oldSha}/kityminder@1/${e.fragments[0].selector}`};
        return {...e, data, statement: caseStatement(data), fragments: e.fragments.map(f => ({...f, source: oldSha}))};
      });
      assert.deepEqual(canonical(after), canonical(before), id);
    }
  });

  it('the same document twice in a call, or listed twice, doubles nothing', () => {
    const id = sample[1];
    const external = `agile:mindmap:${id}`;
    const once = oneDocument(corpus, id);
    const doc = { ...element(corpus.documents[id]), external };
    const twice = cases({ build: buildOf('10.6.1', [external, external]), slots: { tree: treeSlot(CATALOG_A), folders: foldersSlot(corpus) }, lists: { documents: [doc, doc] }, batch: { index: 0, of: 1 }, params: { batch: BATCH } });
    assert.deepEqual(twice.entries, once);
    assert.ok(twice.warnings.some((w) => w.includes('出现了不止一次')));
    assert.deepEqual(listedIds({ sources: { case_documents: [external, external] } }, 'case_documents'), [external]);
    const unnamed = cases({ build: buildOf('10.6.1', [external]), slots: { tree: treeSlot(CATALOG_A), folders: foldersSlot(corpus) }, lists: { documents: [element(corpus.documents[id])] }, batch: { index: 0, of: 1 }, params: {} });
    assert.ok(unnamed.entries.length > 0 && unnamed.entries.every((entry) => entry.data.document === null));
    assert.ok(unnamed.warnings.some((warning) => warning.includes('没有写明')));
  });

  it('an entry depends on its own document only: a document alone gives what it gives in its batch', () => {
    const whole = produceBuild(corpus, '10.6.1').entries;
    for (const id of sample.slice(0, 6)) {
      const alone = oneDocument(corpus, id);
      assert.deepEqual(alone, whole.filter((e) => e.data.document === id), id);
    }
  });
});

describe('which document an element is', () => {
  const ids = Array.from({ length: 40 }, (_, k) => `agile:case:${960000 + k}`);
  const build = { sources: { case_documents: ids } };

  it('reads the external id and does not guess a position when the call holds part of the list', () => {
    const partial = ids.slice(0, 39).map((external) => ({ external }));
    const named = elementDocuments(partial, build);
    assert.deepEqual(named.documents, ids.slice(0, 39).map((id) => id.slice('agile:case:'.length)));
    assert.equal(named.anonymous, 0);
    const bare = elementDocuments(Array.from({ length: 39 }, () => ({ sha256: 'ab'.repeat(32) })), build);
    assert.deepEqual(bare.documents, Array(39).fill(null));
    assert.equal(bare.anonymous, 39);
    assert.deepEqual(elementDocuments([{ external: ids[0] }, { external: 'other:doc:1' }], build).documents, [ids[0].slice('agile:case:'.length), null]);
    assert.deepEqual(elementDocuments([{ external: 'agile:mindmap:7' }], { sources: { case_documents: ['agile:mindmap:7'] } }).documents, ['7']);
    assert.deepEqual(elementDocuments([{ external: 'agile:mindmap:7' }], build).documents, [null], 'an id the build does not list is unknown');
  });

  it('keeps every document of a short batch when each element carries its external id', () => {
    const listed = listedFor(corpus, '10.6.1').map((id) => `agile:case:${id}`);
    const part = listed.slice(0, 39).map((external) => ({ ...element(corpus.documents[external.slice('agile:case:'.length)]), external }));
    const out = cases({ build: buildOf('10.6.1', listed), slots: { tree: treeSlot(CATALOG_A), folders: foldersSlot(corpus) }, lists: { documents: part }, batch: { index: 0, of: Math.ceil(listed.length / BATCH) }, params: {} });
    assert.ok(ProducerOutput.safeParse(out).success);
    assert.ok(out.entries.length > 0);
    assert.ok(out.entries.every((entry) => entry.data.document !== null && entry.data.line !== null));
    const withCases = listed.slice(0, 39).filter((external) => (corpus.truth.find((doc) => doc.id === external.slice('agile:case:'.length))?.cases.length ?? 0) > 0);
    assert.equal(new Set(out.entries.map((entry) => entry.data.document)).size, withCases.length);
    assert.ok(withCases.length > 30);
  });
});

describe('cases the code cannot file under a command', () => {
  it('still produces one entry, with an empty path and the case data in the statement', () => {
    const doc = corpus.truth.find((d) => d.product && d.cases.some((k) => k.commands.a.length === 0));
    assert.ok(doc);
    const entries = oneDocument(corpus, doc.id);
    for (const k of doc.cases.filter((item) => item.commands.a.length === 0)) {
      const entry = entries.find((item) => item.data.node === k.node && item.path === null);
      assert.ok(entry, `${doc.id}:${k.node}`);
      assert.deepEqual(entry.data.commands, []);
      assert.match(entry.statement, /版本线：/);
      assert.ok(entry.statement.includes(k.title));
    }
  });

  it('keeps a case id that an expected-result leaf copies, and does not merge a positional case with an id that looks like a selector', () => {
    const copied: KmDocument = {
      root: {
        data: { id: 'r', text: '根' },
        children: [{ data: { id: 'k7', text: 'widget pool add p1', priority: 2, resource: ['Function'] }, children: [{ data: { id: 'k7', text: '设备正常' }, children: [] }] }],
      },
      template: '',
      theme: '',
      version: '',
    };
    const copiedOut = cases({
      build: buildOf('10.6.1', ['agile:case:5']),
      slots: { tree: treeSlot(CATALOG_A), folders: null },
      lists: { documents: [{ ...element(copied), external: 'agile:case:5' }] },
      batch: { index: 0, of: 1 },
      params: {},
    });
    assert.equal(copiedOut.entries[0]?.data.node, 'k7');
    const lookalike: KmDocument = {
      root: {
        data: { id: 'r', text: '根' },
        children: [
          { data: { id: 'i/1', text: 'widget pool add p1', priority: 2, resource: ['Function'] }, children: [] },
          { data: { text: 'widget pool delete p1', priority: 2, resource: ['Function'] }, children: [] },
        ],
      },
      template: '',
      theme: '',
      version: '',
    };
    const lookalikeOut = cases({
      build: buildOf('10.6.1', ['agile:case:6']),
      slots: { tree: treeSlot(CATALOG_A), folders: null },
      lists: { documents: [{ ...element(lookalike), external: 'agile:case:6' }] },
      batch: { index: 0, of: 1 },
      params: {},
    });
    const nodes = lookalikeOut.entries.map((entry) => entry.data.node);
    assert.equal(new Set(nodes).size, nodes.length);
    assert.ok(nodes.includes('i/1'));
  });
});

describe('the producer on bad input', () => {
  it('is total on hostile input and always answers producer-output@1', () => {
    const slots = { tree: treeSlot(CATALOG_A), folders: foldersSlot(corpus) };
    for (const [k, input] of hostileInputs().entries()) {
      assert.ok(ProducerOutput.safeParse(assertTotal(cases, input, `hostile ${k}`)).success);
      const asDocument = assertTotal(cases, { build: buildOf('10.6.1', ['agile:mindmap:1']), slots, lists: { documents: [{ sha256: 'b'.repeat(64), media_type: 'application/json', parser: 'kityminder@1', model: input }] }, batch: { index: 0, of: 1 }, params: { batch: BATCH } }, `document ${k}`);
      assert.ok(ProducerOutput.safeParse(asDocument).success);
      const asTree = assertTotal(cases, { build: buildOf('10.6.1', []), slots: { tree: { ...slots.tree, model: input }, folders: { ...slots.folders, model: input } }, lists: { documents: [element(corpus.documents['950081'])] }, batch: { index: 0, of: 1 }, params: { batch: BATCH } }, `slots ${k}`);
      assert.ok(ProducerOutput.safeParse(asTree).success);
    }
  });

  it('says what it could not use: no list, no tree, documents that are no mind maps or hold no case', () => {
    assert.deepEqual(cases({ build: buildOf('10.6.141', []), slots: { tree: treeSlot(CATALOG_A), folders: null }, lists: { documents: [] }, batch: { index: 0, of: 1 }, params: {} }), { entries: [], warnings: ['这个构建没有列出用例文档'] });
    const noTree = cases({ build: buildOf('10.6.1', []), slots: { tree: null, folders: null }, lists: { documents: [element(corpus.documents['950081'])] }, batch: { index: 0, of: 1 }, params: {} });
    assert.ok(noTree.entries.length > 0 && noTree.entries.every((entry) => entry.path === null));
    assert.match(noTree.warnings[0] ?? '', /没有命令树/);
    const odd = cases({ build: buildOf('10.6.1', []), slots: { tree: treeSlot(CATALOG_A), folders: null }, lists: { documents: [{ ...element(corpus.documents['950081']), parser: 'json@1' }, element({ root: { data: { text: '提纲' }, children: [] }, template: '', theme: '', version: '' })] }, batch: { index: 0, of: 1 }, params: {} });
    assert.ok(odd.warnings.some((w) => w.includes('不是 KityMinder 脑图')) && odd.warnings.some((w) => w.includes('没有用例节点')) && odd.warnings.some((w) => w.includes('用例树')));
  });

  it('keeps stored text storable: no NUL, no lone surrogate, bounded', () => {
    assert.equal(storable('a\u0000b\ud800c\udc00d', 10), 'ab�c�d');
    assert.equal(storable('😀'.repeat(5), 3), '😀😀😀…');
    const doc: KmDocument = { root: { data: { id: 'r0', text: 'widget pool add\u0000' }, children: [{ data: { id: 'c1', text: `widget pool add p\ud800 ${'长'.repeat(3000)}`, priority: 2, resource: ['Function'] }, children: [{ data: { id: 'e1', text: '设备正常' }, children: [] }] }] }, template: '', theme: '', version: '' };
    const out = cases({ build: buildOf('10.6.1', ['agile:mindmap:5']), slots: { tree: treeSlot(CATALOG_A), folders: null }, lists: { documents: [{ ...element(doc), external: 'agile:mindmap:5' }] }, batch: { index: 0, of: 1 }, params: {} });
    assert.equal(out.entries.length, 1);
    assert.ok(ProducerOutput.safeParse(out).success);
    const title = out.entries[0].data.title as string;
    assert.ok(!/\u0000|[\ud800-\udbff](?![\udc00-\udfff])/.test(title) && [...title].length <= 1001);
  });
});

describe('scale', () => {
  it('one batch of 40 documents of 60 cases against a catalog of 4,000 commands stays well inside the sandbox time limit', () => {
    const catalog: Command[] = [...CATALOG_A];
    for (let g = 0; g < 40; g++) for (let c = 0; c < 100; c++) catalog.push({ words: `grp${g} cmd${c} set`, help: 'synthetic', args: [{ type: 'U32', help: 'Value', limit: '[0 - 600]' }] });
    const titles = CASE_COMMAND_TABLE.filter((r) => r.where === 'title').map((r) => r.text);
    const documents: Element[] = [];
    for (let d = 0; d < 40; d++) {
      const groups: KmNode[] = [];
      for (let g = 0; g < 6; g++) {
        const casesOf: KmNode[] = [];
        for (let c = 0; c < 10; c++) {
          const n = d * 60 + g * 10 + c;
          const title = n % 3 === 0 ? `grp${n % 40} cmd${n % 100} set ${n}` : titles[n % titles.length];
          casesOf.push({ data: { id: `k${n}`, text: title, priority: 2, resource: ['Function'] }, children: [{ data: { id: `e${n}`, text: n % 2 ? '设备正常' : `返回 ${n}` }, children: [] }] });
        }
        groups.push({ data: { id: `g${d}-${g}`, text: `分组 ${g}`, priority: 1 }, children: casesOf });
      }
      documents.push(element({ root: { data: { id: `r${d}`, text: `文档 ${d}` }, children: groups }, template: '', theme: '', version: '' }));
    }
    const ids = documents.map((_, d) => `agile:mindmap:97${String(d).padStart(4, '0')}`);
    const start = performance.now();
    const out = cases({ build: buildOf('10.6.1', ids), slots: { tree: treeSlot(catalog), folders: foldersSlot(corpus) }, lists: { documents }, batch: { index: 0, of: 1 }, params: { batch: BATCH } });
    const ms = performance.now() - start;
    assert.ok(ProducerOutput.safeParse(out).success);
    assert.ok(out.entries.length >= 1500, `${out.entries.length} entries`);
    assert.ok(ms < 20_000, `${Math.round(ms)} ms for one batch`);
    assert.ok(new TextEncoder().encode(JSON.stringify(out)).length < 64 * 1024 * 1024);
  });
});

describe('the producer in the Hub sandbox', { skip: (await osIsolationAvailable()) ? false : 'no OS network isolation on this machine (sandbox-exec)' }, () => {
  it('gives the same answer as the direct call', async () => {
    const ids = listedFor(corpus, '10.6.1').map((id) => `agile:mindmap:${id}`);
    const batch = listBatches(ids, BATCH)[1];
    const input = { build: buildOf('10.6.1', ids), slots: { tree: treeSlot(CATALOG_A), folders: foldersSlot(corpus) }, lists: { documents: batch.externals.map((id) => element(corpus.documents[id.slice('agile:mindmap:'.length)])) }, batch: { index: batch.index, of: batch.of }, params: { batch: BATCH } };
    const result = await callPackFunction({ packDir: PACK_DIR, module: 'functions/cases.ts', export: 'cases' }, input, { timeoutMs: 60_000 });
    assert.equal(result.osIsolation, true);
    assert.deepEqual(result.output, JSON.parse(JSON.stringify(cases(input))));
  });
});
