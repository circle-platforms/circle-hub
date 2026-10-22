// The sweep, written down before the projection: a case of the earlier build on a removed path is stale; a case on a
// modified path whose definition data differ is changed, field by field; a behaviour-only change is not an item; a
// clean pair says so; order does not matter.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ImpactView } from '../../../../contracts/src/views.ts';
import { checkOutcomes } from './check.ts';
import { projectItems } from './project.ts';
import { sweepOf } from './sweep.ts';
import { buildImpact, reversedView, reviewSweep, SOURCE, type ChangeSpec } from './test-support.ts';
import { parseView } from './view.ts';

const NONE = { ignoreFields: [] as string[] };

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
  }) as {
    items: Array<{ id: string; label: string; summary: string; fields: { [key: string]: unknown } }>;
    groups: Array<{ [key: string]: unknown }>;
    warnings: Array<{ code: string; message: string }>;
    error?: { code: string };
  };
  assert.equal(output.error, undefined, JSON.stringify(output.error));
  const subject = { items: output.items.map((item) => ({ id: item.id, location: '', fields: item.fields })), note: output.groups[0] };
  return { output, exists: checkOutcomes('command_exists', subject), unchanged: checkOutcomes('command_unchanged', subject) };
}

const removedTwo: ChangeSpec[] = [
  {
    path: '/commands/drop',
    change: 'removed',
    before: [{ name: 'drop' }],
    from: [
      { document: 'doc-1', node: 'n1', title: '删除上的甲', priority: 1 },
      { document: 'doc-2', node: 'n2', title: '删除上的乙', priority: 2 },
    ],
  },
];

const behaviourOnly: ChangeSpec[] = [
  {
    path: '/commands/text',
    change: 'modified',
    before: [{ name: 'text', help: '相同' }],
    after: [{ name: 'text', help: '相同' }],
    behaviourBefore: ['说明甲'],
    behaviourAfter: ['说明乙'],
    from: [{ document: 'doc-5', node: 'n1', title: '只改了行为说明', priority: 1 }],
  },
];

const both: ChangeSpec[] = [
  {
    path: '/commands/drop',
    change: 'removed',
    before: [{ name: 'drop' }],
    from: [{ document: 'doc-1', node: 'n1', title: '又删又改', priority: 1, negative: true }],
  },
  {
    path: '/commands/show',
    change: 'modified',
    before: [{ name: 'show', help: '旧' }],
    after: [{ name: 'show', help: '新' }],
    from: [{ document: 'doc-1', node: 'n1', title: '又删又改', priority: 1, negative: true }],
  },
];

const added: ChangeSpec[] = [
  {
    path: '/commands/add',
    change: 'added',
    after: [{ name: 'add' }],
    from: [{ document: 'doc-6', node: 'n1', title: '新增路径上的旧用例', priority: 1 }],
  },
];

