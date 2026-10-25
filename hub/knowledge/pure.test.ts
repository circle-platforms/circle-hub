// Pure parts of hub/knowledge: normalisation and digests, the in-memory tree, levels, pointer names, build order,
// applicability text, the placement question and the CLI arguments. No database, no sandbox.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { TreeNodeBody, levelOfHeight } from '../../contracts/src/knowledge.ts';
import { NONE_OPTION } from '../jev/api.ts';
import { canonicalize, sha256Hex } from '../records/api.ts';
import { compareNewestFirst, pointerName } from './builds.ts';
import { KNOWLEDGE_SYNC_USAGE, parseKnowledgeSyncArgs, formatSyncReport } from './cli.ts';
import { cutText, entryContentOf, entryDigest, nodeDigest, normaliseApplicability, normaliseStatement } from './digest.ts';
import { KnowledgeError } from './errors.ts';
import { MAX_REAL_OPTIONS, belowThreshold, narrowCandidates, optionNames, placementNote, placementQuestion, questionId } from './placement.ts';
import { buildProblem } from './store.ts';
import { catalogData, plannedSources } from './produce.ts';
import { applicabilityText } from './read.ts';
import type { SyncReport } from './sync.ts';
import { TreeBuilder, flatten } from './tree.ts';
import { checkPath } from './verify.ts';

const H = (c: string): string => c.repeat(64);

describe('normalisation and digests (K01 R[7], K02 R[4])', () => {
  test('a statement is NFC with LF line breaks, no NUL and no trailing white space or empty edge lines', () => {
    assert.equal(normaliseStatement('\r\n  é one  \r\ntwo\u0000\t\r\n\r\n'), '  é one\ntwo');
    assert.equal(normaliseStatement('a\rb'), 'a\nb');
    assert.equal(normaliseStatement(''), '');
  });

  test('applicability lists are sorted without repeats and null stays undeclared', () => {
    assert.equal(normaliseApplicability(null), null);
    assert.deepEqual(normaliseApplicability({ builds: ['b', 'a', 'b'], models: [] }), { builds: ['a', 'b'], models: [] });
  });

  test('the entry digest covers kind, normalised statement, data and applicability only', () => {
    const base = entryContentOf({ kind: 'command', statement: 'show x', data: { words: ['show', 'x'] }, applicability: null });
    const same = entryContentOf({ kind: 'command', statement: 'show x  \r\n', data: { words: ['show', 'x'] }, applicability: null });
    assert.equal(entryDigest(base), entryDigest(same));
    assert.equal(entryDigest(base), sha256Hex(canonicalize({ kind: 'command', statement: 'show x', data: { words: ['show', 'x'] }, applicability: null })));
    for (const changed of [
      { ...base, kind: 'other' },
      { ...base, statement: 'show y' },
      { ...base, data: { words: ['show'] } },
      { ...base, applicability: { builds: ['b1'] } },
    ]) {
      assert.notEqual(entryDigest(changed), entryDigest(base));
    }
  });

  test('data that is not canonical JSON is refused', () => {
    assert.throws(() => entryContentOf({ kind: 'k', statement: 's', data: { bad: Number.NaN }, applicability: null }));
  });

  test('text is cut on characters and made well formed', () => {
    assert.equal(cutText(`${'a'.repeat(159)}\u{1F600}b`, 160), 'a'.repeat(159));
    assert.equal(cutText(`${'a'.repeat(158)}\u{1F600}b`, 160), `${'a'.repeat(158)}\u{1F600}`);
    assert.equal(cutText('lone \ud83d here', 100), 'lone � here');
    assert.equal(cutText('short', 100), 'short');
    assert.ok(cutText('\udc00'.repeat(10), 5).isWellFormed());
  });

  test('the node digest covers the name, the children (names and digests) and the entry digests', () => {
    const node = { name: 'x', children: [{ name: 'a', digest: H('1') }], entries: [H('2')] };
    assert.equal(nodeDigest(node), sha256Hex(canonicalize(node)));
    assert.notEqual(nodeDigest({ ...node, name: 'y' }), nodeDigest(node));
    assert.notEqual(nodeDigest({ ...node, children: [{ name: 'b', digest: H('1') }] }), nodeDigest(node));
    assert.notEqual(nodeDigest({ ...node, entries: [] }), nodeDigest(node));
  });

  test('levels follow the height: leaf, branch, trunk', () => {
    assert.equal(levelOfHeight(0), 'leaf');
    assert.equal(levelOfHeight(1), 'branch');
    assert.equal(levelOfHeight(2), 'trunk');
    assert.equal(levelOfHeight(9), 'trunk');
    assert.throws(() => levelOfHeight(-1));
  });
});

