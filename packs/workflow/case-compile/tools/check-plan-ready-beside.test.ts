import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readyPlansBeside } from './check-plan.ts';

test('the ready plans of the other cases are found from a plan under cases/<k>/plan, and from nowhere else', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-beside-'));
  for (const [k, dir] of [['00', 'ready'], ['01', 'ready'], ['01', 'plan'], ['02', 'plan'], ['03', 'audit']] as const) mkdirSync(join(root, 'cases', k, dir), { recursive: true });
  writeFileSync(join(root, 'cases', '00', 'ready', '00.json'), '{"k":0}');
  writeFileSync(join(root, 'cases', '01', 'ready', '01.json'), '{"k":1}');
  writeFileSync(join(root, 'cases', '01', 'ready', 'notes.txt'), 'not a plan');
  writeFileSync(join(root, 'cases', '01', 'plan', '01.json'), '{"k":"own"}');
  writeFileSync(join(root, 'cases', '02', 'plan', '02.json'), '{"k":"not ready"}');
  assert.deepEqual(readyPlansBeside(join(root, 'cases', '01', 'plan', '01.json')), [{ path: 'cases/00/ready/00.json', text: '{"k":0}' }], 'its own ready copy and plans that are not ready are left out');
  assert.deepEqual(readyPlansBeside(join(root, 'cases', '02', 'plan', '02.json')).map((row) => row.path), ['cases/00/ready/00.json', 'cases/01/ready/01.json']);
  mkdirSync(join(root, 'plans'), { recursive: true }); writeFileSync(join(root, 'plans', '01.json'), '{}');
  assert.deepEqual(readyPlansBeside(join(root, 'plans', '01.json')), [], 'a collected plan directory is not the pipeline layout');
  assert.deepEqual(readyPlansBeside(join(root, 'nowhere', 'plan', '01.json')), []);
});
