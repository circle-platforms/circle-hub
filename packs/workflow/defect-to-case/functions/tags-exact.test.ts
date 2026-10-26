import assert from 'node:assert/strict';
import {test} from 'node:test';
import {normalizeTag} from './checks.ts';
import {CANONICAL_CATEGORIES} from './types.ts';
for(const value of CANONICAL_CATEGORIES){
 test('defect-to-case: declared tag '+value+' matches only itself',()=>{const raw=value;assert.equal(normalizeTag(raw),value);});
 const caseVariant=value.toLowerCase()===value?value.toUpperCase():value.toLowerCase();
 const fullWidth=[...value].map(c=>String.fromCharCode(c.charCodeAt(0)+0xfee0)).join('');
 for(const raw of [caseVariant,fullWidth,' '+value,value+' ', '['+value,'['+value+']',value+' test',value+' case'])
  test('defect-to-case: variant '+JSON.stringify(raw)+' cannot claim '+value,()=>assert.equal(normalizeTag(raw),null));
}
for(const raw of ['功能','配置','负向','异常','pressure','neg'])test('defect-to-case: alias '+raw+' is not a declaration',()=>assert.equal(normalizeTag(raw),null));
