import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import TABLE from '../tables/template-v3.json' with { type: 'json' };
import POLICY from '../tables/template-v3-coverage.json' with { type: 'json' };
import { categoryFacts, MAX_EVIDENCE, readTemplate, TEMPLATE_SCHEMA } from './template.ts';
import type { DocumentCases } from './cases.ts';

describe('the descriptive category declaration', () => {
  it('keeps all 24 policy requirements separately from model-readable category metadata', () => {
    const t=readTemplate(TABLE);assert.ok(typeof t!=='string');
    assert.equal(t.categories.length,24);assert.deepEqual(t.categories.filter(c=>c.required).map(c=>c.id),POLICY.required.values);
    assert.ok(t.categories.every(c=>c.description.length>0));
  });
  it('rejects search programs, tag aliases, duplicate ids and malformed metadata', () => {
    const c=TABLE.categories[0];
    for(const bad of [null,[],{...TABLE,schema:'old@1'},{...TABLE,id:''},{...TABLE,origin:''},{...TABLE,extra:1},{...TABLE,categories:[]},
      ...['contains','prefixes','equals','tags','fields','required'].map(key=>({...TABLE,categories:[{...c,[key]:[]}]})),
      {...TABLE,categories:[c,c]},...['id','label','group','description'].map(key=>({...TABLE,categories:[{...c,[key]:''}]}))]){
      assert.equal(typeof readTemplate(bad),'string');
    }
    assert.equal(TABLE.schema,TEMPLATE_SCHEMA);
  });
  it('counts deduplicated case identities before capping display evidence and ignores every body field', () => {
    const t=readTemplate(TABLE);assert.ok(typeof t!=='string');
    const cases=Array.from({length:30},(_,i)=>({id:`d:${String(29-i).padStart(2,'0')}`,nodeId:null,visit:i,title:'audit no clear security',tags:['Functional'],steps:['删除'],expected:['数据库'],preconditions:['安全'],category_ids:['functional']}));
    const document:Pick<DocumentCases,'cases'|'nodes'>={cases,nodes:{texts:cases.map(c=>c.title),parents:new Int32Array(30).fill(-1)}};
    const facts=categoryFacts(t,document);assert.deepEqual(facts.filter(c=>c.present).map(c=>c.id),['functional']);
    assert.equal(facts[0].count,30);assert.equal(facts[0].evidence.length,MAX_EVIDENCE);assert.deepEqual(facts[0].evidence,cases.map(c=>c.id).sort().slice(0,MAX_EVIDENCE));
    assert.deepEqual(categoryFacts(t,{...document,cases:[...cases].reverse()}),facts);
    assert.equal(categoryFacts(t,document,{evidenceLimit:Infinity})[0].evidence.length,30);
  });
});
