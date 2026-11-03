// Real SHA verification is shared only for the exact raw envelope inside one request.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import crypto from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import {verifiedRecord} from './store.ts';
import {envelopeDigest} from './digest.ts';
import {withReadScope,scopedRecordStore,IntegrityError,type Transaction,type RecordStore} from './api.ts';
test('record verification hashes identical raw envelopes once and rechecks changed bytes, transactions, writes and later requests',async()=>{
 const meta={kind:'action',schema:'synthetic-integrity@1',provenance:'declared',created_at:'2026-11-03T04:00:00.000Z'},body=JSON.stringify({nested:{n:1}}),row={...meta,id:'rcd_'+'0'.repeat(26),body,digest:envelopeDigest(meta,body)};
 const original=crypto.createHash;let hashes=0;
 crypto.createHash=((...args:Parameters<typeof original>)=>{hashes++;return original(...args);}) as typeof original;syncBuiltinESMExports();
 try{
  await withReadScope(async()=>{
   const first=verifiedRecord<any>({...row}),second=verifiedRecord<any>({...row});assert.equal(first,second);assert.equal(hashes,1);
   assert.throws(()=>{first.body.nested.n=9;},TypeError);assert.equal(second.body.nested.n,1);
   assert.throws(()=>verifiedRecord({...row,body:JSON.stringify({nested:{n:9}})}),IntegrityError);assert.equal(verifiedRecord({...row}),first,'a failed raw row never poisons the healthy record');
   const before=hashes,tx={} as Transaction;const a=verifiedRecord<any>({...row},tx),b=verifiedRecord({...row},tx);assert.equal(hashes,before+2);assert.notEqual(a,b);a.body.nested.n=7;assert.equal(first.body.nested.n,1);
   const store=scopedRecordStore({put:async()=>({})} as unknown as RecordStore);await store.put({kind:'action',schema:'synthetic-clear@1',provenance:'declared',body:{}});
   const previous=hashes;assert.notEqual(verifiedRecord({...row}),first);assert.equal(hashes,previous+1);
  });
  const previous=hashes;await withReadScope(async()=>verifiedRecord({...row}));assert.equal(hashes,previous+1);
 }finally{crypto.createHash=original;syncBuiltinESMExports();}
});
