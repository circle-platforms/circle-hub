import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectedSources } from './expected.ts';

const input = (title: string, parameters: Record<string, unknown> = {}) => ({
  items: [{ id: 'SYN-CASE', fields: { kind: 'document', root: 'ORBIT', ancestors: ['060:10.8'], title, path: [] } }],
  context: { product: 'orbit', names: ['ORBIT', 'COMET'], parameters },
  parameters,
});

test('two candidate reads do not determine an undeclared identifier kind', () => {
  const unknown = expectedSources(input('33001'));
  assert.deepEqual(unknown.sources.map(source => source.external), ['plm:story:33001', 'plm:bug:33001']);
  assert.ok(unknown.warnings.some(warning => warning.message.includes('不能凭是否存在判断类型') && warning.message.includes('下一步')));
  assert.ok(unknown.warnings.every(warning => !warning.message.includes('存在的那一个决定种类')));
  assert.deepEqual(expectedSources(input('bug to case 33001')).sources, []);
  assert.deepEqual(expectedSources(input('bug:33001')).sources.map(source => source.external), ['plm:bug:33001']);
  assert.deepEqual(expectedSources(input('33001', { id_ranges: { story: { min: 30000, max: 39999 } } })).sources.map(source => source.external), ['plm:story:33001']);
});
