// SELECT_CELL parameters are judged by the cell-selection rules only: a refusal names the block field, the value seen and
// the one rule it breaks, never the ordinary single-line conditions of other command values.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {cellFixture,cellPlan} from '../testing/blocks.ts';
import {readSlots} from './slots.ts';
import {typedAuthorityGaps,authorityRecovery,humanGapLocation} from './typed-authority.ts';
import {checkContractShape} from './checks.ts';
import {bindArguments} from './binding.ts';
import {runtimeMethod} from './runtime-contract.ts';
import {generateWorkbook} from './generate.ts';
import {readWorkbook} from './workbook.ts';
import {coreModel} from '../testing/workbook-model.ts';

const GENERIC_TEXT=['不以 = 开头','没有 {} 或 {0}','首尾无空白'];
type Block=Record<string,any>;
function recipe(mutate:(block:Block)=>void=()=>{}){
 const f=cellFixture(),slots=cellPlan(),block=slots.blocks[1];mutate(block);
 return {...f,slots,plan_run:'run_00000000000000000000000000',build:'SYN-BUILD-A'};
}
function gapsOf(input:ReturnType<typeof recipe>){
 const parsed=readSlots(input.slots);assert.ok(parsed.ok,JSON.stringify(parsed));if(!parsed.ok)return [];
 return typedAuthorityGaps(input.contract,input.profile,parsed.slots,undefined,input.catalog,[],input.manifest_sha256);
}
const separator=(value:string)=>recipe(block=>{block.table={format:'delimited',separator:value,columns:value===''?1:2,header:false};block.column=value===''?1:2;block.select={row:1};});
const gapAt=(gaps:ReturnType<typeof gapsOf>,pointer:string)=>gaps.filter(gap=>gap.pointer===pointer);

for(const [label,value] of [['one space',' '],['a tab','\t'],['spaces around an equals sign',' = '],['trailing space','x ']] as const)
test(`separator ${label} is refused at its own field with its value and the G rule, not the ordinary single-line text`,()=>{
 const input=separator(value),gaps=gapsOf(input),own=gapAt(gaps,'/blocks/1/table/separator');
 assert.equal(gaps.length,1,JSON.stringify(gaps));assert.equal(own.length,1,JSON.stringify(gaps));
 const [gap]=own;assert.equal(gap.verdict,'refute');
 assert.ok(gap.message.includes(JSON.stringify(value)),gap.message);assert.match(gap.message,/首尾带空白/);assert.match(gap.message,/去掉首尾/);
 for(const piece of GENERIC_TEXT.slice(0,2))assert.ok(!gap.message.includes(piece),`${piece}：${gap.message}`);
 const text=authorityRecovery(gaps);assert.ok(text.includes('/table/separator'),text);assert.ok(text.includes(JSON.stringify(value)),text);
 const outcome=checkContractShape(input.subject(input.slots)).find(row=>row.verdict==='refute')!;assert.ok(outcome);assert.equal((outcome as any).pointer,'/data/blocks/1/table/separator');
});

test('a separator is judged by the cell rules alone, whatever the ordinary value policy says about its neighbours',()=>{
 for(const legal of [':','|',',','=','+','::','->','{{','}}','a b','é','x=y','1a','_']){
  const input=separator(legal),gaps=gapsOf(input);assert.deepEqual(gaps,[],legal);
  const outcomes=checkContractShape(input.subject(input.slots));assert.ok(outcomes.every(row=>row.verdict==='support'),legal+JSON.stringify(outcomes));
  const read=readWorkbook(coreModel(generateWorkbook(input)),input);assert.ok(read.ok,legal+JSON.stringify(read));
 }
});

test('every separator the cell rules accept reaches the workbook, and every refusal names the separator field',()=>{
 const candidates=[' ','\t','  ',' x','x ',' = ','\u00a0','\u3000','12','٣','a1','=','==',':','|','||',',',';','/','\\','-','_','x',"'",'"','a b','\n','\r','\u0001','_x0041_','\ud800','{{','}}','中文','→'];
 for(const value of candidates){
  const input=separator(value),parsed=readSlots(input.slots);
  // A separator is judged by what the runner does with it: whitespace at its ends, line breaks and all-digit text never survive G.
  const lost=/^[\p{Number}]+$/u.test(value)||value.trim()!==value||/[\r\n]/.test(value);
  if(!parsed.ok){assert.ok(!lost,JSON.stringify([value,parsed.problems]));assert.ok(parsed.problems.every(problem=>problem.pointer.startsWith('/blocks/1/')),JSON.stringify([value,parsed.problems]));continue;}
  const gaps=gapsOf(input),own=gapAt(gaps,'/blocks/1/table/separator');
  if(lost)assert.equal(own.length,1,JSON.stringify([value,gaps]));
  if(own.length){assert.ok(own.every(gap=>gap.message.includes(JSON.stringify(value))),JSON.stringify([value,own]));continue;}
  // Not refused at the field: the later G stage may still judge quoting, but never a property listed above.
  const refused=checkContractShape(input.subject(input.slots)).filter(row=>row.verdict==='refute');
  assert.ok(!lost,`${JSON.stringify(value)} reached the later G stage: ${JSON.stringify(refused)}`);
 }
});

