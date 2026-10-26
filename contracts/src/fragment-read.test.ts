import {unitFiles} from '../../tools/run-unit-tests.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { AXES } from '../generated/vocabulary.ts';

test('fragment grades and provenance implement integrator decision 36', () => {
  assert.deepEqual(AXES.fragment_read.values, [
    { code: 'bound', label: '已绑定可读' },
    { code: 'not_bound', label: '不是这次运行的输入' },
    { code: 'not_groundable', label: '这类记录不能作根据' },
    { code: 'entry_unaddressed', label: '知识条目单独引用了，没写树地址' },
    { code: 'malformed', label: '引用写法不对' },
    { code: 'no_fragment', label: '找不到片段' },
    { code: 'too_large', label: '超过大小上限' },
    { code: 'retain_only', label: '只保留、不可读' },
    { code: 'unavailable', label: '暂时读不到' },
    { code: 'integrity_unproven', label: '完整性未证明' },
  ]);
  const model = readFileSync(new URL('../model.json', import.meta.url), 'utf8');
  assert.match(model, /fragment_read[^\n]*决定 36/);
});

test('the fragment vocabulary pin is included by the unit test runner', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const pin = relative(root, fileURLToPath(import.meta.url));
  assert.ok(unitFiles('all').includes(pin));
  assert.ok(unitFiles('regular').includes(pin));
});
