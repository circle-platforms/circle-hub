import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { packIdAbsenceError } from './tools.ts';
import { toolText } from './text.ts';
import { absentPackRefusal, uninstalledPackRefusal, withdrawnPackRefusal } from './pack-words.ts';
import { ListTaskPacksOutput } from '../../contracts/src/tools.ts';

const TRACE = 'a'.repeat(32);

describe('list_task_packs exact pack_id absence errors', () => {
  test('unassigned matches start_run SOURCE_NOT_PERMITTED', () => {
    assert.deepEqual(packIdAbsenceError('local-review', 'unassigned'), {
      code: 'SOURCE_NOT_PERMITTED',
      message: '当前账户未获授权使用工作流「local-review」',
      fix: '请联系管理员为该账户或所在团队分配此工作流。当前账户可用的工作流和技能用 list_task_packs 查看',
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
      '无权限：当前账户未获授权使用工作流「local-review」。请联系管理员为该账户或所在团队分配此工作流。当前账户可用的工作流和技能用 list_task_packs 查看。',
    );
  });

  test('unknown matches absent 工作流或技能 wording', () => {
    assert.deepEqual(packIdAbsenceError('not-a-pack', 'unknown'), {
      code: 'SOURCE_ABSENT',
      message: 'Hub 里没有名为「not-a-pack」的工作流或技能',
      fix: '请核对名称；当前账户可用的工作流和技能用 list_task_packs 查看',
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
    assert.equal(text, '不存在：Hub 里没有名为「not-a-pack」的工作流或技能。请核对名称；当前账户可用的工作流和技能用 list_task_packs 查看。');
  });

  test('withdrawn and uninstalled stay SOURCE_ABSENT', () => {
    assert.equal(packIdAbsenceError('x', 'withdrawn').code, 'SOURCE_ABSENT');
    assert.match(packIdAbsenceError('x', 'withdrawn').message, /已退役/);
    assert.doesNotMatch(packIdAbsenceError('x', 'withdrawn').message, /任务包|你/);
    assert.equal(packIdAbsenceError('skill-a', 'uninstalled').code, 'SOURCE_ABSENT');
    assert.match(packIdAbsenceError('skill-a', 'uninstalled').message, /没有安装技能/);
    assert.doesNotMatch(packIdAbsenceError('skill-a', 'uninstalled').message, /任务包|你/);
    // Every next step says where the usable ones are listed, as start_run does; a retired version has no name to check.
    assert.equal(packIdAbsenceError('x', 'withdrawn').fix, '当前账户可用的工作流和技能用 list_task_packs 查看');
    assert.equal(packIdAbsenceError('skill-a', 'uninstalled').fix, '请联系管理员安装此技能；当前账户可用的工作流和技能用 list_task_packs 查看');
  });

  test('each absence reads the same here as in the answer of the local-tools download', () => {
    for (const [absence, refusal] of [['unknown', absentPackRefusal], ['withdrawn', withdrawnPackRefusal], ['uninstalled', uninstalledPackRefusal]] as const) {
      const text = toolText('list_task_packs', ListTaskPacksOutput.parse({ call_result: 'error', errors: [packIdAbsenceError('skill-a', absence)], packs: [], trace: TRACE }));
      assert.equal(text, refusal('skill-a'), absence);
    }
  });

  test('skill kind uses 技能 in the unassigned fact', () => {
    const error = packIdAbsenceError('toy-skill', 'unassigned', 'skill');
    assert.equal(error.message, '当前账户未获授权使用技能「toy-skill」');
    assert.match(error.fix!, /分配此技能/);
  });
});
