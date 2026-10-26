import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {kityminderParser} from '../../../../hub/refs/api.ts';
import {cases} from './cases.ts';

test('untagged cases explicitly record undeclared polarity and test type',()=>{
 const bytes=Buffer.from(JSON.stringify({root:{data:{text:'synthetic'},children:[
  {data:{text:'untagged',priority:2},children:[{data:{text:'expected result'}}]},
  {data:{text:'blank tags',resource:[' '],priority:2},children:[{data:{text:'expected result'}}]},
  {data:{text:'tagged',resource:['Functional'],priority:2},children:[{data:{text:'expected result'}}]},
 ]}}));
 const id='agile:mindmap:synthetic';
 const out=cases({build:{name:'Rel_FAMX_10_6_1_7',family:'FAMX',line:'10.6.1',base:'Rel_FAMX_10_6_1_7',platform:null,built_at:null,released_at:null,root:null,sources:{case_documents:[id]}},slots:{},lists:{documents:[{sha256:createHash('sha256').update(bytes).digest('hex'),media_type:'application/json',parser:'kityminder@1',model:kityminderParser.parse(bytes).model,external:id}]},params:{}});
 assert.equal(out.entries.length,3,JSON.stringify(out));
 for(const entry of out.entries){
  if(entry.data.title==='tagged'){assert.equal(entry.data.tags_note,undefined);continue;}
  assert.equal(entry.data.tags_note,'正负向和测试类型未声明');
  assert.equal(entry.data.negative,null);
  assert.match(entry.statement,/正负向和测试类型未声明/);
 }
});
