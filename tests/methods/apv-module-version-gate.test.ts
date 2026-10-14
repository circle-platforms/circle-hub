import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as fixture from '../fixtures/apv-module-flow-synthetic-provider-protocol.ts';

function frozen(version:string,declared=version){return {module:{version,root:'products/apv',manifestPath:'products/apv/product-line.json'},files:[{path:'product-line.json',base64:Buffer.from(JSON.stringify({id:'apv',version:declared})).toString('base64')}]};}
test('APV acceptance version gate accepts a frozen matching stable release at or above 1.3.0',()=>{
 const check=(fixture as any).assertFrozenApvModuleVersion;assert.equal(typeof check,'function');for(const version of ['1.3.0','1.3.1','1.4.0','2.0.0'])assert.equal(check(frozen(version)),version);
});
test('APV acceptance version gate preserves prerelease precedence and ignores build metadata when comparing the minimum',()=>{
 const check=(fixture as any).assertFrozenApvModuleVersion;assert.equal(typeof check,'function');for(const version of ['1.2.99','1.3.0-rc','1.3.0-rc.1','1.3.0-0'])assert.throws(()=>check(frozen(version)));for(const version of ['1.3.0+build.7','1.3.1-rc.1','2.0.0-rc'])assert.equal(check(frozen(version)),version);for(const version of ['01.3.0','1.3','1.3.0-01','1.3.0+','1.3.0-'])assert.throws(()=>check(frozen(version)));
});
test('APV acceptance version gate reads the frozen manifest and rejects differing catalog identity or a missing manifest',()=>{
 const check=(fixture as any).assertFrozenApvModuleVersion;assert.equal(typeof check,'function');assert.throws(()=>check(frozen('1.3.1','1.3.0')));assert.throws(()=>check(frozen('1.3.0+one','1.3.0+two')));assert.throws(()=>check({...frozen('1.3.1'),files:[]}));assert.throws(()=>check({...frozen('1.3.1'),module:{...frozen('1.3.1').module,manifestPath:'products/other/product-line.json'}}));
});