test('an all-digit separator would be read as an integer by the runner and is refused with the value seen',()=>{
 const input=separator('12'),gaps=gapsOf(input),own=gapAt(gaps,'/blocks/1/table/separator');
 assert.equal(own.length,1,JSON.stringify(gaps));assert.ok(own[0].message.includes('"12"'));assert.match(own[0].message,/整数/);
});

test('a line break or a control character in a separator is refused as cell text, not as an ordinary command',()=>{
 for(const value of ['\n','a\nb','\u0001']){
  const gaps=gapsOf(separator(value)),own=gapAt(gaps,'/blocks/1/table/separator');
  assert.equal(own.length,1,JSON.stringify([value,gaps]));assert.ok(own[0].message.includes(JSON.stringify(value)),own[0].message);assert.match(own[0].message,/单元格/);
 }
});

test('a condition constant keeps its inner and leading whitespace and is refused only where the runner would cut it',()=>{
 for(const value of [' lead','in side','a  b','x,y','0012']){
  const input=recipe(block=>{block.select={where:[{column:1,value}]};});assert.deepEqual(gapsOf(input),[],JSON.stringify(value));
  const read=readWorkbook(coreModel(generateWorkbook(input)),input);assert.ok(read.ok,JSON.stringify([value,read]));
 }
 const trailing=recipe(block=>{block.select={where:[{column:1,value:'name '}]};}),gaps=gapsOf(trailing),own=gapAt(gaps,'/blocks/1/select/where/0/value');
 assert.equal(gaps.length,1,JSON.stringify(gaps));assert.equal(own.length,1);assert.ok(own[0].message.includes('"name "'),own[0].message);assert.match(own[0].message,/末尾带空白/);
 for(const piece of GENERIC_TEXT.slice(0,2))assert.ok(!own[0].message.includes(piece),own[0].message);
 const doubled=recipe(block=>{block.select={where:[{column:1,value:'{{}}'}]};});assert.deepEqual(gapsOf(doubled),[],'a doubled brace pair is a legal literal for the cell rules');
});

test('the closed table shapes and the numeric selectors have their own refusals when a lowered step reaches the binder',()=>{
 const input=recipe(),parsed=readSlots(input.slots);assert.ok(parsed.ok);if(!parsed.ok)return;
 const step=parsed.slots.steps[1],method=runtimeMethod(input.contract,step.object,step.method)!;
 const bind=(keywords:Record<string,string|number>,args=step.args)=>bindArguments(method,{...step,args,keywords:{...step.keywords,...keywords}},'/steps/1').problems;
 const format=bind({format:'csv'});assert.equal(format.length,1,JSON.stringify(format));assert.equal(format[0].pointer,'/steps/1/keywords/format');assert.ok(format[0].message.includes('"csv"'));assert.ok(format[0].message.includes('delimited')&&format[0].message.includes('key_value'));
 for(const [name,value,rule] of [['columns',0,'不小于 1'],['column',0,'不小于 1'],['header',2,'只能是 0'],['row',-1,'非负整数']] as const){
  const problems=bind({[name]:value});assert.equal(problems.length,1,JSON.stringify([name,problems]));assert.equal(problems[0].pointer,`/steps/1/keywords/${name}`);
  assert.ok(problems[0].message.includes(`${name}=${value}`),problems[0].message);assert.ok(problems[0].message.includes(rule),problems[0].message);
 }
 assert.deepEqual(bind({}),[]);
 const where=bind({},['{}','where 1=x ']);assert.equal(where.length,1);assert.equal(where[0].pointer,'/steps/1/args/1');assert.ok(where[0].message.includes('"x "'));
});

