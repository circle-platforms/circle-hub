import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderReport, summary, type Check } from './report.ts';

const checks: Check[] = [
  { area: '回归范围', name: '10.6.3→10.6.4 命令差', expected: '+14 -11 ~2', actual: '+14 -11 ~2', ok: true, evidence: ['root a', 'root b'] },
  { area: '回归范围', name: '10.6.4→10.7.0 命令差', expected: '+289 -82 ~42', actual: '+288 -82 ~42', ok: false, note: '少一条' },
  { area: '用例定位', name: '文档 90001', expected: '10.6.4 / 10.6.4-R2-2026/7 / SSL', actual: '10.6.4 / 10.6.4-R2-2026/7 / SSL', ok: true },
];

test('the summary counts by area and in total', () => {
  assert.deepEqual(summary(checks), { total: 3, passed: 2, failed: 1, byArea: { 回归范围: { passed: 1, failed: 1 }, 用例定位: { passed: 1, failed: 0 } } });
  assert.equal(summary([]).total, 0);
});

test('the report names every area, marks a disagreement and lists the limits', () => {
  const text = renderReport({ title: '验收报告', generatedAt: '2026-10-22T00:00:00Z', checks, limits: ['没有在设备上执行'] });
  assert.match(text, /^# 验收报告/);
  assert.match(text, /共 3 项核对，2 项相符，1 项不符/);
  assert.match(text, /## 回归范围（1 相符，1 不符）/);
  assert.match(text, /\*\*不符\*\*/);
  assert.match(text, /- 没有在设备上执行/);
  assert.ok(!text.includes('| | |'), 'no empty cells');
});

test('pipes and line breaks in a cell cannot break the table', () => {
  const text = renderReport({ title: 't', generatedAt: 'x', checks: [{ area: 'a', name: 'x|y', expected: 'l1\nl2', actual: 'z', ok: true }], limits: [] });
  assert.match(text, /x\\\|y/);
  assert.match(text, /l1 l2/);
});

test('renderReport appends extra sections at the end without affecting summary tally', () => {
  const text = renderReport({
    title: '验收报告',
    generatedAt: '2026-10-22T00:00:00Z',
    checks,
    limits: ['限制项'],
    sections: [
      {
        title: '人工抽查（不是场景核对）',
        lines: [
          '- 文档 900101：关联编号 17206 在缺陷系统里找到',
          '- 文档 900102：关联编号 70499 在缺陷系统里未找到',
        ],
      },
    ],
  });
  assert.match(text, /共 3 项核对，2 项相符，1 项不符/);
  assert.match(text, /## 这份报告证明不了的事\n\n- 限制项\n\n## 人工抽查（不是场景核对）\n\n- 文档 900101：关联编号 17206 在缺陷系统里找到\n- 文档 900102：关联编号 70499 在缺陷系统里未找到/);
});
