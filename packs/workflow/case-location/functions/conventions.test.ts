import assert from 'node:assert/strict';
import { test } from 'node:test';
import { locateItem } from './locate.ts';

const context = { case_id: 'synthetic-case', root: 'FAMY', names: ['FAMX', 'FAMY'], product: 'famx', title: '合成文档' };
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

for (const [name, version] of [['Rel_FAMY_10_9_1_37', '10.9.1'], ['Beta_FAMX_10_8_42', '10.8']] as const) {
  test(`a bound build name supplies its folder version: ${name}`, () => {
    const result = locateItem({ ...context, ancestors: [`${name} 回归`] });
    // The build-name grammar supplies the version, but the train and module layers are unread: R6 keeps the answer
    // unknown and names the missing layer identities instead of letting it into the located group.
    assert.equal(result.judgment.verdict, 'unknown'); assert.equal(result.answer.confidence, 'high');
    assert.equal(result.answer.version, version); assert.equal(result.answer.line, version);
    assert.deepEqual(result.answer.build_names, [name]);
    assert.deepEqual(result.answer.missing, ['famx-directory@1 的发布火车层身份', 'famx-directory@1 的模块层身份']);
    assert.match(result.answer.notes.join('；'), /版本取自目录名里的构建名/);
    assert.match(result.judgment.statement, /下一步由包作者补目录语法或作者调整目录层级后重产/);
  });
}
test('a folder build name agrees with a line node or proves their conflict', () => {
  // An agreeing line node is not a located answer while the train and module layers are unread; a contradicting one is
  // still a deterministic refutation, which outranks the missing layers.
  for (const [version, verdict] of [['10.9.1', 'unknown'], ['10.8.1', 'refute']] as const) {
    const result = locateItem({ ...context, ancestors: ['Rel_FAMY_10_9_1_37 回归', `060：${version}`] });
    assert.equal(result.judgment.verdict, verdict); assert.equal(result.answer.version, '10.9.1');
  }
});
test('foreign builds and builds below the version level remain references', () => {
  const foreign = locateItem({ ...context, ancestors: ['Rel_OTHER_10_9_1_37 回归'] });
  assert.equal(foreign.judgment.verdict, 'unknown'); assert.equal(foreign.answer.version, null);
  const below = locateItem({ ...context, ancestors: ['060：10.8.1', 'Rel_FAMY_10_9_1_37 回归'] });
  // Below the version level a build name stays a reference: the line node gives the version, and the unread layers keep
  // the answer unknown.
  assert.equal(below.judgment.verdict, 'unknown'); assert.equal(below.answer.version, '10.8.1');
  assert.deepEqual(below.answer.build_names, ['Rel_FAMY_10_9_1_37']);
  assert.deepEqual(below.answer.missing, ['famx-directory@1 的发布火车层身份', 'famx-directory@1 的模块层身份']);
});

for (const label of ['802.1Q VLAN', 'FAMY_10.9.1.37_专项']) test(`a version mention names the missing fact and corrective action: ${label}`, () => {
  const { answer, judgment } = locateItem({ ...context, ancestors: [label] });
  assert.equal(judgment.verdict, 'unknown');
  // Nothing is read out of a label that is not wholly a version, so the version layer is missing too, and every unread
  // layer is named with the author's exit.
  assert.deepEqual((answer as unknown as { missing: unknown }).missing, ['目录里的版本层', 'famx-directory@1 的发布火车层身份', 'famx-directory@1 的模块层身份']);
  assert.match(judgment.statement, /缺少.*目录里的版本层/);
  assert.match(judgment.statement, /下一步.*整理.*目录.*参数 line/);
  assert.match(judgment.statement, /下一步由包作者补目录语法或作者调整目录层级后重产/);
});

