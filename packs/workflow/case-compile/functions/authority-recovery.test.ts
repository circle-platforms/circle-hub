import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorityRecovery, humanGapLocation } from './typed-authority.ts';
test('authority recovery describes declared pointer structure and retains raw machine evidence',()=>{
  const gaps=[{document:'blocks',pointer:'/blocks/1/call/args/0/command_parameters/2',message:'合成缺口',verdict:'unknown' as const}];
  const original=JSON.stringify(gaps), output=authorityRecovery(gaps);
  assert.ok(output.includes('第 2 块调用步骤第 1 个参数的第 3 个命令参数'));
  assert.ok(output.includes('合成缺口'));assert.ok(output.includes('重新生成该构建的手册和命令树'));
  assert.ok(!output.includes('blocks/blocks/'));assert.ok(!output.includes('重新育苗'));
  assert.equal(JSON.stringify(gaps),original);
});
test('malformed or unknown pointer shapes never invent an ordinal',()=>{
  for(const path of ['/blocks/01/call','/blocks/-1/call','/blocks/9007199254740991/call','/blocks//call','/other/1']) {
    assert.doesNotMatch(humanGapLocation('blocks',path),/第 \d+/);
  }
});
