// The local runner rebuilds, from the frozen download, input the Hub builds in its own code. Each piece that mirrors Hub code is
// run here beside the Hub's own function on the same data, so a change of the Hub's side shows up as a red test here, and the
// words copied from it are pinned to its source. The Hub's whole validation is compared in tools/check-record-hub.test.ts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { selectCatalog as hubSelectCatalog } from '../../../../../hub/knowledge/catalog-selection.ts';
import { runContextOf } from '../../../../../hub/runs/engine/evaluate.ts';
import { runCheck } from '../../../../../hub/rules/api.ts';
import { frozenRunFixture, knowledgeNodes } from '../../testing/recompose-frozen.ts';
import { frozenContext, hubOutcomes, selectedCatalog, type KnowledgeNodes } from './local-checks.ts';
import { shapeIssues } from './record-shape.ts';
import SHAPE from '../tables/recompose-record.schema.json' with { type: 'json' };

type Row = { [key: string]: any };
const ROOT = 'b'.repeat(64);
const RUN = 'run_01aaaaaaaaaaaaaaaaaaaaaaaa';
const param = (name: string, type: string) => ({ name, type, native_type: { name: 'synthetic-' + type, declaration: 'src:' + ROOT + '/xml@1/x/arg', grammar: 'synthetic-tree@1' } });
const entry = (words: string[], id = '1', params: Row[] = [param('pool', 'string')]) => ({ words, signatures: [{ id: words.join('/') + id, reference: 'src:' + ROOT + '/xml@1/x/' + words.join('/') + '/arguments', params }] });

const parsed = (text: string): KnowledgeNodes => new Map(text.split('\n').filter(Boolean).map((line) => JSON.parse(line)).slice(1).map((node: Row) => [node.path, node]));

/** The Hub's own selection (hub/knowledge/catalog-selection.ts) over the same nodes, answered from what the export wrote. */
async function hubSays(text: string, selection: { base: string; lines: string[] }): Promise<{ entries: Row[] } | { missing: string }> {
  const nodes = parsed(text);
  const byDigest = new Map([...nodes.values()].map((node) => [node.digest, node]));
  const body = (node: Row) => ({ name: node.name, height: 0, level: node.level, children: node.children.map((child: Row) => ({ name: child.name, digest: child.digest })), entries: node.entries.map((row: Row) => row.entry) });
  const row = (path: string, e: Row) => ({ path, entry: e.entry, kind: e.kind, producers: [], content: { kind: e.kind, statement: e.statement, data: e.data, applicability: null } });
  try {
    const view = await hubSelectCatalog({
      root: ROOT,
      selection,
      declaration: { id: 'commands@1', entry_kind: 'definition', complete: true, case_sensitive: true } as any,
      nodeAt: async (segments) => { const node = nodes.get(segments.length === 0 ? '/' : '/' + segments.join('/')); return node ? { digest: node.digest, node: body(node) as any } : null; },
      node: async (digest) => { const node = byDigest.get(digest); return node ? (body(node) as any) : null; },
      rowsAt: async (path) => new Map((nodes.get(path)?.entries ?? []).map((e: Row) => [e.entry, row(path, e) as any])),
      entries: async (ids) => new Map(ids.map((id) => { for (const node of nodes.values()) for (const e of node.entries) if (e.entry === id) return [id, row(node.path, e).content as any] as const; throw new Error('no such entry'); })),
    });
    return { entries: JSON.parse(JSON.stringify(view.entries())) };
  } catch (error) {
    if (error instanceof RangeError) return { missing: error.message };
    throw error;
  }
}

