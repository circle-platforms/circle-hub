// Exact pack_id empty list → SOURCE_ABSENT / SOURCE_NOT_PERMITTED (brief D4 A). Text rendering is D1.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { packIdAbsenceError } from './tools.ts';
import { toolText } from './text.ts';
import { ListTaskPacksOutput } from '../../contracts/src/tools.ts';

const TRACE = 'a'.repeat(32);

describe('list_task_packs exact pack_id absence errors', () => {
  test('unassigned matches start_run SOURCE_NOT_PERMITTED', () => {
    assert.deepEqual(packIdAbsenceError('local-review', 'unassigned'), {
      code: 'SOURCE_NOT_PERMITTED',
      message: '当前账户未获授权使用工作流「local-review」',
      fix: '请联系管理员为该账户或所在团队分配此工作流',
      path: '/pack_id',
    });
    const text = toolText(
      'list_task_packs',
      ListTaskPacksOutput.parse({
        call_result: 'error',
        errors: [packIdAbsenceError('local-review', 'unassigned')],
        packs: [],
        trace: TRACE,
      }),
    );
    assert.equal(
      text,
      '无权限：当前账户未获授权使用工作流「local-review」。请联系管理员为该账户或所在团队分配此工作流；当前账户可用的工作流和技能用 list_task_packs 查看。',
    );
  });

  test('unknown matches absent 工作流或技能 wording', () => {
    assert.deepEqual(packIdAbsenceError('not-a-pack', 'unknown'), {
      code: 'SOURCE_ABSENT',
      message: 'Hub 里没有名为「not-a-pack」的工作流或技能',
      fix: '请核对名称',
      path: '/pack_id',
    });
    const text = toolText(
      'list_task_packs',
      ListTaskPacksOutput.parse({
        call_result: 'error',
        errors: [packIdAbsenceError('not-a-pack', 'unknown')],
        packs: [],
        trace: TRACE,
      }),
    );
    assert.equal(text, '不存在：Hub 里没有名为「not-a-pack」的工作流或技能。请核对名称。');
  });

  test('withdrawn and uninstalled stay SOURCE_ABSENT', () => {
    assert.equal(packIdAbsenceError('x', 'withdrawn').code, 'SOURCE_ABSENT');
    assert.match(packIdAbsenceError('x', 'withdrawn').message, /已退役/);
    assert.doesNotMatch(packIdAbsenceError('x', 'withdrawn').message, /任务包|你/);
    assert.equal(packIdAbsenceError('skill-a', 'uninstalled').code, 'SOURCE_ABSENT');
    assert.match(packIdAbsenceError('skill-a', 'uninstalled').message, /没有安装技能/);
    assert.doesNotMatch(packIdAbsenceError('skill-a', 'uninstalled').message, /任务包|你/);
  });

  test('skill kind uses 技能 in the unassigned fact', () => {
    const error = packIdAbsenceError('toy-skill', 'unassigned', 'skill');
    assert.equal(error.message, '当前账户未获授权使用技能「toy-skill」');
    assert.match(error.fix!, /分配此技能/);
  });
});
