// Exact pack_id empty list → SOURCE_ABSENT / SOURCE_NOT_PERMITTED (brief D4 A). Text rendering is D1.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { packIdAbsenceError } from './tools.ts';

describe('list_task_packs exact pack_id absence errors', () => {
  test('unassigned matches start_run SOURCE_NOT_PERMITTED', () => {
    assert.deepEqual(packIdAbsenceError('local-review', 'unassigned'), {
      code: 'SOURCE_NOT_PERMITTED',
      message: '任务包 local-review 存在，没有分配给你',
      fix: '请管理员把它分配给你；用 list_task_packs 看你能用的任务包',
      path: '/pack_id',
    });
  });

  test('unknown matches start_run SOURCE_ABSENT', () => {
    assert.deepEqual(packIdAbsenceError('not-a-pack', 'unknown'), {
      code: 'SOURCE_ABSENT',
      message: 'Hub 里没有任务包 not-a-pack',
      fix: '核对任务包名；用 list_task_packs 看你能用的任务包',
      path: '/pack_id',
    });
  });

  test('withdrawn and uninstalled stay SOURCE_ABSENT', () => {
    assert.equal(packIdAbsenceError('x', 'withdrawn').code, 'SOURCE_ABSENT');
    assert.match(packIdAbsenceError('x', 'withdrawn').message, /已退役/);
    assert.equal(packIdAbsenceError('skill-a', 'uninstalled').code, 'SOURCE_ABSENT');
    assert.match(packIdAbsenceError('skill-a', 'uninstalled').message, /没有安装技能包/);
  });
});
