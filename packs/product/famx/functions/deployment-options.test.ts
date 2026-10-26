import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {ProductDeclaration} from '../../../../contracts/src/product.ts';
import {caseIndexOptions} from './cases-sync.ts';
import {parsePageName} from './naming.ts';
import {planSync} from './sync-plan.ts';
import {html} from '../testing/test-support.ts';

test('deployment conventions declare synthetic defaults and whole-value variable references',()=>{
 const p=ProductDeclaration.parse(JSON.parse(readFileSync(new URL('../product.json',import.meta.url),'utf8')));
 assert.equal(p.variables?.find(v=>v.name==='FAMX_MIN_LINE')?.default,null);
 assert.deepEqual(p.variables?.find(v=>v.name==='FAMX_MAINLINE_PAGE_WORDS')?.default,[]);
 assert.equal(p.sync?.options?.min_line,'${var:FAMX_MIN_LINE}');
 assert.equal(p.sync?.options?.mainline_page_words,'${var:FAMX_MAINLINE_PAGE_WORDS}');
});
test('an explicit null floor and omitted synthetic floor impose no lower line bound',()=>{
 assert.deepEqual(caseIndexOptions({case_index:true,min_line:null}),{on:true,minLine:null,notes:[]});
 assert.deepEqual(caseIndexOptions({}),{on:false,minLine:null,notes:[]});
 assert.deepEqual(caseIndexOptions({case_index:true,min_line:'10.6.2'}),{on:true,minLine:'10.6.2',notes:[]});
});
test('only supplied page words extend the mainline grammar and the sync plan uses them',()=>{
 const name='rel_famx_10_8_demoqualifier';
 assert.equal(parsePageName(name),null, 'an undeclared page suffix has no inferred customer classification');
 assert.equal(parsePageName(name,['demoqualifier'])?.kind,'mainline');
 const index=html(`<a href="${name}.html">Synthetic listing</a>`);
 assert.equal(planSync({index}).pages.length,0);
 assert.equal(planSync({index,options:{mainline_page_words:['demoqualifier']}}).pages.length,1);
});
