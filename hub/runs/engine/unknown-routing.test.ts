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