test('identifiers come from whole declared fields, and a padded number is outside the grammar', () => {
  // famx-id-fields@1: the field is the whole text, its numbers are non-zero-leading decimals, and the display text is the
  // declared spelling. The retired rule normalized a padded number found in prose and kept the padding for display.
  const padded = locateItem({ ...context, ancestors: ['060：10.6.1'], title: 'bug 001234 合成标题' });
  assert.deepEqual(padded.answer.defects, []);
  assert.deepEqual(padded.answer.id_sources, []);
  const declared = locateItem({ ...context, ancestors: ['060：10.6.1'], title: 'bug:1234' });
  assert.deepEqual(declared.answer.defects, ['1234']);
  // No normalization means no separate display spelling: the declared field is the identity and the text shown.
  assert.deepEqual(declared.answer.id_sources, [{ id: '1234', kind: 'bug', from: ['title'] }]);
  assert.match(declared.judgment.statement, /缺陷 1234/);
  const paddedField = locateItem({ ...context, ancestors: ['060：10.6.1'], title: 'bug:001234' });
  assert.deepEqual(paddedField.answer.defects, [], 'a padded number is not a declared identifier');
});

test('a root that is not a product name names what is missing and the next action', () => {
  const { answer, judgment } = locateItem({ ...context, root: '合成平台', ancestors: ['060：10.6.1'] });
  assert.equal(judgment.verdict, 'unknown');
  assert.ok(answer.missing.includes('作为产品线名称的根目录'));
  assert.match(judgment.statement, /下一步把文档放到产品的根目录下/);
});

test('an unbound run names the missing product binding and the next action', () => {
  const { answer, judgment } = locateItem({ ...context, names: [], product: null, ancestors: ['060：10.6.1'] });
  assert.equal(judgment.verdict, 'unknown');
  assert.ok(answer.missing.includes('运行绑定的产品线'));
  assert.match(judgment.statement, /下一步开始这次运行时绑定这条产品线/);
});

test('a declared line with no version level is not answered by declaring line again', () => {
  const { answer, judgment } = locateItem({ ...context, ancestors: ['通用用例', '基础功能'], declared: { line: '10.9.1' } });
  assert.equal(judgment.verdict, 'unknown');
  assert.ok(answer.missing.includes('目录里的版本层'));
  assert.match(judgment.statement, /下一步/);
  assert.equal(judgment.statement.includes('用参数 line 声明'), false);
  assert.match(judgment.statement, /整理敏捷平台目录/);
});

test('a version conflict keeps a declared product that contradicts the root', () => {
  const { answer, judgment } = locateItem({ ...context, ancestors: ['060：10.6.1', '061：10.7.1'], declared: { product: 'OTHERPRODUCT' } });
  assert.equal(judgment.verdict, 'refute');
  assert.equal('code' in judgment && judgment.code, 'case-location.version_conflict');
  assert.equal(answer.conflicts.some(conflict => conflict.field === 'product' && conflict.declared === 'OTHERPRODUCT' && conflict.tree === 'FAMY'), true);
  assert.match(judgment.statement, /OTHERPRODUCT/);
  assert.match(judgment.statement, /目录树的根“FAMY”/);
  assert.match(judgment.brief, /OTHERPRODUCT/);
});

test('a build folder of 10.7.0 does not agree with a declared line 10.7.1', () => {
  const { answer, judgment } = locateItem({ ...context, ancestors: ['Rel_FAMX_10_7_0_12 回归'], declared: { line: '10.7.1' } });
  assert.equal(answer.line, '10.7.0');
  assert.equal(judgment.verdict, 'refute');
  assert.equal(answer.conflicts.some(conflict => conflict.field === 'line' && conflict.declared === '10.7.1' && conflict.tree === '10.7.0'), true);
});

test('a declaration matching a conflicting value remains visible even when the note list is full', () => {
  const ancestors = [...Array.from({ length: 20 }, (_, index) => `build20261399 合成目录${index}`), '060：10.6.1', '061：10.7.1'];
  const result = locateItem({ ...context, ancestors, declared: { line: '10.6.1' } });
  assert.match(result.judgment.statement, /调用方声明的版本线 10\.6\.1 与 10\.6\.1 一致/);
});
