import assert from 'node:assert/strict';
import {test} from 'node:test';
import {checkDraftShape,checkCommandsRefutation} from './checks.ts';
const draft=(resource:unknown)=>({title:'合成起草',priority:2,negative:true,expects_refutation:true,resource,tags:['Functional'],steps:[{command:'widget set 9'}],expected:[{text:'原文字段不变',quote:{reference:'src:'+'a'.repeat(64)+'/markdown@1/p',text:'原文字段不变'}}]});
test('undeclared resource is advisory even if the legacy tags field looks valid',()=>{
 const out=checkDraftShape({subject:{slots:{cases:[{data:draft(['Negative'])}]}}});assert.ok(out.some(o=>o.verdict==='refute'&&o.tier==='advisory'&&o.statement.includes('未声明的标签')));
});
test('an invalid resource cannot authorize the negative out-of-range exception through a self-reported boolean',()=>{
 const catalog=[{words:['widget','set'],reference:'tree:'+'b'.repeat(64)+'/commands/widget/set',signatures:[{id:'one',params:[{name:'n',type:'int',minimum:1,maximum:5}]}]}];
 const out=checkCommandsRefutation({subject:{slots:{cases:[{data:draft(['negative case'])}]}},catalog});assert.ok(!out.some(o=>o.verdict==='support'));assert.ok(out.some(o=>o.verdict==='refute'&&o.code==='defect-to-case.shape_invalid'));
});
