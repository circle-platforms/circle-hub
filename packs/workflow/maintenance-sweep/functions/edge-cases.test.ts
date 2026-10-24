// Edge cases of the maintenance sweep written after a mutation check: a named definition the view
// does not hold is not agreement, the least digest wins, over-long ids are excluded, array
// length-change diffs name the absent side, a removed reason without the pack code still refutes,
// one skipped earlier document still withholds proof, and a second bound view is refused.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkOutcomes } from './check.ts';
import { definitionDiff } from './diff.ts';
import { projectItems } from './test-support.ts';
import { sweepOf } from './sweep.ts';
import { buildImpact, SOURCE } from './test-support.ts';
import { parseView } from './view.ts';

const NONE = { ignoreFields: [] as string[] };

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

const CASE = 'a'.repeat(64);
const BEFORE = 'b'.repeat(64);
const AFTER = 'd'.repeat(64);
const LATER = 'e'.repeat(64);
const ref = (root: string, entry: string) => `tree:${root}/commands/show@${entry}`;

describe('maintenance sweep edge cases', () => {
  it('counts a modified path whose named definition is not in the view as a missing fact, not a fabricated difference', () => {
    const view = buildImpact([{ path: '/commands/x', change: 'modified', before: [{ name: 'x' }], after: [{ name: 'x' }], from: [{ document: 'doc-1', node: 'n1', title: '甲', priority: 1 }] }]);
    const absent = 'f'.repeat(64);
    const rows = view.changes as Array<{ before: string[]; after: string[] }>;
    rows[0].before = [absent];
    rows[0].after = [absent];
    const sweep = sweepOf(parsed(view)!, NONE);
    assert.deepEqual(
      sweep.items.map((item) => item.id),
      ['doc-1:n1'],
    );
    const row = sweep.note.details[sweep.items[0].reasons[0].detail];
    assert.deepEqual(row?.fields, []);
    assert.deepEqual(row?.missing, [absent]);
    assert.ok(sweep.warnings.some((warning) => warning.code === 'maintenance-sweep.missing_entry'));
  });

  it('points an item at the least digest of a case placed on two removed paths', () => {
    const view = buildImpact([
      { path: '/commands/a', change: 'removed', before: [{ name: 'a' }], from: [{ document: 'doc-1', node: 'n1', title: '甲', priority: 1 }] },
      { path: '/commands/b', change: 'removed', before: [{ name: 'b' }], from: [{ document: 'doc-1', node: 'n1', title: '甲', priority: 1 }] },
    ]);
    const digests = caseDigests(view);
    assert.equal(digests.length, 2);
    const sweep = sweepOf(parsed(view)!, NONE);
    assert.deepEqual(
      sweep.items.map((item) => item.id),
      ['doc-1:n1'],
    );
    assert.equal(sweep.items[0].entry, digests[0], 'the item points at the least digest');
  });

  it('excludes a case whose id is longer than the limit and says so', () => {
    const view = buildImpact([{ path: '/commands/drop', change: 'removed', before: [{ name: 'drop' }], from: [{ document: 'd'.repeat(150), node: 'n'.repeat(60), title: '编号超长', priority: 1 }] }]);
    const sweep = sweepOf(parsed(view)!, NONE);
    assert.deepEqual(sweep.items, []);
    assert.ok(sweep.warnings.some((warning) => warning.code === 'maintenance-sweep.case_id_too_long' && warning.message.includes('超过 200 个字符')));
  });

  it('names the absent side of an array length change', () => {
    assert.deepEqual(definitionDiff([{ a: 1 }], [{ a: 1 }, { b: 2 }], []), [{ path: '/1', before: null, after: { b: 2 }, absent: 'before' }]);
    assert.deepEqual(definitionDiff([{ a: 1 }, { b: 2 }], [{ a: 1 }], []), [{ path: '/1', before: { b: 2 }, after: null, absent: 'after' }]);
  });

  it('refutes command_exists on a removed change', () => {
    const [outcome] = checkOutcomes('command_exists', {
      items: [{ id: 'doc-1:n1', label: '甲', location: 'src:loc', fields: { document: 'doc-1', node: 'n1', reasons: [{ detail: 0, change: 'removed' }] } }],
      note: { details: [{ path: '/commands/drop', change: 'removed', fields: [] }] },
    });
    assert.deepEqual([outcome.verdict, outcome.code], ['refute', 'maintenance-sweep.case.command_removed']);
    assert.match(outcome.statement, /已删除/);
  });

  it('withholds proof when exactly one listed earlier document is missing from the index', () => {
    const reason = {
      code: 'maintenance-sweep.case.command_changed',
      path: '/commands/show',
      change: 'modified' as const,
      fields: [{ path: '/help', before: '旧', after: '新' }],
      before: [{ entry: BEFORE, kind: 'definition', reference: ref(BEFORE, BEFORE) }],
      after: [{ entry: AFTER, kind: 'definition', reference: ref(LATER, AFTER) }],
      case: { entry: CASE, reference: ref(LATER, CASE) },
    };
    const outcomes = checkOutcomes('command_exists', {
      items: [{ id: 'doc-1:n1', location: '', fields: { document: 'doc-1', node: 'n1', title: '甲', reasons: [reason] } }],
      note: { skipped_from: 1, truncated: false, changed_paths: 1, ignore_fields: [] },
    });
    const loose = outcomes.find((outcome) => outcome.item === undefined && outcome.verdict === 'unknown');
    assert.equal(loose?.reason, 'missing_input');
    assert.match(loose?.statement ?? '', /缺少 1 份列出的文档/);
  });

  it('refuses a second bound impact view', () => {
    const first = buildImpact([{ path: '/commands/x', change: 'removed', before: [{ name: 'x' }], from: [{ document: 'doc-1', node: 'n1', title: '甲', priority: 1 }] }]);
    const second = buildImpact([{ path: '/commands/y', change: 'added', after: [{ name: 'y' }] }]);
    const output = projectItems({ inputs: [input(first), input(second)], parameters: {}, context: {} }) as { error?: { code: string; message: string } };
    assert.equal(output.error?.code, 'maintenance-sweep.no_impact');
    assert.match(output.error?.message ?? '', /只接受一个影响视图，给了 2 个/);
  });
});
