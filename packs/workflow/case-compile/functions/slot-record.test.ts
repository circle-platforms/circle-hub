import assert from 'node:assert/strict';
import {test} from 'node:test';
import {slotProblems} from '../../../../hub/runs/engine/slots.ts';
import {slotWorkflow,frozenSlots} from '../testing/frozen-run.ts';
import {slotRecordProblems} from './slot-record.ts';
import {goodData,QUOTE} from './test-support.ts';

type Slots=Record<string,unknown>;
const claim=(mutate:(value:Record<string,any>)=>void=()=>{}):Record<string,any>=>{const value:Record<string,any>={text:'合成计划槽位',quotes:[{...QUOTE}],data:goodData()};mutate(value);return value;};
const FIXTURES:Array<{label:string;slots:()=>Slots;words:'same'|'lead'|'pointer'}>=[
 {label:'an accepted record',slots:()=>({plan:[claim()]}),words:'same'},
 {label:'a claim without its text',slots:()=>({plan:[claim(value=>{delete value.text;})]}),words:'same'},
 {label:'a field the claim does not have',slots:()=>({plan:[{...claim(),extra:1}]}),words:'lead'},
 {label:'a text that is a number',slots:()=>({plan:[claim(value=>{value.text=7;})]}),words:'same'},
 {label:'a quotation without its text',slots:()=>({plan:[claim(value=>{value.quotes=[{reference:QUOTE.reference}];})]}),words:'same'},
 {label:'a data field that is missing',slots:()=>({plan:[claim(value=>{delete value.data.bucket;})]}),words:'same'},
 {label:'no statement',slots:()=>({plan:[]}),words:'same'},
 {label:'two statements',slots:()=>({plan:[claim(),claim()]}),words:'same'},
 {label:'a slot the pack does not declare',slots:()=>({plan:[claim()],other:[]}),words:'same'},
 {label:'a record without the declared slot',slots:()=>({}),words:'same'},
 {label:'a slot that is no list',slots:()=>({plan:claim()}),words:'same'},
 {label:'an empty text',slots:()=>({plan:[claim(value=>{value.text='';})]}),words:'pointer'},
 {label:'a data that is no object',slots:()=>({plan:[claim(value=>{value.data='x';})]}),words:'pointer'},
 {label:'a reference that is no reference',slots:()=>({plan:[claim(value=>{value.quotes=[{reference:'bogus',text:'x'}];})]}),words:'pointer'},
 {label:'a statement that is no object',slots:()=>({plan:['x']}),words:'pointer'},
 {label:'steps that are no list',slots:()=>({plan:[claim(value=>{value.data.steps='x';})]}),words:'pointer'},
 {label:'a code the pack does not declare',slots:()=>({plan:[claim(value=>{value.code='x';})]}),words:'pointer'},
];

test('the offline slot-record rule names what the Hub core names, at the same pointer',()=>{
 const workflow=slotWorkflow(),schema=frozenSlots().schema;
 for(const {label,slots,words} of FIXTURES){
  const value=slots(),hub=slotProblems(workflow,[{id:'i1'} as never],{run:'run_x',model:'m',items:[{item:'i1',handling:'handled',slots:value}]} as never);
  const hubRows=hub.map(problem=>({pointer:(problem.path??'').replace('/items/0',''),message:String(problem.message).replaceAll('/items/0','')})),local=slotRecordProblems(schema,value);
  assert.deepEqual(local.map(row=>row.pointer).sort(),hubRows.map(row=>row.pointer).sort(),label);
  if(words==='same')assert.deepEqual(local.map(row=>[row.pointer,row.message]).sort(),hubRows.map(row=>[row.pointer,row.message]).sort(),label);
  if(words==='lead')for(const row of local){const hubRow=hubRows.find(candidate=>candidate.pointer===row.pointer);assert.ok(hubRow&&row.message.startsWith(hubRow.message),label+': '+row.message);}
 }
});

test('a block whose kind is no declared kind is named at its kind, where the Hub can only name the block',()=>{
 const schema=frozenSlots().schema,value={plan:[claim(entry=>{entry.data.blocks=[{id:'a',kind:'NOPE'}];})]};
 const problems=slotRecordProblems(schema,value);assert.equal(problems.length>=1,true);
 const kind=problems.find(row=>row.pointer==='/slots/plan/0/data/blocks/0/kind')!;assert.ok(kind,JSON.stringify(problems));assert.ok(kind.message.includes('"CONFIG"')&&kind.message.includes('"NOPE"'),kind.message);
});

test('a keyword the reader does not know is reported instead of being skipped',()=>{
 const schema={type:'object',properties:{plan:{type:'array',items:{type:'object',properties:{text:{type:'string',format:'ipv4'}},required:['text']}}}};
 const problems=slotRecordProblems(schema,{plan:[{text:'x'}]});
 assert.ok(problems.some(row=>row.message.includes('读不懂的关键字 format')),JSON.stringify(problems));
});

test('a frozen run without a slot schema leaves nothing to judge against and says so',()=>{
 assert.deepEqual(slotRecordProblems(undefined,{plan:[]}).map(row=>row.pointer),['/slots']);
});

test('the claim shell and the data are reported together, where the Hub names the shell first and the data in the next round',()=>{
 const schema=frozenSlots().schema,value={plan:[claim(entry=>{delete entry.text;delete entry.data.bucket;})]};
 assert.deepEqual(slotRecordProblems(schema,value).map(row=>row.pointer).sort(),['/slots/plan/0/data/bucket','/slots/plan/0/text']);
 const workflow=slotWorkflow(),hub=slotProblems(workflow,[{id:'i1'} as never],{run:'run_x',model:'m',items:[{item:'i1',handling:'handled',slots:value}]} as never);
 assert.deepEqual(hub.map(problem=>problem.path).sort(),['/items/0/slots/plan/0/text'],'the Hub stops at the claim shell');
});

const evidence={type:'object',properties:{plan:{type:'array',minItems:1,items:{type:'object',additionalProperties:false,required:['text'],properties:{text:{type:'string',minLength:1},grounds:{type:'array',items:{type:'string'}},quotes:{type:'array',items:{type:'string'}}},anyOf:[{required:['grounds'],properties:{grounds:{minItems:1}}},{required:['quotes'],properties:{quotes:{minItems:1}}}]}}}};
test('alternatives apply together with the claim fields they sit beside',()=>{
 assert.deepEqual(slotRecordProblems(evidence,{plan:[{text:'x',quotes:['q']}]}),[]);
 assert.deepEqual(slotRecordProblems(evidence,{plan:[{text:'x',grounds:['g']}]}),[]);
 const none=slotRecordProblems(evidence,{plan:[{text:'x'}]});assert.ok(none.length>=1,'neither grounds nor quotes');
 assert.deepEqual(slotRecordProblems(evidence,{plan:[{text:'x',quotes:['q'],extra:1}]}).map(row=>row.pointer),['/slots/plan/0/extra'],'the claim\'s own fields are still judged');
 assert.deepEqual(slotRecordProblems(evidence,{plan:[{quotes:['q']}]}).map(row=>row.pointer),['/slots/plan/0/text']);
});
test('a pattern the reader cannot evaluate is reported instead of passing the value',()=>{
 const schema={type:'object',properties:{plan:{type:'array',items:{type:'object',properties:{text:{type:'string',pattern:'('}}}}}};
 assert.ok(slotRecordProblems(schema,{plan:[{text:'x'}]}).some(row=>row.message.includes('读不懂的正则')));
});
