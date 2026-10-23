// The scope, written down before the projection: every later-build case on an added or modified path is in scope once,
// with every reason; an unchanged path and a removed path are not; a changed path with no case is unknown, never a
// failure; priorities and include_added do what they say; order does not matter.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ImpactView } from '../../../../contracts/src/views.ts';
import { checkOutcomes } from './check.ts';
import { projectItems } from './test-support.ts';
import { scopeOf } from './scope.ts';
import { buildImpact, reversedView, reviewChanges, reviewOptions, SOURCE, type ChangeSpec } from './test-support.ts';
import { parseView } from './view.ts';

const PARAMETERS = { priorities: null, includeAdded: true };

function parsed(view: { [key: string]: unknown }) {
  const result = parseView(view);
  assert.equal(result.ok, true, result.ok ? '' : result.message);
  return result.ok ? result.view : null;
}

function projected(view: { [key: string]: unknown }, parameters: { [key: string]: unknown } = {}) {
  const output = projectItems({
    inputs: [{ slot: 'impact', external: null, sha256: SOURCE, media_type: 'application/json', parser: 'json@1', model: view, meta: null }],
    parameters,
    context: { product: null, names: [], line: null, build: null, root: null, parameters, groups: [] },
  }) as { items: Array<{ id: string; label: string; summary: string; location: { selector: string }; fields: { [key: string]: unknown } }>; groups: Array<{ [key: string]: unknown }>; warnings: Array<{ code: string; message: string }>; error?: { code: string } };
  assert.equal(output.error, undefined, JSON.stringify(output.error));
  const subject = {
    items: output.items.map((item) => ({ id: item.id, label: item.label, location: `src:${SOURCE}/json@1/${item.location.selector}`, fields: item.fields })),
    note: output.groups[0],
  };
  return { output, subject, inScope: checkOutcomes('in_scope', subject), uncovered: checkOutcomes('uncovered_changes', subject) };
}

function idsOf(view: { [key: string]: unknown }): string[] {
  const viewParsed = parsed(view);
  assert.ok(viewParsed);
  return scopeOf(viewParsed, PARAMETERS).items.map((item) => item.id);
}

