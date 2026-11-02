// Portable entity data must match the declared parser for every named reference, including legacy text prefixes.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseFragment} from 'parse5';
import {decodeHtmlEntity} from './html-entity.ts';
import {HTML_NAMED_REFERENCES} from './html-entities.generated.ts';

const expected=(value:string)=>{const node=parseFragment(value).childNodes[0];return node&&'value'in node?node.value:value;};
test('all generated named and legacy HTML references agree with the declared parser',()=>{
 assert.ok(Object.keys(HTML_NAMED_REFERENCES).length>2000);
 for(const value of [...Object.keys(HTML_NAMED_REFERENCES),'&unknown;','&notanything','&AMPtext','&equalsText'])assert.equal(decodeHtmlEntity(value),expected(value),value);
});
test('numeric HTML references retain replacement rules, leading zeros and valid Unicode boundaries',()=>{
 for(const point of [...Array.from({length:256},(_,i)=>i),0xd7ff,0xd800,0xdfff,0xe000,0xffff,0x10000,0x10ffff,0x110000])for(const value of ['&#'+point+';','&#x'+point.toString(16)+';'])assert.equal(decodeHtmlEntity(value),expected(value),value);
 for(const value of ['&#000000000000061;','&#x00000000000003d;','&#9999999999999999999999999;'])assert.equal(decodeHtmlEntity(value),expected(value),value);
});
