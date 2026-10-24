// Tests for the four new vocabulary axes added in model version 7:
//   sample_source (T02): author, returned_counterexample, retained_delivery
//   target (W02): item, run (shared by RequirementTemplate.target and CheckEntry.applies)
//   measure (C04): count, sum, min, max
//   placement (K04): code_only, judgment_allowed
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  AXES,
  MEASURE,
  MEASURE_LABEL,
  MeasureSchema,
  PLACEMENT,
  PLACEMENT_LABEL,
  PlacementSchema,
  SAMPLE_SOURCE,
  SAMPLE_SOURCE_LABEL,
  SampleSourceSchema,
  TARGET,
  TARGET_LABEL,
  TargetSchema,
  isMeasure,
  isPlacement,
  isSampleSource,
  isTarget,
} from '../generated/vocabulary.ts';
import { MODEL_VERSION } from '../generated/protocol.ts';
import { CheckEntry, PackSample, RequirementTemplate } from './pack.ts';
import { ProducerPlacement } from './product.ts';
import { RangeTable } from './tables.ts';

const model = JSON.parse(readFileSync(new URL('../model.json', import.meta.url), 'utf8')) as {
  version: number;
  elements: Array<{ id: string; changes7?: string[] }>;
  vocabulary: Array<{ axis: string; label: string; owner: string; values: Array<{ code: string; label: string }> }>;
};

test('model version is 13 and the generated vocabulary covers every declared axis', () => {
  assert.equal(model.version, 13);
  assert.equal(MODEL_VERSION, 13);
  assert.equal(model.vocabulary.length, Object.keys(AXES).length);
});

test('sample_source axis holds T02 R[1] terms with owner T02 and revision note', () => {
  assert.deepEqual(SAMPLE_SOURCE, ['author', 'returned_counterexample', 'retained_delivery']);
  assert.deepEqual(SAMPLE_SOURCE_LABEL, {
    author: '作者',
    returned_counterexample: '回流反例',
    retained_delivery: '外部留存交付',
  });
  const t02 = model.elements.find((e) => e.id === 'T02')!;
  assert.ok((t02.changes7 ?? []).some((c) => c.includes('sample_source')));

  const axis = model.vocabulary.find((v) => v.axis === 'sample_source')!;
  assert.equal(axis.label, '样例来源');
  assert.equal(axis.owner, 'T02');

  assert.ok(isSampleSource('author'));
  assert.ok(isSampleSource('returned_counterexample'));
  assert.ok(isSampleSource('retained_delivery'));
  assert.ok(!isSampleSource('synthetic'));

  assert.ok(SampleSourceSchema.safeParse('author').success);
  assert.ok(!SampleSourceSchema.safeParse('other').success);
});

test('target axis holds W02 F[0] terms with owner W02 and revision note', () => {
  assert.deepEqual(TARGET, ['item', 'run']);
  assert.deepEqual(TARGET_LABEL, {
    item: '条目',
    run: '运行',
  });
  const w02 = model.elements.find((e) => e.id === 'W02')!;
  assert.ok((w02.changes7 ?? []).some((c) => c.includes('target')));

  const axis = model.vocabulary.find((v) => v.axis === 'target')!;
  assert.equal(axis.label, '目标种类');
  assert.equal(axis.owner, 'W02');

  assert.ok(isTarget('item'));
  assert.ok(isTarget('run'));
  assert.ok(!isTarget('suite'));

  assert.ok(TargetSchema.safeParse('item').success);
  assert.ok(TargetSchema.safeParse('run').success);
  assert.ok(!TargetSchema.safeParse('anything').success);
});

test('measure axis holds C04 threshold measure terms with owner C04 and revision note', () => {
  assert.deepEqual(MEASURE, ['count', 'sum', 'min', 'max']);
  assert.deepEqual(MEASURE_LABEL, {
    count: '个数',
    sum: '总和',
    min: '最小值',
    max: '最大值',
  });
  const c04 = model.elements.find((e) => e.id === 'C04')!;
  assert.ok((c04.changes7 ?? []).some((c) => c.includes('measure')));

  const axis = model.vocabulary.find((v) => v.axis === 'measure')!;
  assert.equal(axis.label, '度量');
  assert.equal(axis.owner, 'C04');

  assert.ok(isMeasure('count'));
  assert.ok(isMeasure('sum'));
  assert.ok(isMeasure('min'));
  assert.ok(isMeasure('max'));
  assert.ok(!isMeasure('average'));

  assert.ok(MeasureSchema.safeParse('count').success);
  assert.ok(!MeasureSchema.safeParse('avg').success);
});

