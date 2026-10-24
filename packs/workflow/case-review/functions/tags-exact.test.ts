import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CANONICAL_TAGS,normalizeTag} from './tags.ts';
for(const value of CANONICAL_TAGS){
 test('case-review: declared tag '+value+' matches only itself',()=>{const raw=value;assert.equal(normalizeTag(raw).canonical,value);});
 const caseVariant=value.toLowerCase()===value?value.toUpperCase():value.toLowerCase();
 const fullWidth=[...value].map(c=>String.fromCharCode(c.charCodeAt(0)+0xfee0)).join('');
 for(const raw of [caseVariant,fullWidth,' '+value,value+' ', '['+value,'['+value+']',value+' test',value+' case'])
  test('case-review: variant '+JSON.stringify(raw)+' cannot claim '+value,()=>assert.equal(normalizeTag(raw).canonical,null));
}
for(const raw of ['功能','配置','负向','异常','pressure','neg'])test('case-review: alias '+raw+' is not a declaration',()=>assert.equal(normalizeTag(raw).canonical,null));
