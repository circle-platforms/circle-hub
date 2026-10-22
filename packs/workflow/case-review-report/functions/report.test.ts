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

const reportItemOf = (out: { items?: ProjectedItem[]; error?: { code?: string; message?: string } }): { fields: Record<string, unknown> } => {
  const item = out.items?.find((i) => i.id === 'report');
  assert.ok(item !== undefined, 'the report item exists');
  return item as unknown as { fields: Record<string, unknown> };
};

describe('the projection of case-review-report', () => {
  it('the worst verdict wins and takes that block\'s level', () => {
    const out = run([
      { result: block({ verdict: 'PASS', level: 'P3', entries: [{ item: 'c1' }] }) },
      { result: block({ verdict: 'PARTIAL', level: 'P5', entries: [{ item: 'c2' }, { item: 'c3' }] }) },
    ]);
    const report = reportItemOf(out);
    assert.deepEqual(report.fields.overall, { verdict: 'PARTIAL', level: 'P5' });
    assert.deepEqual((out.items ?? []).filter((i) => i.id !== 'report').map((i) => i.id), ['c1', 'c2', 'c3']);
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
    assert.equal(reportItemOf(out).fields.overall, null);
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
  const reportClaim = (statement: string, rank: string | undefined, grounds: string[]): Record<string, unknown> => ({ nature: 'judgment', statement, grounds, code: 'report', ...(rank === undefined ? {} : { rank }) });

  it('the overall check supports the computed worst verdict and refutes a wrong one', () => {
    const good = subjectWith([reportClaim('终稿：整体 PARTIAL，两块取最差', 'P5', refs)]);
    assert.equal(overallCheck({ subject: good })[0]!.verdict, 'support');
    const wrongVerdict = subjectWith([reportClaim('终稿：整体 PASS', 'P3', refs)]);
    const wrongOut = overallCheck({ subject: wrongVerdict });
    assert.equal(wrongOut[0]!.verdict, 'refute');
    assert.equal(wrongOut[0]!.code, 'case-review-report.verdict_mismatch');
    const wrongLevel = subjectWith([reportClaim('终稿：整体 PARTIAL', 'P3', refs)]);
    const levelOut = overallCheck({ subject: wrongLevel });
    assert.equal(levelOut[0]!.code, 'case-review-report.level_mismatch');
    assert.equal(overallCheck({ subject: subjectWith([]) })[0]!.code, 'case-review-report.report_missing', 'no report claim at all');
  });

  it('the overall check demands unknown when a final was unreadable', () => {
    const items = [{ id: 'report', label: '评审终稿', location: `src:${DIGEST}/kityminder@1/n/c1`, fields: { overall: null, findings } }];
    const saysUnknown = { applies: 'run', items, context: {}, cross_item: [reportClaim('终稿：整体未知，缺一块的结论', undefined, refs)] };
    assert.equal(overallCheck({ subject: saysUnknown })[0]!.verdict, 'support');
    const saysPass = { applies: 'run', items, context: {}, cross_item: [reportClaim('终稿：整体 PARTIAL', 'P4', refs)] };
    assert.equal(overallCheck({ subject: saysPass })[0]!.code, 'case-review-report.verdict_mismatch');
  });

  it('the report check wants every non-refuted finding cited, none refuted, none invented', () => {
    const agree = subjectWith([reportClaim('终稿：整体 PARTIAL，两块取最差', 'P5', refs)]);
    assert.equal(reportCheck({ subject: agree })[0]!.verdict, 'support');
    const missing = subjectWith([reportClaim('终稿：整体 PARTIAL，两块取最差', 'P5', refs.slice(0, 2))]);
    const missingOut = reportCheck({ subject: missing });
    assert.ok(missingOut.some((o) => o.code === 'case-review-report.finding_missing'));
    const refuted = subjectWith([reportClaim('终稿：整体 PARTIAL，两块取最差', 'P5', [...refs, refutedRef])]);
    assert.ok(reportCheck({ subject: refuted }).some((o) => o.code === 'case-review-report.finding_refuted'));
    const invented = subjectWith([reportClaim('终稿：整体 PARTIAL，两块取最差', 'P5', [...refs, 'rec:' + '9'.repeat(64) + '#/x'])]);
    assert.ok(reportCheck({ subject: invented }).some((o) => o.code === 'case-review-report.finding_unknown'));
  });

  it('a suggestion without all three labeled parts is refused', () => {
    const partial = subjectWith([reportClaim('终稿：整体 PARTIAL，两块取最差', 'P5', refs), { nature: 'judgment', statement: '补反向用例', grounds: [], code: 'suggestion' }]);
    assert.ok(reportCheck({ subject: partial }).some((o) => o.code === 'case-review-report.suggestion_incomplete'));
    const whole = subjectWith([reportClaim('终稿：整体 PARTIAL，两块取最差', 'P5', refs), { nature: 'judgment', statement: '补：反向用例；因为：边界未覆盖；期望：非法输入被拒绝', grounds: [], code: 'suggestion' }]);
    assert.equal(reportCheck({ subject: whole })[0]!.verdict, 'support');
  });
});
