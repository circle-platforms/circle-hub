// A build's fixed-bug page read with the product known: the build only from the whole file name (famx-assets@2, with the
// product prefix the newer listings write), one fed-build@1 row per tracker identity as fixed-bugs.ts reads it, never a status
// and never a number from prose. Synthetic page, prefix DemoOS, tracker hosts under .invalid, invented ids.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import project from './feeding.ts';
import {fixedBugsBuild,parseListing} from './listing.ts';
import {html} from '../testing/test-support.ts';
import {KnowledgeStructureSchema} from '../../../../contracts/src/feeding.ts';
import {canonicalize,sha256Hex} from '../../../../hub/records/api.ts';

const sha='c'.repeat(64);
const BUILD='Rel_FAMX_10_6_1_57';
type Row={body:Record<string,unknown>;identity:unknown;lines:string[];selector:string;grammar:string;conflict:boolean;missing?:Array<{missing:string;next_action:string}>};
const rows=(value:unknown):Row[]=>(value as {rows:Row[]}).rows;
const page=(body:string)=>html(Buffer.from(`<HTML><HEAD><TITLE>Bugs fixed with Rel_FAMX_10_9_9_99</TITLE></HEAD><BODY>${body}</BODY></HTML>`));
const plm=(id:string)=>`<a href="https://tracker.example.invalid/index.php?m=bug&f=view&t=html&id=${id}">${id}</a><br />`;
const read=(key:string,model:unknown,root:string|null='d'.repeat(64))=>rows(project({product:'famx',root,parser:'html@1',model,source:{system:'buildsite',type:'file',key,external:'buildsite:file:'+key,revision:null,bytes:sha}}));

test('the asset grammar reads the prefixed fixed-bug and command-tree names as whole names, nothing by substring',()=>{
 const listing=parseListing(html(Buffer.from([
  `<font color=red>${BUILD} (build on  2026-09-20 10:00:00 ): Released on 2026-09-21 </font> </br>`,
  `<BLOCKQUOTE><A href=/builds/DemoOS-${BUILD}.demoimg>image</A><BR><A href=/builds/command_tree-DemoOS-${BUILD}.xml>tree</A><BR><A href=/builds/Bugs_Fixed_with_DemoOS_${BUILD}.html>bugs</A><BR></BLOCKQUOTE>`,
 ].join('\n'))));
 const files=listing.builds[0].files;
 assert.equal(files.commandTree?.name,`command_tree-DemoOS-${BUILD}.xml`);
 assert.equal(files.bugsFixed?.name,`Bugs_Fixed_with_DemoOS_${BUILD}.html`);
 assert.equal(files.image?.name,`DemoOS-${BUILD}.demoimg`);
 assert.ok(!listing.warnings.some(warning=>warning.includes('资产角色未核对')),listing.warnings.join('；'));
 // The bare forms of the older listings are read as before.
 assert.equal(fixedBugsBuild(`/builds/Bugs_Fixed_with_${BUILD}.html`),BUILD);
 assert.equal(fixedBugsBuild(`Bugs_Fixed_with_DemoOS_${BUILD}.htm`),BUILD);
 assert.equal(fixedBugsBuild(`/rel/x/Bugs_Fixed_with_DemoOS_${BUILD}.html?view=1#top`),BUILD);
 assert.equal(fixedBugsBuild(`/builds/Bugs_Fixed_with_Demo%20OS_${BUILD}.html`),null,'an escaped space is no prefix character');
 for(const name of [`xBugs_Fixed_with_${BUILD}.html`,`Bugs_Fixed_with_DemoOS-${BUILD}.html`,`Bugs_Fixed_with_${BUILD}.html.bak`,`Bugs_Fixed_with__${BUILD}.html`,`Bugs_Fixed_with_DemoOS_${BUILD}_old.html`,`command_tree-DemoOS-${BUILD}.xml`,`Bugs Fixed with ${BUILD}.html`])
  assert.equal(fixedBugsBuild(name),null,name);
 const wrong=parseListing(html(Buffer.from(`${BUILD} (build on  2026-09-20 10:00:00 ): </br><A href=/builds/command_tree-DemoOS_${BUILD}.xml>tree</A><BR><A href=/builds/Bugs_Fixed_with_DemoOS-${BUILD}.html>bugs</A><BR>`)));
 assert.equal(wrong.builds[0].files.commandTree,undefined,'the command-tree prefix is separated by - only');
 assert.equal(wrong.builds[0].files.bugsFixed,undefined,'the fixed-bug prefix is separated by _ only');
 assert.equal(wrong.warnings.filter(warning=>warning.includes('famx-assets@2')).length,2);
});

