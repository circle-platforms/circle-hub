// A block carries the one line InfoTest's compile model writes for every block (blocks_schema.json common_fields.desc,
// compile-worker.md W15, 99% of the blocks of its real runs): it goes to column D of the block's row as a flat step's
// description does, and it is never shown to the audit (scenario-fidelity.md: the judged party's account is a claim).
// Synthetic plans only; addresses are 192.0.2.0/24.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import TABLE from '../tables/blocks-format.json' with {type:'json'};
import {blockSchema} from '../testing/gen-block-schema.ts';
import {cellFixture,cellPlan,fixture,positiveBlocks} from '../testing/blocks.ts';
import {coreModel} from '../testing/workbook-model.ts';
import {fidelityBrief} from './fidelity.ts';
import {formatBlockForFidelity,partitionFidelityBlocks,renderFidelityStepState} from './fidelity-render.ts';
import {generateWorkbook,pathCell} from './generate.ts';
import {readSlots,type PlanSlots} from './slots.ts';
import {readWorkbook} from './workbook.ts';

const f=fixture();
const RUN={plan_run:'run_00000000000000000000000000',build:'SYN_ORBIT_10_8_1'};
const json=(path:string)=>JSON.parse(readFileSync(new URL('../'+path,import.meta.url),'utf8'));
/** Column D of one worksheet row as the independent core parser reads it. */
const columnD=(model:ReturnType<typeof coreModel>,row:number):string=>model.sheets[0]!.rows.find(entry=>entry.number===row)?.cells.find(cell=>cell.reference==='D'+row)?.text??'';
const described=(data:PlanSlots,say:(kind:string,index:number)=>string):PlanSlots=>{const copy=structuredClone(data);copy.blocks.forEach((block,index)=>{block.description=say(String(block.kind),index);});return copy;};
const RECORD={schema:'recompose-record@1',contract:{intent:{text:'合成意图'}},atoms:[{id:'a1',kind:'intent',text:'合成意图'},{id:'a2',kind:'action',text:'配置合成值并查看'}],ledgers:{original:[{atom:'a2',text:'配置合成值并查看'}],adapted:[],concretizations:[],rebindings:[]}};

test('every block kind declares an optional description, and both published block schemas accept it on every kind',()=>{
 for(const row of TABLE.kinds){
  assert.ok(row.fields.includes('description'),row.kind+' lists description among its fields');
  assert.ok(!row.required.includes('description'),row.kind+' does not require it: InfoTest marks desc optional too');
 }
 const slots=json('slots.schema.json').item.plan.data.properties.blocks.items.anyOf,published=json('tables/block-plan.schema.json').properties.blocks.items.anyOf;
 for(const branches of [slots,published,blockSchema().block.anyOf]){
  assert.equal(branches.length,TABLE.kinds.length);
  for(const branch of branches){
   assert.equal(branch.properties.description?.type,'string',String(branch.properties.kind.const));
   assert.equal(branch.properties.description.minLength,1);
   assert.ok(!(branch.required as string[]).includes('description'));
   assert.match(branch.properties.description.description,/不是抄作者步骤/,'the field tells the writer what it is for');
  }
 }
});

for(const [kind,data] of Object.entries(positiveBlocks())){
 test(kind+' plan: the description of each block stays on the step the block lowers to',()=>{
  const plan=described(data,(name,index)=>`第 ${index+1} 块（${name}）做的事`),parsed=readSlots(plan);
  assert.ok(parsed.ok,JSON.stringify(parsed));if(!parsed.ok)return;
  // A comparison of two captures has no call of its own: its description is accepted and kept in the plan, there is no row for it.
  const lowered=plan.blocks.filter(block=>block.kind!=='CAPTURE_COMPARE');
  assert.deepEqual(parsed.slots.steps.map(step=>step.description),lowered.map(block=>block.description));
  assert.equal(readSlots(data).ok,true,'the plan without descriptions is still accepted');
 });
}

test('a block description round-trips into column D of the workbook exactly as a flat step description does, and an assertion row has none',()=>{
 const words=['配置：把合成值设为 5','查看：读取合成状态并核对','清理：撤销合成值'];
 const plan=described(positiveBlocks().CONFIG,(_kind,index)=>words[index]!),parsed=readSlots(plan);
 assert.ok(parsed.ok,JSON.stringify(parsed));if(!parsed.ok)return;
 assert.deepEqual(parsed.slots.steps.map(step=>step.description),words);
 const recipe={slots:parsed.slots,contract:f.contract,profile:f.profile,fields:f.fields,...RUN},bytes=generateWorkbook(recipe),model=coreModel(bytes),read=readWorkbook(model,recipe);
 assert.ok(read.ok,JSON.stringify(read));if(!read.ok)return;
 const path=pathCell(f.fields.path)!,steps=read.executions.filter(execution=>!execution.assertion),asserts=read.executions.filter(execution=>execution.assertion);
 assert.equal(steps.length,3);assert.equal(asserts.length,1);
 assert.deepEqual(steps.map(execution=>columnD(model,execution.row)),[path+'\n'+words[0],words[1],words[2]],'the first row keeps the case path, then the description, as stepDescription writes it');
 assert.deepEqual(asserts.map(execution=>columnD(model,execution.row)),[''],'the reader requires an assertion row to have an empty D');
 assert.deepEqual(generateWorkbook(recipe),bytes,'generation stays deterministic');
 // The writer's description is part of the recipe the workbook identity row binds: another description is another workbook.
 const other=described(positiveBlocks().CONFIG,(_kind,index)=>words[index]!+'。'),again=readSlots(other);assert.ok(again.ok);if(!again.ok)return;
 assert.notDeepEqual(generateWorkbook({...recipe,slots:again.slots}),bytes);
 assert.equal(readWorkbook(coreModel(bytes),{...recipe,slots:again.slots}).ok,false,'a workbook written for other descriptions is refused by the independent reader');
});

