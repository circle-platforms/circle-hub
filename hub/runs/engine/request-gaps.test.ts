import assert from 'node:assert/strict';
import {test} from 'node:test';
import {accepted,runRecord,ADMIN,USER} from '../../../contracts/src/fixtures.ts';
import {ValidationResult} from '../../../contracts/src/validation.ts';
import {RunRecord} from '../../../contracts/src/run.ts';
import type {RequirementTemplate} from '../../../contracts/src/pack.ts';
import {digestOf} from '../../records/api.ts';
import type {EngineContext} from './deps.ts';
import {recordResultRequests} from './requests.ts';

function fixture(rows:RequirementTemplate['error_handling']=[]){
  const result=ValidationResult.parse(accepted),item=result.partitions.delivered[0],requirement=item.requirements[0];
  result.partitions={delivered:[item],rejected:[],quarantined:[],incomplete:[]};item.requirements=[requirement];
  const run={...RunRecord.parse(runRecord),runner:USER,requirements:[{...RunRecord.parse(runRecord).requirements[0],key:requirement.requirement,repair_rounds:5}]};
  const exit={action:'request' as const,request_kind:'repair' as const,audience:{user:ADMIN},due:'2026-10-26T00:00:00.000Z'};
  const writes:Array<{kind:string;body:{code?:string;kind?:string}}>=[];
  const ctx={now:()=>new Date('2026-10-24T00:00:00.000Z'),deps:{records:{store:{find:async()=>({items:[],next:null}),put:async(input:{kind:string;body:{code?:string;kind?:string}})=>{writes.push(input);return {...input,digest:digestOf(input.body)};}},principals:{get:async(id:string)=>({id,name:'合成管理员',role:'admin',disabled:false}),list:async()=>[{id:ADMIN,name:'合成管理员',role:'admin',disabled:false}]}},workflows:{byDigest:async()=>({requirements:[{key:requirement.requirement,error_handling:rows}]})}}} as unknown as EngineContext;
  result.errors=[];
  const input={run:run.run,items:[{item:'unrelated',handling:'handled',slots:{}},{item:item.item,handling:'handled',slots:{}}]};
  return{result,run,item,requirement,exit,ctx,input,writes};
}

test('a settled violation cannot absorb independent missing facts from its gaps',async()=>{
  const {ctx,run,result,item,requirement,exit,input,writes}=fixture();
  requirement.layers=[{layer:'static',terminal:'violation',code:'synthetic.violation',gaps:[{reason:'check_error',missing:'缺少合成观察甲',exit},{reason:'check_error',missing:'缺少合成观察乙',exit}]}];
  result.errors=[{code:'synthetic.violation',message:'已确定的合成违规',item:item.item,requirement:requirement.requirement,path:'/items/1'}];
  await recordResultRequests(ctx,run,result,new Map([[requirement.requirement,2]]),input);
  const gaps=result.errors.filter(e=>e.code==='check_error');
  assert.deepEqual(gaps.map(e=>e.message),['缺少合成观察甲','缺少合成观察乙']);
  assert.ok(gaps.every(e=>e.path==='/items/1'&&e.rounds_left===3&&e.fix?.includes('请求 rec:')));
  assert.equal(requirement.layers[0].terminal,'violation');
  assert.deepEqual(writes.filter(w=>w.kind==='request').map(w=>w.body.code),['check_error','check_error']);
});

test('an unknown without an earlier error names its real submission position and remaining rounds',async()=>{
  const {ctx,run,result,requirement,exit,input}=fixture();
  requirement.layers=[{layer:'static',terminal:'unchecked',reason:'check_error',missing:'缺少合成检查结论',exit}];
  await recordResultRequests(ctx,run,result,new Map([[requirement.requirement,2]]),input);
  const error=result.errors.find(e=>e.requirement===requirement.requirement)!;
  assert.equal(error.path,'/items/1');assert.equal(error.rounds_left,3);
});

test('request projection uses exact-code priority before a same-named cause row',async()=>{
  const {ctx,run,result,item,requirement,writes,input}=fixture([{reason:'missing_input',action:'unknown'},{code:'missing_input',action:'request'},{code:'*',action:'unknown'}]);
  requirement.layers=[{layer:'static',terminal:'pass'}];requirement.claims=[];
  result.errors=[{code:'missing_input',message:'合成输入需要处置',item:item.item,requirement:requirement.requirement,path:'/items/1'}];
  await recordResultRequests(ctx,run,result,new Map(),input);
  assert.deepEqual(writes.filter(w=>w.kind==='request').map(w=>w.body.kind),['repair']);
  assert.ok(!writes.some(w=>w.kind==='claim'),'a lower-priority cause row must not create a hypothesis set');
});
