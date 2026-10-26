import assert from 'node:assert/strict';
import {test} from 'node:test';
import {commandCatalog,resolvePhrasePaths,textCommands} from './cases-commands.ts';
import {produceCommandEntries} from './command-tree.ts';
import {produceManualEntries} from './manual.ts';
import {xml,markdown} from '../testing/test-support.ts';

const source=(help='')=>xml(`<commands><menu name="demo"><item name="set"><arguments><arg name="value" type="DOTTEDIP" help_string="${help}"/></arguments></item><item name="status"/><item name="echo"><arguments><arg name="value" type="STRING"/></arguments></item></menu></commands>`);
const catalog=()=>commandCatalog(source()).catalog;
for(const help of ['or','hostname','URL','IP address or hostname','hostname URL list empty'])test(`R4 help cannot change structured DOTTEDIP type: ${help}`,()=>{
 const entries=produceCommandEntries(source(help)).entries;
 assert.deepEqual((entries[0].data.signatures as any[]).map(s=>s.params[0].type),['ipv4']);
});
for(const command of ['de status','DE status','DEMO status','demo status extra','no demo status','执行 demo status','Ｓdemo status','demo status demo set 192.0.2.7'])test(`R4 rejects non-complete grammar: ${command}`,()=>assert.deepEqual(resolvePhrasePaths(catalog(),command),[]));
test('R4 complete structured parameters determine command identity',()=>{
 const c=catalog();assert.deepEqual(resolvePhrasePaths(c,'demo set 192.0.2.7'),['/commands/demo/set']);
 for(const line of ['demo set','demo set hostname.invalid','demo set 192.0.2.7 extra'])assert.deepEqual(resolvePhrasePaths(c,line),[]);
 assert.deepEqual(resolvePhrasePaths(c,'demo echo "demo status"'),['/commands/demo/echo'],'a command-shaped STRING value is one argument, never another command');
});
test('R4 source lines are independent complete slots; no prose extraction or variant folding',()=>{
 const c=catalog();const result=textCommands(c,['demo status','执行 demo status 查看','ｄｅｍｏ status','demo\nstatus','demo status\ndemo set 192.0.2.7']);
 assert.deepEqual(result.results.map(r=>r.paths),[['/commands/demo/status'],[],[],[],['/commands/demo/set','/commands/demo/status']]);
});
test('R4 missing or undeclared types never create STRING catalog signatures',()=>{
 for(const type of ['', 'UNKNOWN', 'string']){
  const result=produceCommandEntries(xml(`<commands><item name="demo"><arguments><arg ${type?`type="${type}"`:''}/></arguments></item></commands>`));
  assert.ok(!result.entries.some(e=>(e.data.signatures as any[])?.some(s=>s.params.some((p:any)=>p.type==='string'))));
  assert.ok(result.warnings.some(w=>w.includes('类型')&&w.includes('下一步')));
 }
});
test('R4 manual formatting cannot fabricate command identity without a locked tree',()=>{
 const result=produceManualEntries(markdown('## Synthetic\n\n**demo status**\n\ntext'));
 assert.ok(!result.entries.some(e=>e.path?.startsWith('/commands/')));
 assert.ok(result.warnings.some(w=>w.includes('命令树')&&w.includes('下一步')));
});
test('R4 natural-language table headers cannot authorize command column roles',()=>{
 const result=produceManualEntries(markdown('## Synthetic\n\n| 命令 | prose |\n|---|---|\n| **demo status** | text |'),null,{catalog:catalog()});
 assert.ok(!result.entries.some(e=>e.data.form==='signature'));
});