test('a block without a description leaves column D empty after the path, as before',()=>{
 const parsed=readSlots(positiveBlocks().CONFIG);assert.ok(parsed.ok);if(!parsed.ok)return;
 assert.deepEqual(parsed.slots.steps.map(step=>step.description),[undefined,undefined,undefined]);
 const recipe={slots:parsed.slots,contract:f.contract,profile:f.profile,fields:f.fields,...RUN},model=coreModel(generateWorkbook(recipe)),read=readWorkbook(model,recipe);
 assert.ok(read.ok);if(!read.ok)return;
 assert.deepEqual(read.executions.map(execution=>columnD(model,execution.row)),[pathCell(f.fields.path)!,'','','']);
});

test('a cell-selection block keeps its own description over the engine sentence, and the engine sentence when it has none',()=>{
 const cf=cellFixture();
 const plain=readSlots(cellPlan());assert.ok(plain.ok);if(!plain.ok)return;
 const cell=plain.slots.steps.find(step=>step.block_kind==='SELECT_CELL')!;assert.equal(cell.description,'按声明的行列结构取一格');
 const own=cellPlan();own.blocks.find(block=>block.kind==='SELECT_CELL')!.description='取出密钥文件名那一列';
 const parsed=readSlots(own);assert.ok(parsed.ok,JSON.stringify(parsed));if(!parsed.ok)return;
 assert.equal(parsed.slots.steps.find(step=>step.block_kind==='SELECT_CELL')!.description,'取出密钥文件名那一列');
 const recipe={slots:parsed.slots,contract:cf.contract,profile:cf.profile,fields:cf.fields,...RUN},model=coreModel(generateWorkbook(recipe)),read=readWorkbook(model,recipe);
 assert.ok(read.ok,JSON.stringify(read));if(!read.ok)return;
 assert.ok(read.executions.some(execution=>columnD(model,execution.row).endsWith('取出密钥文件名那一列')));
});

test('a description that would break a workbook cell is refused at its block with the rule a flat step has',()=>{
 const good=positiveBlocks().OBSERVE_ASSERT;good.blocks[0]!.description='查看合成状态并核对';
 assert.equal(readSlots(good).ok,true,'a plain one-line description is accepted');
 // The schema lets these through as text; the rule of a flat step (one line, trimmed, no formula prefix) refuses them at the block.
 for(const [label,value] of [['two lines','配置合成值\n再查看'],['leading space',' 配置合成值'],['trailing space','配置合成值 '],['formula prefix','=配置合成值'],['carriage return','配置合成值\r']] as const){
  const plan=positiveBlocks().OBSERVE_ASSERT;plan.blocks[0]!.description=value;
  const parsed=readSlots(plan);assert.equal(parsed.ok,false,label);
  if(!parsed.ok)assert.deepEqual(parsed.problems.map(problem=>problem.pointer),['/blocks/0/description'],label+' '+JSON.stringify(parsed.problems));
 }
 // The schema itself refuses an empty text or another type.
 for(const [label,value] of [['empty',''],['not text',7]] as const){const plan=positiveBlocks().OBSERVE_ASSERT;plan.blocks[0]!.description=value;assert.equal(readSlots(plan).ok,false,label);}
 const flat=readSlots({bucket:'bed-a',blocks:[],replacements:[],steps:[{object:'ORBIT_0',method:'command',args:['demo show'],keywords:{},description:'=公式'}],expects:[]});
 assert.equal(flat.ok,false,'the flat rule is the same one');
 if(!flat.ok)assert.deepEqual(flat.problems.map(problem=>problem.pointer),['/steps/0/description']);
});

test('the audit never sees a block description: not in the brief, not in what Plumb is asked',()=>{
 const secrets=new Map<string,string>();
 const plan=described(positiveBlocks().CONFIG,(kind,index)=>{const text=`编写自述${index}：${kind} 的内部说明不应出现在审计里`;secrets.set(kind+index,text);return text;});
 assert.ok(readSlots(plan).ok,'the plan with its descriptions is one the checks accept');
 const brief=fidelityBrief('doc-1:c-1',RECORD,plan)!;
 assert.ok(brief,'the plan has a brief');
 const everywhere=[JSON.stringify(brief),...brief.blocks.map(block=>formatBlockForFidelity(block)),renderFidelityStepState(brief,0,partitionFidelityBlocks(brief)).state].join('\n');
 for(const text of secrets.values())assert.equal(everywhere.includes(text),false,text);
 assert.equal(everywhere.includes('编写自述'),false);
 assert.equal(brief.blocks.every(block=>!('description' in block)),true);
 // What the audit does see of the same blocks is unchanged by the descriptions.
 const bare=fidelityBrief('doc-1:c-1',RECORD,positiveBlocks().CONFIG)!;
 assert.deepEqual(brief.blocks,bare.blocks);assert.equal(brief.brief_sha256,bare.brief_sha256,'a description does not change the brief the verdict is bound to');
});
