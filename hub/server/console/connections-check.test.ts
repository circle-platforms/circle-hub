import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecutorView } from '../api.ts';
import { environmentCheckCell, environmentCheckFacts, environmentLastCheck, type EnvironmentLastCheck } from './connections.ts';

function view(last_check?: EnvironmentLastCheck | null): ExecutorView {
  const base: ExecutorView = {
    id: 'exe_01habcdefghijklmnopqrstuvw',
    target: '合成环境',
    endpoint: 'https://192.0.2.10',
    enabled: true,
    resources: [],
  };
  if (arguments.length === 0) return base;
  return {
    ...base,
    state: {
      executor: base.id,
      enabled: true,
      registration: { digest: 'a'.repeat(64), decided_at: null },
      known: { occupancy: true, latest: true, version: true },
      holding: [],
      bed_hold: null,
      latest: null,
      reported_version: null,
      missing: [],
      last_check,
    } as NonNullable<ExecutorView['state']> & { last_check?: EnvironmentLastCheck | null },
  };
}

test('absent last_check is 尚无核对, not a dispatch outcome', () => {
  assert.equal(environmentLastCheck(view()), undefined);
  assert.match(String(environmentCheckCell(view())), /尚无核对/);
  assert.deepEqual(environmentCheckFacts(view())[0], ['最近核对', '尚无核对']);
});

test('null last_check is 未知', () => {
  const v = view(null);
  assert.equal(environmentLastCheck(v), null);
  assert.match(String(environmentCheckCell(v)), /未知/);
});

test('projected last_check shows time, confirmation word, and item rows', () => {
  const at = '2026-11-14T00:00:00.000Z';
  const v = view({
    at,
    items: [
      { name: '基线', ok: false, detail: '尚未登记所需基线', next_action: '请管理员登记基线' },
      { name: '网关版本', ok: true },
    ],
  });
  const cell = String(environmentCheckCell(v));
  assert.match(cell, /错误/);
  assert.match(cell, /1 项未通过/);
  const facts = environmentCheckFacts(v);
  assert.equal(facts[0]![0], '最近核对');
  assert.match(String(facts[0]![1]), /错误/);
  assert.equal(facts[1]![0], '基线');
  assert.match(String(facts[1]![1]), /错误/);
  assert.match(String(facts[1]![1]), /请管理员登记基线/);
});


test('recent checks derive presentation from each item rather than an aggregate outcome', () => {
  const at = '2026-11-14T00:00:00.000Z';
  assert.match(String(environmentCheckCell(view({ at, items: [{ name: '清单', ok: true }] }))), /已确认/);
  assert.match(String(environmentCheckCell(view({ at, items: [{ name: '清单', ok: true }, { name: '证据', ok: null }] }))), /未知/);
  assert.match(String(environmentCheckCell(view({ at, items: [{ name: '清单', ok: false }, { name: '证据', ok: null }] }))), /错误/);
});
