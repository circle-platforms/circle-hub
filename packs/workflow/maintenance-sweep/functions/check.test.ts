// Tests for commandUnchanged statement formatting with field differences:
// 1 diff, 3 diffs, 5 diffs (3 diffs + 另有 2 处), absent on one side, long values clipped, object values, multiple paths,
// and 400-char length budget.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkOutcomes } from './check.ts';

function makeSubject(rows: Array<{ path: string; change?: 'removed' | 'modified'; fields: Array<{ path: string; before: unknown; after: unknown; absent?: 'before' | 'after' }> }>): Record<string, unknown> {
  return {
    note: {
      details: rows.map((r) => ({ path: r.path, change: r.change ?? 'modified', fields: r.fields })),
    },
    items: [
      {
        id: 'doc-1:n1',
        fields: {
          document: 'doc-1',
          node: 'n1',
          title: '查看',
          reasons: rows.map((r) => ({
            code: 'maintenance-sweep.case.command_changed',
            path: r.path,
            change: r.change ?? 'modified',
            references: ['ref1', 'ref2'],
            case: { entry: 'c1', reference: 'refc' },
          })),
        },
      },
    ],
  };
}

describe('commandUnchanged field difference formatting in statement', () => {
  it('formats one field difference with old and new values and retains data.fields', () => {
    const subject = makeSubject([
      {
        path: '/commands/show',
        fields: [{ path: '/help', before: '旧帮助', after: '新帮助' }],
      },
    ]);
    const [outcome] = checkOutcomes('command_unchanged', subject);
    assert.equal(outcome.verdict, 'refute');
    assert.equal(outcome.code, 'maintenance-sweep.case.command_changed');
    assert.equal(
      outcome.statement,
      '用例 doc-1:n1（查看）所在命令的定义有变更（/commands/show）。字段差异 1 处：/help 旧 旧帮助 → 新 新帮助',
    );
    assert.match(outcome.statement, /字段差异/);
    assert.match(outcome.statement, /旧/);
    assert.match(outcome.statement, /新/);
    assert.deepEqual(outcome.data?.fields, [
      { command: '/commands/show', path: '/help', before: '旧帮助', after: '新帮助' },
    ]);
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
    const [outcome] = checkOutcomes('command_unchanged', subject);
    assert.equal(outcome.verdict, 'refute');
    assert.equal(
      outcome.statement,
      '用例 doc-1:n1（查看）所在命令的定义有变更（/commands/show）。字段差异 3 处：/help 旧 旧帮助 → 新 新帮助；/args/0/name 旧 foo → 新 bar；/args/0/type 旧 string → 新 integer',
    );
    assert.ok(!outcome.statement.includes('另有'));
    assert.equal((outcome.data?.fields as unknown[]).length, 3);
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
    const [outcome] = checkOutcomes('command_unchanged', subject);
    assert.equal(outcome.verdict, 'refute');
    assert.equal(
      outcome.statement,
      '用例 doc-1:n1（查看）所在命令的定义有变更（/commands/show）。字段差异 5 处：/f1 旧 1 → 新 2；/f2 旧 a → 新 b；/f3 旧 true → 新 false；另有 2 处',
    );
    assert.equal((outcome.data?.fields as unknown[]).length, 5);
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
    const [outcome] = checkOutcomes('command_unchanged', subject);
    assert.equal(outcome.verdict, 'refute');
    assert.equal(
      outcome.statement,
      '用例 doc-1:n1（查看）所在命令的定义有变更（/commands/show）。字段差异 2 处：/added_prop 旧值：无 → 新 added_val；/removed_prop 旧 removed_val → 新值：无',
    );
    assert.deepEqual(outcome.data?.fields, [
      { command: '/commands/show', path: '/added_prop', before: null, after: 'added_val', absent: 'before' },
      { command: '/commands/show', path: '/removed_prop', before: 'removed_val', after: null, absent: 'after' },
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
    const [outcome] = checkOutcomes('command_unchanged', subject);
    assert.equal(outcome.verdict, 'refute');
    const expectedBefore = `${'a'.repeat(59)}…`;
    const expectedAfter = `${'b'.repeat(59)}…`;
    assert.equal(
      outcome.statement,
      `用例 doc-1:n1（查看）所在命令的定义有变更（/commands/show）。字段差异 1 处：/desc 旧 ${expectedBefore} → 新 ${expectedAfter}`,
    );
    const fields = outcome.data?.fields as Array<{ before: unknown; after: unknown }> | undefined;
    assert.equal(fields?.[0]?.before, longBefore);
    assert.equal(fields?.[0]?.after, longAfter);
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
    const [outcome] = checkOutcomes('command_unchanged', subject);
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
    const [outcome] = checkOutcomes('command_unchanged', subject);
    assert.equal(outcome.verdict, 'refute');
    assert.equal(
      outcome.statement,
      '用例 doc-1:n1（查看）所在命令的定义有变更（/commands/add、/commands/delete）。/commands/add 字段差异 2 处：/help 旧 加甲 → 新 加乙；/type 旧 int → 新 float；/commands/delete 字段差异 1 处：/confirm 旧 false → 新 true',
    );
    assert.equal((outcome.data?.fields as unknown[]).length, 3);
  });

  it('restricts total section length to at most 400 characters by showing fewer diffs and adding 另有 M 处', () => {
    // Each diff item has ~140 characters, so 3 diffs would be ~420 characters.
    // It should reduce to 2 diffs with 另有 3 处 so total section length <= 400.
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
    const [outcome] = checkOutcomes('command_unchanged', subject);
    assert.equal(outcome.verdict, 'refute');
    const baseSentence = '用例 doc-1:n1（查看）所在命令的定义有变更（/commands/show）。';
    assert.ok(outcome.statement.startsWith(baseSentence));
    const section = outcome.statement.slice(baseSentence.length);
    assert.ok(section.length <= 400, `section length ${section.length} must be <= 400`);
    assert.match(section, /另有 \d+ 处/);
  });
});
