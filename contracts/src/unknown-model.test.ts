// Synthetic contract regressions for the unknown-sweep changes; no Hub or product modules execute here.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {AjvJsonSchemaValidator} from '@modelcontextprotocol/sdk/validation/ajv';
import {accepted,copy} from './fixtures.ts';
import {RangeTable} from './tables.ts';
import {CheckOutcome} from './tables.ts';
import {LayerResult} from './validation.ts';
import * as validation from './validation.ts';
import {DISPOSITION,EXIT_ACTION,labelOf} from '../generated/vocabulary.ts';

test('item 4 preserves the disposition code while naming its time-bounded meaning',()=>{
  assert.ok(DISPOSITION.includes('keep_unknown'));
  assert.equal(labelOf('disposition','keep_unknown'),'带期限的暂缓');
  assert.ok(!EXIT_ACTION.some(action=>(action as string)==='keep_unknown'),'keeping unknown is never an exit action');
});


const due='2026-11-01T12:00:00.000Z';
const automatic={action:'reread',audience:{hub:true},due};
const gap={missing:'Temporary read result of a bound synthetic source',exit:automatic};
const unknown={verdict:'unknown',statement:'缺少合成原件',grounds:[],tier:'blocking',reason:'missing_input'};
test('item 3 refuses a check unknown without top-level missing but lets the Hub fill its exit',()=>{
  assert.equal(CheckOutcome.safeParse(unknown).success,false);
  assert.equal(CheckOutcome.safeParse({...unknown,data:{missing:['/source']}}).success,false);
  assert.ok(CheckOutcome.safeParse({...unknown,missing:gap.missing}).success);
  assert.ok(CheckOutcome.safeParse({...unknown,...gap}).success);
});
test('item 3 requires a complete recovery for every transitional new layer',()=>{
  for(const layer of [{layer:'static',terminal:'unchecked'},{layer:'static',terminal:'incomplete'},{layer:'dynamic',terminal:'not_run'},{layer:'dynamic',terminal:'no_verdict'},{layer:'dynamic',terminal:'incomplete'}]){
    const value={...layer,reason:'missing_input'};assert.equal(LayerResult.safeParse(value).success,false);
    assert.equal(LayerResult.safeParse({...value,missing:' '}).success,false);
    assert.equal(LayerResult.safeParse({...value,...gap,exit:{...automatic,due:'later'}}).success,false);
    assert.ok(LayerResult.safeParse({...value,...gap}).success);
  }
  assert.ok(LayerResult.safeParse({layer:'static',terminal:'pass'}).success);
});
test('item 3 binds request kind and a named audience only to request exits',()=>{
  const valid={...unknown,missing:gap.missing};
  for(const exit of [{action:'request',audience:{user:'usr_01m5h9zh07x7amhg4bwmye5yhw'},due},{...automatic,request_kind:'repair'},{action:'request',request_kind:'repair',audience:{hub:true},due}])assert.equal(CheckOutcome.safeParse({...valid,exit}).success,false);
  assert.ok(CheckOutcome.safeParse({...valid,exit:{action:'request',request_kind:'repair',audience:{user:'usr_01m5h9zh07x7amhg4bwmye5yhw'},due}}).success);
});


test('item 3 reads historical omissions without inventing facts, actors or deadlines',()=>{
  const legacy=validation.ValidationResult.parse(copy(accepted));const requirement=legacy.partitions.delivered[0].requirements[0];
  requirement.layers=[{layer:'static',terminal:'unchecked',reason:'timeout'}];requirement.status='pending';
  assert.equal(validation.ValidationResult.safeParse(legacy).success,false);
  const read=validation.readStoredValidationResult(legacy);assert.deepEqual(read.result,legacy);
  assert.ok(read.notices.some(note=>note.path.endsWith('/exit')&&note.message==='出口未写'));
  assert.ok(!Object.hasOwn(read.result.partitions.delivered[0].requirements[0].layers[0],'exit'));
  assert.deepEqual(legacy,read.result);
});
test('item 3 retains independent secondary reasons and their own recovery facts',()=>{
  const value={layer:'static',terminal:'unchecked',reason:'missing_input',...gap,gaps:[{reason:'budget_exhausted',missing:'Remaining synthetic batch',exit:{...automatic,action:'rerun'}}]};
  const parsed=LayerResult.parse(value);assert.equal(parsed.gaps?.length,1);assert.equal(parsed.gaps?.[0].reason,'budget_exhausted');
  assert.equal(LayerResult.safeParse({...value,gaps:[{reason:'budget_exhausted',missing:'batch'}]}).success,false);
});
test('item 3 publishes the same recovery admission constraints in JSON Schema',()=>{
  const ajv=new AjvJsonSchemaValidator();
  const check=ajv.getValidator(JSON.parse(readFileSync(new URL('../generated/schemas/check-outcome.v1.schema.json',import.meta.url),'utf8')));
  for(const value of [unknown,{...unknown,missing:gap.missing},{...unknown,...gap},{...unknown,...gap,exit:{action:'request',audience:{hub:true},due}}])assert.equal(check(value).valid,CheckOutcome.safeParse(value).success,JSON.stringify(value));
  const result=validation.ValidationResult.parse(copy(accepted));result.partitions.delivered[0].requirements[0].layers=[{layer:'static',terminal:'unchecked',reason:'timeout'}];
  const validate=ajv.getValidator(JSON.parse(readFileSync(new URL('../generated/schemas/validation.v1.schema.json',import.meta.url),'utf8')));
  assert.equal(validate(result).valid,false);Object.assign(result.partitions.delivered[0].requirements[0].layers[0],gap);assert.equal(validate(result).valid,true);
});


test('item 6 declares empty threshold behavior while omission means failure',()=>{
  const table={schema:'range@1',origin:'Synthetic threshold rule',checks:[{values:'$.items[*]',threshold:{measure:'min',minimum:1,empty:'pass'}}]};
  assert.ok(RangeTable.safeParse({...table,checks:[{values:'$.items[*]',threshold:{measure:'min',minimum:1}}]}).success);
  assert.ok(RangeTable.safeParse(table).success);
  assert.ok(RangeTable.safeParse({...table,checks:[{values:'$.items[*]',threshold:{measure:'min',minimum:1,empty:'fail'}}]}).success);
  assert.equal(RangeTable.safeParse({...table,checks:[{values:'$.items[*]',threshold:{measure:'min',empty:'unknown'}}]}).success,false);
});
