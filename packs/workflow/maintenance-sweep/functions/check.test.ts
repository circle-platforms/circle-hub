// Tests for commandUnchanged statement formatting with field differences:
// 1 diff, 3 diffs, 5 diffs (3 diffs + 另有 2 处), absent on one side, long values clipped, object values, multiple paths,
// and 400-char length budget.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkOutcomes } from './check.ts';

function makeSubject(rows: Array<{ path: string; change?: 'removed' | 'modified'; fields: Array<{ path: string; before: unknown; after: unknown; absent?: 'before' | 'after' }> }>): Record<string, unknown> {
  return {
    note: {
      details: rows.map((r) => ({ path: r.path, change: r.change ?? 'modified', fields: r.fields, references: ['ref1', 'ref2'] })),
    },
    items: [
      {
        id: 'doc-1:n1',
        label: '查看',
        location: 'src:loc',
        fields: {
          document: 'doc-1',
          node: 'n1',
          reasons: rows.map((r, index) => ({ detail: index, change: r.change ?? 'modified' })),
        },
      },
    ],
  };
}

describe('commandUnchanged field difference formatting in statement', () => {
  /** The item's own outcome (the command-diff summary now leads this check's outcomes; these tests assert the item). */
  const itemOutcome = (subject: unknown) => {
    const outcome = checkOutcomes('command_unchanged', subject).find((o) => o.item !== undefined);
    assert.ok(outcome);
    return outcome;
  };

  it('formats one field difference with old and new values and retains data.fields', () => {
    const subject = makeSubject([
      {
        path: '/commands/show',
        fields: [{ path: '/help', before: '旧帮助', after: '新帮助' }],
      },
    ]);
    const outcome = itemOutcome(subject);
    assert.equal(outcome.verdict, 'refute');
    assert.equal(outcome.code, 'maintenance-sweep.case.command_changed');
    assert.equal(
      outcome.statement,
      '用例 doc-1:n1（查看）所在命令的定义有变更（/commands/show）。字段差异 1 处：/help 旧 旧帮助 → 新 新帮助',
    );
    assert.match(outcome.statement, /字段差异/);
    assert.match(outcome.statement, /旧/);
    assert.match(outcome.statement, /新/);
    // The raw field row is not repeated on the outcome; it lives once in the note's detail row the reason indexes.
    assert.deepEqual(outcome.data?.reasons, [{ detail: 0, change: 'modified' }]);
    assert.deepEqual((subject.note as { details: Array<{ fields: unknown[] }> }).details[0].fields, [{ path: '/help', before: '旧帮助', after: '新帮助' }]);
  });

  it('formats three field differences without 另有 M 处', () => {
    const subject = makeSubject([
      {
        path: '/commands/show',
        fields: [
          { path: '/help', before: '旧帮助', after: '新帮助' },
          { path: '/args/0/name', before: 'foo', after: 'bar' },
          { path: '/args/0/type', before: 'string', after: 'integer' },
        ],
      },
    ]);
    const outcome = itemOutcome(subject);
    assert.equal(outcome.verdict, 'refute');
    assert.equal(
      outcome.statement,
      '用例 doc-1:n1（查看）所在命令的定义有变更（/commands/show）。字段差异 3 处：/help 旧 旧帮助 → 新 新帮助；/args/0/name 旧 foo → 新 bar；/args/0/type 旧 string → 新 integer',
    );
    assert.ok(!outcome.statement.includes('另有'));
    assert.deepEqual(outcome.data?.reasons, [{ detail: 0, change: 'modified' }]);
  });

  it('formats five field differences by writing first 3 diffs and 另有 2 处, while keeping all 5 in data.fields', () => {
    const subject = makeSubject([
      {
        path: '/commands/show',
        fields: [
          { path: '/f1', before: 1, after: 2 },
          { path: '/f2', before: 'a', after: 'b' },
          { path: '/f3', before: true, after: false },
          { path: '/f4', before: 'x', after: 'y' },
          { path: '/f5', before: 10, after: 20 },
        ],
      },
    ]);
    const outcome = itemOutcome(subject);
    assert.equal(outcome.verdict, 'refute');
    assert.equal(
      outcome.statement,
      '用例 doc-1:n1（查看）所在命令的定义有变更（/commands/show）。字段差异 5 处：/f1 旧 1 → 新 2；/f2 旧 a → 新 b；/f3 旧 true → 新 false；另有 2 处',
    );
    assert.equal((subject.note as { details: Array<{ fields: unknown[] }> }).details[0].fields.length, 5, 'all five stay once in the detail row');
  });

  it('formats absent side as 旧值：无 or 新值：无', () => {
    const subject = makeSubject([
      {
        path: '/commands/show',
        fields: [
          { path: '/added_prop', before: null, after: 'added_val', absent: 'before' },
          { path: '/removed_prop', before: 'removed_val', after: null, absent: 'after' },
        ],
      },
    ]);
    const outcome = itemOutcome(subject);
    assert.equal(outcome.verdict, 'refute');
    assert.equal(
      outcome.statement,
      '用例 doc-1:n1（查看）所在命令的定义有变更（/commands/show）。字段差异 2 处：/added_prop 旧值：无 → 新 added_val；/removed_prop 旧 removed_val → 新值：无',
    );
    assert.deepEqual((subject.note as { details: Array<{ fields: unknown[] }> }).details[0].fields, [
      { path: '/added_prop', before: null, after: 'added_val', absent: 'before' },
      { path: '/removed_prop', before: 'removed_val', after: null, absent: 'after' },
    ]);
  });

  it('clips values longer than 60 characters with ellipsis', () => {
    const longBefore = 'a'.repeat(80);
    const longAfter = 'b'.repeat(70);
    const subject = makeSubject([
      {
        path: '/commands/show',
        fields: [{ path: '/desc', before: longBefore, after: longAfter }],
      },
    ]);
    const outcome = itemOutcome(subject);
    assert.equal(outcome.verdict, 'refute');
    const expectedBefore = `${'a'.repeat(59)}…`;
    const expectedAfter = `${'b'.repeat(59)}…`;
    assert.equal(
      outcome.statement,
      `用例 doc-1:n1（查看）所在命令的定义有变更（/commands/show）。字段差异 1 处：/desc 旧 ${expectedBefore} → 新 ${expectedAfter}`,
    );
    const fields = (subject.note as { details: Array<{ fields: Array<{ before: unknown; after: unknown }> }> }).details[0].fields;
    assert.equal(fields[0].before, longBefore);
    assert.equal(fields[0].after, longAfter);
  });

  it('formats objects and arrays as compact JSON', () => {
    const objBefore = { k: 'val', num: 1 };
    const arrAfter = [1, 'two', { three: 3 }];
    const subject = makeSubject([
      {
        path: '/commands/show',
        fields: [{ path: '/config', before: objBefore, after: arrAfter }],
      },
    ]);
    const outcome = itemOutcome(subject);
    assert.equal(outcome.verdict, 'refute');
    assert.equal(
      outcome.statement,
      '用例 doc-1:n1（查看）所在命令的定义有变更（/commands/show）。字段差异 1 处：/config 旧 {"k":"val","num":1} → 新 [1,"two",{"three":3}]',
    );
  });

  it('formats multiple changed command paths separately and keeps all in data.fields', () => {
    const subject = makeSubject([
      {
        path: '/commands/add',
        fields: [
          { path: '/help', before: '加甲', after: '加乙' },
          { path: '/type', before: 'int', after: 'float' },
        ],
      },
      {
        path: '/commands/delete',
        fields: [
          { path: '/confirm', before: false, after: true },
        ],
      },
    ]);
    const outcome = itemOutcome(subject);
    assert.equal(outcome.verdict, 'refute');
    assert.equal(
      outcome.statement,
      '用例 doc-1:n1（查看）所在命令的定义有变更（/commands/add、/commands/delete）。/commands/add 字段差异 2 处：/help 旧 加甲 → 新 加乙；/type 旧 int → 新 float；/commands/delete 字段差异 1 处：/confirm 旧 false → 新 true',
    );
    assert.deepEqual(outcome.data?.reasons, [
      { detail: 0, change: 'modified' },
      { detail: 1, change: 'modified' },
    ]);
  });

  it('restricts total section length to at most 200 characters by showing fewer diffs and adding 另有 M 处', () => {
    // Each diff item has ~140 characters, so 2 diffs would be ~280 characters.
    // It should reduce to 1 diff with 另有 4 处 so total section length <= 200.
    const longStr1 = 'x'.repeat(55);
    const longStr2 = 'y'.repeat(55);
    const subject = makeSubject([
      {
        path: '/commands/show',
        fields: [
          { path: '/very/long/field/path/one', before: longStr1, after: longStr2 },
          { path: '/very/long/field/path/two', before: longStr1, after: longStr2 },
          { path: '/very/long/field/path/three', before: longStr1, after: longStr2 },
          { path: '/very/long/field/path/four', before: longStr1, after: longStr2 },
          { path: '/very/long/field/path/five', before: longStr1, after: longStr2 },
        ],
      },
    ]);
    const outcome = itemOutcome(subject);
    assert.equal(outcome.verdict, 'refute');
    const baseSentence = '用例 doc-1:n1（查看）所在命令的定义有变更（/commands/show）。';
    assert.ok(outcome.statement.startsWith(baseSentence));
    const section = outcome.statement.slice(baseSentence.length);
    assert.ok(section.length <= 200, `section length ${section.length} must be <= 200`);
    assert.match(section, /另有 \d+ 处/);
  });
});

