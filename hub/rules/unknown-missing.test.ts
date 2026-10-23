import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCheck } from './check.ts';
const declaration={id:'demo',function:{module:'demo.ts'},tier:'advisory' as const};
const bindings={packDir:'/synthetic',subject:{},context:{pack:'demo'}};
test('pack unknowns require top-level missing; data.missing cannot substitute it',async()=>{
  for(const output of [[{verdict:'unknown',reason:'missing_input',statement:'缺原件',grounds:[],tier:'advisory',data:{missing:'原件'}}],[{verdict:'unknown',reason:'missing_input',statement:'缺原件',grounds:[],tier:'advisory',missing:'原件正文'}]]){
    const result=await runCheck(declaration,{...bindings,functionRunner:async()=>({output,stdout:'',stderr:'',durationMs:0,truncated:false,osIsolation:false})});
    assert.ok(result[0].missing);
    assert.equal(result[0].reason,'missing' in output[0]?'missing_input':'check_error');
  }
});
test('Hub-side check failures include their missing fact without a pack exit',async()=>{
  const result=await runCheck({id:'demo'},bindings);
  assert.ok(result[0].missing?.includes('demo'));
});

test('the shared core unknown constructor records exactly the existing concrete detail',async()=>{
  const {unknown}=await import('./outcome.ts');
  const detail='合成条目 A 缺少运行输入 /original';
  assert.equal(unknown({tier:'advisory',grounds:[]},'missing_input',detail).missing,detail);
});
