import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

test('authored version examples and conventions use only synthetic release lines',()=>{
 const files=['README.md','functions/cases-rules.ts','functions/cases-sync.ts','functions/cases-sync.test.ts','functions/cases.test.ts','functions/naming.ts','functions/naming.test.ts','product.json'];
 const pattern=/(?<![0-9])10[._][0-5](?![0-9])(?:[._][0-9]+)*/;
 const hits=files.flatMap(file=>readFileSync(new URL('../'+file,import.meta.url),'utf8').split('\n').flatMap((line,index)=>pattern.test(line)?[file+':'+(index+1)]:[]));
 assert.deepEqual(hits,[]);
});

test('deployment instructions name every variable and distinguish unset, null and configured adoc roots',()=>{
 const readme=readFileSync(new URL('../README.md',import.meta.url),'utf8');
 const product=JSON.parse(readFileSync(new URL('../product.json',import.meta.url),'utf8'));
 for(const declaration of product.variables)assert.ok(readme.includes(declaration.name),declaration.name);
 assert.match(readme,/发布以后、启用以前/);assert.match(readme,/circle-hub var set.*--file/);
 assert.match(readme,/未设置.*读任何页之前/);assert.match(readme,/显式 null.*Markdown/);assert.match(readme,/字符串模板.*旧根/);
});