test('a fixed-bug page gives one fed-build record per tracker identity, bound to the build of its file name, without status',()=>{
 const key=`/builds/Bugs_Fixed_with_DemoOS_${BUILD}.html`;
 const model=page(`${plm('900301')}${plm('900302')}${plm('900301')}<a href="https://bugs.example.invalid/show_bug.cgi?id=4401">4401</a><br /><a href="/builds/index.html">900399</a><br />900398 fixed in Rel_FAMX_10_9_9_99`);
 const fed=read(key,model);
 assert.equal(fed.length,3,JSON.stringify(fed.map(row=>row.body.fixed_bugs)));
 assert.deepEqual(fed.map(row=>row.body.fixed_bugs),[['plm:bug:900301'],['plm:bug:900302'],['bugzilla:bug:4401']]);
 const listed=rows(project({product:'famx',root:null,parser:'html@1',model:html(Buffer.from(`<font color=red>${BUILD} (build on 2026-09-20 10:00:00 ): Released on 2026-09-21</font>`)),source:{system:'buildsite',type:'listing',key:'rel_famx_10_6_1',bytes:sha}}))[0];
 for(const row of fed){
  assert.deepEqual(row.identity,listed.identity,'the same build object as its listing entry: name, family, line and platform');
  assert.deepEqual(row.lines,['10.6.1']);assert.equal(row.grammar,'famx-assets@2');assert.equal(row.conflict,false);assert.equal(row.missing,undefined);
  assert.match(row.selector,/^a\/[0-9]+$/);
  assert.deepEqual([row.body.name,row.body.built_at,row.body.released_at,row.body.tree,row.body.root],[BUILD,null,null,null,'d'.repeat(64)]);
  assert.deepEqual(row.body.source,{system:'build-site',page:key,bytes:sha});
  assert.ok(!('status' in row.body),'a fixed-bug list never declares a release status');
  assert.ok(KnowledgeStructureSchema.safeParse({...row.body,object:sha256Hex(canonicalize(row.identity))}).success);
 }
 // The title and the prose name another build and other numbers: neither is read.
 assert.ok(!fed.some(row=>JSON.stringify(row.body).includes('10_9_9_99')||JSON.stringify(row.body).includes('900398')||JSON.stringify(row.body).includes('900399')));
});

test('a fixed-bug page without a readable tracker link records the gap instead of an empty list',()=>{
 const key=`Bugs_Fixed_with_${BUILD}.html`;
 const none=read(key,page('<TABLE><TR><TD>900301</TD><TD>synthetic text</TD></TR></TABLE>'));
 assert.equal(none.length,1);assert.deepEqual(none[0].body.fixed_bugs,[]);assert.equal(none[0].selector,'b/0');
 assert.ok(none[0].missing?.[0].missing.includes('没有可读的缺陷系统链接'));assert.ok(none[0].missing?.[0].next_action.includes('重新读取'));
 const odd=read(key,page(`${plm('900301')}<a href="https://tracker.example.invalid/index.php?m=bug&f=view&id=9%2000">9 00</a>`));
 assert.deepEqual(odd.map(row=>row.body.fixed_bugs),[['plm:bug:900301'],[]]);
 assert.ok(odd[1].missing?.[0].missing.includes('1 个缺陷系统链接'));
});

test('other build-site files and listing pages keep their reading',()=>{
 assert.deepEqual(read('/builds/release-notes.html',page(plm('900301'))),[],'a page that is not the fixed-bug form is read as a listing, which lists no build here');
 assert.deepEqual(rows(project({product:'famx',root:null,parser:'html@1',model:page(plm('900301')),source:{system:'buildsite',type:'listing',key:`Bugs_Fixed_with_${BUILD}.html`,bytes:sha}})),[],'only a build-site file read is a fixed-bug page');
 const famy=read('Bugs_Fixed_with_Rel_FAMY_10_6_1_57.html',page(plm('900301')));
 assert.deepEqual(famy.map(row=>[row.body.name,row.body.family,row.lines]),[['Rel_FAMY_10_6_1_57','FAMY',['10.6.1']]],'a page of the second name family is its own build, never its base');
});
