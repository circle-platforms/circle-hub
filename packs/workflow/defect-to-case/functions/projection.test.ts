import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BoundInput, RunContext } from '../../../../contracts/src/pack.ts';
import { SYNTHETIC_BOUND_MANUAL, SYNTHETIC_BUG_74001, SYNTHETIC_BUG_71010_UNCHECKABLE, SYNTHETIC_INDEX_VIEW } from '../testing/fixtures.ts';
import { projectDefects } from './projection.ts';

const DUMMY_CONTEXT: RunContext = {
  product: 'famx',
  names: ['FAMX', 'FAMY'],
  line: '10.6.1',
  build: 'Rel_FAMX_10_6_1_57',
  root: '1111111111111111111111111111111111111111111111111111111111111111',
  parameters: {},
  groups: [],
};

function makeBoundDefect(bug: { id: string; title: string; status?: string; [key: string]: unknown }, sha = 'sha_bug_74001'): BoundInput {
  return {
    slot: 'defects',
    external: `plm:bug:${bug.id}`,
    sha256: sha,
    media_type: 'application/json',
    parser: 'json@1',
    model: bug,
    meta: { title: `缺陷 ${bug.id} ${bug.title}`, status: bug.status },
  };
}

function makeBoundIndex(indexView = SYNTHETIC_INDEX_VIEW, sha = 'sha_index'): BoundInput {
  return {
    slot: 'indexed_cases',
    external: `knowledge:index:famx:Rel_FAMX_10_6_1_57?kind=case&key=commands`,
    sha256: sha,
    media_type: 'application/json',
    parser: 'json@1',
    model: indexView,
    meta: null,
  };
}

describe('projection', () => {
  it('projects one item per defect with id, label, summary, location, and fields', () => {
    const bound = [makeBoundDefect(SYNTHETIC_BUG_74001), makeBoundIndex()];
    const result = projectDefects({
      inputs: [...bound, SYNTHETIC_BOUND_MANUAL],
      parameters: {},
      context: DUMMY_CONTEXT,
    });

    assert.ok(!('error' in result), 'projection should succeed');
    assert.equal(result.items.length, 1);
    const item = result.items[0];
    assert.equal(item.id, '74001');
    assert.equal(item.label, 'SLB健康检查间隔无法保存');
    assert.ok(item.summary && item.summary.includes('74001'));
    assert.equal(item.location.slot, 'defects');
    assert.equal(item.fields.id, '74001');
    assert.equal(item.fields.title, 'SLB健康检查间隔无法保存');
    assert.ok(result.groups && result.groups.length > 0, 'indexed_cases should be captured in groups');
  });

  it('projects multiple defects up to 20', () => {
    const bound = [
      makeBoundDefect(SYNTHETIC_BUG_74001, 'sha1'),
      makeBoundDefect(SYNTHETIC_BUG_71010_UNCHECKABLE, 'sha2'),
      makeBoundIndex(),
    ];
    const result = projectDefects({
      inputs: [...bound, SYNTHETIC_BOUND_MANUAL],
      parameters: {},
      context: DUMMY_CONTEXT,
    });

    assert.ok(!('error' in result));
    assert.equal(result.items.length, 2);
    assert.equal(result.items[0].id, '74001');
    assert.equal(result.items[1].id, '71010');
  });

  it('refuses when defects input slot is missing or empty', () => {
    const bound = [makeBoundIndex()];
    const result = projectDefects({
      inputs: [...bound, SYNTHETIC_BOUND_MANUAL],
      parameters: {},
      context: DUMMY_CONTEXT,
    });
    assert.ok('error' in result);
    assert.equal(result.error.code, 'defect-to-case.missing_defects');
  });

  it('refuses when defect id is duplicate', () => {
    const bound = [
      makeBoundDefect(SYNTHETIC_BUG_74001, 'sha1'),
      makeBoundDefect(SYNTHETIC_BUG_74001, 'sha2'),
      makeBoundIndex(),
    ];
    const result = projectDefects({
      inputs: [...bound, SYNTHETIC_BOUND_MANUAL],
      parameters: {},
      context: DUMMY_CONTEXT,
    });
    assert.ok('error' in result);
    assert.equal(result.error.code, 'defect-to-case.duplicate_defect_id');
  });
});
