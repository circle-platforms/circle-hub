import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SandboxError } from '../rules/api.ts';
import { sandboxReadDiagnostic, withParserSite } from './sandbox-diagnostic.ts';

const site = {parser:'synthetic@1',pack:'synthetic-format@1.0.0',module:'functions/parse.ts',export:'locate',phase:'locate' as const};

test('an operation deadline does not claim that a child function timed out', () => {
  const result = sandboxReadDiagnostic(new SandboxError('SANDBOX_TIMEOUT',{limit:'operation'}));
  assert.match(result.message,/整次操作超过时限/);
  assert.match(result.message,/无法据此判断单个函数/);
  assert.match(result.admin,/整次文档操作时限/);
  assert.match(result.fix,/不要推定/);
});

test('a child timeout names its actual limit and safe declared parser identity', () => {
  for (const limit of ['time','cpu'] as const) {
    const error = new SandboxError('SANDBOX_TIMEOUT',{limit,message:'synthetic private text'}, {stdout:'synthetic private output'});
    withParserSite(error,site);
    const result = sandboxReadDiagnostic(error);
    assert.match(result.message,limit==='time'?/函数调用超过时间上限（含子进程启动）/:/函数调用超过 CPU/);
    assert.match(result.admin,/定位 synthetic@1，synthetic-format@1\.0\.0\/functions\/parse\.ts#locate/);
    assert.ok(!JSON.stringify(result).includes('synthetic private'));
  }
});

test('a document too large for its parse is answered with a smaller original, any other sandbox failure goes to the administrator', () => {
  assert.deepEqual(sandboxReadDiagnostic(new SandboxError('SANDBOX_OUTPUT_TOO_LARGE', { limit: 'document_cache_bytes' })), {
    message: '文档缓存估算超过预算：SANDBOX_OUTPUT_TOO_LARGE',
    fix: '请来源维护者拆分原件，或请解析器维护者缩小保留结构后重读',
    admin: '文档缓存预算：SANDBOX_OUTPUT_TOO_LARGE',
  });
  // The memory watchdog's own detail, as the sandbox gives it, and the output limit.
  for (const [error, message, admin] of [
    [new SandboxError('SANDBOX_VIOLATION', { limit: 'memory', residentBytes: 495_583_232, memoryMb: 256 }), '解析原件超过沙箱内存上限：SANDBOX_VIOLATION', '沙箱内存上限：SANDBOX_VIOLATION'],
    [new SandboxError('SANDBOX_OUTPUT_TOO_LARGE', { outputBytes: 67_108_865 }), '解析结果超过沙箱输出上限：SANDBOX_OUTPUT_TOO_LARGE', '沙箱输出上限：SANDBOX_OUTPUT_TOO_LARGE'],
  ] as const) {
    const answer = sandboxReadDiagnostic(error);
    assert.equal(answer.message, message);
    assert.match(answer.fix, /^原样重读仍会失败；请来源维护者拆分原件后重读/);
    assert.equal(answer.admin, admin);
  }
  for (const error of [new SandboxError('SANDBOX_VIOLATION', { reason: 'symbolic_link' }), new SandboxError('SANDBOX_TIMEOUT'), new SandboxError('FUNCTION_THREW')]) {
    assert.equal(sandboxReadDiagnostic(error).fix, '管理员核对技能包和沙箱状态，恢复后重新读取', error.code);
  }
});

test('unsafe declaration details and arbitrary exception text never enter diagnostics', () => {
  const error=new SandboxError('FUNCTION_THREW',{message:'synthetic private content'}, {stdout:'synthetic output'},'synthetic exception');
  withParserSite(error,{...site,module:'/synthetic/private/location'});
  const result=sandboxReadDiagnostic(error);
  assert.equal(result.admin,'技能包函数失败：FUNCTION_THREW');
  assert.ok(!JSON.stringify(result).includes('synthetic private'));
  assert.ok(!JSON.stringify(result).includes('/synthetic/private'));
});
