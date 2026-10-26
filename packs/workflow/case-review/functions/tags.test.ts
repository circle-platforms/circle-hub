import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import normalize,{CANONICAL_TAGS,canonicalTags,isNegative,normalizeTag,normalizeTags,tagKey} from './tags.ts';
import {RESOURCE_TAG_TABLE,declareResourceTags} from './generated/vocabulary.ts';
const table=JSON.parse(readFileSync(new URL('../tables/resource-tags.json',import.meta.url),'utf8')) as {tags:Array<{id:string;text:string;test_type:boolean;negative:boolean}>};
const expected=(raw:unknown)=>table.tags.find(tag=>tag.text===raw&&tag.test_type)?.id??null;
test('every retained historical spelling is compared only to the published exact text',()=>{
    const cases: Array<[string, string]> = [
      ['Function', 'Functional'],
      ['function', 'Functional'],
      ['Functional', 'Functional'],
      ['[Function]', 'Functional'],
      ['[Functional]', 'Functional'],
      ['[Functional', 'Functional'],
      ['Functional]', 'Functional'],
      ['功能', 'Functional'],
      ['功能测试', 'Functional'],
      ['Configuration', 'Configuration'],
      ['configuration', 'Configuration'],
      ['[Configuration]', 'Configuration'],
      ['[configuration]', 'Configuration'],
      ['Configure', 'Configuration'],
      ['配置', 'Configuration'],
      ['Integration', 'Integration'],
      ['[Integration]', 'Integration'],
      ['集成', 'Integration'],
      ['Compatibility', 'Compatibility'],
      ['compatibility', 'Compatibility'],
      ['兼容性', 'Compatibility'],
      ['兼容', 'Compatibility'],
      ['Negative', 'Negative'],
      ['negative', 'Negative'],
      ['[Negative]', 'Negative'],
      ['负向', 'Negative'],
      ['负面测试', 'Negative'],
      ['Stress', 'Stress'],
      ['stress', 'Stress'],
      ['[Stress]', 'Stress'],
      ['压力', 'Stress'],
      ['压力测试', 'Stress'],
      ['Stress Test', 'Stress'],
      ['  Negative  ', 'Negative'],
      ['ＦＵＮＣＴＩＯＮＡＬ', 'Functional'],
      ['（配置）', 'Configuration'],
      ['【压力】', 'Stress'],
      ['Functional testing', 'Functional'],
      ['negative-case', 'Negative'],
    ];
  for(const [raw] of cases)assert.deepEqual(normalizeTag(raw),{canonical:expected(raw),raw},raw);
});
test('canonical ids and authored text are separate and the full resource closure is generated',()=>{
 assert.deepEqual(CANONICAL_TAGS,table.tags.filter(tag=>tag.test_type).map(tag=>tag.id));
 for(const tag of table.tags){assert.equal(normalizeTag(tag.text).canonical,tag.test_type?tag.id:null);assert.equal(tagKey(tag.text),tag.text);}
 for(const raw of ['20260301ADD','R2ADD','release-label']){assert.equal(normalizeTag(raw).canonical,null);const declaration=declareResourceTags([raw]);assert.equal(declaration.valid,true);assert.equal(declaration.status,'undeclared');assert.equal(declaration.negative,null);}
});
test('nontext values and huge unregistered values never obtain a type',()=>{
 for(const raw of [null,undefined,{},[],7,true])assert.equal(normalizeTag(raw).canonical,null);
 const huge='Functional'+'x'.repeat(1_000_000);assert.equal(normalizeTag(huge).canonical,null);assert.equal(normalizeTag('['.repeat(150)+'functional').canonical,null);
});
test('absence or any unregistered member cannot establish positive polarity',()=>{
 assert.equal(isNegative(['configuration','negative']),true);assert.equal(isNegative(['functional']),false);
 for(const raw of [[],['负向'],['Negative'],['functional','Negative'],['R2ADD']])assert.equal(isNegative(raw),null);
 assert.deepEqual(canonicalTags(['stress','functional','negative']),['functional','negative','stress']);assert.deepEqual(canonicalTags(['stress','Function']),[]);
});
test('the entry point reads resource only and preserves the original declaration and repair data',()=>{
 const good=normalizeTags({resource:['functional','negative','R2ADD']});assert.ok(!('error'in good));assert.deepEqual(good.canonical,['functional','negative']);assert.equal(good.negative,true);assert.deepEqual(good.declaration.raw,['functional','negative','R2ADD']);assert.deepEqual(good.declaration.table,RESOURCE_TAG_TABLE);
 const bad=normalizeTags({resource:['Functional']});assert.ok(!('error'in bad));assert.equal(bad.negative,null);assert.equal(bad.declaration.valid,false);assert.deepEqual(bad.declaration.issues[0].allowed,table.tags.map(tag=>tag.text));
 const legacy=normalizeTags({tags:['negative']});assert.ok(!('error'in legacy));assert.equal(legacy.declaration.present,false);assert.equal(legacy.negative,null);
 for(const value of [null,undefined,1,'x',[]])assert.ok('error'in normalizeTags(value));
 assert.deepEqual(normalize({resource:['functional']}),normalize({resource:['functional']}));
});
