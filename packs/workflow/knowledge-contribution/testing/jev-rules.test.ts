import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as reference from '../../../../hub/jev/api.ts';
import * as client from '../tools/jev/lib/api.ts';
import { parseResponseText } from '../tools/jev/lib/validate.ts';
const model = 'jev-scripted-10.6.0';
const request = { model, state: { passage: 'synthetic manual' }, questions: { q: { type: 'choice' as const, instructions: 'Classify `passage`', criteria: { a: 'first', none: 'none' } } } };
function accepted(fn: () => unknown) { try { return { ok: true, value: fn() }; } catch { return { ok: false }; } }
test('client request rules match the retained pure validator on shared good and bad samples', () => {
  for (const value of [request, null, {}, { ...request, state: 2 }, { ...request, questions: {} }, { ...request, questions: { q: { type: 'choice', instructions: 'x', criteria: { '12': 'numeric' } } } }, { ...request, questions: { q: { type: 'noul', instructions: 'x' } } }, { ...request, questions: { q: { type: 'score', instructions: 'x', criteria: ['low', 'high'] } } }]) assert.deepEqual(accepted(() => client.checkRequest(value, { pinnedModel: model, maxRequestBytes: 4096 })), accepted(() => reference.checkRequest(value, { pinnedModel: model, maxRequestBytes: 4096 })));
});
test('client response rules match the retained validator including distributions and pinned model', () => {
  const good = { model, answers: { q: { type: 'choice', choice: 'a', confidence: 0.9, probabilities: { a: 0.95, none: 0.05 } } }, usage: { input_tokens: 2, output_tokens: 2 } };
  for (const value of [good, { ...good, model: 'jev-scripted-10.6.1' }, { ...good, answers: {} }, { ...good, usage: {} }, { ...good, answers: { q: { ...good.answers.q, probabilities: { a: 0.9, none: 0.9 } } } }]) assert.deepEqual(accepted(() => client.checkResponse(request, value, { pinnedModel: model })), accepted(() => reference.checkResponse(request, value, { pinnedModel: model })));
  assert.throws(() => parseResponseText('{"model":"a","model":"b"}', { pinnedModel: model }));
});
test('reuse identity records token estimates and batch planning match the pure reference', () => {
  const input = { model, question: request.questions.q, stateDigest: reference.inputDigest(request.state) };
  assert.equal(client.reuseKey(input), reference.reuseKey(input)); assert.equal(client.estimateTokens('合成 manual 123'), reference.estimateTokens('合成 manual 123'));
  const items = [{ id: 'passage', piece: 'synthetic manual', question: request.questions.q }]; assert.deepEqual(client.planBatches(items), reference.planBatches(items));
});

test('ask planning splits sendable question groups by token budget and preserves their exact state',async()=>{
 const {questionWork}=await import('../tools/jev/lib/judge.ts');const question={type:'choice',instructions:'Classify `p`',criteria:Object.fromEntries(Array.from({length:60},(_,i)=>['option-'+i,'合成说明'.repeat(30)]))};const raw={schema:'jev-ask@1',questions:Object.fromEntries(Array.from({length:10},(_,i)=>['q'+i,question]))};const pieces=[{id:'p',reference:'synthetic-ref',kind:'definition',text:'synthetic manual',sha256:'a'.repeat(64),bytes:16}];const plan=questionWork(raw,pieces,model);assert.ok(plan.length>1);assert.equal(plan.reduce((n,b)=>n+Object.keys(b.questions).length,0),10);assert.ok(plan.every(b=>b.state.p==='synthetic manual'));
});
