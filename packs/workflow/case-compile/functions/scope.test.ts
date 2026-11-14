import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseScopePopulation } from './scope.ts';

const POP = ['990000000000000101', '990000000000000102', '990000000000000103', 'doc-1:c-4'];

test('parseScopePopulation supports per-case headings, explicit directives, 只做 clauses, plain bullets, 全部, and excluded sections', () => {
  assert.deepEqual(parseScopePopulation(`## 990000000000000101\n只测这个\n## doc-1:c-4\n也测这个\n## 范围外\n- 990000000000000102\n`, POP), {
    inScope: ['990000000000000101', 'doc-1:c-4'],
    outOfScope: ['990000000000000102', '990000000000000103'],
  });

  assert.deepEqual(parseScopePopulation(`- **990000000000000102**\n- 990000000000000103\n不做 990000000000000101\n`, POP), {
    inScope: ['990000000000000102', '990000000000000103'],
    outOfScope: ['990000000000000101', 'doc-1:c-4'],
  });

  assert.deepEqual(parseScopePopulation(`# 使用者原话，由主会话记录\n\n本次跑全部用例。\n`, POP), {
    inScope: POP,
    outOfScope: [],
  });

  assert.deepEqual(parseScopePopulation(`范围：全部\n`, POP), {
    inScope: POP,
    outOfScope: [],
  });
});

test('parseScopePopulation throws when scope names no identifiable case IDs or names an unknown case', () => {
  assert.throws(() => parseScopePopulation('# 测试范围\n只写背景说明，未列条目\n', POP, 'scope.md'), /没有写明要交付的原始用例编号/);
  assert.throws(() => parseScopePopulation('范围：990000000000000101, 990000000000000999\n', POP, 'scope.md'), /990000000000000999/);
});
