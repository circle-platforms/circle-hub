import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CheckOutcome } from '../../../../contracts/src/tables.ts';
import { kityminderParser } from '../../../../hub/testing/parsers.ts';
import { levelConsistency } from './checks.ts';
import { projection } from './projection.ts';
import { captureReviewScope, createReviewScope, readReviewScope, REVIEW_SCOPE_GROUP, reviewScopeSubject } from './review-scope.ts';

const SHA = 'a'.repeat(64);
const map = kityminderParser.parse(Buffer.from(JSON.stringify({ root: {
  data: { id: 'root', text: 'Meridian 合成评审' },
  children: [{ data: { id: 'group', text: '合成组', priority: 1 }, children: [
    { data: { id: 'c1', text: '合成用例一', priority: 2, resource: ['Functional'] }, children: [{ data: { id: 'c1e', text: '结果一' } }] },
    { data: { id: 'u1', text: '合成标记用例', priority: 2 }, children: [{ data: { id: 'u1e', text: '结果二' } }] },
    { data: { id: 'c2', text: '合成用例二', priority: 2, resource: ['Functional'] }, children: [{ data: { id: 'c2e', text: '结果三' } }] },
  ] }],
} }))).model;

function projected(parameters: Record<string, unknown> = {}) {
  const output = projection({
    inputs: [{ slot: 'subject', external: null, sha256: SHA, media_type: 'application/json', parser: 'kityminder@1', model: map, meta: { id: 'meridian-review' } }],
    parameters,
    context: { product: 'Meridian', names: ['Meridian'], line: '1.0', build: 'synthetic', root: null, parameters, groups: [] },
  });
  assert.ok(!('error' in output), JSON.stringify(output));
  return output as { items: Array<{ id: string }>; groups: Array<Record<string, unknown>> };
}

function scopeOf(output: ReturnType<typeof projected>) {
  const group = output.groups.find(row => row.kind === REVIEW_SCOPE_GROUP);
  assert.ok(group);
  const scope = readReviewScope((group.data as Record<string, unknown>).review_scope);
  assert.ok(scope);
  return scope;
}

describe('the frozen whole-document review scope', () => {
  it('keeps every expected item when a slice selects only one', () => {
    const output = projected({ slice: { from: 1, to: 1 } });
    const scope = scopeOf(output);
    assert.equal(scope.source, SHA);
    assert.equal(scope.document, 'meridian-review');
    assert.deepEqual(scope.expected.map(row => row.item), ['meridian-review:c1', 'meridian-review:u1', 'meridian-review:c2']);
    assert.deepEqual(scope.selected, [output.items[0].id]);
    assert.deepEqual(scope.parameters, { case_rule: 'marked', case_priority: 2, group_priority: 1, precondition_priority: 3 });
    assert.ok(scope.expected.every(row => row.location.startsWith(`src:${SHA}/kityminder@1/`)));
  });

  it('reconciles a whole explicit subtree rather than either its slices or unrelated document nodes', () => {
    const subtree = kityminderParser.parse(Buffer.from(JSON.stringify({ root: { data: { id: 'root', text: 'Meridian 合成评审' }, children: [
      { data: { id: 'group', text: '指定子树', priority: 1 }, children: [{ data: { id: 'inside', text: '子树内用例', priority: 2, resource: ['Functional'] }, children: [] }] },
      { data: { id: 'outside', text: '子树外用例', priority: 2, resource: ['Functional'] }, children: [] },
    ] } }))).model;
    const output = projection({ inputs: [{ slot: 'subject', external: null, sha256: SHA, media_type: 'application/json', parser: 'kityminder@1', model: subtree, meta: { id: 'meridian-review' } }], parameters: { block: 'group' }, context: {} });
    assert.ok(!('error' in output), JSON.stringify(output));
    const scope = scopeOf(output as ReturnType<typeof projected>);
    assert.deepEqual(scope.expected.map(row => row.item), ['meridian-review:inside']);
    assert.deepEqual(scope.selected, ['meridian-review:inside']);
  });

  it('freezes effective non-default recognition parameters rather than raw or inferred values', () => {
    const scope = scopeOf(projected({ case_priority: 3, group_priority: null, precondition_priority: null }));
    assert.deepEqual(scope.parameters, { case_rule: 'marked', case_priority: 3, group_priority: null, precondition_priority: null });
    const tagged = scopeOf(projected({ case_rule: 'tagged' }));
    assert.deepEqual(tagged.expected.map(row => row.item), ['meridian-review:c1', 'meridian-review:c2']);
  });

  it('captures the scope through a Hub function fact and refuses an absent snapshot', () => {
    const scope = scopeOf(projected());
    const group = { kind: REVIEW_SCOPE_GROUP, data: { review_scope: scope } };
    const subject = reviewScopeSubject({ applies: 'run', items: [], context: { groups: [group] } });
    const [supported] = captureReviewScope({ subject }, 'case-review');
    assert.equal(supported.verdict, 'support');
    assert.deepEqual(supported.data?.review_scope, scope);
    assert.ok(CheckOutcome.safeParse(supported).success);
    const [missing] = captureReviewScope({ subject: { scope: null } }, 'case-review');
    assert.equal(missing.verdict, 'unknown');
    assert.equal(missing.reason, 'check_error');
    assert.ok(CheckOutcome.safeParse(missing).success);
    const [conflict] = captureReviewScope({ subject: reviewScopeSubject({ applies: 'run', items: [], context: { groups: [group, group] } }) }, 'case-review');
    assert.equal(conflict.verdict, 'refute');
    assert.equal(conflict.code, 'case-review.scope_conflict');
    assert.ok(CheckOutcome.safeParse(conflict).success);
  });

  it('validates unique item identities and selected membership structurally', () => {
    const scope = scopeOf(projected());
    assert.equal(readReviewScope({ ...scope, expected: [...scope.expected, scope.expected[0]] }), null);
    assert.equal(readReviewScope({ ...scope, selected: ['meridian-review:absent'] }), null);
    assert.equal(readReviewScope({ ...scope, parameters: { ...scope.parameters, case_rule: 'other' } }), null);
    assert.deepEqual(createReviewScope({ source: scope.source, document: scope.document, parameters: scope.parameters, expected: scope.expected, selected: scope.selected }), scope);
  });
});

describe('the initial severity band', () => {
  function check(ranks: unknown[], level: unknown) {
    return levelConsistency({ subject: {
      items: [{ id: 'meridian-review:c1', slots: { findings: ranks.map(rank => ({ rank })) } }],
      cross_item: [{ code: 'level', rank: level }],
    } });
  }

  it('encloses each declared severity interval without inventing a score', () => {
    for (const [rank, good, bad] of [['critical', 'P6', 'P5'], ['major', 'P3', 'P2'], ['minor', 'P2', 'P3']] as const) {
      assert.equal(check([rank], good)[0].verdict, 'support');
      const [out] = check([rank], bad);
      assert.equal(out.verdict, 'refute');
      assert.equal(out.code, 'case-review.level_severity_mismatch');
    }
    assert.equal(check(['minor', 'critical', 'major'], 'P7')[0].verdict, 'support');
    assert.equal(check([], 'P7')[0].verdict, 'support', 'no findings do not imply a grade');
  });

  it('rejects missing severities and does not treat malformed levels as a pass', () => {
    assert.equal(check([undefined], 'P2')[0].code, 'case-review.severity_missing');
    assert.equal(check(['minor'], 'P8')[0].code, 'case-review.level_missing');
  });
});
