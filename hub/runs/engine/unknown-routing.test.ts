import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RequirementTemplate } from '../../../contracts/src/pack.ts';
import { applyRouting, routeOf, staticTerminal } from './terminals.ts';
const template:RequirementTemplate={key:'r',name:'r',description:'r',target:'item',required:true,done_rule:'bookkeeping',layers:['static'],accepted_producer:'fact',checks:['c'],error_handling:[{reason:'missing_input',action:'repair',max_rounds:2}]};
test('a cause row routes missing artifact facts and exhausts the actual shared repair budget',()=>{
  const outcome={check:'c',judges:'artifact_under_verification' as const,outcome:{verdict:'unknown' as const,reason:'missing_input' as const,missing:'条目 A 缺正文',statement:'没有正文',grounds:[],tier:'advisory' as const}};
  const raw=staticTerminal({producer:'fact',hasProducer:true,checks:1,outcomes:[outcome],handling:null,expectation:{outcome:'support',codes:[]}});
  assert.equal(routeOf(template.error_handling,undefined,'missing_input')?.action,'repair');
  assert.equal(applyRouting(raw,template,0,[outcome]).routed[0]?.roundsLeft,2);
  assert.equal(applyRouting(raw,template,2,[outcome]).reason,'repair_exhausted');
});

test('selector priority is exact code, then cause, then wildcard regardless of row order',()=>{
  const exact={code:'synthetic.code',action:'request'} as const;
  const cause={reason:'missing_input',action:'repair',max_rounds:2} as const;
  const wildcard={code:'*',action:'unknown'} as const;
  for(const rows of [[wildcard,cause,exact],[cause,exact,wildcard],[exact,wildcard,cause]]){
    assert.equal(routeOf(rows,'synthetic.code','missing_input'),exact);
    assert.equal(routeOf(rows,'different.code','missing_input'),cause);
    assert.equal(routeOf(rows,undefined,'missing_input'),cause);
    assert.equal(routeOf(rows,'different.code','check_error'),wildcard);
    assert.equal(routeOf(rows,undefined,'check_error'),wildcard,'a cause-only outcome still reaches wildcard fallback');
    assert.equal(routeOf(rows,'*','missing_input'),cause,'wildcard is not an exact-code selector');
  }
  assert.equal(routeOf([cause],undefined,'check_error'),undefined);
  assert.equal(routeOf([cause],undefined,undefined),undefined);
});

test('wildcard repair really routes a code-less unknown and exhausts its declared budget',()=>{
  const outcome={check:'c',judges:'artifact_under_verification' as const,outcome:{verdict:'unknown' as const,reason:'missing_input' as const,missing:'合成条目缺正文',statement:'没有正文',grounds:[],tier:'blocking' as const}};
  const raw=staticTerminal({producer:'fact',hasProducer:true,checks:1,outcomes:[outcome],handling:null,expectation:{outcome:'support',codes:[]}});
  const wildcard={...template,error_handling:[{code:'*',action:'repair' as const,max_rounds:2}]};
  const first=applyRouting(raw,wildcard,0,[outcome]);
  assert.equal(first.routed.length,1);assert.equal(first.routed[0].action,'repair');assert.equal(first.routed[0].roundsLeft,2);
  assert.equal(applyRouting(raw,wildcard,2,[outcome]).reason,'repair_exhausted');
});

test('a wildcard reject row never treats an unknown as a blocking refutation',()=>{
  const outcome={check:'c',judges:'artifact_under_verification' as const,outcome:{verdict:'unknown' as const,code:'synthetic.code',reason:'check_error' as const,missing:'合成检查没有结论',statement:'没有结论',grounds:[],tier:'blocking' as const}};
  const raw=staticTerminal({producer:'fact',hasProducer:true,checks:1,outcomes:[outcome],handling:null,expectation:{outcome:'support',codes:[]}});
  const routed=applyRouting(raw,{...template,error_handling:[{code:'*',action:'reject'}]},0,[outcome]);
  assert.deepEqual(routed.routed,[]);assert.equal(routed.terminal,'unchecked');
});

test('inapplicable exact and cause rows fall through to the next applicable selector',()=>{
  const outcome={check:'c',judges:'subject' as const,outcome:{verdict:'unknown' as const,code:'synthetic.code',reason:'missing_input' as const,missing:'合成对象缺正文',statement:'没有正文',grounds:[],tier:'advisory' as const}};
  const raw=staticTerminal({producer:'fact',hasProducer:true,checks:1,outcomes:[outcome],handling:null,expectation:{outcome:'support',codes:[]}});
  const exact={code:'synthetic.code',action:'repair',max_rounds:2} as const;
  const request={reason:'missing_input',action:'request'} as const;
  const wildcard={code:'*',action:'unknown'} as const;
  const routed=applyRouting(raw,{...template,error_handling:[wildcard,request,exact]},0,[outcome]);
  assert.equal(routed.routed.length,1);assert.equal(routed.routed[0].action,'request');
  const fallback=applyRouting(raw,{...template,error_handling:[wildcard,{...request,action:'repair',max_rounds:2},exact]},0,[outcome]);
  assert.equal(fallback.routed.length,1);assert.equal(fallback.routed[0].action,'unknown');
});