describe('the in-memory tree (K01 R[1], R[2])', () => {
  test('digests are bottom-up, independent of insertion order, and nodes validate as tree_node@1', () => {
    const one = new TreeBuilder();
    one.add(['commands', 'net', 'ping'], H('a'));
    one.add(['commands', 'system', 'reboot'], H('b'));
    one.add(['commands', 'system'], H('c'));
    const two = new TreeBuilder();
    two.add(['commands', 'system'], H('c'));
    two.add(['commands', 'system', 'reboot'], H('b'));
    two.add(['commands', 'net', 'ping'], H('a'));
    const a = one.build();
    const b = two.build();
    assert.equal(a.digest, b.digest);
    const nodes = flatten(a);
    assert.deepEqual(
      nodes.map((n) => [n.path, n.level, n.height]),
      [
        ['/', 'trunk', 3],
        ['/commands', 'trunk', 2],
        ['/commands/net', 'branch', 1],
        ['/commands/net/ping', 'leaf', 0],
        ['/commands/system', 'branch', 1],
        ['/commands/system/reboot', 'leaf', 0],
      ],
    );
    for (const node of nodes) {
      assert.equal(TreeNodeBody.safeParse({ name: node.name, height: node.height, level: node.level, children: node.children, entries: node.entries }).success, true, node.path);
      assert.equal(node.digest, nodeDigest(node));
    }
  });

  test('an unchanged subtree keeps its digest when a sibling changes', () => {
    const one = new TreeBuilder();
    one.add(['c', 'net', 'ping'], H('a'));
    one.add(['c', 'system', 'reboot'], H('b'));
    const two = new TreeBuilder();
    two.add(['c', 'net', 'ping'], H('a'));
    two.add(['c', 'system', 'reboot'], H('d'));
    const find = (root: ReturnType<TreeBuilder['build']>, path: string) => flatten(root).find((n) => n.path === path)?.digest;
    const a = one.build();
    const b = two.build();
    assert.equal(find(a, '/c/net'), find(b, '/c/net'));
    assert.notEqual(find(a, '/c/system'), find(b, '/c/system'));
    assert.notEqual(a.digest, b.digest);
  });

  test('tree_node@1 refuses unsorted children, a wrong level and a height that contradicts the children', () => {
    const ok = { name: 'x', height: 1, level: 'branch', children: [{ name: 'a', digest: H('1') }, { name: 'b', digest: H('2') }], entries: [] };
    assert.equal(TreeNodeBody.safeParse(ok).success, true);
    assert.equal(TreeNodeBody.safeParse({ ...ok, children: [...ok.children].reverse() }).success, false);
    assert.equal(TreeNodeBody.safeParse({ ...ok, level: 'leaf' }).success, false);
    assert.equal(TreeNodeBody.safeParse({ ...ok, height: 0 }).success, false);
    assert.equal(TreeNodeBody.safeParse({ ...ok, entries: [H('2'), H('1')] }).success, false);
  });

  test('producer paths must be canonical tree path text', () => {
    assert.deepEqual(checkPath('/commands/show').ok && checkPath('/commands/show'), { ok: true, value: { segments: ['commands', 'show'], path: '/commands/show' } });
    assert.equal(checkPath('/a%20b').ok, true);
    for (const bad of ['commands', '/a//b', '/a/', '/a b', '/a%2', '/a%41']) assert.equal(checkPath(bad).ok, false, bad);
    assert.equal(checkPath('/').ok, true);
  });
});

