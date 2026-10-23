import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {test} from 'node:test';
test('c3 7 contribution delivery uses core admission codes without the retired pack code table',()=>{
 const manifest=JSON.parse(readFileSync(new URL('../pack.json',import.meta.url),'utf8'));assert.ok(!manifest.files.some((v:{path:string})=>v.path==='tables/codes.json'));assert.equal(existsSync(new URL('../tables/codes.json',import.meta.url)),false);
});
