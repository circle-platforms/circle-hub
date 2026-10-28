import {createTestParserRegistry as createDefaultRegistry} from '../../../../hub/testing/parsers.ts';
// A real knowledge service over synthetic ports: deployment values are explicit even when equal to a sample default.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {after,before,test} from 'node:test';
import {ProductDeclaration} from '../../../../contracts/src/product.ts';
import {createKnowledge} from '../../../../hub/knowledge/api.ts';
import {FakeExternal,FakePacks} from '../../../../hub/knowledge/test-support.ts';

import {sha256Hex} from '../../../../hub/records/api.ts';
import {startPostgres,type TemporaryPostgres} from '../../../../hub/testing/postgres.ts';
import {openTestRecords} from '../../../../hub/testing/records.ts';
let postgres:TemporaryPostgres;
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
test('real sync refuses unset conventions before reading; only dry run uses synthetic defaults',async t=>{
 const records=await openTestRecords({postgres});t.after(()=>records.close());
 const admin=(await records.principals.bootstrapAdmin('合成管理员')).user;
 const raw=readFileSync(new URL('../product.json',import.meta.url),'utf8');
 const product={id:'famx',version:'1.0.0',digest:sha256Hex(raw),kind:'product' as const,directory:fileURLToPath(new URL('..',import.meta.url)),product:ProductDeclaration.parse(JSON.parse(raw))};
 const packs=new FakePacks();packs.add(product);
 const external=new FakeExternal(records);external.set('buildsite:listing:index',{bytes:'<html></html>',mediaType:'text/html'});
 const knowledge=createKnowledge({records,parsers:createDefaultRegistry(),packs,external,admin,sandbox:{requireOsIsolation:false}});
 const refused=await knowledge.syncProduct(product);assert.match(refused.error??'',/circle-hub var set FAMX_MIN_LINE/);assert.match(refused.error??'',/circle-hub var set FAMX_MAINLINE_PAGE_WORDS/);assert.equal(external.reads.length,0);
 const dry=await knowledge.syncProduct(product,{dryRun:true});assert.equal(dry.error,null);assert.ok(dry.variables?.every(v=>v.default));
 for(const declaration of product.product.variables??[])await records.variables.setVariable(admin,declaration.name,declaration.default,'合成部署设置');
 const real=await knowledge.syncProduct(product);assert.equal(real.error,null);assert.ok(real.variables?.every(v=>v.version===1&&!v.default));
});
