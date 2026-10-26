import assert from 'node:assert/strict';
import {test} from 'node:test';
import {toCatalogSubject,toStructureSubjects} from './subject.ts';
import {tagSpelling} from './checks.ts';
const item=(resource:unknown)=>({id:'synthetic:case',location:'src:'+'a'.repeat(64)+'/kityminder@1/n/case',fields:{document:'synthetic',path:['原文不变'],title:'原文不变',resource,resourcePresent:true,tags:Array.isArray(resource)?resource:[],expected:['原文不变']}});
test('an invalid common spelling stays an advisory structural violation even when every case uses it',()=>{
 const subjects=toStructureSubjects([item(['Functional']),{...item(['Functional']),id:'synthetic:case2'}]);
 const outcomes=tagSpelling({subject:{subjects}});assert.equal(outcomes.length,2);
 assert.ok(outcomes.every(o=>o.verdict==='refute'&&o.tier==='advisory'&&o.statement.includes('未声明的标签')));
 assert.ok(outcomes.every(o=>!o.statement.includes('最常用')));
});
for(const resource of [['Negative'],['NEGATIVE'],['negative case'],['负向'],['functional','negative case'],[],['R2ADD']])test('catalog polarity is unresolved for '+JSON.stringify(resource),()=>assert.equal(toCatalogSubject(item(resource)).negative,null));
test('exact author text alone controls polarity with the case prose unchanged',()=>{
 assert.equal(toCatalogSubject(item(['negative'])).negative,true);assert.equal(toCatalogSubject(item(['functional'])).negative,false);
});
