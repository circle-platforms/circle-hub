// A field the schema does not give a node is refused in the Hub's own words, and then (here, where the writer sees it first) with
// the closed set of the node's fields, every place the schema declares that name, and what the other plan mode writes instead.
// Round 36: a block carried precondition_source, a field of a flat step; the refusal said "不认识的字段" twelve times.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {slotProblems} from '../../../../hub/runs/engine/slots.ts';
import {slotWorkflow,frozenSlots} from '../testing/frozen-run.ts';
import {slotRecordProblems} from './slot-record.ts';
import {goodData,QUOTE} from './test-support.ts';

const schema=()=>frozenSlots().schema;
const claim=(mutate:(value:Record<string,any>)=>void=()=>{}):Record<string,any>=>{const value:Record<string,any>={text:'合成计划槽位',quotes:[{...QUOTE}],data:goodData()};mutate(value);return value;};
const block=(extra:Record<string,unknown>={})=>({id:'b1',kind:'CONFIG',call:{object:'widget-seat',method:'configure',args:['widget health interval 60'],keywords:{}},...extra});
const SOURCE={reference:QUOTE.reference,text:QUOTE.text};
const has=(text:string,...parts:string[])=>{for(const part of parts)assert.ok(text.includes(part),`missing ${JSON.stringify(part)} in: ${text}`);};
const hubMessages=(value:unknown)=>slotProblems(slotWorkflow(),[{id:'i1'} as never],{run:'run_x',model:'m',items:[{item:'i1',handling:'handled',slots:value}]} as never).map(problem=>({pointer:(problem.path??'').replace('/items/0',''),message:String(problem.message).replaceAll('/items/0','')}));

test('a block with a field of a flat step is told the allowed fields of its kind, where the schema declares the field and what a block plan writes', () => {
  const value={plan:[claim(entry=>{entry.data.blocks=[block({precondition_source:SOURCE})];entry.data.steps=[];entry.data.expects=[];})]};
  const own=slotRecordProblems(schema(),value).filter(row=>row.pointer==='/slots/plan/0/data/blocks/0/precondition_source');assert.equal(own.length,1,JSON.stringify(slotRecordProblems(schema(),value)));
  has(own[0]!.message,'不认识的字段 precondition_source','允许：id、kind、call、cleanup、input_register、author_step_refs、description','/slots/plan/0/data/steps/<序号>/precondition_source','block_context.preconditions','下一步');
  const hub=hubMessages(value).find(row=>row.pointer===own[0]!.pointer);
  if(hub!==undefined)assert.ok(own[0]!.message.startsWith(hub.message),'the Hub\'s words lead: '+hub.message);
});

test('the allowed fields are those of the kind the block declares', () => {
  const observe={id:'o1',kind:'OBSERVE_ONLY',call:block().call,precondition_source:SOURCE};
  const value={plan:[claim(entry=>{entry.data.blocks=[observe];})]};
  const own=slotRecordProblems(schema(),value).find(row=>row.pointer.endsWith('/precondition_source'))!;assert.ok(own);
  has(own.message,'允许：id、kind、call、author_step_refs、description');assert.ok(!own.message.includes('cleanup'),own.message);
});

test('a field the schema does not declare anywhere gets the allowed set and no place', () => {
  const value={plan:[{...claim(),extra:1}]};
  const own=slotRecordProblems(schema(),value).find(row=>row.pointer==='/slots/plan/0/extra')!;assert.ok(own);
  has(own.message,'不认识的字段 extra','允许：text、location、grounds、quotes、commands、data','下一步');
  assert.ok(!own.message.includes('在模式里的位置'),own.message);
  const hub=hubMessages(value).find(row=>row.pointer==='/slots/plan/0/extra');assert.ok(hub,'the Hub refuses it too');assert.ok(own.message.startsWith(hub!.message),own.message+' vs '+hub!.message);
});

test('several unknown fields at one node are named together at the node', () => {
  const value={plan:[claim(entry=>{entry.data.steps[0]={...entry.data.steps[0],alpha:1,precondition_source:SOURCE,beta:2};})]};
  const own=slotRecordProblems(schema(),value).filter(row=>row.pointer==='/slots/plan/0/data/steps/0');assert.equal(own.length,1,JSON.stringify(slotRecordProblems(schema(),value)));
  has(own[0]!.message,'不认识的字段 alpha、beta');
});

test('a field of a flat step that the flat step does have is not refused, and the Hub agrees', () => {
  const value={plan:[claim(entry=>{entry.data.steps[0]={...entry.data.steps[0],precondition_source:SOURCE};})]};
  assert.deepEqual(slotRecordProblems(schema(),value),[]);assert.deepEqual(hubMessages(value),[]);
});

test('the decisions: the same pointers are refused as before, with or without the extra words', () => {
  const values=[
    {plan:[claim(entry=>{entry.data.blocks=[block({precondition_source:SOURCE})];})]},
    {plan:[{...claim(),extra:1}]},
    {plan:[claim(entry=>{delete entry.text;})]},
    {plan:[claim(entry=>{delete entry.data.bucket;})]},
  ];
  const expected=[['/slots/plan/0/data/blocks/0/precondition_source'],['/slots/plan/0/extra'],['/slots/plan/0/text'],['/slots/plan/0/data/bucket']];
  for(const [index,value] of values.entries())assert.deepEqual(slotRecordProblems(schema(),value).map(row=>row.pointer).filter(pointer=>index>0||pointer.endsWith('/precondition_source')),expected[index]);
});
