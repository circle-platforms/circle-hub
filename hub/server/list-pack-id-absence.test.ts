// Exact pack_id empty list → SOURCE_ABSENT / SOURCE_NOT_PERMITTED (brief D4 A). Text rendering is D1.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { packIdAbsenceError } from './tools.ts';

describe('list_task_packs exact pack_id absence errors', () => {
  test('unassigned matches start_run SOURCE_NOT_PERMITTED', () => {
    assert.deepEqual(packIdAbsenceError('local-review', 'unassigned'), {
      code: 'SOURCE_NOT_PERMITTED',
      message: '无权限：当前账户未获授权使用工作流「local-review」',
      fix: '请联系管理员为该账户或所在团队分配此工作流',
      path: '/pack_id',
    });
    assert.equal(
      `${packIdAbsenceError('local-review', 'unassigned').message}。${packIdAbsenceError('local-review', 'unassigned').fix}。`,
      '无权限：当前账户未获授权使用工作流「local-review」。请联系管理员为该账户或所在团队分配此工作流。',
    );
  });

  test('unknown matches start_run SOURCE_ABSENT', () => {
    assert.deepEqual(packIdAbsenceError('not-a-pack', 'unknown'), {
      code: 'SOURCE_ABSENT',
      message: '不存在：Hub 里没有工作流「not-a-pack」',
      fix: '请核对名称',
      path: '/pack_id',
    });
    assert.equal(
      `${packIdAbsenceError('not-a-pack', 'unknown').message}。${packIdAbsenceError('not-a-pack', 'unknown').fix}。`,
      '不存在：Hub 里没有工作流「not-a-pack」。请核对名称。',
    );
  });

  test('withdrawn and uninstalled stay SOURCE_ABSENT', () => {
    assert.equal(packIdAbsenceError('x', 'withdrawn').code, 'SOURCE_ABSENT');
    assert.match(packIdAbsenceError('x', 'withdrawn').message, /^不存在：.*已退役/);
    assert.doesNotMatch(packIdAbsenceError('x', 'withdrawn').message, /任务包|你/);
    assert.equal(packIdAbsenceError('skill-a', 'uninstalled').code, 'SOURCE_ABSENT');
    assert.match(packIdAbsenceError('skill-a', 'uninstalled').message, /^不存在：.*没有安装技能/);
    assert.doesNotMatch(packIdAbsenceError('skill-a', 'uninstalled').message, /任务包|你/);
  });
});