describe('regression scope on a hand-built pair of trees', () => {
  const view = buildImpact(reviewChanges(), reviewOptions());

  it('is an impact-view@1 the knowledge reader could have returned', () => {
    assert.equal(ImpactView.safeParse(view).success, true, JSON.stringify(ImpactView.safeParse(view).error?.issues.slice(0, 3)));
  });

  it('keeps every later-build case on an added or modified path, once, with every reason', () => {
    const scope = scopeOf(parsed(view)!, PARAMETERS);
    assert.deepEqual(
      scope.items.map((item) => item.id),
      ['doc-1:n1', 'doc-2:n2', 'doc-5:n1', 'doc-6:n1'],
    );
    const both = scope.items[0];
    assert.equal(both.label, '查看部件状态');
    assert.equal(both.negative, true);
    assert.equal(both.priority, 1);
    assert.deepEqual(
      both.reasons.map((reason) => [scope.note.details[reason.detail].path, reason.change]),
      [
        ['/commands/add', 'added'],
        ['/commands/show', 'modified'],
      ],
    );
    // The slim reason names its detail row by index; the row carries the path's tree references (definitions of both
    // sides) once, and the item's own ground is its location (no repeated reference in the fields).
    const showDetail = scope.note.details[both.reasons[1].detail];
    assert.ok(showDetail.references.length > 0, JSON.stringify(showDetail));
    for (const reference of showDetail.references) assert.match(reference, /^tree:[0-9a-f]{64}\/commands\/show(@[0-9a-f]{64})?$/);
    assert.deepEqual(Object.keys(scope.items[0].reasons[0]).sort(), ['change', 'detail']);
    assert.match(both.summary, /^优先级 1；文档 doc-1；2 条命令有变更；\/commands\/add 新增命令$/);
    assert.ok([...both.summary].length <= 200);
    // The earlier build's case on the same modified path is not the later build's case.
    assert.ok(!scope.items.some((item) => item.id === 'doc-9:old'));
  });

  it('leaves out a case on an unchanged path and a case on a removed path', () => {
    const ids = idsOf(view);
    assert.ok(!ids.includes('doc-4:n1'));
    assert.ok(!ids.includes('doc-3:n9'));
    assert.ok(!ids.includes('doc-8:n1'));
  });

  it('reports a changed path with no case as unknown, and never as a failure', () => {
    const run = projected(view);
    assert.deepEqual(
      run.output.groups[0].uncovered,
      [{ path: '/commands/bare', change: 'added' }],
    );
    assert.ok(run.uncovered.every((outcome) => outcome.verdict !== 'refute'));
    assert.deepEqual(
      run.uncovered.filter((outcome) => outcome.verdict === 'unknown').map((outcome) => outcome.reason),
      ['missing_input'],
    );
    const unknown = run.uncovered.find((outcome) => outcome.verdict === 'unknown')!;
    assert.match(unknown.statement, /\/commands\/bare（新增）/);
    assert.match(unknown.statement, /不是失败/);
    assert.ok(run.inScope.every((outcome) => outcome.verdict === 'support'));
    // One ground per outcome: the item's own location (the case entry fragment); the path's definition references
    // live once per detail row.
    const grounds = run.inScope.find((outcome) => outcome.item === 'doc-1:n1')!.grounds;
    const location = run.subject.items.find((item) => item.id === 'doc-1:n1')!.location;
    assert.deepEqual(grounds, [location]);
    assert.ok(grounds.every((ref) => typeof ref === 'string' && ref.startsWith('src:')), 'every ground is the item location reference');
  });

  it('does not depend on the order of placements or entries', () => {
    const forward = projected(view);
    const backward = projected(reversedView(view));
    assert.deepEqual(backward.output.items, forward.output.items);
    assert.deepEqual(backward.output.groups, forward.output.groups);
    assert.deepEqual(backward.inScope, forward.inScope);
    assert.deepEqual(backward.uncovered, forward.uncovered);
  });

  it('one case listed twice on one path grounds the smallest digest, whatever the order', () => {
    // The same document:node attached to one path by two entries: the reason's case ground is the smaller digest
    // either way around (never the order the view happened to give).
    const changes: ChangeSpec[] = [
      {
        path: '/commands/dup',
        change: 'modified',
        before: [{ name: 'dup' }],
        after: [{ name: 'dup', help: '新' }],
        to: [
          { document: 'doc-1', node: 'n1', title: '挂两次的用例（先）', priority: 1 },
          { document: 'doc-1', node: 'n1', title: '挂两次的用例（后）', priority: 1 },
        ],
      },
    ];
    const built = buildImpact(changes);
    const forward = projected(built);
    const backward = projected(reversedView(built));
    assert.deepEqual(backward.output.items, forward.output.items, 'the whole item is identical in both orders');
    const entryOf = (run: typeof forward): string => {
      assert.equal(run.output.items.length, 1);
      return (run.output.items[0].location as { selector: string }).selector.slice('p/entries/'.length);
    };
    assert.equal(entryOf(backward), entryOf(forward), 'the same digest grounds the reason in both orders');
    const digests = (built.placements as Array<{ to: string[] }>)[0].to;
    assert.equal(entryOf(forward), digests[0], 'the smaller of the path’s two case digests');
  });

  it('filters by priority without reporting a path as uncovered when its only case was filtered out', () => {
    const run = projected(view, { priorities: [1] });
    assert.deepEqual(
      run.output.items.map((item) => item.id),
      ['doc-1:n1', 'doc-5:n1'],
    );
    assert.deepEqual(run.output.groups[0].uncovered, [{ path: '/commands/bare', change: 'added' }]);
    assert.ok(!run.uncovered.some((outcome) => outcome.verdict === 'unknown' && outcome.statement.includes('/commands/extra')), '筛掉的用例不报未覆盖');
  });

  it('drops added paths when include_added is false, including from a case that also sits on a modified path', () => {
    const run = projected(view, { include_added: false });
    assert.deepEqual(
      run.output.items.map((item) => item.id),
      ['doc-1:n1', 'doc-2:n2', 'doc-5:n1'],
    );
    const reasons = run.output.items[0].fields.reasons as Array<{ detail: number; change: string }>;
    const details = run.output.groups[0].details as Array<{ path: string }>;
    assert.deepEqual(reasons.map((reason) => details[reason.detail].path), ['/commands/show']);
    assert.deepEqual(run.output.groups[0].uncovered, []);
    const covered = run.uncovered.find((outcome) => outcome.verdict === 'support' && outcome.statement.includes('都有用例'));
    assert.ok(covered, JSON.stringify(run.uncovered));
  });

  it('says the scope is empty when the pair has no changed path', () => {
    const run = projected(buildImpact([]));
    assert.deepEqual(run.output.items, []);
    assert.ok(run.output.warnings.some((warning) => warning.code === 'regression-scope.empty_scope' && warning.message.includes('回归范围是空的')));
    assert.match(String(run.output.groups[0].message), /回归范围是空的/);
    const empty = run.uncovered.find((outcome) => outcome.statement.includes('回归范围是空的'));
    assert.ok(empty, JSON.stringify(run.uncovered));
    assert.equal(empty.verdict, 'support');
  });

  it('names a skipped later-build index on the unknown outcome and on the run-level note', () => {
    const run = projected(buildImpact(reviewChanges(), { ...reviewOptions(), skipped: { from: 1, to: 4 } }));
    assert.match(String(run.output.groups[0].message), /后一构建的索引缺少 4 份列出的文档/);
    const unknown = run.uncovered.find((outcome) => outcome.verdict === 'unknown')!;
    assert.equal(unknown.reason, 'missing_input');
    assert.match(unknown.statement, /缺少 4 份列出的文档/);
    assert.match(unknown.statement, /可能没有被读到/);
    assert.ok(run.uncovered.every((outcome) => outcome.verdict !== 'refute'));
  });

  it('does not claim the list is complete when the view is truncated', () => {
    const run = projected(buildImpact([{ path: '/commands/show', change: 'modified', to: [{ document: 'doc-1', node: 'n1', title: '查看', priority: 1 }] }], { truncated: true, changedPaths: 80 }));
    assert.ok(run.uncovered.some((outcome) => outcome.verdict === 'unknown' && outcome.reason === 'integrity_unproven' && outcome.statement.includes('80')));
    // 命令差总结只陈述列出的部分，不算完整性的主张；其余结论没有一条说得上完整。
    assert.ok(
      run.uncovered
        .filter((outcome) => !outcome.statement.startsWith('命令差共') && !outcome.statement.includes('个用例没有解析出命令'))
        .every((outcome) => outcome.verdict !== 'support'),
    );
  });

  it('reads a numeric document and node, and keeps priority 0', () => {
    const view = buildImpact([{ path: '/commands/show', change: 'modified', to: [{ document: 12, node: 3, title: '编号是数字', priority: 0 }] }]);
    const run = projected(view, { priorities: [0] });
    assert.deepEqual(run.output.items.map((item) => [item.id, item.fields.priority]), [['12:3', 0]]);
  });

  it('scopes five thousand cases', () => {
    const changes: ChangeSpec[] = [];
    for (let i = 0; i < 5000; i++) {
      changes.push({ path: `/commands/c${i}`, change: 'modified', before: [{ n: i }], after: [{ n: i + 1 }], to: [{ document: 'bulk', node: String(i), title: `用例 ${i}`, priority: 1 }] });
    }
    const built = buildImpact(changes);
    const viewParsed = parsed(built);
    assert.ok(viewParsed);
    const started = Date.now();
    const scope = scopeOf(viewParsed, PARAMETERS);
    const spent = Date.now() - started;
    assert.equal(scope.items.length, 5000);
    assert.deepEqual(scope.note.uncovered, []);
    assert.equal(scope.items[0].id < scope.items[1].id, true);
    assert.ok(spent < 8000, `scope of 5000 cases took ${spent} ms`);
  });
});

describe('projection refusals', () => {
  it('refuses a value that is not an impact view, a missing slot and a bad parameter', () => {
    const notView = projectItems({ inputs: [{ slot: 'impact', sha256: SOURCE, model: { schema: 'other' } }], parameters: {}, context: {} }) as { error: { code: string } };
    assert.equal(notView.error.code, 'regression-scope.not_a_view');
    const missing = projectItems({ inputs: [], parameters: {}, context: {} }) as { error: { code: string } };
    assert.equal(missing.error.code, 'regression-scope.no_impact');
    const bad = projectItems({ inputs: [{ slot: 'impact', sha256: SOURCE, model: buildImpact([]) }], parameters: { priorities: ['high'] }, context: {} }) as { error: { code: string } };
    assert.equal(bad.error.code, 'regression-scope.invalid_parameter');
  });
});
