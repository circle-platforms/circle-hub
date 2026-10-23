import assert from 'node:assert/strict';
import { test } from 'node:test';
import { locateItem } from './locate.ts';

const context = { case_id: 'synthetic-case', root: 'NSAE', names: ['APV', 'NSAE'], product: 'apv', title: '合成文档' };
const paths = [
  ['060：10.6.1', '061：10.7.1'],
  ['060：10.6.1', '004：10.7.1-R2'],
  ['10.6.1', '060：10.7.1'],
];
for (const ancestors of paths) for (const declared of [undefined, { line: '10.6.1' }, { line: '10.8.1' }]) {
  test(`version conflict retains every source and precedes declaration for ${ancestors.join('/')} with ${declared?.line ?? 'no declaration'}`, () => {
    const { answer, judgment } = locateItem({ ...context, ancestors, declared });
    assert.equal(answer.version, '10.6.1');
    assert.equal(judgment.verdict, 'refute');
    assert.equal('code' in judgment && judgment.code, 'case-location.version_conflict');
    assert.deepEqual((answer as unknown as { version_values: unknown }).version_values, [
      { version: '10.6.1', level: 1, label: ancestors[0] }, { version: '10.7.1', level: 2, label: ancestors[1] },
    ]);
    assert.match(judgment.statement, /^目录.*自相矛盾/);
    assert.match(judgment.statement, /整理.*目录|参数 line/);
    if (declared) assert.match(judgment.statement, new RegExp(`声明.*${declared.line}`));
    assert.equal(answer.conflicts.filter(conflict => conflict.field === 'line').length, 0);
  });
}
