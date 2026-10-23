// The tests of case-review-report: the projection (the worst verdict wins, per-item delivery merges, an overlap refuses,
// an item nobody delivered marks the whole unfinished with the missing items named, a missing final makes the overall
// unknown) and the two checks (the overall fact and the report agreement over cross_item claims), driven on the same
// synthetic two-block shape the samples use. Pure functions, no Hub, no database.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ProjectedItem } from '../../../../contracts/src/pack.ts';
import projection from './projection.ts';
import { overallCheck, reportCheck } from './checks.ts';

const A = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const B = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
const DIGEST = 'a'.repeat(64);

interface Entry { item: string; kind?: string; text?: string; rank?: string }
type Block = { verdict: string | null; level: string | null; entries: Entry[]; partition?: string };

/** A synthetic verification result: delivered entries with one claim each, a cross_item final (Claim-shaped), one source. */
function block(spec: Block): Record<string, unknown> {
  const delivered = spec.entries.map((entry, index) => ({
    item: entry.item,
    label: `用例 ${entry.item}`,
    location: `src:${DIGEST}/kityminder@1/n/${entry.item}`,
    requirements: [
      { key: 'verification', claims: [{ statement: { code: entry.kind ?? 'verified', text: entry.text ?? `发现 ${entry.item}`, rank: entry.rank ?? 'minor' }, data: {} }] },
      { key: 'final', claims: [] },
    ],
  }));
  // The real-data shape: a block that carries entries it did not deliver lists them unfinished (the first half), the
  // rest of its entries stay delivered.
  const halved = spec.partition === 'unfinished' ? spec.entries.slice(0, Math.ceil(spec.entries.length / 2)) : [];
  const unfinished = halved.map((entry) => ({ item: entry.item, label: `用例 ${entry.item}`, location: `src:${DIGEST}/kityminder@1/n/${entry.item}`, requirements: [] }));
  const partitions: Record<string, unknown[]> = { delivered: spec.partition === 'unfinished' ? delivered.slice(halved.length) : delivered };
  if (unfinished.length > 0) partitions.unfinished = unfinished;
  return {
    schema: 'validation@1',
    locks: { pack: 'case-review-verify@1.0.3', pack_digest: '0'.repeat(64), subject: { digest: DIGEST } },
    partitions,
    ...(spec.verdict === null ? {} : { cross_item: [{ nature: 'judgment', statement: { text: '结论', code: spec.verdict, rank: spec.level }, grounds: [] }] }),
  };
}

function run(blocks: Array<{ result: Record<string, unknown> }>): { items?: ProjectedItem[]; error?: { code?: string; message?: string } } {
  // The BoundInput shape the Hub really gives: the rec: value parsed into `model` (the record or the result itself).
  let n = 0;
  return projection({ inputs: blocks.map((b) => ({ slot: 'verifications', external: null, sha256: '0'.repeat(64), media_type: 'application/json', parser: 'json@1', model: { kind: 'validation_result', schema: 'record@1', body: b.result }, meta: { record: `${String(++n).repeat(64)}`.slice(0, 64) } })), parameters: {}, context: {} }) as { items?: ProjectedItem[]; error?: { code?: string; message?: string } };
}

const reportItemOf = (out: { items?: ProjectedItem[]; error?: { code?: string; message?: string } }): { summary?: string; fields: Record<string, unknown> } => {
  const item = out.items?.find((i) => i.id === 'report');
  assert.ok(item !== undefined, 'the report item exists');
  return item as unknown as { summary?: string; fields: Record<string, unknown> };
};

