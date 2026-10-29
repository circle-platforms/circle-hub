import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReadReplies } from './read-replies.ts';

test('reply retention is scoped by user, exact arguments and trace, and expires',()=>{
  let now=0;const cache=new ReadReplies(()=>now,4096,1000),args={reference:'src:'+'a'.repeat(64)},trace='1'.repeat(32);
  const answer={call_result:'ok',errors:[],trace,content:{reference:args.reference,read_tier:'model_readable',readable:true,text:'合成原文'}};
  cache.retain('alice',args,trace,'2035-01-01T00:00:00Z',answer);
  assert.deepEqual(cache.get('alice',args,trace)?.answer,answer);assert.equal(cache.get('bob',args,trace),null);
  assert.equal(cache.get('alice',{...args,reference:'src:'+'b'.repeat(64)},trace),null);assert.equal(cache.get('alice',args,'2'.repeat(32)),null);
  now=1001;assert.equal(cache.get('alice',args,trace),null);
});
test('duplicate traces and oversized responses never select an arbitrary reply',()=>{
  const args={root:'a'.repeat(64)},trace='1'.repeat(32),cache=new ReadReplies(()=>0,512,1000);
  const answer={call_result:'ok',errors:[],trace,nodes:[],root:args.root};
  cache.retain('alice',args,trace,'2035-01-01T00:00:00Z',answer);cache.retain('alice',args,trace,'2035-01-01T00:00:01Z',answer);
  assert.equal(cache.get('alice',args,trace),null);
  cache.retain('alice',{root:'b'.repeat(64)},'2'.repeat(32),'2035-01-01T00:00:00Z',{...answer,large:'x'.repeat(1000)});
  assert.equal(cache.get('alice',{root:'b'.repeat(64)},'2'.repeat(32)),null);
});
