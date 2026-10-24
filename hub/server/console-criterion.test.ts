import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runRecord,accepted} from '../../contracts/src/fixtures.ts';
import type {ServerDeps} from './api.ts';
import {runPage,type PageContext} from './console/pages.ts';
test('run pages show escaped criterion changes request decisions and replacement history',async()=>{
 const run=structuredClone(runRecord),result=structuredClone(accepted) as unknown as import('../../contracts/src/validation.ts').ValidationResult;
 const declaration={item:run.items[0].id,criterion:'src:'+'a'.repeat(64),assertion:'合成声明',old:'合成旧判据',new:'<新判据>',grounds:[{reference:'src:'+'a'.repeat(64),quote:'引文'}],request:'rec:'+'b'.repeat(64),declaration:'rec:'+'c'.repeat(64)+'#/criterion_changes/0',audience:run.runner,due:'2026-10-25T08:00:00.000Z',answered:true,expired:false,accepted:false,reviewer:run.runner,reason:'合成不接受理由',next_action:'补依据后重交声明'};
 const replacement={criterion:declaration.criterion,old:declaration.old,new:declaration.new,declaration:declaration.declaration,review:'rec:'+'d'.repeat(64),reviewer:run.runner};Object.values(result.partitions).flat()[0].replaced_criteria=[replacement];
 const deps={runs:{getRun:async()=>({run:{...run,criterion_changes:[declaration]},latest:{record:'e'.repeat(64),result},production:{record:'e'.repeat(64),result},submissions:[]})},records:{callLog:{query:async()=>({items:[],next:null})}}} as unknown as ServerDeps;
 const context:PageContext={deps,principal:{id:run.runner,name:'合成读者',role:'user'},admin:false,url:new URL('http://127.0.0.1/console/runs/'+run.run),userName:async id=>id??'—',chrome:title=>({title,user:{name:'合成读者',role:'用户',admin:false},csrf:null})};
 const response=await runPage(context,run.run),body=String(response.body);assert.equal(response.status,200);for(const text of ['判据变更声明','被取代的判据',declaration.request,declaration.declaration,declaration.reason,declaration.next_action,declaration.due,'合成旧判据','&lt;新判据&gt;',replacement.review])assert.ok(body.includes(text),text);assert.ok(!body.includes('<新判据>'));
});
