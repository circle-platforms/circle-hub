import assert from 'node:assert/strict';
import {test} from 'node:test';
import {RequirementTemplate,WorkflowFile} from './pack.ts';
import {RequestRecord} from './request.ts';
import {RUN,USER,H} from './fixtures.ts';
const requirement={key:'review',name:'复核',description:'合成',target:'item',required:true,done_rule:'bookkeeping',layers:['static'],accepted_producer:'independent_judgment',independent_of:'predecessor',checks:['form'],error_handling:[]};
test('account independence is explicit and cannot be declared without predecessor independence',()=>{
 assert.ok(RequirementTemplate.safeParse({...requirement,independence_by_account:true}).success);
 const {independent_of,...missing}=requirement;assert.equal(RequirementTemplate.safeParse({...missing,accepted_producer:'judgment',independence_by_account:true}).success,false);
});
test('read-only criterion review workflow declarations preserve explicit input binding',()=>{
 assert.ok(WorkflowFile.safeParse({schema:'workflow@1',inputs:[{slot:'declaration',role:'artifact_under_verification',description:'声明提交',accepts:['application/json'],required:true,many:false}],parameters:[],product:{catalogs:[]},subject:'declaration',projection:{module:'functions/project.ts'},predecessor:'required',predecessor_access:'view',criterion_review:true}).success);
});
test('declaration request positions are optional for history and exact for new requests',()=>{
 const request={run:RUN,kind:'judgment',audience:USER,due:'2026-11-01T00:00:00.000Z',missing:'等待非作者复核',next_action:'显式绑定声明提交和期望片段开复核',source:H,code:'awaiting_step'};
 assert.ok(RequestRecord.safeParse(request).success);assert.ok(RequestRecord.safeParse({...request,declaration:'/criterion_changes/0'}).success);
 assert.equal(RequestRecord.safeParse({...request,declaration:'/criterion_changes/01'}).success,false);
});
