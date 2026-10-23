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

for (const [name, version] of [['Rel_NSAE_10_9_1_37', '10.9.1'], ['Beta_APV_10_8_42', '10.8']] as const) {
  test(`a bound build name supplies its folder version: ${name}`, () => {
    const result = locateItem({ ...context, ancestors: [`${name} 回归`] });
    assert.equal(result.judgment.verdict, 'support'); assert.equal(result.answer.confidence, 'high');
    assert.equal(result.answer.version, version); assert.equal(result.answer.line, version);
    assert.deepEqual(result.answer.build_names, [name]);
    assert.match(result.answer.notes.join('；'), /版本取自目录名里的构建名/);
  });
}
test('a folder build name agrees with a line node or proves their conflict', () => {
  for (const [version, verdict] of [['10.9.1', 'support'], ['10.8.1', 'refute']] as const) {
    const result = locateItem({ ...context, ancestors: ['Rel_NSAE_10_9_1_37 回归', `060：${version}`] });
    assert.equal(result.judgment.verdict, verdict); assert.equal(result.answer.version, '10.9.1');
  }
});
test('foreign builds and builds below the version level remain references', () => {
  const foreign = locateItem({ ...context, ancestors: ['Rel_OTHER_10_9_1_37 回归'] });
  assert.equal(foreign.judgment.verdict, 'unknown'); assert.equal(foreign.answer.version, null);
  const below = locateItem({ ...context, ancestors: ['060：10.8.1', 'Rel_NSAE_10_9_1_37 回归'] });
  assert.equal(below.judgment.verdict, 'support'); assert.equal(below.answer.version, '10.8.1');
  assert.deepEqual(below.answer.build_names, ['Rel_NSAE_10_9_1_37']);
});