test('R4 declared signature column accepts a complete locked identity without a natural-language command label',()=>{
 const result=produceManualEntries(markdown('## Synthetic\n\n| command_signature@2 | description |\n|---|---|\n| **demo status** | text |'),null,{catalog:catalog()});
 assert.equal(result.entries.filter(e=>e.data.form==='signature').length,1);
 assert.equal(result.entries.find(e=>e.data.form==='signature')?.path,'/commands/demo/status');
});
test('R4 undeclared no variant cannot borrow the positive command identity',()=>{
 const result=produceManualEntries(markdown('## Synthetic\n\n**[no] demo status**'),null,{catalog:catalog()});
 assert.ok(!result.entries.some(e=>e.data.form==='signature'));
});
test('R4 AST signature mapping does not use Latin or CJK appearance as command evidence',async()=>{
 const {readSignatureLine}=await import('./adoc/k1-model.ts');
 assert.notEqual(readSignatureLine('查看 状态').spelling,null);
 const grammar=commandCatalog(xml('<commands><menu name="查看"><item name="状态"/></menu></commands>')).catalog;
 const read=readSignatureLine('查看 状态');
 const result=produceManualEntries(markdown('## Synthetic\n\n'+read.spelling),null,{catalog:grammar});
 assert.equal(result.entries.find(e=>e.data.form==='signature')?.path,'/commands/查看/状态');
});
test('R4 a newline or NUL cannot hide inside one quoted argument',()=>{
 for(const line of ['demo echo "a\nb"','demo echo "a\rb"','demo echo "a\0b"'])assert.deepEqual(resolvePhrasePaths(catalog(),line),[]);
});
test('R4 signature group syntax checks matching delimiter kinds',async()=>{
 const {readSignatureLine}=await import('./adoc/k1-model.ts');
 for(const line of ['demo echo <name]','demo echo [<name]>'])assert.equal(readSignatureLine(line).spelling,null,line);
});
for(const optional of ['yes','y','true','1','maybe','FALSE'])test(`R4 optional variant is invalid structure: ${optional}`,()=>{
 const result=produceCommandEntries(xml(`<commands><item name="demo"><arguments><arg type="STRING" optional="${optional}"/></arguments></item></commands>`));
 assert.equal(result.entries.length,0);assert.ok(result.warnings.some(w=>w.includes('optional')&&w.includes('下一步')));
});
test('R4 repaired XML cannot become an apparently complete command catalog',()=>{
 const result=produceCommandEntries(xml('<commands><item name="demo" help_string="a "bad" description"/></commands>'));
 assert.equal(result.entries.length,0);assert.ok(result.warnings.some(w=>w.includes('XML')&&w.includes('下一步')));
});
test('R4 production diagnostics remain structured rather than classified from warning prose',async()=>{
 const {commandTree}=await import('./producers.ts');
 const result=commandTree({slots:{tree:{parser:'xml@1',model:xml('<commands><item name="demo"><arguments><arg name="peer"/></arguments></item></commands>')}}});
 assert.equal(result.grammar?.complete,false);assert.equal(result.diagnostics?.[0].attribute,'type');
 assert.equal(result.diagnostics?.[0].type_declaration_status,'undeclared');assert.equal(result.diagnostics?.[0].command_parse_status,'parameters_unchecked');
 assert.ok(result.warnings.some(w=>w.includes('命令树维护者')&&w.includes('下一次生产')));
});
test('R4 XML path identity never folds Unicode whitespace or decodes an attribute twice',()=>{
 const c=commandCatalog(xml('<commands><item name="demo　status"/><item name="literal&amp;amp;name"/></commands>')).catalog;
 assert.deepEqual(resolvePhrasePaths(c,'demo status'),[]);
 assert.deepEqual(resolvePhrasePaths(c,'demo　status'),['/commands/demo%E3%80%80status']);
 assert.deepEqual(resolvePhrasePaths(c,'literal&name'),[]);
 assert.deepEqual(resolvePhrasePaths(c,'literal&amp;name'),['/commands/literal&amp;name']);
});
test('R4 unsupported container syntax cannot manufacture a complete catalog',()=>{
 const result=produceCommandEntries(xml('<commands><unknown><item name="demo"/></unknown></commands>'));
 assert.equal(result.entries.length,0);assert.equal(result.grammar?.complete,false);assert.ok(result.diagnostics?.some(d=>d.syntax_valid===false));
});
test('R4 type override requires exact authorized declaration schema and identity',()=>{
 const result=produceCommandEntries(source(),{argumentTypes:[{command:'demo set',position:1,type:'HOSTNAME',origin:'help says hostname'}]});
 assert.equal((result.entries[0].data.signatures as any[])[0].params[0].type,'ipv4');
});
test('R4 an unchecked shorter signature cannot disambiguate to a longer command',async()=>{
 const {parseCommandState}=await import('./commands.ts');
 const c=commandCatalog(xml('<commands><item name="alpha"><arguments><arg name="value"/></arguments></item><menu name="alpha"><item name="beta"/></menu></commands>')).catalog;
 assert.equal(parseCommandState(c,'alpha beta').status,'parameters_unchecked');
 assert.deepEqual(resolvePhrasePaths(c,'alpha beta'),[]);
});
test('R4 a declared STRING limit member set is consumed exactly as structure',()=>{
 const c=commandCatalog(xml('<commands><item name="mode"><arguments><arg type="STRING" limit="{on|off}"/></arguments></item></commands>')).catalog;
 assert.deepEqual(resolvePhrasePaths(c,'mode on'),['/commands/mode']);
 for(const line of ['mode ON','mode enabled','mode on extra'])assert.deepEqual(resolvePhrasePaths(c,line),[]);
});
test('R4 a one-member head group cannot collapse to its shorter prefix',()=>{
 const c=commandCatalog(xml('<commands><item name="demo"/></commands>')).catalog;
 const result=produceManualEntries(markdown('**demo {unknown}**'),null,{catalog:c});
 assert.ok(!result.entries.some(e=>e.data.form==='signature'));
});
test('R4 partial emphasis inside a token is not an explicit signature slot',()=>{
 const c=commandCatalog(xml('<commands><item name="ax"/></commands>')).catalog;
 const result=produceManualEntries(markdown('**a**x'),null,{catalog:c});
 assert.ok(!result.entries.some(e=>e.data.form==='signature'));
});
test('R4 every declared no variant remains in the verified signature identities',()=>{
 const c=commandCatalog(xml('<commands><item name="demo"/><item name="no demo"/></commands>')).catalog;
 const result=produceManualEntries(markdown('**[no] demo**'),null,{catalog:c});
 const entry=result.entries.find(e=>e.data.form==='signature');assert.ok(entry);
 assert.deepEqual(entry.data.signature_literals,[{primary:'demo',alternatives:['demo','no demo']}]);
});
test('R4 canonical references retain native words when path segments require escaping',()=>{
 const c=commandCatalog(xml('<commands><item name="a/b"/></commands>')).catalog;
 const result=produceManualEntries(markdown('```\na/b\n```'),null,{catalog:c});
 assert.deepEqual(result.entries[0].data.command_literals,['a/b']);
 assert.deepEqual(result.entries[0].data.command_lines,['a/b']);
});
