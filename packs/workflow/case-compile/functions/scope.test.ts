import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectCaseHeadingMarkers, escapeRegExp } from './scope.ts';

test('escapeRegExp and detectCaseHeadingMarkers extract case markers from scope section headings', () => {
  assert.equal(escapeRegExp('a.b+c[1]'), 'a\\.b\\+c\\[1\\]');
  assert.deepEqual(detectCaseHeadingMarkers('## 990000000000000101（合成意图）').sort(), ['990000000000000101']);
  assert.deepEqual(detectCaseHeadingMarkers('doc-1:c-4 / item_abc-1').sort(), ['doc-1:c-4', 'item_abc-1']);
  assert.deepEqual(detectCaseHeadingMarkers('case:orbit-01'), ['orbit-01']);
  assert.deepEqual(detectCaseHeadingMarkers('用例 102：配置检查'), ['102']);
});