test('placement axis holds K04 placement terms with owner K04 and revision note', () => {
  assert.deepEqual(PLACEMENT, ['code_only', 'judgment_allowed']);
  assert.deepEqual(PLACEMENT_LABEL, {
    code_only: '只按代码归位',
    judgment_allowed: '可由 bot 提议归位',
  });
  const k04 = model.elements.find((e) => e.id === 'K04')!;
  assert.ok((k04.changes7 ?? []).some((c) => c.includes('placement')));

  const axis = model.vocabulary.find((v) => v.axis === 'placement')!;
  assert.equal(axis.label, '归位方式');
  assert.equal(axis.owner, 'K04');

  assert.ok(isPlacement('code_only'));
  assert.ok(isPlacement('judgment_allowed'));
  assert.ok(!isPlacement('manual'));

  assert.ok(PlacementSchema.safeParse('code_only').success);
  assert.ok(!PlacementSchema.safeParse('other').success);
  assert.deepEqual(ProducerPlacement.options, PLACEMENT);
});

test('contracts schemas integrate with the generated schemas seamlessly', () => {
  // RequirementTemplate.target accepts item and run, rejects others
  const reqBase = {
    key: 'k',
    name: 'Req',
    description: 'Desc',
    required: true,
    done_rule: 'bookkeeping' as const,
    layers: ['static' as const],
    accepted_producer: 'fact' as const,
    checks: ['c'],
    error_handling: [],
  };
  assert.ok(RequirementTemplate.safeParse({ ...reqBase, target: 'item' }).success);
  assert.ok(RequirementTemplate.safeParse({ ...reqBase, target: 'run' }).success);
  assert.ok(!RequirementTemplate.safeParse({ ...reqBase, target: 'invalid' }).success);

  // CheckEntry.applies accepts item and run, rejects others
  const checkBase = {
    id: 'c',
    interpreter: 'structure@1',
    table: 'tables/s.json',
    judges: 'subject' as const,
  };
  assert.ok(CheckEntry.safeParse({ ...checkBase, applies: 'item' }).success);
  assert.ok(CheckEntry.safeParse({ ...checkBase, applies: 'run' }).success);
  assert.ok(!CheckEntry.safeParse({ ...checkBase, applies: 'invalid' }).success);

  // RangeTable measure accepts count, sum, min, max, rejects others
  const tableBase = {
    schema: 'range@1' as const,
    origin: 'clause 1',
  };
  for (const measure of ['count', 'sum', 'min', 'max']) {
    assert.ok(RangeTable.safeParse({ ...tableBase, checks: [{ values: '$.items', threshold: { measure, minimum: 1 } }] }).success);
  }
  assert.ok(!RangeTable.safeParse({ ...tableBase, checks: [{ values: '$.items', threshold: { measure: 'avg', minimum: 1 } }] }).success);

  // PackSample source accepts author, returned_counterexample, retained_delivery
  const sampleBase = {
    id: 's',
    check: 'c',
    subject: {},
    expect: [{ verdict: 'support' as const }],
  };
  for (const source of ['author', 'returned_counterexample', 'retained_delivery']) {
    assert.ok(PackSample.safeParse({ ...sampleBase, source }).success);
  }
  assert.ok(!PackSample.safeParse({ ...sampleBase, source: 'unknown' }).success);
});

 test('share audiences are generated from the B04 decision', async () => {
  const { SHARE_AUDIENCE, SHARE_AUDIENCE_LABEL, ShareAudienceSchema } = await import('../generated/vocabulary.ts');
  assert.deepEqual(SHARE_AUDIENCE, ['user', 'pack_users']);
  assert.deepEqual(SHARE_AUDIENCE_LABEL, { user: '用户', pack_users: '能用这个包的用户' });
  assert.ok(!ShareAudienceSchema.safeParse('other').success);
  assert.ok(model.elements.find(e => e.id === 'B04') !== undefined);
});
