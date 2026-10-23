// Edge cases of the regression scope written after a mutation check: which digest an item points at,
// one missing-entry warning per digest, the no-case-kind warning, the empty-after-priority-filter
// message, the uncovered paths derived from the considered ones, the parser's refusal of a malformed
// entry key and the refusal of a second bound view.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkOutcomes } from './check.ts';
import { projectItems } from './test-support.ts';
import { scopeOf } from './scope.ts';
import { buildImpact, SOURCE } from './test-support.ts';
import { parseView } from './view.ts';

const PARAMETERS = { priorities: null, includeAdded: true };

function parsed(view: { [key: string]: unknown }) {
  const result = parseView(view);
  assert.equal(result.ok, true, result.ok ? '' : result.message);
  return result.ok ? result.view : null;
}

const input = (model: unknown): unknown => ({
  slot: 'impact',
  external: null,
  sha256: SOURCE,
  media_type: 'application/json',
  parser: 'json@1',
  model,
  meta: null,
});

const caseDigests = (view: { [key: string]: unknown }): string[] =>
  Object.entries(view.entries as Record<string, { kind: string }>)
    .filter(([, entry]) => entry.kind === 'case')
    .map(([key]) => key)
    .sort();

describe('regression scope edge cases', () => {
  it('points an item at the least digest of a case placed on several paths', () => {
    const view = buildImpact([
      { path: '/commands/a', change: 'modified', before: [{ name: 'a' }], after: [{ name: 'a2' }], to: [{ document: 'doc-1', node: 'n1', title: '两处放置', priority: 1 }] },
      { path: '/commands/b', change: 'modified', before: [{ name: 'b' }], after: [{ name: 'b2' }], to: [{ document: 'doc-1', node: 'n1', title: '两处放置', priority: 1 }] },
    ]);
    const digests = caseDigests(view);
    assert.equal(digests.length, 2);
    const scope = scopeOf(parsed(view)!, PARAMETERS);
    assert.deepEqual(
      scope.items.map((item) => item.id),
      ['doc-1:n1'],
    );
    assert.equal(scope.items[0].entry, digests[0], 'the item points at the least digest');
    const output = projectItems({ inputs: [input(view)], parameters: {}, context: {} }) as { items: Array<{ location: { selector: string } }> };
    assert.equal(output.items[0].location.selector, `p/entries/${digests[0]}`);
  });

  it('warns once per digest a side names that the view does not hold', () => {
    const view = buildImpact([
      { path: '/commands/a', change: 'modified', before: [{ name: 'a' }], after: [{ name: 'a2' }], to: [{ document: 'doc-1', node: 'n1', title: '甲', priority: 1 }] },
      { path: '/commands/b', change: 'modified', before: [{ name: 'b' }], after: [{ name: 'b2' }], to: [{ document: 'doc-2', node: 'n2', title: '乙', priority: 1 }] },
    ]);
    const absent = 'f'.repeat(64);
    for (const row of view.changes as Array<{ before: string[] }>) row.before.push(absent);
    const scope = scopeOf(parsed(view)!, PARAMETERS);
    assert.equal(scope.items.length, 2);
    const missing = scope.warnings.filter((warning) => warning.code === 'regression-scope.missing_entry');
    assert.equal(missing.length, 1, 'one warning per absent digest although two sides name it');
    assert.match(missing[0].message, /不在视图里/);
  });

  it('warns when the attached kinds hold no case', () => {
    const view = buildImpact([{ path: '/commands/a', change: 'modified', before: [{ name: 'a' }], after: [{ name: 'a2' }], to: [{ document: 'doc-1', node: 'n1', title: '甲', priority: 1 }] }], { attached: [] });
    const scope = scopeOf(parsed(view)!, PARAMETERS);
    assert.ok(scope.warnings.some((warning) => warning.code === 'regression-scope.no_case_kind' && warning.message.includes('没有用例')));
  });

  it('says the priority filter emptied the scope, not that the paths have no case', () => {
    const view = buildImpact([{ path: '/commands/a', change: 'modified', before: [{ name: 'a' }], after: [{ name: 'a2' }], to: [{ document: 'doc-1', node: 'n1', title: '甲', priority: 2 }] }]);
    const scope = scopeOf(parsed(view)!, { priorities: [1], includeAdded: true });
    assert.deepEqual(scope.items, []);
    assert.match(scope.note.message, /按优先级筛选后没有用例留在回归范围/);
    assert.ok(scope.warnings.some((warning) => warning.code === 'regression-scope.empty_scope' && warning.message.includes('按优先级筛选后')));
  });

  it('refuses an entry-table key that is not a digest', () => {
    const view = buildImpact([]);
    const key = 'g'.repeat(64);
    (view.entries as Record<string, unknown>)[key] = {
      entry: key,
      kind: 'definition',
      statement: '键不是摘要',
      data: {},
      reference: `tree:${'a'.repeat(64)}/commands/x@${'b'.repeat(64)}`,
    };
    const result = parseView(view);
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.message, /条目表的键或值不对/);
  });

  it('derives the uncovered paths from the considered ones when the note names none', () => {
    const CASE = 'a'.repeat(64);
    const LATER = 'e'.repeat(64);
    const reason = { detail: 0, change: 'modified' as const };
    const outcomes = checkOutcomes('uncovered_changes', {
      items: [{ id: 'doc-1:n1', label: '甲', location: `tree:${LATER}/commands/show@${CASE}`, fields: { document: 'doc-1', node: 'n1', reasons: [reason] } }],
      note: {
        considered: [{ path: '/commands/show', change: 'modified' }, { path: '/commands/bare', change: 'added' }],
        details: [{ path: '/commands/show', change: 'modified' }],
        skipped_to: 0,
        truncated: false,
        changed_paths: 2,
        include_added: true,
      },
    });
    assert.ok(outcomes.every((outcome) => outcome.verdict !== 'refute'), 'a path with a case in scope is not uncovered');
    const unknowns = outcomes.filter((outcome) => outcome.verdict === 'unknown');
    assert.equal(unknowns.length, 1, JSON.stringify(outcomes));
    assert.equal(unknowns[0].reason, 'missing_input');
    assert.match(unknowns[0].statement, /\/commands\/bare/);
  });

  it('refuses a second bound impact view', () => {
    const first = buildImpact([{ path: '/commands/a', change: 'modified', before: [{ name: 'a' }], after: [{ name: 'a2' }], to: [{ document: 'doc-1', node: 'n1', title: '甲', priority: 1 }] }]);
    const second = buildImpact([{ path: '/commands/b', change: 'added', after: [{ name: 'b' }] }]);
    const output = projectItems({ inputs: [input(first), input(second)], parameters: {}, context: {} }) as { error?: { code: string; message: string } };
    assert.equal(output.error?.code, 'regression-scope.no_impact');
    assert.match(output.error?.message ?? '', /只接受一个影响视图，给了 2 个/);
  });
});
