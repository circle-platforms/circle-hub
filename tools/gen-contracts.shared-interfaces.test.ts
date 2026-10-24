// The shared-interface generator consumes a closed structural language; never executable expressions.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {ContractsError,renderSharedInterfaces,validateInputs} from './gen-contracts.ts';
const model=()=>JSON.parse(readFileSync(new URL('../contracts/model.json',import.meta.url),'utf8'));
const codes=JSON.parse(readFileSync(new URL('../contracts/codes.json',import.meta.url),'utf8'));
test('the shared definitions generate deterministic module exports and react to source changes',()=>{
 const m=model();const first=renderSharedInterfaces(m)!;assert.equal(first,renderSharedInterfaces(m));
 assert.match(first,/export const CommandIdentitySchema =/);assert.match(first,/export type ExpectedQuoteIdentity =/);
 m.formatProposals.sharedInterfaces.definitions[0].schema.properties.length.minimum=2;
 const second=renderSharedInterfaces(m)!;assert.notEqual(first,second);assert.match(second,/'length': z.number\(\).int\(\).min\(2\)/);
});
test('unknown expressions, nonclosed objects and unknown schema keywords are rejected',()=>{
 for(const change of [
  (d:any)=>{d.schema.expression='process.exit()';},
  (d:any)=>{d.schema.additionalProperties=true;},
  (d:any)=>{d.schema.required.push('absent');},
  (d:any)=>{d.schema.properties.length={type:'integer',minimum:3,maximum:2};},
  (d:any)=>{d.schema.properties.length={$ref:'file:/synthetic/source.ts'};},
 ]){const m=model();change(m.formatProposals.sharedInterfaces.definitions[0]);assert.throws(()=>renderSharedInterfaces(m),ContractsError);assert.ok(validateInputs(m,codes).some(p=>p.includes('sharedInterfaces')));}
});
test('duplicate names, ids and forward or cyclic references cannot silently change shared identities',()=>{
 for(const key of ['name','id']){const m=model();m.formatProposals.sharedInterfaces.definitions[1][key]=m.formatProposals.sharedInterfaces.definitions[0][key];assert.throws(()=>renderSharedInterfaces(m),ContractsError);}
 const clash=model();clash.formatProposals.sharedInterfaces.definitions[1].name='SourceSpanSchema';assert.throws(()=>renderSharedInterfaces(clash),ContractsError);
 for(const name of ['SourceSpan','CommandIdentity']){const m=model();m.formatProposals.sharedInterfaces.definitions[0].schema={$ref:'#/$defs/'+name};assert.throws(()=>renderSharedInterfaces(m),ContractsError);}
});
test('vocabulary references use exact existing axes and values, never aliases',()=>{
 const m=model();m.formatProposals.sharedInterfaces.definitions=[{name:'SyntheticState',id:'synthetic-state@1',meaning:'Synthetic generated state',schema:{$ref:'vocabulary:classification_status/unclassified'}}];
 assert.match(renderSharedInterfaces(m)!,/V.ClassificationStatusSchema.extract\(\['unclassified'\]\)/);
 for(const r of ['vocabulary:classification_status/Unclassified','vocabulary:no_axis','vocabulary:classification_status/unclassified/extra']){
  m.formatProposals.sharedInterfaces.definitions[0].schema.$ref=r;assert.throws(()=>renderSharedInterfaces(m),ContractsError);
 }
});
test('the optional shared-interface source is compatible with models that do not declare it',()=>{
 const m=model();delete m.formatProposals.sharedInterfaces;assert.equal(renderSharedInterfaces(m),undefined);
});
