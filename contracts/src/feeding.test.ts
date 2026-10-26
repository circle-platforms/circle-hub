import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SCHEMA_REGISTRY} from './index.ts';
import {FEEDING_SCHEMAS,VersionBindingSchema,FeedingRetractionSchema,FedCaseSchema,FedNoteSchema} from './feeding.ts';
import {COMPOSITION_BASES} from './knowledge.ts';
import {BINDING_STATUS,BINDING_BASIS,RELATION_KIND,COMPOSITION_BASIS} from '../generated/vocabulary.ts';
import {feedingExamples} from './feeding-fixtures.ts';
test('all knowledge-structure records are registered closed shapes generated from the model',()=>{
 for(const [id,schema]of Object.entries(FEEDING_SCHEMAS)){assert.equal(SCHEMA_REGISTRY[id],schema);for(const value of feedingExamples()[id]){assert.ok(schema.safeParse(value).success,id);assert.equal(schema.safeParse({...value as object,unexpected:true}).success,false,id);}}
});
test('source structure is a composition basis and binding codes are exact generated values',()=>{
 assert.equal(COMPOSITION_BASES,COMPOSITION_BASIS);assert.ok(COMPOSITION_BASIS.includes('source_structure'));assert.deepEqual(BINDING_STATUS,['bound','undeclared','conflict']);assert.deepEqual(BINDING_BASIS,['source_structure','declared']);assert.ok(RELATION_KIND.includes('covers'));
});
test('a target usage cannot become a binding and a declaration cannot impersonate source structure',()=>{
 const rows=feedingExamples();assert.equal(VersionBindingSchema.safeParse(rows['usage@1'][0]).success,false);const binding=rows['version-binding@1'][0] as Record<string,unknown>;
 for(const change of [{grounds:{by:'usr_'+'0'.repeat(26),run:'run_'+'0'.repeat(26)}},{state:'conflict',candidates:['10.8'],line:null},{state:'bound',line:null},{state:'undeclared',line:null}])assert.equal(VersionBindingSchema.safeParse({...binding,...change}).success,false);
});
test('retractions have exactly one nonempty target set; no destructive edit form exists',()=>{
 const row=feedingExamples()['retraction@1'][0] as Record<string,unknown>;assert.equal(FeedingRetractionSchema.safeParse({...row,objects:[]}).success,false);assert.equal(FeedingRetractionSchema.safeParse({...row,entries:['b'.repeat(64)]}).success,false);assert.equal(FeedingRetractionSchema.safeParse({...row,delete:true}).success,false);
});
test('observed source provenance and note classification are strict; free text gets no inferred fields',()=>{
 const kase=feedingExamples()['fed-case@1'][0] as Record<string,unknown>;assert.equal(FedCaseSchema.safeParse({...kase,source:{system:'upload',bytes:'a'.repeat(64)}}).success,false);
 const note=feedingExamples()['fed-note@1'][0] as Record<string,unknown>,quote={identity:{source_sha256:'a'.repeat(64),parser:'text@1',path:'l/1',span:{unit:'byte',offset:0,length:4}},text:'合成'};
 assert.ok(FedNoteSchema.safeParse({...note,classification:[{value:'minutes',quote}]}).success);assert.equal(FedNoteSchema.safeParse({...note,classification:[{value:'Minutes',quote}]}).success,false);assert.equal(FedNoteSchema.safeParse({...note,commands:[]}).success,false);
});
test('case resource diagnostics are optional for history and admit only an advisory structure violation',()=>{
 const old=feedingExamples()['fed-case@1'][0] as Record<string,unknown>;assert.ok(FedCaseSchema.safeParse(old).success);
 const violation={field:'resource',tier:'advisory',allowed_values:['functional'],statement:'未声明的标签；作者选择发布闭集的精确原文修正',next_action:'修正 resource 后重读'};
 const resource_declaration={status:'undeclared',present:true,raw_json:'["Functional"]',types:[],table:{id:'synthetic-tags',version:'1',sha256:'a'.repeat(64)},violations:[violation],missing:'标签未声明',next_action:'修正后重读'};const current={...old,resources:[],resource_declaration};assert.ok(FedCaseSchema.safeParse(current).success);assert.equal(FedCaseSchema.safeParse({...current,resource_declaration:{...resource_declaration,violations:[{...violation,tier:'blocking'}]}}).success,false);assert.equal(FedCaseSchema.safeParse({...current,resource_declaration:{...resource_declaration,status:'guessed'}}).success,false);
});