describe('builds, lines and pointers', () => {
  const build = (name: string, released: string | null, built: string | null) => ({ name, family: 'ACME', line: '1.2', base: name, platform: null, built_at: built, released_at: released, sources: {} });

  test('newest first: release date, unreleased last, then build time, then name', () => {
    const list = [
      build('b', null, '2026-01-09T00:00:00.000Z'),
      build('a', '2026-01-05T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      build('c', '2026-01-05T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
      build('d', '2026-01-07T00:00:00.000Z', null),
    ].sort(compareNewestFirst);
    assert.deepEqual(list.map((b) => b.name), ['d', 'c', 'a', 'b']);
  });

  test('pointer names encode the line injectively within the records name grammar', () => {
    const names = ['1.2.3', '1.2.TLS9.9', '1.2.tls9.9', '1:2', 'x/y', '版本'].map((line) => pointerName('acme', line));
    assert.equal(new Set(names).size, names.length);
    for (const name of names) assert.match(name, /^[a-z0-9][a-z0-9:._/-]{0,199}$/);
    assert.equal(pointerName('acme', '1.2.3'), 'knowledge/acme/1.2.3');
    assert.throws(() => pointerName('acme', 'x'.repeat(300)), KnowledgeError);
  });

  test('a build the store cannot index is named: too long in UTF-8 bytes, a NUL, a lone surrogate, a line without a pointer', () => {
    const ok = { name: 'Rel_ACME_1_2_15', family: 'ACME', line: '1.2', base: 'Rel_ACME_1_2_15', platform: null, built_at: null, released_at: null, sources: {} };
    assert.equal(buildProblem('acme', ok), null);
    assert.equal(buildProblem('acme', { ...ok, name: '构'.repeat(300), base: '构'.repeat(300) }), null, '900 bytes fit');
    for (const bad of [
      { ...ok, name: '构'.repeat(400) },
      { ...ok, base: 'x'.repeat(996) },
      { ...ok, name: 'Rel_ACME_1_2_9\u0000x' },
      { ...ok, family: 'AC\ud800ME' },
      { ...ok, platform: 'p\u0000' },
      { ...ok, line: 'l'.repeat(300) },
    ]) {
      assert.match(buildProblem('acme', bad) ?? '', /构建名|构建信息|版本线/, JSON.stringify(bad).slice(0, 80));
    }
  });

  test('declared sources: build roles and templates; the basis follows the release record', () => {
    const product = {
      id: 'acme',
      version: '1.0.0',
      digest: H('9'),
      kind: 'product' as const,
      directory: '/nonexistent',
      product: {
        schema: 'product@1' as const,
        id: 'acme',
        title: 't',
        names: ['ACME'],
        catalogs: [],
        producers: [
          { id: 'p', title: 'p', function: { module: 'functions/p.ts' }, inputs: { tree: { source: 'tree' }, manual: { external: 'store:manual:{product}-{line}', optional: true }, plat: { external: 'store:p:{platform}', optional: true } } },
        ],
      },
    };
    const released = { ...build('Rel_ACME_1_2_15', '2026-01-05T00:00:00.000Z', null), sources: { tree: 'site:tree:Rel_ACME_1_2_15' } };
    const planned = plannedSources(product, released);
    assert.deepEqual(
      planned.map((s) => [s.slot, s.external, s.basis, s.problem === null]),
      [
        ['tree', 'site:tree:Rel_ACME_1_2_15', 'release_record', true],
        ['manual', 'store:manual:acme-1.2', 'declared', true],
        ['plat', null, 'declared', false],
      ],
    );
    assert.equal(plannedSources(product, { ...released, released_at: null })[0].basis, 'declared');
  });
});

describe('display and placement questions', () => {
  test('applicability text says 未声明 for undeclared conditions (K02 R[2])', () => {
    assert.equal(applicabilityText(null), '未声明');
    assert.equal(applicabilityText({}), '未声明具体条件，不能据此判为无条件适用');
    assert.equal(applicabilityText({ builds: ['b1', 'b2'], platforms: ['p'] }), '起止构建 b1、b2；平台 p');
  });

  test('the placement note reads 归类判断：Jev@<exact version>，p=…，只影响位置 (K04 R[5])', () => {
    assert.equal(placementNote('jev-1.13.0', 0.934), '归类判断：Jev@jev-1.13.0，p=0.93，只影响位置');
  });

  test('a probability below a threshold is printed with the digits that keep the order', () => {
    assert.deepEqual(belowThreshold(0.6, 0.97), ['0.60', '0.97']);
    assert.deepEqual(belowThreshold(0.9601, 0.965), ['0.960', '0.965']);
    // Cut, never rounded up: the threshold is never shown higher than it is.
    assert.deepEqual(belowThreshold(0.96449, 0.9645), ['0.9644', '0.9645']);
    assert.deepEqual(belowThreshold(0.28, 0.29), ['0.28', '0.29']);
    const [p, t] = belowThreshold(0.123456789, 0.1234567891);
    assert.ok(Number(p) < Number(t), `${p} ${t}`);
  });

  test('every choice question has an explicit none option last; option names avoid what the service refuses', () => {
    const children = [{ name: 'net', description: 'networking' }, { name: '12', description: null }, { name: NONE_OPTION, description: null }, { name: ' spaced', description: null }];
    const options = optionNames(children);
    assert.deepEqual([...options.keys()], ['net', 'child-2', 'child-3', 'child-4']);
    const question = placementQuestion('q1', ['commands'], children, options);
    const keys = Object.keys(question.criteria);
    assert.equal(keys[keys.length - 1], NONE_OPTION);
    assert.equal(keys.length, children.length + 1);
    assert.match(question.instructions, /`q1`/);
    assert.equal(question.criteria['child-2'], '12');
  });

  test('more than 254 children are narrowed by literal match; nothing left or still too many cannot be asked', () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ name: `opt${i}`, description: null }));
    assert.equal(MAX_REAL_OPTIONS, 254);
    assert.deepEqual(narrowCandidates(many, 'about OPT7 and opt12')?.map((c) => c.name), ['opt1', 'opt7', 'opt12']);
    assert.equal(narrowCandidates(many, 'nothing here'), null);
    assert.equal(narrowCandidates(many.slice(0, 10), 'nothing')?.length, 10);
  });

  test('question ids are stable for the same span and node', () => {
    assert.equal(questionId('k', ['a']), questionId('k', ['a']));
    assert.notEqual(questionId('k', ['a']), questionId('k', ['b']));
    assert.match(questionId('k', []), /^q[0-9a-f]{40}$/);
  });

  test('catalog data is taken from the catalog-entry fields of an entry', () => {
    assert.deepEqual(catalogData({ words: ['show'], signatures: [{ id: '1', params: [] }], extra: 1 }), { words: ['show'], signatures: [{ id: '1', params: [] }] });
    assert.equal(catalogData({ words: [] }), null);
    assert.equal(catalogData({ signatures: [] }), null);
  });
});

