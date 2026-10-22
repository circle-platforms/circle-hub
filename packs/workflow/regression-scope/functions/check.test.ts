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
    const [outcome] = checkOutcomes('uncovered_changes', {
      items: [item('modified')],
      note: { ...NOTE, considered: [{ path: '/commands/show', change: 'modified' }], uncovered: [], skipped_to: 0, truncated: false, changed_paths: 1, include_added: true },
    });
    assert.equal(outcome.verdict, 'support');
    assert.equal(outcome.item, undefined);
  });

  it('refutes an uncovered path that a case in scope already names', () => {
    const [outcome] = checkOutcomes('uncovered_changes', {
      items: [item('modified')],
      note: { ...NOTE, considered: [{ path: '/commands/show', change: 'modified' }], uncovered: [{ path: '/commands/show', change: 'modified' }], skipped_to: 0, truncated: false, changed_paths: 1 },
    });
    assert.deepEqual([outcome.verdict, outcome.code], ['refute', 'regression-scope.not_uncovered']);
  });
});
