import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {foldText,quoteMatches} from './quote.ts';
const vectors=JSON.parse(readFileSync(new URL('../testing/quote-vectors.json',import.meta.url),'utf8')).vectors as Array<{note:string;fragment:string;quote:string;match:boolean}>;
for(const v of vectors)test(`strict verbatim quotation vector: ${v.note}`,()=>assert.equal(quoteMatches(v.fragment,v.quote),v.match));
for(const wide of ['中','あ','한','Ａ','！','𠀀','😀','\u{18d80}'])test(`wide character keeps quotation whitespace contextual: ${wide}`,()=>{
 assert.equal(foldText(`x \t${wide}\n y`),`x${wide}y`);assert.equal(quoteMatches(`x${wide}y`,`x ${wide} y`),false);
});
test('quotation folding preserves Latin symbols ambiguous-width characters and normalization form',()=>{
 for(const narrow of ['A','0','+','α','·','ｱ'])assert.equal(foldText(`x \t${narrow}\n y`),`x ${narrow} y`);
 assert.equal(quoteMatches('caf\u00e9','cafe\u0301'),false);assert.equal(quoteMatches('x','\ud800'),false);assert.equal(foldText('set 10 0'),'set 10 0');
});
