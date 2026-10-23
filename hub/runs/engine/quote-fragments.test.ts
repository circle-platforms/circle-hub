// quote@1 reads any fragment of a source bound to the run, parsed by the boundary's own parser — also when the
// reference appears only deep inside slot data (the real defect-to-case shape: expected texts quote src fragments that
// the boundary never resolves because they sit in data, not in a quotes array). Verbatim passes; a wrong quote, a
// source that is not an input of this run and a selector that resolves to nothing are refuted; one reference is parsed
// once per evaluation. The retain-only and over-cap grades are covered at the interpreter level (quote.grades.test.ts).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { openHarness, sandboxSkip, type Harness } from './testing/harness.ts';
import { ROOTS } from './testing/knowledge.ts';
import { standardDocument, toyMap, ITEM } from './testing/mindmap.ts';

let postgres: TemporaryPostgres;
const skip = await sandboxSkip();

before(async function beforeHook() {
  postgres = await startPostgres();
});
after(async function afterHook() {
  await postgres?.stop();
});

/** The expected texts of the standard document's cases (each case's expected subnode, id suffix e0). */
const EXPECTED: Record<string, string> = { c1: '3 区开始浇灌，15 分钟后停止' };

/** A run whose c4 findings slot carries the quote deep in data (data.expected_quote); returns the findings requirement. */
const quoteRun = async (h: Harness, map: string, quote: { text: string; reference: string }) => {
  const run = (await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: map } } }, h.call())).run!;
  const reference = quote.reference === '@c1expected' ? expectedRef(map, run) : quote.reference;
  // The top-level quotes row carries a boundary-resolvable reference (the slot rule wants one); the data row is the
  // one under test — its reference never passes through the boundary.
  const topLevel = expectedRef(map, run);
  const answer = await h.service.submitResult(
    h.alice,
    {
      run: run.run,
      model: 'aster-7',
      items: [
        { item: ITEM.c1, handling: 'handled', slots: { findings: [] } },
        { item: ITEM.c2, handling: 'handled', slots: { findings: [] } },
        { item: ITEM.c3, handling: 'handled', slots: { findings: [] } },
        { item: ITEM.c4, handling: 'handled', slots: { findings: [{ text: '期望来源引文', code: 'edge_case_gap', rank: 'major', quotes: [{ reference: topLevel, text: EXPECTED.c1 }], data: { expected_quote: { text: quote.text, reference } } }] } },
      ],
      cross_item: [{ nature: 'judgment', statement: '一般', grounds: [], code: 'draft_level', rank: 'P4' }],
    },
    h.call(),
  );
  assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
  const row = answer.result!.partitions.delivered!.find((it) => it.item === ITEM.c4)!;
  return row.requirements.find((r) => r.requirement === 'findings')!;
};

/** c1's expected-subnode reference, derived from the started run's own item location (the id suffix e0, reuse's shape). */
const expectedRef = (map: string, run: { items: Array<{ id: string; location: string }> }): string => {
  const at = run.items.find((i) => i.id === ITEM.c1)!.location;
  return at.replace(/c1aaaaaaaaaa$/, 'c1aaaaaaaaaae0');
};

const open = async (): Promise<{ h: Harness; map: string }> => {
  const h = await openHarness(postgres, { review: { dynamicFindings: true }, dataQuotes: true });
  const map = await h.upload(h.alice, toyMap(standardDocument()));
  return { h, map };
};