test('ordinary command values keep the single-line policy and the input template stays judged by its own rule',()=>{
 const input=recipe(),parsed=readSlots(input.slots);assert.ok(parsed.ok);if(!parsed.ok)return;
 const configured=parsed.slots.steps[2],method=runtimeMethod(input.contract,configured.object,configured.method)!;
 assert.deepEqual(bindArguments(method,configured,'/steps/2').problems,[]);
 for(const args of [[' demo set {}'],['demo set {} '],['=demo set {}'],['demo set {}{0}']]){
  const problems=bindArguments(method,{...configured,args},'/steps/2').problems;assert.ok(problems.length,JSON.stringify(args));
 }
 const flat=bindArguments(method,{object:configured.object,method:configured.method,args:[' '],keywords:{}},'/steps/0');assert.ok(flat.problems.some(problem=>problem.message.includes('首尾无空白')),'a plain command value is still judged by the single-line policy');
});

test('structural selection refusals name the field and the value seen',()=>{
 const refuse=(mutate:(block:Block)=>void)=>{const input=recipe(mutate),read=readSlots(input.slots);assert.equal(read.ok,false);return read.ok?[]:read.problems;};
 const brace=refuse(block=>{block.table.separator='{x}';});assert.equal(brace.length,1,JSON.stringify(brace));assert.equal(brace[0].pointer,'/blocks/1/table/separator');assert.ok(brace[0].message.includes('"{x}"'));assert.ok(brace[0].message.includes('{{'));
 const condition=refuse(block=>{block.select={where:[{column:1,value:'a}b'}]};});assert.equal(condition[0].pointer,'/blocks/1/select/where/0/value');assert.ok(condition[0].message.includes('"a}b"'));
 const emptyKey=refuse(block=>{block.table={format:'key_value',separator:'',columns:2,header:false};block.column=2;block.select={row:1};});
 assert.equal(emptyKey.length,1,JSON.stringify(emptyKey));assert.equal(emptyKey[0].pointer,'/blocks/1/table/separator');assert.ok(emptyKey[0].message.includes('""'));assert.match(emptyKey[0].message,/key_value/);
 const wide=refuse(block=>{block.table={format:'key_value',separator:':',columns:3,header:false};block.column=2;block.select={row:1};});
 assert.equal(wide.length,1,JSON.stringify(wide));assert.equal(wide[0].pointer,'/blocks/1/table/columns');assert.ok(wide[0].message.includes('3'));assert.match(wide[0].message,/两列/);
 const single=refuse(block=>{block.table={format:'delimited',separator:'',columns:2,header:false};block.column=1;block.select={row:1};});
 assert.equal(single.length,1,JSON.stringify(single));assert.equal(single[0].pointer,'/blocks/1/table/separator');assert.ok(single[0].message.includes('""')&&single[0].message.includes('2'));
 const column=refuse(block=>{block.column=7;});assert.equal(column.length,1);assert.equal(column[0].pointer,'/blocks/1/column');assert.ok(column[0].message.includes('7')&&column[0].message.includes('6'));
 const select=refuse(block=>{block.select={where:[{column:7,value:'x'}]};});assert.equal(select.length,1);assert.equal(select[0].pointer,'/blocks/1/select/where/0/column');assert.ok(select[0].message.includes('7')&&select[0].message.includes('6'));
});

test('the human location of a table or selection gap carries the field path',()=>{
 assert.equal(humanGapLocation('contract','/blocks/10/table/separator'),'第 11 块的表格设置（/table/separator）');
 assert.equal(humanGapLocation('contract','/blocks/10/select/where/0/value'),'第 11 块的第 1 条选行条件（/select/where/0/value）');
 assert.equal(humanGapLocation('contract','/blocks/10/select/row'),'第 11 块的选行条件（/select/row）');
 assert.equal(humanGapLocation('contract','/blocks/10/column'),'第 11 块（/column）');
});

test('a legal table of every format, header, width and row selector passes every check',()=>{
 for(const format of ['delimited','key_value'] as const)for(const header of [false,true])for(const columns of format==='key_value'?[2]:[1,2,5])for(const column of [1,columns])for(const select of [{row:1},{row:3},{where:[{column:1,value:'k'}]},{where:[{column:1,value:'k'},{column:columns,value:'v'}]}]){
  const sep=format==='key_value'||columns>1?'|':'';
  const input=recipe(block=>{block.table={format,separator:sep,columns,header};block.column=column;block.select=select;});
  assert.deepEqual(gapsOf(input),[],JSON.stringify([format,header,columns,column,select]));
  assert.ok(checkContractShape(input.subject(input.slots)).every(row=>row.verdict==='support'),JSON.stringify([format,header,columns,column,select]));
 }
});
