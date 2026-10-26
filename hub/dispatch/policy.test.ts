import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EFFECT_CLASS,ENVIRONMENT} from '../../contracts/generated/vocabulary.ts';
test('the core boundary policy covers every effect reversibility and environment cell',async()=>{
 const api=await import('./policy.ts').catch(()=>null);assert.ok(api?.boundaryPolicy,'core policy is not installed');
 const policy=await api.boundaryPolicy();
 for(const effect_class of EFFECT_CLASS)for(const reversible of [false,true])for(const environment of ENVIRONMENT){const expected=effect_class==='none'||effect_class==='read'||effect_class==='job'&&environment!=='production';assert.equal(api.policyAllows(policy.document,{effect_class,reversible,environment}),expected,JSON.stringify({effect_class,reversible,environment}));}
 assert.equal(policy.document.samples.length,30);for(const sample of policy.document.samples)assert.equal(api.policyAllows(policy.document,sample.input),sample.expected);
 assert.match(policy.version,/^[a-f0-9]{64}$/);
});