test('a quote that appears only in slot data is checked against the bound source: verbatim passes', { skip }, async () => {
  const { h, map } = await open();
  try {
    const findings = await quoteRun(h, map, { text: EXPECTED.c1, reference: '@c1expected' });
    // The requirement is an independent judgment: its static layer is a judgment; the two quote checks (the boundary's
    // and the slot-data one) each support — the second proves the data-only reference was read and matched.
    const quoteSupports = findings.claims.filter((c) => c.statement.verdict === 'support' && JSON.stringify(c.statement.data ?? {}).includes('逐字') === false && (c.statement.text ?? '').includes('逐字一致'));
    assert.equal(quoteSupports.length, 2, JSON.stringify(findings.claims.map((c) => c.statement)));
    assert.ok(findings.claims.every((c) => c.statement.verdict !== 'refute' && c.statement.verdict !== 'unknown'), JSON.stringify(findings.claims.map((c) => c.statement)));
  } finally {
    await h.close();
  }
});

test('the same slot-data quote, not verbatim, is refuted with QUOTE_MISMATCH', { skip }, async () => {
  const { h, map } = await open();
  try {
    const findings = await quoteRun(h, map, { text: `${EXPECTED.c1}？`, reference: '@c1expected' });
    const layer = findings.layers.find((l) => l.layer === 'static')!;
    assert.equal(layer.terminal, 'violation', JSON.stringify(findings.layers));
    assert.ok(findings.claims.some((c) => c.statement.verdict === 'refute' && (c.statement as { code?: string }).code === 'QUOTE_MISMATCH'), JSON.stringify(findings.claims.map((c) => c.statement)));
  } finally {
    await h.close();
  }
});

test('a quote whose source is not an input of this run is refuted, not unknown', { skip }, async () => {
  const { h, map } = await open();
  try {
    const findings = await quoteRun(h, map, { text: '随便什么文字', reference: `src:${'f'.repeat(64)}/kityminder@1/n/docq7/c1aaaaaaaaaa` });
    const layer = findings.layers.find((l) => l.layer === 'static')!;
    assert.equal(layer.terminal, 'violation', JSON.stringify(findings.layers));
    const refute = findings.claims.find((c) => c.statement.verdict === 'refute')!;
    assert.match(refute.statement.text, /不是这次运行的输入/);
  } finally {
    await h.close();
  }
});

test('a selector that resolves to no fragment of a bound source is refuted as 片段不存在', { skip }, async () => {
  const { h, map } = await open();
  try {
    const findings = await quoteRun(h, map, { text: '随便什么文字', reference: `${map}/kityminder@1/n/docq7/nope` });
    const layer = findings.layers.find((l) => l.layer === 'static')!;
    assert.equal(layer.terminal, 'violation', JSON.stringify(findings.layers));
    const refute = findings.claims.find((c) => c.statement.verdict === 'refute')!;
    assert.match(refute.statement.text, /片段不存在/);
  } finally {
    await h.close();
  }
});

test('two quote rows over one reference evaluate in one pass (parsed once)', { skip }, async () => {
  const h = await openHarness(postgres, { review: { dynamicFindings: true }, dataQuotes: true });
  try {
    const map = await h.upload(h.alice, toyMap(standardDocument()));
    const started = (await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: map } } }, h.call())).run!;
    const reference = expectedRef(map, started);
    const answer = await h.service.submitResult(
      h.alice,
      {
        run: started.run,
        model: 'aster-7',
        items: [
          { item: ITEM.c1, handling: 'handled', slots: { findings: [] } },
          { item: ITEM.c2, handling: 'handled', slots: { findings: [] } },
          { item: ITEM.c3, handling: 'handled', slots: { findings: [] } },
          { item: ITEM.c4, handling: 'handled', slots: { findings: [
            { text: '期望来源引文一', code: 'edge_case_gap', rank: 'major', quotes: [{ reference, text: EXPECTED.c1 }], data: { expected_quote: { text: EXPECTED.c1, reference } } },
            { text: '期望来源引文二', code: 'coverage_gap', rank: 'major', quotes: [{ reference, text: EXPECTED.c1 }], data: { expected_quote: { text: EXPECTED.c1, reference } } },
          ] } },
        ],
        cross_item: [{ nature: 'judgment', statement: '一般', grounds: [], code: 'draft_level', rank: 'P4' }],
      },
      h.call(),
    );
    assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
    const row = answer.result!.partitions.delivered!.find((it) => it.item === ITEM.c4)!;
    // Both rows over the one reference are checked (four quote supports: two rows x two checks) with no refute or
    // unknown — one parse served them all.
    const findings = row.requirements.find((r) => r.requirement === 'findings')!;
    const quoteSupports = findings.claims.filter((c) => c.statement.verdict === 'support' && (c.statement.text ?? '').includes('逐字一致'));
    assert.equal(quoteSupports.length, 4, JSON.stringify(findings.claims.map((c) => c.statement)));
    assert.ok(findings.claims.every((c) => c.statement.verdict !== 'refute' && c.statement.verdict !== 'unknown'));
  } finally {
    await h.close();
  }
});

