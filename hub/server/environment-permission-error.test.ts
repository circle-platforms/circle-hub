import test from 'node:test';
import assert from 'node:assert/strict';
import { StartRunOutput } from '../../contracts/src/tools.ts';
import { callErrorCategory } from '../../contracts/generated/protocol.ts';
import { toolText } from './text.ts';

test('a failed environment permission check is an invocation error with the actual caller next action', () => {
  const fact='测试环境的权限核对现在不能进行，这次没有执行';
  assert.equal(callErrorCategory('ENVIRONMENT_PERMISSION_UNAVAILABLE'),'temporarily_unavailable');
  for(const role of ['user','admin'] as const){
    const fix=role==='admin'?'请联系维护人员恢复测试环境权限核对':'请联系管理员';
    const result=StartRunOutput.parse({call_result:'error',errors:[{code:'ENVIRONMENT_PERMISSION_UNAVAILABLE',message:fact,fix}],trace:'a'.repeat(32)});
    const text=toolText('start_run',result,{caller:{role}});
    assert.equal(text,`暂时不可用：${fact}。${fix}。`);
    assert.doesNotMatch(text,/资料尚未取得|状态未知|原因缺资料|决定者/);
  }
  assert.equal(callErrorCategory('SOURCE_UNAVAILABLE'),null,'missing source data retains its distinct unknown meaning');
});
