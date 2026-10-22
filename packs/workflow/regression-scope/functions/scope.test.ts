// The scope, written down before the projection: every later-build case on an added or modified path is in scope once,
// with every reason; an unchanged path and a removed path are not; a changed path with no case is unknown, never a
// failure; priorities and include_added do what they say; order does not matter.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ImpactView } from '../../../../contracts/src/views.ts';
import { checkOutcomes } from './check.ts';
import { projectItems } from './project.ts';
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
    items: output.items.map((item) => ({ id: item.id, location: `src:${SOURCE}/json@1/${item.location.selector}`, fields: item.fields })),
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
      both.reasons.map((reason) => [reason.path, reason.change]),
      [
        ['/commands/add', 'added'],
        ['/commands/show', 'modified'],
      ],
    );
    // The slim reason points at the path's tree references (definitions of both sides); the case rides the location.
    assert.ok(both.reasons[1].references.length > 0, JSON.stringify(both.reasons[1]));
    for (const reference of both.reasons[1].references) assert.match(reference, /^tree:[0-9a-f]{64}\/commands\/show(@[0-9a-f]{64})?$/);
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
    assert.match(run.uncovered[0].statement, /\/commands\/bare（新增）/);
    assert.match(run.uncovered[0].statement, /不是失败/);
    assert.ok(run.inScope.every((outcome) => outcome.verdict === 'support'));
    // The slim grounds: each reason's case reference plus the path's tree references (no bodies).
    const grounds = run.inScope.find((outcome) => outcome.item === 'doc-1:n1')!.grounds;
    const show = run.output.items[0].fields.reasons as Array<{ path: string; references: string[]; case: { reference: string } }>;
    const wanted = show.flatMap((reason) => [reason.case.reference, ...reason.references]);
    assert.deepEqual(grounds, [...new Set(wanted)].sort());
    assert.ok(grounds.every((ref) => ref.startsWith('tree:')), 'every ground is a tree reference');
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
      const reasons = run.output.items[0].fields.reasons as Array<{ path: string; case: { entry: string; reference: string } }>;
      assert.equal(reasons.length, 1);
      return reasons[0].case.entry;
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
    assert.ok(!run.uncovered.some((outcome) => outcome.statement.includes('/commands/extra')));
  });

  it('drops added paths when include_added is false, including from a case that also sits on a modified path', () => {
    const run = projected(view, { include_added: false });
    assert.deepEqual(
      run.output.items.map((item) => item.id),
      ['doc-1:n1', 'doc-2:n2', 'doc-5:n1'],
    );
    const reasons = run.output.items[0].fields.reasons as Array<{ path: string; change: string }>;
    assert.deepEqual(reasons.map((reason) => reason.path), ['/commands/show']);
    assert.deepEqual(run.output.groups[0].uncovered, []);
    assert.equal(run.uncovered.length, 1);
    assert.equal(run.uncovered[0].verdict, 'support');
  });

  it('says the scope is empty when the pair has no changed path', () => {
    const run = projected(buildImpact([]));
    assert.deepEqual(run.output.items, []);
    assert.ok(run.output.warnings.some((warning) => warning.code === 'regression-scope.empty_scope' && warning.message.includes('回归范围是空的')));
    assert.match(String(run.output.groups[0].message), /回归范围是空的/);
    assert.equal(run.uncovered[0].verdict, 'support');
    assert.match(run.uncovered[0].statement, /回归范围是空的/);
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
    assert.ok(run.uncovered.every((outcome) => outcome.verdict !== 'support'));
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
