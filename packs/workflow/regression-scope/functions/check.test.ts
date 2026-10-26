// The two refutations exist so the publish check has a negative sample (C05 R[0]). A well-formed view never produces them:
// a scope is not a defect, and an uncovered path is unknown.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkOutcomes } from './check.ts';

const ROOT = 'c'.repeat(64);
const CASE = 'a'.repeat(64);
const BEFORE = 'b'.repeat(64);
const AFTER = 'd'.repeat(64);
const LATER = 'e'.repeat(64);
const ref = (root: string, entry: string) => `tree:${root}/commands/show@${entry}`;

const reason = (change: 'added' | 'modified' | 'removed') => ({ detail: 0, change });

const NOTE = { details: [{ path: '/commands/show', change: 'modified' }] };

const item = (change: 'added' | 'modified' | 'removed') => ({
  id: 'doc-1:n1',
  location: ref(LATER, CASE),
  fields: { document: 'doc-1', node: 'n1', title: '查看部件状态', priority: 1, negative: false, entry: CASE, reference: ref(LATER, CASE), reasons: [reason(change)] },
});

describe('checks on a subject', () => {
  it('supports a case whose reasons are added or modified paths', () => {
    const [outcome] = checkOutcomes('in_scope', { items: [item('modified')], note: NOTE });
    assert.equal(outcome.verdict, 'support');
    assert.equal(outcome.item, 'doc-1:n1');
    assert.deepEqual(outcome.grounds, [ref(LATER, CASE)]);
    assert.ok(outcome.data && Array.isArray(outcome.data.reasons));
  });

  it('refutes a reason that is not an added or modified path of the later build', () => {
    const [outcome] = checkOutcomes('in_scope', { items: [item('removed')], note: NOTE });
    assert.deepEqual([outcome.verdict, outcome.code, outcome.item], ['refute', 'regression-scope.not_in_scope', 'doc-1:n1']);
  });

  it('supports uncovered when every considered path has a later-build case', () => {
    const outcomes = checkOutcomes('uncovered_changes', {
      items: [item('modified')],
      note: { ...NOTE, considered: [{ path: '/commands/show', change: 'modified' }], uncovered: [], skipped_to: 0, truncated: false, changed_paths: 1, include_added: true },
    });
    const outcome = outcomes.find((o) => o.statement.includes('都有用例'));
    assert.ok(outcome, JSON.stringify(outcomes));
    assert.equal(outcome.verdict, 'support');
    assert.equal(outcome.item, undefined);
  });

  it('refutes an uncovered path that a case in scope already names', () => {
    const outcomes = checkOutcomes('uncovered_changes', {
      items: [item('modified')],
      note: { ...NOTE, considered: [{ path: '/commands/show', change: 'modified' }], uncovered: [{ path: '/commands/show', change: 'modified' }], skipped_to: 0, truncated: false, changed_paths: 1 },
    });
    const outcome = outcomes.find((o) => o.code === 'regression-scope.not_uncovered');
    assert.ok(outcome, JSON.stringify(outcomes));
    assert.equal(outcome.verdict, 'refute');
  });
});

describe('an empty scope is a deterministic support, not an unknown', () => {
  it('in_scope gives an empty-scope support when the projection note exists and there are no items', () => {
    const outcomes = checkOutcomes('in_scope', { items: [], note: { ...NOTE, considered: [], uncovered: [], skipped_to: 0, truncated: false, changed_paths: 0 } });
    assert.equal(outcomes.length, 1, JSON.stringify(outcomes));
    assert.equal(outcomes[0].verdict, 'support');
    assert.equal(outcomes[0].item, undefined);
    assert.match(outcomes[0].statement, /回归范围是空的/);
  });

  it('keeps the unknown when the subject carries no note (malformed subject)', () => {
    const outcomes = checkOutcomes('in_scope', { items: [], note: null });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].verdict, 'unknown');
    assert.equal(outcomes[0].reason, 'check_error');
  });
});

describe('an uncovered path is a deterministic gap when the view scope is complete (decision: view scope)', () => {
  it('skipped 0 and not truncated: unknown (advisory) with the exact missing evidence, never a refutation', () => {
    const outcomes = checkOutcomes('uncovered_changes', {
      items: [],
      note: { ...NOTE, considered: [{ path: '/commands/show', change: 'modified' }], uncovered: [{ path: '/commands/show', change: 'modified' }], skipped_to: 0, truncated: false, changed_paths: 1, include_added: true },
    });
    const gap = outcomes.find((o) => o.verdict === 'unknown' && o.statement.includes('/commands/show'));
    assert.ok(gap, JSON.stringify(outcomes));
    assert.equal(gap.reason, 'missing_input');
    assert.equal(gap.tier, 'advisory');
    assert.equal(gap.statement, '变更路径 /commands/show（修改）在后一构建里没有用例。用例索引在这里没有条目，所以这不是失败。');
    assert.equal(gap.missing, '尚未取得本检查所需的事实：变更路径 /commands/show（修改）在后一构建里没有用例。用例索引在这里没有条目，所以这不是失败。');
    assert.equal(outcomes.some((o) => o.verdict === 'refute'), false, JSON.stringify(outcomes));
  });

  it('skipped sources keep the unknown with the missing fact and next step', () => {
    const outcomes = checkOutcomes('uncovered_changes', {
      items: [],
      note: { ...NOTE, considered: [{ path: '/commands/show', change: 'modified' }], uncovered: [{ path: '/commands/show', change: 'modified' }], skipped_to: 2, truncated: false, changed_paths: 1, include_added: true },
    });
    const unknown = outcomes.find((o) => o.verdict === 'unknown' && o.statement.includes('/commands/show'));
    assert.ok(unknown, JSON.stringify(outcomes));
    assert.match(unknown.statement, /缺少 2 份列出的文档/);
    assert.match(unknown.missing ?? '', /尚未取得/);
  });

  it('a truncated view keeps the unknown', () => {
    const outcomes = checkOutcomes('uncovered_changes', {
      items: [],
      note: { ...NOTE, considered: [{ path: '/commands/show', change: 'modified' }], uncovered: [{ path: '/commands/show', change: 'modified' }], skipped_to: 0, truncated: true, changed_paths: 5, include_added: true },
    });
    assert.ok(outcomes.some((o) => o.verdict === 'unknown' && o.statement.includes('截断')), JSON.stringify(outcomes));
    assert.equal(outcomes.some((o) => o.code === 'regression-scope.uncovered_path'), false, JSON.stringify(outcomes));
  });
});