describe('maintenance sweep on a hand-built pair of trees', () => {
  const view = buildImpact(reviewSweep());

  it('is an impact-view@1 the knowledge reader could have returned', () => {
    assert.equal(ImpactView.safeParse(view).success, true);
  });

  it('reports every earlier case on a removed path, and a signature change field by field', () => {
    const run = projected(view);
    assert.deepEqual(
      run.output.items.map((item) => item.id),
      ['doc-1:n1', 'doc-2:n2', 'doc-3:n1', 'doc-4:n1'],
    );
    assert.ok(!run.output.items.some((item) => item.id === 'doc-5:n1' || item.id === 'doc-6:n1' || item.id === 'doc-9:n9'));
    const removed = run.exists.filter((outcome) => outcome.verdict === 'refute');
    assert.deepEqual(
      removed.map((outcome) => outcome.item),
      ['doc-1:n1', 'doc-2:n2'],
    );
    assert.ok(removed.every((outcome) => outcome.code === 'maintenance-sweep.case.command_removed' && outcome.tier === 'blocking'));
    assert.equal((removed[0].data as { fix: string }).fix, '按替代命令改写这条用例，或者停用它');
    assert.match(removed[0].statement, /按替代命令改写这条用例，或者停用它/);
    const changed = run.unchanged.filter((outcome) => outcome.verdict === 'refute');
    assert.deepEqual(
      changed.map((outcome) => outcome.item),
      ['doc-3:n1', 'doc-4:n1'],
    );
    assert.ok(changed.every((outcome) => outcome.code === 'maintenance-sweep.case.command_changed' && outcome.tier === 'advisory'));
    const signatureFields = (changed.find((outcome) => outcome.item === 'doc-3:n1')!.data as { fields: Array<{ command: string; path: string; before: unknown; after: unknown }> }).fields;
    assert.deepEqual(signatureFields, [{ command: '/commands/show', path: '/args/0/type', before: 'string', after: 'integer' }]);
    const helpFields = (changed.find((outcome) => outcome.item === 'doc-4:n1')!.data as { fields: Array<{ path: string; before: unknown; after: unknown }> }).fields;
    assert.deepEqual(helpFields, [{ command: '/commands/help', path: '/help', before: '旧帮助', after: '新帮助' }].map((row) => row));
    assert.equal(run.output.items[2].summary, '优先级 1；文档 doc-3；1 处需要维护；/commands/show 修改');
    // A removal-only item is not a definition change. A definition change is not a removed command.
    assert.equal(run.unchanged.find((outcome) => outcome.item === 'doc-2:n2')!.verdict, 'support');
    assert.equal(run.exists.find((outcome) => outcome.item === 'doc-3:n1')!.verdict, 'support');
  });

  it('keeps both reasons on one case', () => {
    const run = projected(buildImpact(both));
    assert.deepEqual(
      run.output.items.map((item) => item.id),
      ['doc-1:n1'],
    );
    const reasons = run.output.items[0].fields.reasons as Array<{ path: string; change: string; code: string }>;
    assert.deepEqual(
      reasons.map((reason) => [reason.path, reason.change, reason.code]),
      [
        ['/commands/drop', 'removed', 'maintenance-sweep.case.command_removed'],
        ['/commands/show', 'modified', 'maintenance-sweep.case.command_changed'],
      ],
    );
    assert.equal(run.output.items[0].fields.negative, true);
    assert.equal(run.exists[0].verdict, 'refute');
    assert.equal(run.unchanged[0].verdict, 'refute');
    assert.match(run.output.items[0].summary, /2 处需要维护；\/commands\/drop 删除/);
  });

  it('does not report a behaviour-only change or an added path', () => {
    const run = projected(buildImpact([...behaviourOnly, ...added]));
    assert.deepEqual(run.output.items, []);
    assert.ok(run.output.warnings.some((warning) => warning.code === 'maintenance-sweep.clean' && warning.message.includes('没有需要维护的用例')));
  });

  it('skips fields named in ignore_fields and still reports the others', () => {
    const run = projected(view, { ignore_fields: ['help'] });
    assert.deepEqual(
      run.output.items.map((item) => item.id),
      ['doc-1:n1', 'doc-2:n2', 'doc-3:n1'],
    );
    const show = (run.output.items.find((item) => item.id === 'doc-3:n1')!.fields.reasons as Array<{ fields: Array<{ path: string }> }>)[0];
    assert.equal(show.fields[0].path, '/args/0/type');
    assert.ok(!run.output.items.some((item) => item.id === 'doc-4:n1'));
  });

  it('says a clean pair is empty', () => {
    const run = projected(buildImpact([]));
    assert.deepEqual(run.output.items, []);
    assert.match(String(run.output.groups[0].message), /没有需要维护的用例/);
    assert.match(String(run.output.groups[0].message), /索引没有收录的用例，这里不作结论/);
  });

  it('says a short earlier index is not proof that nothing is stale', () => {
    const run = projected(buildImpact(behaviourOnly, { skipped: { from: 3, to: 0 } }));
    assert.match(String(run.output.groups[0].message), /较早构建的索引缺少 3 份列出的文档/);
    assert.match(String(run.output.groups[0].message), /没有维护项并不能证明没有过期的用例/);
    const withItems = projected(buildImpact(removedTwo, { skipped: { from: 3, to: 0 } }));
    const loose = withItems.exists.filter((outcome) => outcome.item === undefined && outcome.verdict === 'unknown');
    assert.equal(loose[0].reason, 'missing_input');
    assert.match(loose[0].statement, /缺少 3 份列出的文档/);
    assert.ok(withItems.exists.filter((outcome) => outcome.item !== undefined).every((outcome) => outcome.verdict === 'refute'));
  });

  it('does not depend on the order of placements, entries or definition keys', () => {
    const forward = projected(view);
    const backward = projected(reversedView(view));
    assert.deepEqual(backward.output.items, forward.output.items);
    assert.deepEqual(backward.exists, forward.exists);
    assert.deepEqual(backward.unchanged, forward.unchanged);
    const swapped = buildImpact([
      {
        path: '/commands/show',
        change: 'modified',
        before: [{ z: 1, a: { b: 2, a: 1 } }],
        after: [{ a: { a: 1, b: 2 }, z: 1 }],
        from: [{ document: 'doc-1', node: 'n1', title: '键序不同', priority: 1 }],
      },
    ]);
    assert.deepEqual(projected(swapped).output.items, []);
  });

  it('reads a numeric document and node', () => {
    const run = projected(buildImpact([{ path: '/commands/drop', change: 'removed', before: [{ name: 'drop' }], from: [{ document: 12, node: 3, title: '编号是数字', priority: 0 }] }]));
    assert.equal(run.output.items[0].id, '12:3');
    assert.equal(run.output.items[0].fields.priority, 0);
  });

  it('sweeps five thousand cases', () => {
    const changes: ChangeSpec[] = [];
    for (let i = 0; i < 5000; i++) {
      const n = String(i).padStart(4, '0');
      changes.push({ path: `/commands/c${n}`, change: 'removed', before: [{ name: 'c' }], from: [{ document: 'doc', node: `n${n}`, title: '用例', priority: 1 }] });
    }
    const viewParsed = parsed(buildImpact(changes));
    assert.ok(viewParsed);
    const started = Date.now();
    const sweep = sweepOf(viewParsed, NONE);
    const elapsed = Date.now() - started;
    assert.equal(sweep.items.length, 5000);
    assert.ok(elapsed < 8000, `${elapsed}ms`);
  });
});

describe('projection refusals', () => {
  it('refuses a value that is not an impact view, a missing slot and a bad parameter', () => {
    const bad = projectItems({ inputs: [{ slot: 'impact', sha256: SOURCE, model: { schema: 'other' } }], parameters: {} }) as { error: { code: string } };
    assert.equal(bad.error.code, 'maintenance-sweep.not_a_view');
    const missing = projectItems({ inputs: [], parameters: {} }) as { error: { code: string } };
    assert.equal(missing.error.code, 'maintenance-sweep.no_impact');
    const parameter = projectItems({ inputs: [{ slot: 'impact', sha256: SOURCE, model: buildImpact([]) }], parameters: { ignore_fields: [1] } }) as { error: { code: string } };
    assert.equal(parameter.error.code, 'maintenance-sweep.invalid_parameter');
  });
});
