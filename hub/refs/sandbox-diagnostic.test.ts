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

test('unsafe declaration details and arbitrary exception text never enter diagnostics', () => {
  const error=new SandboxError('FUNCTION_THREW',{message:'synthetic private content'}, {stdout:'synthetic output'},'synthetic exception');
  withParserSite(error,{...site,module:'/synthetic/private/location'});
  const result=sandboxReadDiagnostic(error);
  assert.equal(result.admin,'技能包函数失败：FUNCTION_THREW');
  assert.ok(!JSON.stringify(result).includes('synthetic private'));
  assert.ok(!JSON.stringify(result).includes('/synthetic/private'));
});