test('the catalog the local runner selects is the catalog the Hub\'s selection answers, entry for entry', async () => {
  const entries = [
    entry(['widget', 'health', 'interval'], '1', [param('pool', 'string'), param('value', 'int')]),
    entry(['widget', 'health', 'probe']),
    entry(['widget', 'pool', 'add']),
    entry(['widget', 'pool']),
    entry(['show', 'health']),
    // Two definitions of one head are one entry with both signatures.
    entry(['widget', 'overload'], 'a'),
    entry(['widget', 'overload'], 'b', [param('mode', 'string')]),
    entry(['gadget']),
    // A definition a manual produced has no overloads of its own: the Hub takes it as a command without arguments, and when the
    // command tree also defines the head, as the first of the two (round 33's real tree has such a head).
    { words: ['widget', 'bare'], signatures: undefined as unknown as Row[] },
    { words: ['widget', 'both'], signatures: undefined as unknown as Row[] },
    entry(['widget', 'both'], 'z'),
    // Not catalog data: no words, or overloads that are no list.
    { words: [], signatures: [] },
    { words: ['widget', 'broken'], signatures: 'none' as unknown as Row[] },
  ];
  const text = knowledgeNodes(ROOT, RUN, entries);
  const nodes = parsed(text);
  for (const lines of [
    ['widget health interval pool1 5'],
    ['widget pool add pool1', 'widget pool add pool1', 'show health pool1'],
    ['widget overload x', 'gadget'],
    ['widget bare', 'widget both x', 'widget broken'],
    ['widget health "interval" pool1', 'widget health probe pool1'],
    ['nothing here', 'widget', '', 'widget pool'],
    ['widget health interval \'pool1\' 5'],
    ['widget "unterminated'],
    [],
  ]) {
    const selection = { base: '/commands', lines };
    const local = selectedCatalog(nodes, selection);
    const hub = await hubSays(text, selection);
    assert.deepEqual(local, hub, JSON.stringify(lines));
  }
  assert.deepEqual(selectedCatalog(nodes, { base: '/nowhere', lines: ['widget'] }), await hubSays(text, { base: '/nowhere', lines: ['widget'] }));
});

test('the limits of the Hub\'s selection are the local runner\'s, with the Hub\'s words', async () => {
  const many = Array.from({ length: 513 }, (_, index) => entry(['many'], String(index)));
  const text = knowledgeNodes(ROOT, RUN, [...many, entry(['widget'])]);
  const nodes = parsed(text);
  const tokens = Array.from({ length: 129 }, () => 'widget').join(' ');
  for (const lines of [['many'], [tokens]]) {
    const local = selectedCatalog(nodes, { base: '/commands', lines });
    assert.ok('missing' in local, JSON.stringify(lines).slice(0, 40));
    assert.deepEqual(local, await hubSays(text, { base: '/commands', lines }), JSON.stringify(lines).slice(0, 40));
  }
  // The count and size of the lines are limited where the evaluation builds the check input, before the selection is asked for.
  const evaluate = readFileSync(new URL('../../../../../hub/runs/engine/evaluate.ts', import.meta.url), 'utf8');
  const tooMany = selectedCatalog(nodes, { base: '/commands', lines: Array.from({ length: 129 }, (_, index) => 'widget ' + index) });
  const tooLong = selectedCatalog(nodes, { base: '/commands', lines: ['x'.repeat(8193)] });
  assert.deepEqual(tooMany, tooLong);
  assert.ok('missing' in tooMany && evaluate.includes(tooMany.missing), 'the selection error the Hub words in evaluate.ts');
  assert.ok(evaluate.includes('缺锁定目录的所选路径；管理员修复目录读取后原样重交，不用整棵目录代替'), 'the unreadable-path words of evaluate.ts');
});

test('what the local runner makes of a function\'s output is what the Hub\'s runCheck makes of it', async () => {
  const good = { verdict: 'support', statement: '核对通过', grounds: [], tier: 'blocking' };
  const unknown = { verdict: 'unknown', reason: 'missing_input', missing: '缺一件事', statement: '缺一件事', grounds: [], tier: 'blocking' };
  const refuted = { verdict: 'refute', code: 'recompose.atom_dropped', statement: '少了命令', grounds: [], tier: 'blocking' };
  for (const [name, output] of [
    ['support, unknown and refute with a code of the pack', [good, unknown, refuted]],
    ['a refutation without a code', [{ ...refuted, code: undefined }]],
    ['a code on an outcome that does not refute', [{ ...good, code: 'recompose.atom_dropped' }]],
    ['an unknown without the missing fact', [{ ...unknown, missing: undefined }]],
    ['an unknown without a reason', [{ ...unknown, reason: undefined }]],
    ['a reason on an outcome that is not unknown', [{ ...good, reason: 'missing_input' }]],
    ['a code of another pack', [{ ...refuted, code: 'other.atom_dropped' }]],
    ['a code of the core', [{ ...refuted, code: 'core.quote.mismatch' }]],
    ['no outcome at all', []],
    ['not a list', { verdict: 'support' }],
  ] as const) {
    const hub = await runCheck(
      { id: 'record', function: { module: 'functions/recompose-check.ts', export: 'checkRecomposition' }, tier: 'blocking', basis: 'Declared structure and exact source identities' },
      { subject: {}, context: { run: RUN, requirement: 'record', pack: 'recompose', sets: {} }, packDir: '/synthetic', functionRunner: async () => ({ output: JSON.parse(JSON.stringify(output)) }) as any },
    );
    const said = (rows: Row[]) => rows.map((row) => ({ verdict: row.verdict, code: row.code, reason: row.reason, words: row.missing ?? row.statement }));
    assert.deepEqual(said(hubOutcomes('record', JSON.parse(JSON.stringify(output)), 'recompose')), said(hub as Row[]), name);
  }
});