describe('the projection of case-review-report', () => {
  it('the worst verdict wins and takes that block\'s level', () => {
    const out = run([
      { result: block({ verdict: 'PASS', level: 'P3', entries: [{ item: 'c1' }] }) },
      { result: block({ verdict: 'PARTIAL', level: 'P5', entries: [{ item: 'c2' }, { item: 'c3' }] }) },
    ]);
    const report = reportItemOf(out);
    assert.deepEqual(report.fields.overall, { verdict: 'PARTIAL', level: 'P5' });
    assert.equal(report.summary, '整体结论码 PARTIAL、等级 P5（最差那块的，照抄）');
    assert.deepEqual((out.items ?? []).filter((i) => i.id !== 'report').map((i) => i.id), ['c1', 'c2', 'c3']);
    const c1 = out.items?.find((i) => i.id === 'c1');
    assert.match(c1?.summary ?? '', /^证实 rec:[0-9a-f]{64}#.+；推翻 0 条$/);
  });

  it('an item unfinished in one block and delivered in another counts as delivered (that block wins)', () => {
    // The real-data shape: block B carried all 62 entries, its first half unfinished; A delivered them.
    const out = run([
      { result: block({ verdict: 'PASS', level: 'P3', entries: [{ item: 'c1' }] }) },
      { result: block({ verdict: 'PASS', level: 'P3', partition: 'unfinished', entries: [{ item: 'c1' }, { item: 'c2' }] }) },
    ]);
    assert.deepEqual((out.items ?? []).filter((i) => i.id !== 'report').map((i) => i.id), ['c1', 'c2']);
    assert.deepEqual(reportItemOf(out).fields.missing_items, []);
  });

  it('an item delivered in two blocks refuses the run with the overlapping items named', () => {
    const out = run([
      { result: block({ verdict: 'PASS', level: 'P3', entries: [{ item: 'c1' }] }) },
      { result: block({ verdict: 'PASS', level: 'P3', entries: [{ item: 'c1' }, { item: 'c2' }] }) },
    ]);
    assert.equal(out.error?.code, 'case-review-report.overlap');
    assert.match(out.error?.message ?? '', /c1/);
  });

  it('an item delivered in no block marks the whole unfinished and names it (never PASS)', () => {
    const out = run([
      { result: block({ verdict: 'PASS', level: 'P3', entries: [{ item: 'c1' }] }) },
      { result: block({ verdict: 'PASS', level: 'P3', partition: 'unfinished', entries: [{ item: 'c9' }] }) },
    ]);
    const report = reportItemOf(out);
    assert.deepEqual(report.fields.missing_items, ['c9']);
  });

  it('a block without a readable final makes the overall unknown', () => {
    const out = run([
      { result: block({ verdict: 'PASS', level: 'P3', entries: [{ item: 'c1' }] }) },
      { result: block({ verdict: null, level: null, entries: [{ item: 'c2' }] }) },
    ]);
    const report = reportItemOf(out);
    assert.equal(report.fields.overall, null);
    assert.equal(report.summary, '整体结论未知（各块没有可读结论）');
  });

  it('real shape (two blocks, 45 findings, 1 refuted): summaries expose all citable references and overall, checks pass on first attempt', () => {
    const block1Entries: Entry[] = Array.from({ length: 23 }, (_, i) => ({
      item: `case-1-${i + 1}`,
      kind: 'verified',
      text: `发现 1-${i + 1}`,
      rank: 'minor',
    }));
    const block2Entries: Entry[] = Array.from({ length: 22 }, (_, i) => ({
      item: `case-2-${i + 1}`,
      kind: i === 0 ? 'refuted' : (i === 1 ? 'partial' : 'verified'),
      text: `发现 2-${i + 1}`,
      rank: 'minor',
    }));

    const out = run([
      { result: block({ verdict: 'PARTIAL', level: 'P4', entries: block1Entries }) },
      { result: block({ verdict: 'PASS', level: 'P2', entries: block2Entries }) },
    ]);

    const report = reportItemOf(out);
    assert.deepEqual(report.fields.overall, { verdict: 'PARTIAL', level: 'P4' });
    assert.equal(report.summary, '整体结论码 PARTIAL、等级 P4（最差那块的，照抄）');

    // Parse overall verdict and level from report summary
    const overallMatch = /整体结论码\s+(\w+)、等级\s+(\w+)/.exec(report.summary ?? '');
    assert.ok(overallMatch !== null, 'report summary contains verdict and level');
    const [, parsedVerdict, parsedLevel] = overallMatch;

    const items = (out.items ?? []).filter((i) => i.id !== 'report');
    assert.equal(items.length, 45);

    const refutedItem = items.find((i) => i.id === 'case-2-1');
    assert.ok(refutedItem !== undefined);
    assert.equal(refutedItem.summary, '没有要引用的发现；推翻 1 条');

    const partialItem = items.find((i) => i.id === 'case-2-2');
    assert.ok(partialItem !== undefined);
    assert.match(partialItem.summary ?? '', /^部分正确 rec:[0-9a-f]{64}#.+；推翻 0 条$/);

    // Extract all citable references from items' summaries
    const citedRefs: string[] = [];
    for (const it of items) {
      const matches = it.summary?.match(/rec:[0-9a-f]{64}#[^\s；、]+/g) ?? [];
      citedRefs.push(...matches);
    }
    // 45 findings total - 1 refuted = 44 citable references
    assert.equal(citedRefs.length, 44);

    // Verify against overallCheck and reportCheck: passes on first attempt!
    const subject = {
      applies: 'run',
      items: out.items,
      context: {},
      cross_item: [{
        nature: 'judgment',
        statement: '终稿：两块合成，共 45 条处置，推翻 1 条，各块发现逐条核对一致',
        grounds: citedRefs,
        code: parsedVerdict,
        rank: parsedLevel,
      }],
    };

    const overallOut = overallCheck({ subject });
    assert.equal(overallOut[0]?.verdict, 'support');

    const reportOut = reportCheck({ subject });
    assert.equal(reportOut[0]?.verdict, 'support');
  });

  it('blocks on two different sources refuse the run', () => {
    const second = block({ verdict: 'PASS', level: 'P3', entries: [{ item: 'c2' }] });
    (second.partitions as Record<string, { item: string; label: string; location: string; requirements: unknown[] }[]>).delivered = (second.partitions as Record<string, { item: string; label: string; location: string; requirements: unknown[] }[]>).delivered.map((entry) => ({ ...entry, location: entry.location.replace(DIGEST, 'b'.repeat(64)) }));
    const out = run([
      { result: block({ verdict: 'PASS', level: 'P3', entries: [{ item: 'c1' }] }) },
      { result: second },
    ]);
    assert.equal(out.error?.code, 'case-review-report.sources_differ');
  });
});

describe('the checks of case-review-report', () => {
  const findings = [
    { kind: 'verified', reference: `rec:${A}#/partitions/delivered/0/requirements/0/claims/0`, block: 0, text: 'A 证实', rank: 'minor' },
    { kind: 'partial', reference: `rec:${B}#/partitions/delivered/0/requirements/0/claims/0`, block: 1, text: 'B 部分正确', rank: 'major' },
    { kind: 'new_finding', reference: `rec:${B}#/partitions/delivered/0/requirements/0/claims/1`, block: 1, text: 'B 新增', rank: 'minor' },
    { kind: 'refuted', reference: `rec:${B}#/partitions/delivered/0/requirements/0/claims/2`, block: 1, text: 'B 推翻', rank: 'minor' },
  ];
  const refs = findings.filter((f) => f.kind !== 'refuted').map((f) => f.reference);
  const refutedRef = findings[3]!.reference;
  const subjectWith = (crossItem: Record<string, unknown>[]): Record<string, unknown> => ({
    applies: 'run',
    items: [{ id: 'report', label: '评审终稿', location: `src:${DIGEST}/kityminder@1/n/c1`, fields: { overall: { verdict: 'PARTIAL', level: 'P5' }, findings } }],
    context: {},
    cross_item: crossItem,
  });
  // The verdict claim: its code IS the verdict, its rank the level (the verification pack's own final shape).
  const verdictClaim = (verdict: string, rank: string | undefined, grounds: string[]): Record<string, unknown> => ({ nature: 'judgment', statement: '终稿（中文全文略）：两块合成，各块发现逐条核对', grounds, code: verdict, ...(rank === undefined ? {} : { rank }) });

  it('the overall check compares the claim code and rank with the computed worst, no text matching', () => {
    const good = subjectWith([verdictClaim('PARTIAL', 'P5', refs)]);
    assert.equal(overallCheck({ subject: good })[0]!.verdict, 'support');
    const wrongVerdict = subjectWith([verdictClaim('PASS', 'P3', refs)]);
    const wrongOut = overallCheck({ subject: wrongVerdict });
    assert.equal(wrongOut[0]!.verdict, 'refute');
    assert.equal(wrongOut[0]!.code, 'case-review-report.verdict_mismatch');
    const wrongLevel = subjectWith([verdictClaim('PARTIAL', 'P3', refs)]);
    const levelOut = overallCheck({ subject: wrongLevel });
    assert.equal(levelOut[0]!.code, 'case-review-report.level_mismatch');
    assert.equal(overallCheck({ subject: subjectWith([{ nature: 'judgment', statement: '只有建议', grounds: [], code: 'suggestion' }]) })[0]!.code, 'case-review-report.report_missing', 'no verdict claim at all');
  });

  it('the overall check refuses every verdict when a final was unreadable (the whole is unknown)', () => {
    const items = [{ id: 'report', label: '评审终稿', location: `src:${DIGEST}/kityminder@1/n/c1`, fields: { overall: null, findings } }];
    const claimsAny = { applies: 'run', items, context: {}, cross_item: [verdictClaim('PARTIAL', 'P4', refs)] };
    assert.equal(overallCheck({ subject: claimsAny })[0]!.code, 'case-review-report.verdict_mismatch');
  });

  it('the report check wants every non-refuted finding cited, none refuted, none invented', () => {
    const agree = subjectWith([verdictClaim('PARTIAL', 'P5', refs)]);
    assert.equal(reportCheck({ subject: agree })[0]!.verdict, 'support');
    const missing = subjectWith([verdictClaim('PARTIAL', 'P5', refs.slice(0, 2))]);
    const missingOut = reportCheck({ subject: missing });
    assert.ok(missingOut.some((o) => o.code === 'case-review-report.finding_missing'));
    const refuted = subjectWith([verdictClaim('PARTIAL', 'P5', [...refs, refutedRef])]);
    assert.ok(reportCheck({ subject: refuted }).some((o) => o.code === 'case-review-report.finding_refuted'));
    const invented = subjectWith([verdictClaim('PARTIAL', 'P5', [...refs, 'rec:' + '9'.repeat(64) + '#/x'])]);
    assert.ok(reportCheck({ subject: invented }).some((o) => o.code === 'case-review-report.finding_unknown'));
  });

  it('a suggestion without all three labeled parts is refused', () => {
    const partial = subjectWith([verdictClaim('PARTIAL', 'P5', refs), { nature: 'judgment', statement: '补反向用例', grounds: [], code: 'suggestion' }]);
    assert.ok(reportCheck({ subject: partial }).some((o) => o.code === 'case-review-report.suggestion_incomplete'));
    const whole = subjectWith([verdictClaim('PARTIAL', 'P5', refs), { nature: 'judgment', statement: '补：反向用例；因为：边界未覆盖；期望：非法输入被拒绝', grounds: [], code: 'suggestion' }]);
    assert.equal(reportCheck({ subject: whole })[0]!.verdict, 'support');
  });
});
