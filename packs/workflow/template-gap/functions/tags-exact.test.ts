import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CANONICAL_TAGS,canonicalTag} from './tags.ts';
for(const value of CANONICAL_TAGS){
 test('template-gap: declared tag '+value+' matches only itself',()=>{const raw=value;assert.equal(canonicalTag(raw),value);});
 const caseVariant=value.toLowerCase()===value?value.toUpperCase():value.toLowerCase();
 const fullWidth=[...value].map(c=>String.fromCharCode(c.charCodeAt(0)+0xfee0)).join('');
 for(const raw of [caseVariant,fullWidth,' '+value,value+' ', '['+value,'['+value+']',value+' test',value+' case'])
  test('template-gap: variant '+JSON.stringify(raw)+' cannot claim '+value,()=>assert.equal(canonicalTag(raw),null));
}
for(const raw of ['功能','配置','负向','异常','pressure','neg'])test('template-gap: alias '+raw+' is not a declaration',()=>assert.equal(canonicalTag(raw),null));
