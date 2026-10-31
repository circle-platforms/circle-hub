// (a) Every vocabulary axis of the model has its generated const, label map, zod enum and guard, and labelOf covers every code.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { z } from 'zod';
import * as vocabulary from '../generated/vocabulary.ts';
import { AXES, axisLabel, axisUiLabel, labelOf, uiLabelOf, type AxisName } from '../generated/vocabulary.ts';

type Axis = { axis: string; label: string; ui?: string; owner: string; values: { code: string; label: string; ui?: string }[] };
const model = JSON.parse(readFileSync(new URL('../model.json', import.meta.url), 'utf8')) as { vocabulary: Axis[] };
const exported = vocabulary as unknown as Record<string, unknown>;
const pascal = (s: string): string => s.split('_').map((p) => p[0].toUpperCase() + p.slice(1)).join('');

test('the generated AXES lists exactly the axes the model declares, in order', () => {
  // The count belongs to the model: a number written down here went stale every time an axis was added or retired.
  assert.ok(model.vocabulary.length > 0, 'the model declares axes');
  assert.equal(new Set(model.vocabulary.map((a) => a.axis)).size, model.vocabulary.length, 'axis names are unique');
  assert.deepEqual(Object.keys(AXES), model.vocabulary.map((a) => a.axis));
});

for (const axis of model.vocabulary) {
  test(`axis ${axis.axis} is generated completely`, () => {
    const C = axis.axis.toUpperCase();
    const T = pascal(axis.axis);
    const codes = axis.values.map((v) => v.code);
    const entry = AXES[axis.axis as AxisName];
    assert.equal(entry.label, axis.label);
    assert.equal(entry.owner, axis.owner);
    assert.deepEqual(entry.values, axis.values);
    assert.equal(axisLabel(axis.axis as AxisName), axis.label);

    assert.deepEqual(exported[C], codes, `${C} lists the codes`);
    assert.deepEqual(exported[`${C}_LABEL`], Object.fromEntries(axis.values.map((v) => [v.code, v.label])), `${C}_LABEL maps every code`);
    assert.deepEqual(exported[`${C}_UI`], Object.fromEntries(axis.values.map((v) => [v.code, v.ui ?? v.label])), `${C}_UI maps every code to its interface term`);
    assert.equal(axisUiLabel(axis.axis as AxisName), axis.ui ?? axis.label);

    const schema = exported[`${T}Schema`];
    assert.ok(schema instanceof z.ZodEnum, `${T}Schema is a zod enum`);
    assert.deepEqual(schema.options, codes);
    const guard = exported[`is${T}`] as (value: unknown) => boolean;
    assert.equal(typeof guard, 'function');

    for (const v of axis.values) {
      assert.equal(labelOf(axis.axis as AxisName, v.code as never), v.label, `labelOf(${axis.axis}, ${v.code})`);
      assert.equal(uiLabelOf(axis.axis as AxisName, v.code as never), v.ui ?? v.label, `uiLabelOf(${axis.axis}, ${v.code})`);
      assert.equal(schema.parse(v.code), v.code);
      assert.equal(guard(v.code), true);
    }
    for (const bad of ['', 'not_a_code_of_any_axis', axis.values[0].label, axis.values[0].code.toUpperCase(), null, 0]) {
      assert.equal(schema.safeParse(bad).success, false, `${T}Schema rejects ${JSON.stringify(bad)}`);
      assert.equal(guard(bad), false, `is${T} rejects ${JSON.stringify(bad)}`);
    }
  });
}

test('labels are non-empty and unique within each axis', () => {
  for (const axis of model.vocabulary) {
    const labels = axis.values.map((v) => v.label);
    assert.equal(new Set(labels).size, labels.length, `${axis.axis} has duplicate labels`);
    for (const label of [axis.label, ...labels]) assert.ok(label.trim().length > 0, `${axis.axis} has an empty label`);
  }
});

test('an interface term is written only where it differs from the label, and none repeats within an axis', () => {
  // The console shows only interface terms (owner's proposal decision 3, 2026-10-31); the model's labels stay for model text.
  for (const axis of model.vocabulary) {
    if (axis.ui !== undefined) assert.notEqual(axis.ui, axis.label, axis.axis);
    for (const v of axis.values) if (v.ui !== undefined) assert.notEqual(v.ui, v.label, `${axis.axis}.${v.code}`);
    const terms = axis.values.map((v) => v.ui ?? v.label);
    assert.equal(new Set(terms).size, terms.length, `${axis.axis} has duplicate interface terms`);
  }
  assert.equal(uiLabelOf('partition', 'quarantined'), '派发结果未确认');
  assert.equal(uiLabelOf('static_terminal', 'unchecked'), '未检查');
  assert.equal(labelOf('static_terminal', 'unchecked'), '未核对', 'the model label is unchanged');
});
