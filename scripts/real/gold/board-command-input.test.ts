import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
const doc='synthetic-doc';
const oneCase={key:`${doc}:c1`,document:doc,node:'c1',comparable:true,paths:[],steps:[]};
function fixture(commands:unknown,empty=false){
 const dir=mkdtempSync(join(tmpdir(),'board-command-input-'));
 try{
  mkdirSync(join(dir,'maps'));
  writeFileSync(join(dir,'maps',`${doc}.json`),JSON.stringify({root:{data:{text:'合成文档'},children:empty?[]:[{data:{id:'c1',text:'合成用例',resource:['Functional']},children:[]}]}}));
  writeFileSync(join(dir,'tree.json'),JSON.stringify([{id:'line',label:'10.7',children:[{id:'train',label:'10.7-R1',children:[{id:'module',label:'合成模块',children:[{id:doc,label:'合成文档',children:[]}]}]}]}]));
  writeFileSync(join(dir,'docs.json'),JSON.stringify([doc]));writeFileSync(join(dir,'commands.json'),JSON.stringify(commands));
  const result=spawnSync(process.execPath,['scripts/real/gold/board.ts','--placement-only','--tree',join(dir,'tree.json'),'--cases-dir',join(dir,'maps'),'--docs',join(dir,'docs.json'),'--product','synthetic','--build','Synthetic_10_7','--case-commands',join(dir,'commands.json'),'--out',join(dir,'out.json')],{encoding:'utf8'});
  return {code:result.status,error:result.stderr,gold:result.status===0?JSON.parse(readFileSync(join(dir,'out.json'),'utf8')):null};
 }finally{rmSync(dir,{recursive:true,force:true});}
}
function commandGold(){return {schema:'case-commands-gold@1',tree_sha256:'a'.repeat(64),documents:[doc],document_cases:{[doc]:1},cases:[oneCase]};}
for(const mode of ['no-documents','wrong-count','missing-counts','orphan-count','malformed-path'])test(`command gold rejects ${mode} before counting`,()=>{
 const input:any=commandGold();
 if(mode==='no-documents')input.documents=[];
 if(mode==='wrong-count')input.document_cases[doc]=0;
 if(mode==='missing-counts')delete input.document_cases;
 if(mode==='orphan-count')input.document_cases.other=0;
 if(mode==='malformed-path')input.cases=[{...oneCase,paths:[{}]}];
 const result=fixture(input);assert.equal(result.code,1,result.error);assert.match(result.error,/case-commands.*重跑/);
 assert.ok(!result.error.includes(doc));
});
test('a covered zero-case document is observed zero rather than a missing export',()=>{
 const input={...commandGold(),document_cases:{[doc]:0},cases:[]};
 const result=fixture(input,true);assert.equal(result.code,0,result.error);
 assert.equal(result.gold.unplaced,0);assert.equal(result.gold.documents,undefined);
});
test('a complete nonempty command measurement is retained',()=>{
 const result=fixture(commandGold());assert.equal(result.code,0,result.error);assert.equal(result.gold.unplaced,1);
});
