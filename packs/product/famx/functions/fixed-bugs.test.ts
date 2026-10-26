import assert from 'node:assert/strict';
import {test} from 'node:test';
import {htmlParser} from '../../../../hub/refs/parsers/html.ts';
import {fixedBugEntries} from './fixed-bugs.ts';
const build='Rel_FAMX_10_8_9_42_main_zx-u';
function read(page:string){const parsed=htmlParser.parse(Buffer.from(page));const out=fixedBugEntries(parsed.model,build);for(const row of out.entries)for(const fragment of row.fragments)assert.ok(parsed.locate(fragment.selector));return out;}
test('URL protocol fields supply identities, never a fixed status',()=>{const out=read('<body><a href="https://plm.example.invalid/index.php?m=bug&amp;f=view&amp;id=SYN-1">一个完全不同的标题</a><a href="https://bugs.example.invalid/show_bug.cgi?id=SYN-2">已修复</a></body>');assert.deepEqual(out.entries.map(row=>[row.data.bug,row.data.system,row.data.status,row.data.declaration_status]),[['SYN-1','plm',null,'undeclared'],['SYN-2','bugzilla',null,'undeclared']]);});
test('bare numbers, table headings and PLM marker words never manufacture identities or states',()=>{const out=read('<body>======ID from PLM=======<br>70412<br>已修复 70413</body>');assert.equal(out.entries.length,1);assert.equal(out.entries[0].data.bug,null);assert.equal(out.entries[0].data.status,null);assert.equal(out.entries[0].data.identity_declaration_status,'undeclared');});
test('duplicate exact tracker identities coalesce and different trackers stay distinct',()=>{const out=read('<body><a href="?m=bug&amp;f=view&amp;id=1">1</a><a href="?m=bug&amp;f=view&amp;id=1">另一个标题</a><a href="show_bug.cgi?id=1">1</a></body>');assert.equal(out.entries.length,2);});
test('an ambiguous query or arbitrary numeric link does not establish an identity',()=>{for(const href of ['?m=bug&amp;f=view&amp;id=1&amp;id=2','/items/70412','javascript:alert(1)']){const out=read('<body><a href="'+href+'">70412</a></body>');assert.ok(out.entries.every(row=>row.data.bug===null&&row.data.status===null));}});
