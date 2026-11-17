// The shared form of a refusal the program can decide: what is wrong, where, the value seen, the allowed set, the next step.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PLAN_DATA,listed,refusalText,shownValue} from './refusal-form.ts';
import {slotRecordProblems} from './slot-record.ts';
import {frozenSlots} from '../testing/frozen-run.ts';
import SLOTS from '../slots.schema.json' with {type:'json'};

test('a refusal names what, where, what was seen, what is allowed, anything else the program knows, and the next step, in that order', () => {
  assert.equal(refusalText({what:'W',place:'/p',seen:'"s"',allowed:['a','b'],also:['X','Y'],next:'N'}),'W；位置：/p；看到："s"；允许：a、b；X；Y；下一步：N');
  assert.equal(refusalText({what:'W',next:'N'}),'W；下一步：N');
  assert.equal(refusalText({what:'W',allowed:[],next:'N'}),'W；允许：无；下一步：N');
});

test('a closed set is listed in full up to the limit and counted after it', () => {
  const values=Array.from({length:15},(_,index)=>String(index+1));
  assert.equal(listed(values.slice(0,3)),'1、2、3');
  assert.equal(listed(values,12),'1、2、3、4、5、6、7、8、9、10、11、12…（共 15 个）');
  assert.equal(listed([]),'无');
});

test('a value is shown the way it was written, clipped when it is long', () => {
  assert.equal(shownValue('x'),'"x"');assert.equal(shownValue(7),'7');assert.equal(shownValue(undefined),'没有');assert.equal(shownValue(null),'null');
  const long=shownValue('a'.repeat(300));assert.ok(long.length<=130&&long.endsWith('…'),long);
});

test('the plan data pointer is where the structure refusals put it, and the schema holds exactly one statement there', () => {
  assert.equal(PLAN_DATA,'/slots/plan/0/data');
  assert.deepEqual(Object.keys((SLOTS as {item:Record<string,unknown>}).item),['plan'],'one requirement, and it is called plan');
  const plan=(SLOTS as {item:{plan:{min:number;max:number}}}).item.plan;assert.equal(plan.min,1);assert.equal(plan.max,1);
  const pointers=slotRecordProblems(frozenSlots().schema,{plan:[{text:'x',data:{}}]}).map(row=>row.pointer);
  assert.ok(pointers.some(pointer=>pointer.startsWith(PLAN_DATA+'/')),JSON.stringify(pointers));
});
