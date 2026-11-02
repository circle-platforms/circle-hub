import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MemoryQuery,MemoryWriteInput,isMemoryRecordKind} from './memory.ts';
import {GetNodesInput,UploadFileInput,TOOLS} from './tools.ts';
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
test('memory modes keep the six tools and reject run, evidence and ordinary-upload payload mixtures',()=>{
 assert.equal(TOOLS.length,6);
 const memory={title:'合成',markdown:'正文',expected_version:null,client_key:'create'};
 assert.ok(UploadFileInput.safeParse({memory}).success);
 for(const extra of [{file_path:'YQ=='},{personal_entry:{}},{space:'personal'},{name:'source.txt'},{provenance_type:'declared'}])assert.equal(UploadFileInput.safeParse({memory,...extra}).success,false);
 assert.ok(GetNodesInput.safeParse({memory:{scope:'personal'}}).success);
 for(const extra of [{run:'run_'+'a'.repeat(26)},{reference:'rec:'+H},{search:'合成'},{pack:'synthetic'},{cursor:'outside'}])assert.equal(GetNodesInput.safeParse({memory:{scope:'personal'},...extra}).success,false);
 assert.equal(MemoryWriteInput.safeParse({...memory,path:'/'+'a'.repeat(2001)}).success,false);
});
