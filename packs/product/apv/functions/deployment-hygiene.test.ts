import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

test('authored version examples and conventions use only synthetic release lines',()=>{
 const files=['README.md','functions/cases-rules.ts','functions/cases-sync.ts','functions/cases-sync.test.ts','functions/cases.test.ts','functions/naming.ts','functions/naming.test.ts','product.json'];
 const pattern=/(?<![0-9])10[._][0-5](?![0-9])(?:[._][0-9]+)*/;
 const hits=files.flatMap(file=>readFileSync(new URL('../'+file,import.meta.url),'utf8').split('\n').flatMap((line,index)=>pattern.test(line)?[file+':'+(index+1)]:[]));
 assert.deepEqual(hits,[]);
});
