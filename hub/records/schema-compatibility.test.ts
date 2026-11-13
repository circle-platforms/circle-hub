import assert from 'node:assert/strict';
import {test} from 'node:test';
import {compareRecordMigrations,currentRecordMigrations,unavailableRecordsSchema} from './schema-compatibility.ts';

test('compatibility is derived from the current migration receipts without hardcoded baseline values',()=>{
  const receipts=currentRecordMigrations();
  assert.ok(receipts.length>0);
  assert.equal(compareRecordMigrations(receipts).compatible,true);
  assert.equal(compareRecordMigrations(null).compatible,false);
  assert.equal(compareRecordMigrations([]).compatible,false);
  for(const field of ['version','name','sha256'] as const){
    const changed=receipts.map(row=>({...row}));
    if(field==='version')changed[0].version+=1;else changed[0][field]+='different';
    assert.equal(compareRecordMigrations(changed).compatible,false,field);
  }
  assert.equal(compareRecordMigrations([...receipts,{...receipts[0],version:receipts.at(-1)!.version+1}]).compatible,false);
});


test('an unavailable observation is unknown, never confirmed incompatible or eligible for rebuilding',()=>{
  const unknown=unavailableRecordsSchema();
  assert.equal(unknown.status,'unavailable');assert.equal(unknown.compatible,null);assert.equal(unknown.applied,null);
  assert.equal(compareRecordMigrations(null).status,'incompatible');
  assert.equal(compareRecordMigrations(currentRecordMigrations()).status,'compatible');
  assert.equal(unknown.status==='incompatible',false);
});