describe('an empty sweep and skipped sources', () => {
  const note = (extra: { [key: string]: unknown } = {}): { [key: string]: unknown } => ({
    kind: 'maintenance-sweep',
    skipped_to: 0,
    skipped_from: 0,
    truncated: false,
    changed_paths: 0,
    ignore_fields: [],
    message: '没有需要维护的用例。',
    details: [],
    diff: [],
    ...extra,
  });

  it('command_exists with zero items and no skipped sources: a deterministic empty-scope support, no unknown', () => {
    const outcomes = checkOutcomes('command_exists', { items: [], note: note() });
    const empty = outcomes.find((o) => o.statement.includes('没有需要维护的用例'));
    assert.ok(empty, JSON.stringify(outcomes));
    assert.equal(empty.verdict, 'support');
    assert.equal(outcomes.some((o) => o.verdict === 'unknown'), false, JSON.stringify(outcomes));
  });

  it('command_unchanged with zero items and a note: a deterministic empty-scope support', () => {
    const outcomes = checkOutcomes('command_unchanged', { items: [], note: note() });
    const empty = outcomes.find((o) => o.statement.includes('没有需要维护的用例'));
    assert.ok(empty, JSON.stringify(outcomes));
    assert.equal(empty.verdict, 'support');
    assert.equal(outcomes.some((o) => o.verdict === 'unknown'), false, JSON.stringify(outcomes));
  });

  it('skipped_from > 0: one unknown naming the skipped documents the view reports and the next step', () => {
    const outcomes = checkOutcomes('command_exists', {
      items: [],
      note: note({
        skipped_from: 2,
        view_notes: ['构建 10.6.1 的根有 2 份列出的来源没有用上（生产器 case-index），这些来源会给出的条目不在这个根里，是未知，不是没有'],
      }),
    });
    const unknown = outcomes.find((o) => o.verdict === 'unknown');
    assert.ok(unknown, JSON.stringify(outcomes));
    assert.match(unknown.statement, /2 份/);
    assert.match(unknown.statement, /生产器 case-index/);
    assert.match(unknown.statement, /构建 10\.6\.1/);
    assert.match(unknown.missing ?? '', /下一步/);
    assert.equal(unknown.reason, 'missing_input');
  });

  it('skipped_from = 0 with items present: no unconditional unknown any more', () => {
    const subject = makeSubject([{ path: '/commands/show', fields: [{ path: '/help', before: '旧', after: '新' }] }]);
    (subject.note as { [key: string]: unknown }).skipped_from = 0;
    const outcomes = checkOutcomes('command_exists', subject);
    assert.equal(outcomes.some((o) => o.verdict === 'unknown' && o.statement.includes('索引没有收录的用例')), false, JSON.stringify(outcomes));
  });
});
