import {kityminderParser} from "../../../../hub/testing/parsers.ts";
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CategoryJudgmentSchema } from '../../../../contracts/generated/shared-interfaces.ts';
import { classify } from './classification.ts';
import TABLE from '../tables/template-v3.json' with { type: 'json' };
import { readTemplate } from './template.ts';
import { bind, sha256 } from '../testing/support.ts';
import { projectDocuments } from './project.ts';
const node=(id:string,text:string,children:unknown[]=[],category_ids?:string[])=>({data:{id,text,priority:id==='r'?1:2,...(id==='a'||id==='b'||id==='nested'?{resource:['Functional']}:{}),...(category_ids?{category_ids}:{})},children});
const km=()=>({root:node('r','共同原文',[node('a','没有审计日志测试 audit',[node('step','共同原文'),node('nested','嵌套例',[node('inner','共同原文')])]),node('b','其他用例',[node('other','共同原文')])])});
function setup(double=false){
  let raw=JSON.stringify(km());if(double)raw=JSON.stringify(raw);
  const bytes=new TextEncoder().encode(raw), source=bind(bytes,{external:'agile:mindmap:d'});const template=readTemplate(TABLE);assert.ok(typeof template!=='string');
  return{raw,source,template,texts:{[`src:${source.sha256}`]:raw}};
}
function claim(s:ReturnType<typeof setup>,selector='n/step',fieldId='step'){
  const encoded=JSON.stringify('共同原文').slice(1,-1); const start=s.raw.indexOf(encoded,s.raw.indexOf(`"id":"${fieldId}"`));
  assert.ok(start>=0);
  return {statement:'合成模型类别判断',data:{item:'d:a',category_id:'audit_log',quote:{identity:{source_sha256:s.source.sha256,parser:'kityminder@1',path:selector,span:{unit:'byte',offset:new TextEncoder().encode(s.raw.slice(0,start)).length,length:new TextEncoder().encode(encoded).length}},text:encoded},producer:{model_id:'synthetic-model',model_family_id:'synthetic-family'}}};
}
test('unclassified cases do not become absent document categories',()=>{
  const s=setup(),out=projectDocuments({inputs:[s.source],parameters:{},context:{groups:[]}});assert.ok(!('error'in out));
  assert.deepEqual(out.items[0].fields.missing,[]);assert.equal(out.items[0].fields.categories.find(c=>c.id==='audit_log')?.present,false);
  assert.ok(out.items[0].summary?.includes('未分类'));
});
test('an exact same-case claim stays a model judgment and empty claims leave cases unclassified',()=>{
  const s=setup(),c=claim(s);assert.ok(CategoryJudgmentSchema.safeParse(c.data).success);
  const result=classify(s.template,s.source,'d','marked',[c],s.texts);assert.deepEqual(result.errors,[]);assert.deepEqual(result.cases.find(c=>c.id==='d:a')?.categories,['audit_log']);
  assert.equal(result.cases.find(c=>c.id==='d:a')?.judgments[0].producer.model_family_id,'synthetic-family');
  assert.ok(classify(s.template,s.source,'d','marked',[],s.texts).unclassified.includes('d:a'));
});
test('sibling, ancestor, nested, nonexistent selectors and borrowed identical spans are rejected',()=>{
  const s=setup();
  for(const [selector,id] of [['n/other','other'],['n/r','r'],['n/inner','inner'],['n/missing','step'],['n/step','other']]){
    const result=classify(s.template,s.source,'d','marked',[claim(s,selector,id)],s.texts);assert.equal(result.errors.length,1,selector+id);assert.ok(result.unclassified.includes('d:a'));
  }
});
test('wrong source, parser, byte span, category, producer or missing quote never supplies classification',()=>{
 const s=setup();for(const mutate of [(c:any)=>{delete c.data.quote},(c:any)=>{c.data.category_id='Audit_log'},(c:any)=>{c.data.quote.identity.source_sha256='f'.repeat(64)},(c:any)=>{c.data.quote.identity.parser='text@1'},(c:any)=>{c.data.quote.identity.span.offset++},(c:any)=>{c.data.quote.text='共同 原文'},(c:any)=>{delete c.data.producer.model_family_id}]){
  const c=claim(s);mutate(c);const result=classify(s.template,s.source,'d','marked',[c],s.texts);assert.equal(result.errors.length,1);assert.ok(result.unclassified.includes('d:a'));
 }
});
test('unavailable or transformed whole-source text is an evidence gap, never accepted as original bytes',()=>{
 const s=setup(),c=claim(s);
 for(const texts of [{},{[`src:${s.source.sha256}`]:' '+s.raw}]){const result=classify(s.template,s.source,'d','marked',[c],texts);assert.ok(result.missing.length);assert.ok(result.unclassified.includes('d:a'));}
});
test('raw escaped JSON and double-encoded JSON are checked against their retained byte spans',()=>{
 for(const double of [false,true]){
  const object={root:node('r','根',[node('a','用例',[node('step','Exact Ａ  text')])])};let raw=JSON.stringify(object);if(double)raw=JSON.stringify(raw);
  const source=bind(new TextEncoder().encode(raw),{external:'agile:mindmap:d'}),template=readTemplate(TABLE);assert.ok(typeof template!=='string');
  const text='Exact Ａ  text',start=raw.indexOf(text), c={statement:'判断',data:{item:'d:a',category_id:'audit_log',quote:{identity:{source_sha256:source.sha256,parser:'kityminder@1',path:'n/step',span:{unit:'byte',offset:new TextEncoder().encode(raw.slice(0,start)).length,length:new TextEncoder().encode(text).length}},text},producer:{model_id:'synthetic',model_family_id:'synthetic'}}};
  assert.deepEqual(classify(template,source,'d','marked',[c],{[`src:${source.sha256}`]:raw}).errors,[]);
 }
});