test('a tree reference whose root is the run\'s locked root is checked: verbatim passes, wrong quote refutes', { skip }, async () => {
  const h = await openHarness(postgres, { review: { dynamicFindings: true }, dataQuotes: true });
  try {
    const map = await h.upload(h.alice, toyMap(standardDocument()));
    // The harness locks line 3.2: its newest build's root (FakeKnowledge ROOTS.meadow329).
    const lockedRoot = ROOTS.meadow329;
    const treeRef = `tree:${lockedRoot}/zone/set`;
    // The fake tree reader answers the text 命令 zone set for a catalog path; quote it verbatim.
    const findings = await quoteRun(h, map, { text: '命令 zone set', reference: treeRef });
    assert.ok(findings.claims.some((c) => c.statement.verdict === 'support' && (c.statement.text ?? '').includes('逐字一致')), JSON.stringify(findings.claims.map((c) => c.statement)));
    const bad = await quoteRun(h, map, { text: '命令 zone set？', reference: treeRef });
    assert.ok(bad.claims.some((c) => c.statement.verdict === 'refute' && (c.statement as { code?: string }).code === 'QUOTE_MISMATCH'), JSON.stringify(bad.claims.map((c) => c.statement)));
  } finally {
    await h.close();
  }
});

test('a tree reference whose root is not the run\'s locked root is refuted as not an input', { skip }, async () => {
  const h = await openHarness(postgres, { review: { dynamicFindings: true }, dataQuotes: true });
  try {
    const map = await h.upload(h.alice, toyMap(standardDocument()));
    const otherRoot = ROOTS.grove105;
    const findings = await quoteRun(h, map, { text: '随便什么文字', reference: `tree:${otherRoot}/zone/set` });
    const refute = findings.claims.find((c) => c.statement.verdict === 'refute');
    assert.ok(refute !== undefined, JSON.stringify(findings.claims.map((c) => c.statement)));
    assert.match(refute.statement.text, /不是这次运行的输入/);
  } finally {
    await h.close();
  }
});

test('a rec reference that does not resolve stays unknown, never refuted', { skip }, async () => {
  const h = await openHarness(postgres, { review: { dynamicFindings: true }, dataQuotes: true });
  try {
    const map = await h.upload(h.alice, toyMap(standardDocument()));
    // An unresolvable rec: reference stays unknown (missing input), never a refutation.
    const stranger = 'e'.repeat(64);
    const findings = await quoteRun(h, map, { text: '随便什么文字', reference: `rec:${stranger}#/body/x` });
    const layer = findings.layers.find((l) => l.layer === 'static')!;
    assert.equal(layer.terminal, 'unchecked', JSON.stringify(findings.layers));
    assert.equal(layer.reason, 'missing_input');
    assert.ok(!findings.claims.some((c) => c.statement.verdict === 'refute'), JSON.stringify(findings.claims.map((c) => c.statement)));
    const unknown = findings.claims.find((c) => c.statement.verdict === 'unknown');
    assert.ok(unknown !== undefined && /取不回|不可读|没有绑定/.test(unknown.statement.text), JSON.stringify(unknown?.statement));
  } finally {
    await h.close();
  }
});