test('the context the local runner gives the checks is the Hub\'s runContextOf of the same frozen run', () => {
  const frozen = frozenRunFixture().run;
  const withTarget = {
    ...frozen,
    target_basis: [{ grounds: [], statement: { text: '产品线', data: { field: 'product', names: ['ORBIT', 'COMET'], requested: 'ORBIT', value: 'orbit' } } }],
    skills: [{ pack: 'mindmap-format', version: '1.0.26', digest: 'd'.repeat(64) }],
    command_policy: { schema: 'command-policy@1', read_only: ['/commands/show'], inverse_rules: [] },
    feeding_offset: { schema: 'feeding-offset@1', offset: 7, root: ROOT, run: RUN },
    predecessor: 'run_01bbbbbbbbbbbbbbbbbbbbbbbb',
  };
  for (const run of [frozen, withTarget]) assert.deepEqual(frozenContext(run), JSON.parse(JSON.stringify(runContextOf(run as any))));
});

test('a value outside the pack\'s record schema is found where it is, with what the schema allows', () => {
  const record = {
    schema: 'recompose-record@1',
    case: { id: 'c1', source_ref: 'src:' + 'a'.repeat(64), node: 'n/1' },
    contract: { intent: { text: 'i', quote_ref: 'src:' + 'a'.repeat(64) + '/x', verbatim: true }, method: { kind: 'declared', text: 't', sources: ['s'], basis: 'b' }, expectation: { text: 'e', quote_ref: 'src:' + 'a'.repeat(64) + '/y', verbatim: true } },
    expectation_slots: [{ slot: 'e1', atom: 'a2', knowledge_location: 'has_verification_knowledge', evidence: [], proposal: null }],
    coverage: { author_atoms: ['a1'], mapped: { a1: ['e1'] }, unmapped: [] },
    atoms: [{ id: 'a1', kind: 'action', text: 'x', quote_ref: 'src:' + 'a'.repeat(64) + '/x', span: [0, 1] }],
    sources: { governing: [], candidates: [], states: [{ atom: 'a1', state: 'settled', adjudicated_by: null, reason: 'r', exit: { action: 'a', object: 'o', owner: 'w', due: 'd' } }] },
    ledgers: { original: [{ atom: 'a1', text: 'x', quote_ref: 'src:' + 'a'.repeat(64) + '/x', span: [0, 1] }], adapted: [], concretizations: [], rebindings: [] },
    status: 'complete',
    unknowns: [],
  };
  assert.deepEqual(shapeIssues(SHAPE, record), []);
  const bad = structuredClone(record) as Row;
  bad.expectation_slots[0].knowledge_location = 'unspecified';
  delete bad.sources.states[0].reason;
  bad.unknowns = [{ missing: 'm', owner: 'someone' }];
  bad.status = 7;
  const issues = shapeIssues(SHAPE, bad);
  assert.deepEqual(issues.map((issue) => issue.pointer).sort(), ['/expectation_slots/0/knowledge_location', '/sources/states/0/reason', '/status', '/unknowns/0/owner']);
  const slot = issues.find((issue) => issue.pointer === '/expectation_slots/0/knowledge_location')!;
  assert.equal(slot.found, '写的是 "unspecified"');
  assert.equal(slot.expected, '"has_verification_knowledge" | "recomposable_from_elsewhere" | "genuinely_missing"');
  assert.equal(issues.find((issue) => issue.pointer === '/unknowns/0/owner')!.found, '多了这个字段');
  assert.equal(issues.find((issue) => issue.pointer === '/sources/states/0/reason')!.found, '缺这一项');
});