describe('knowledge sync arguments', () => {
  test('product, line and flags in both spellings', () => {
    assert.deepEqual(parseKnowledgeSyncArgs(['--product', 'acme', '--line', '1.3', '--dry-run']), { product: 'acme', line: '1.3', dryRun: true, recheck: false, includeUnreleased: false, maxAgeSeconds: null });
    assert.deepEqual(parseKnowledgeSyncArgs(['--product=ZETA', '--recheck', '--include-unreleased']), { product: 'ZETA', line: null, dryRun: false, recheck: true, includeUnreleased: true, maxAgeSeconds: null });
    assert.equal(parseKnowledgeSyncArgs(['--product', 'acme', '--max-age', '0']).maxAgeSeconds, 0);
    assert.equal(parseKnowledgeSyncArgs(['--product', 'acme', '--max-age=3600']).maxAgeSeconds, 3600);
  });

  test('a missing product, a missing value or an unknown argument is refused with the usage', () => {
    for (const argv of [
      [],
      ['--line', '1.3'],
      ['--product'],
      ['--product', '--dry-run'],
      ['--product', 'a', '--force'],
      ['--product', 'a', '--dry-run=yes'],
      ['--product', 'a', '--line='],
      ['--product', 'a', '--max-age', '-1'],
      ['--product', 'a', '--max-age=1.5'],
      ['--product', 'a', '--max-age'],
    ]) {
      assert.throws(() => parseKnowledgeSyncArgs(argv), (error: unknown) => error instanceof KnowledgeError && (error.message.includes(KNOWLEDGE_SYNC_USAGE) || error.message.includes('--line')), argv.join(' '));
    }
  });

  test('the report text names every build with its outcome and reason', () => {
    const report: SyncReport = {
      sync: 'sync_x',
      product: 'acme',
      pack: 'acme@1.0.0',
      dry_run: false,
      started_at: '2026-01-01T00:00:00.000Z',
      ended_at: '2026-01-01T00:00:01.000Z',
      plan: { rounds: 3, done: true, note: null, builds: 2, reads: 4, failed_reads: [{ id: 'site:page:x', reason: '读取失败：HTTP 404' }], limits: { rounds: false, reads: false, max_rounds: 6, max_reads: 50 } },
      builds: [
        { name: 'b1', family: 'ACME', line: '1.2', base: 'b1', outcome: 'produced', reason: '产出根', root: H('a'), composition: H('b') },
        { name: 'b2', family: 'ZETA', line: '1.2', base: 'b1', outcome: 'skipped', reason: '别名', root: null, composition: null },
        { name: 'b3', family: 'ACME', line: '1.2', base: 'b3', outcome: 'registered', reason: '没有可读的来源，只登记名字', root: null, composition: null },
      ],
      pointers: [{ line: '1.2', from: null, to: H('a'), build: 'b1', moved: true, reason: '移到 b1 的根' }],
      counts: { produced: 1, registered: 1, skipped: 1, failed: 0 },
      warnings: [],
      error: null,
    };
    const text = formatSyncReport(report);
    assert.match(text, /\[产出\] b1/);
    assert.match(text, /\[跳过\] b2（ZETA，1\.2，基于 b1）：别名/);
    assert.match(text, /\[登记\] b3（ACME，1\.2）：没有可读的来源，只登记名字/);
    assert.match(text, /构建：产出 1，只登记名字 1，跳过 1，失败 0/);
    assert.match(text, /读取失败 site:page:x：读取失败：HTTP 404/);
    assert.match(text, /当前根 1\.2：（无） → a{64}（b1）/);
  });
});
