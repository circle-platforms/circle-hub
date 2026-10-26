// Keep the documented validity evidence aligned with the two independently stored sources.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
test('the validity table distinguishes visible claim relations from composition source conflicts',()=>{
 const text=readFileSync(new URL('./README.md',import.meta.url),'utf8');
 const row=text.split('\n').find(line=>line.startsWith('| `contradicted`'))!;
 assert.ok(row.includes('applicability_sources'));
 assert.ok(row.includes('来源声明互相矛盾'));
 assert.ok(row.includes('只有 claim 关系受上述读者可见范围限制'));
 assert.ok(row.includes('不补造 claim'));
});
