import {kityminderParser, xmlParser} from "../../../../hub/testing/parsers.ts";
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {cases} from './cases.ts';
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
test('commands in steps and expected results use the title command resolver',()=>{
 const bytes=Buffer.from(JSON.stringify({root:{data:{text:'synthetic'},children:[
  {data:{text:'generic title',priority:2},children:[{data:{text:'system reboot'},children:[{data:{text:'system show'}}]}]},
  {data:{text:'prose references',priority:2},children:[{data:{text:'run `system reboot`'},children:[{data:{text:'`system show` succeeds'}}]}]},
  {data:{text:'no catalog command',priority:2},children:[{data:{text:'expected result'}}]},
  {data:{text:'precondition only',priority:2},children:[{data:{text:'system reboot',priority:3}},{data:{text:'ordinary expected'}}]},
 ]}}));
 const xml=Buffer.from('<commands><scope type="global"><menu name="system"><item name="reboot" help_string="restart"><arguments/></item><item name="show" help_string="inspect"><arguments/></item></menu></scope></commands>');
 const id='agile:mindmap:synthetic';
 const out=cases({build:{name:'Rel_FAMX_10_6_1_7',family:'FAMX',line:'10.6.1',base:'Rel_FAMX_10_6_1_7',platform:null,built_at:null,released_at:null,root:null,sources:{case_documents:[id]}},slots:{tree:{sha256:sha(xml),media_type:'application/xml',parser:'xml@1',model:xmlParser.parse(xml).model}},lists:{documents:[{sha256:sha(bytes),media_type:'application/json',parser:'kityminder@1',model:kityminderParser.parse(bytes).model,external:id}]},params:{}});
 assert.deepEqual(out.entries.filter(entry=>entry.data.title==='generic title').map(entry=>entry.path).sort(),['/commands/system/reboot','/commands/system/show']);
 assert.deepEqual(out.entries.filter(entry=>entry.data.title==='prose references').map(entry=>entry.path),[null]);
 assert.deepEqual(out.entries.filter(entry=>entry.data.title==='precondition only').map(entry=>entry.path),[null]);
 assert.ok(out.warnings.some(text=>text.includes('3 个用例没引用目录里的任何命令')));
 assert.ok(out.warnings.every(text=>!text.includes('Jev')&&!text.includes('归类服务')));
});
