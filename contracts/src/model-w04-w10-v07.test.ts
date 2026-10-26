// Model-owner prerequisites only: no runtime implementation or package source is changed here.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {MODEL_VERSION,PACK_FILE_PATHS} from '../generated/protocol.ts';
import {AXES,QualifierMarkSchema,labelOf} from '../generated/vocabulary.ts';
const model=JSON.parse(readFileSync(new URL('../model.json',import.meta.url),'utf8'));
const element=(id:string)=>model.elements.find((value:any)=>value.id===id);
const source='决定 35（集成者，10-24）';
test('the shared qualifier axis retains its existing codes and records each mark owner in its element',()=>{
 assert.equal(labelOf('qualifier_mark','decision_shape_unruled'),'判定形状未裁定');
 assert.ok(QualifierMarkSchema.safeParse('decision_shape_unruled').success);
 assert.ok(!QualifierMarkSchema.safeParse('unruled_shape').success);
 assert.equal(labelOf('qualifier_mark','intermittent'),'间歇');
 assert.ok(element('W04').changes10.some((text:string)=>text.includes('decision_shape_unruled')&&text.includes('归 W04')&&text.includes(source)));
 assert.ok(element('V07').changes10.some((text:string)=>text.includes('intermittent')&&text.includes(source)));
});
test('the existing work class, ledger and model revision remain unique and consistent with their generated contracts',()=>{
 assert.equal(model.version,13);assert.equal(MODEL_VERSION,13);
 assert.equal(model.vocabulary.length,Object.keys(AXES).length);
 assert.equal(model.vocabulary.filter((value:any)=>value.axis==='work_class').length,1);
 assert.deepEqual(AXES.work_class,{label:'工作类',owner:'V07',values:[{code:'verification',label:'验证'},{code:'reproduction',label:'复现'},{code:'web',label:'Web'}]});
 const ledgers=model.formatProposals.packFiles.filter((file:any)=>file.path==='ledger.json');
 assert.equal(ledgers.length,1);assert.deepEqual(ledgers[0].elements,['W04']);
 assert.equal(PACK_FILE_PATHS.filter(path=>path==='ledger.json').length,1);
});
test('V07 retains the detailed baseline rule and states work-class defaults and explicit dispatch overrides',()=>{
 const rule=element('V07').rules[0];
 for(const phrase of ['终态和码取第一次不合的那一轮（首因不丢）','要求项未满足（终态不符合期望）','这是确定的结论，不记未知','取其中最弱的','写明缺哪几轮','出口是重跑这几轮','只作假设集里的假设，不进归责（V04 R[0]）'])assert.ok(rule.includes(phrase),phrase);
 assert.ok(rule.includes('加限定标记“'+labelOf('qualifier_mark','intermittent')+'”'));

 const defaults=element('V07').rules[5];
 for(const phrase of ['验证和复现是 3 次','聚合方式“全部”','Web 是首次通过、2 次','首轮通过就停，失败再跑一次','包没声明工作类的就是一轮','派发那一行写了自己的次数的，以写的为准'])assert.ok(defaults.includes(phrase),phrase);
});
test('decision 19 is settled with the owner choice and each touched element records the integrator source',()=>{
 const decision=model.pendingDecisions.find((value:any)=>value.item.startsWith('决定表第 19 行'));
 assert.equal(decision.status,'已定');assert.ok(decision.decision.includes('所有者 10-21'));
 for(const id of ['W04','W10','V07'])assert.ok(element(id).changes10.some((text:string)=>text.includes(source)));
 assert.equal(element('B07').rules[9],'回答改变期望（要求项参数或输入）时，按新修订在同一血缘开新运行，不改写原运行');
});

test('the k-of-n and first-pass rules refer to the preserved missing-round branch of R[0]',()=>{
 for(const index of [1,2]){
  const text=element('V07').rules[index];
  assert.ok(text.includes('照 R[0]'));
  assert.ok(element('V07').rules[0].includes('出口是重跑这几轮'));
 }
});
