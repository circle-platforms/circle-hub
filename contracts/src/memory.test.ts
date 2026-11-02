import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MemoryQuery,MemoryWriteInput,isMemoryRecordKind} from './memory.ts';
const H='a'.repeat(64);
test('memory creates and optimistic edits are distinct and session reads pin eligible versions',()=>{
 assert.ok(MemoryWriteInput.safeParse({title:'合成',markdown:'正文',expected_version:null,client_key:'create'}).success);
 assert.ok(!MemoryWriteInput.safeParse({title:'合成',markdown:'正文',expected_version:H,client_key:'create'}).success);
 assert.ok(!MemoryWriteInput.safeParse({document:H,expected_version:null,markdown:'正文',client_key:'edit'}).success);
 assert.ok(!MemoryWriteInput.safeParse({title:'合成',markdown:'\ud800',expected_version:null,client_key:'create'}).success);
 assert.ok(!MemoryQuery.safeParse({scope:'shared',for_session:true}).success);
 assert.ok(!MemoryQuery.safeParse({document:H,for_session:true}).success);
 assert.ok(MemoryQuery.safeParse({document:H,version:H,for_session:true}).success);
 for(const kind of ['memory_document','memory_version','memory_grant','memory_share'])assert.ok(isMemoryRecordKind(kind));assert.ok(!isMemoryRecordKind('claim'));
});
