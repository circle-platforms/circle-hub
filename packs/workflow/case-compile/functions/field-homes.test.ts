import assert from 'node:assert/strict';
import {test} from 'node:test';
import {frozenSlots} from '../testing/frozen-run.ts';
import {fieldHomes,counterparts,unknownFieldNote} from './field-homes.ts';
import {PLAN_DATA} from './refusal-form.ts';

const schema=()=>frozenSlots().schema;

test('every property name lists the places the schema declares it, as pointers into the plan file', () => {
  const homes=fieldHomes(schema());
  assert.deepEqual(homes.get('precondition_source'),[PLAN_DATA+'/steps/<序号>/precondition_source']);
  assert.deepEqual(homes.get('bucket'),[PLAN_DATA+'/bucket']);
  assert.ok((homes.get('quote')??[]).length>=3,'a name declared at several places lists every one: '+JSON.stringify(homes.get('quote')));
  assert.equal(homes.get('no_such_field'),undefined);
});

test('a place is listed once however many branches of a union declare the name', () => {
  const homes=fieldHomes(schema()),places=homes.get('author_step_refs')??[];
  assert.equal(new Set(places).size,places.length,JSON.stringify(places));
});

test('the counterparts name places the schema has', () => {
  const homes=fieldHomes(schema());
  assert.ok(counterparts().length>=1);
  for(const row of counterparts()){
    assert.ok((homes.get(row.field)??[]).includes(PLAN_DATA+row.declared_at),`${row.field} is declared at ${row.declared_at}`);
    const last=row.instead.split('/').pop()!;
    assert.ok((homes.get(last)??[]).includes(PLAN_DATA+row.instead),`${row.instead} is a place of the schema`);
    assert.ok(row.says.length>10);
  }
});

test('the note of an unknown field lists the allowed fields and the places, and says nothing it cannot support', () => {
  const homes=fieldHomes(schema());
  const note=unknownFieldNote({homes,keys:['precondition_source'],allowed:['id','kind','call']});
  assert.deepEqual(note.allowed,['id','kind','call']);
  assert.ok(note.also.some(line=>line.includes(PLAN_DATA+'/steps/<序号>/precondition_source')),JSON.stringify(note));
  assert.ok(note.also.some(line=>line.includes('block_context.preconditions')),JSON.stringify(note));
  assert.match(note.next,/删去 precondition_source/);
  const plain=unknownFieldNote({homes,keys:['nothing_like_it'],allowed:['id']});
  assert.deepEqual(plain.also,[]);assert.match(plain.next,/删去 nothing_like_it/);
  const placed=unknownFieldNote({homes,keys:['bucket'],allowed:['id']});
  assert.ok(placed.also.some(line=>line.includes(PLAN_DATA+'/bucket')),JSON.stringify(placed));assert.ok(!placed.also.some(line=>line.includes('block_context')),'no counterpart row, no counterpart sentence');
});
