import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {kityminderParser,htmlParser} from '../../../../hub/refs/api.ts';
import * as sync from './cases-sync.ts';
import {cases} from './cases.ts';
import {planBuilds} from './sync.ts';
export const caseListing={ok:true,parser:'json@1',model:{complete:true,roots:[{id:'root',title:'APV'}],documents:[
 {id:'81001',root:'root',ancestors:['APV','未定版本']},
 {id:'81002',root:'root',ancestors:['APV','10.7','10.7-main-2026/2']},
 {id:'81003',root:'root',ancestors:['APV','10.6','10.6-main-2026/1']},
 {id:'81004',root:'root',ancestors:['APV','10.8','10.8-main-2026/3']},
 {id:'invalid/id',root:'root',ancestors:['APV']},
 {id:'81005',root:'root',listed:false,ancestors:['APV']},
]}};
test('unlocated and uncovered documents join the product-wide scope while exclusions stay out',()=>{
 const tree=sync.caseTree({'agile:tree:roots':caseListing},sync.caseIndexOptions({case_index:true,min_line:'10.7'}));
 assert.equal(tree.status,'ready');if(tree.status!=='ready')return;
 const out=sync.unversionedCaseSources(tree,['10.7']);
 assert.deepEqual(out.ids,['agile:case:81001','agile:case:81004']);
 assert.equal(out.noLine,1);assert.equal(out.uncovered,1);assert.equal(out.excluded,2);
});
test('a sync without builds still lists readable no-line and unsupported-line case documents',()=>{
 const out=planBuilds({round:1,options:{case_index:true,min_line:null},read:{'agile:tree:roots':caseListing,'buildsite:listing:index':{ok:true,parser:'html@1',model:htmlParser.parse(Buffer.from('<html><body>Empty synthetic index</body></html>')).model}}} as any);
 assert.deepEqual(out.scope?.unversioned_case_documents,['agile:case:81001','agile:case:81002','agile:case:81003','agile:case:81004']);
 assert.match(out.note??'',/没有版本线 1.*没有覆盖构建 3.*仍未列出 1/);
});
test('an unread build index is not evidence that located documents have no covering build',()=>{
 const out=planBuilds({round:1,options:{case_index:true,min_line:null},read:{'agile:tree:roots':caseListing}} as any);
 assert.equal(out.scope,undefined);assert.match(out.note??'',/缺少完整构建索引.*下一步/);
});
test('product-wide sources retain all no-line identities beyond the three note examples',()=>{
 const model={...caseListing.model,documents:Array.from({length:7},(_,i)=>({id:String(82000+i),root:'root',ancestors:['APV','未定版本']}))};
 const tree=sync.caseTree({'agile:tree:roots':{...caseListing,model}},sync.caseIndexOptions({case_index:true,min_line:null}));
 assert.equal(tree.status,'ready');if(tree.status!=='ready')return;
 assert.equal(tree.counts.noLine.examples.length,3);assert.equal(sync.unversionedCaseSources(tree,[]).ids.length,7);
});
test('raw command phrases are opt-in and never create command placements without a tree',()=>{
 const model=kityminderParser.parse(Buffer.from(JSON.stringify({root:{data:{id:'root',text:'合成文档'},children:[{data:{id:'case',text:'验证 `demo pool  add`',resource:['Functional']}}]}}))).model;
 const input={slots:{folders:{parser:'json@1',model:caseListing.model}},lists:{documents:[{external:'agile:case:81001',parser:'kityminder@1',model,sha256:'a'.repeat(64)}]}};
 const old=cases(input);assert.equal(old.entries.length,1);assert.equal(Object.hasOwn(old.entries[0].data,'command_phrases'),false);
 assert.deepEqual(cases({...input,params:{command_phrases:false}}),old);
 assert.equal(createHash('sha256').update(JSON.stringify(old.entries)).digest('hex'),'43718f9baf9a2594486e9e5e37d9085f28930113a4f3524f8d9ec9f55ddcaf0f');
 const added=cases({...input,params:{command_phrases:true}});
 assert.equal(added.entries[0].path,null);assert.ok((added.entries[0].data.command_phrases as string[]).includes('demo pool  add'));
});
