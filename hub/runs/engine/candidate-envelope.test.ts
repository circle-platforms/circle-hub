import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidateEnvelope } from './candidate-envelope.ts';
import { receivedDigest } from './util.ts';

test('candidate content and malformed private values never enter a stored submission envelope',()=>{
  const marker='synthetic-private-candidate-body';
  for(const payload of [[{statement:marker}],{bad:marker},[marker,{bad:marker}]]){
    const raw={run:'synthetic',model:'scripted',items:[],candidates:payload};
    const envelope=candidateEnvelope(raw);
    assert.equal(JSON.stringify(envelope.stored).includes(marker),false);
    assert.deepEqual(envelope.payload,payload);
    assert.equal(envelope.summary?.count,Array.isArray(payload)?payload.length:0);
    assert.match(envelope.summary!.sha256,/^[a-f0-9]{64}$/);
    assert.equal(receivedDigest(envelope.ordinary).digest,receivedDigest({run:'synthetic',model:'scripted',items:[]}).digest);
  }
});
test('changing only candidates leaves the ordinary submission digest fixed but changes the batch summary',()=>{
  const base={run:'synthetic',model:'scripted',items:[]};
  const a=candidateEnvelope({...base,candidates:[{statement:'one'}]}),b=candidateEnvelope({...base,candidates:[{statement:'two'}]});
  assert.equal(receivedDigest(a.ordinary).digest,receivedDigest(b.ordinary).digest);
  assert.notEqual(a.summary?.sha256,b.summary?.sha256);
  assert.deepEqual(candidateEnvelope(base).stored,base);
});

test('the envelope snapshots private values and protects a document output put in the task channel',()=>{
  const candidate={statement:'before'};
  const env=candidateEnvelope({items:[],candidates:[candidate]});candidate.statement='after';
  assert.equal((env.payload as Array<{statement:string}>)[0].statement,'before');
  const wrong=candidateEnvelope({items:[],task_outputs:[{output:'doc',value:'private document payload'}]},new Set(['doc']));
  assert.equal(JSON.stringify(wrong.stored).includes('private document payload'),false);
  assert.equal(wrong.summary?.count,1);
});
