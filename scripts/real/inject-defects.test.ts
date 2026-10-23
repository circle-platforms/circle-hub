import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('review 8: CLI refusals hide plan values and save full diagnostics privately', t => {
  const out = mkdtempSync(join(tmpdir(), 'review-refusal-')); t.after(() => rmSync(out, { recursive: true, force: true }));
  const source = join(out, 'source.json'), plan = join(out, 'plan.json'), manual = join(out, 'manual.txt');
  writeFileSync(source, JSON.stringify({ root: { data: { id: 'private-case-id', text: 'private-title', resource: ['configuration'], priority: 2 }, children: [{ data: { id: 'expected', text: 'before' }, children: [] }] } }));
  writeFileSync(plan, JSON.stringify([{ label: 'private-label', seen_by: 'judgment', op: { kind: 'contradict_manual', node: 'private-case-id', from: 'before', to: 'after', quote: 'private-manual-quote' } }])); writeFileSync(manual, 'another fragment');
  const run = spawnSync(process.execPath, ['scripts/real/inject-defects.ts', '--source', source, '--plan', plan, '--manual', manual, '--out', out], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  for (const value of ['private-case-id', 'private-label', 'private-manual-quote', 'private-title']) assert.ok(!(run.stdout + run.stderr).includes(value));
  assert.match(run.stderr, /计划第 1 条/);
  assert.ok(readFileSync(join(out, 'refusal.txt'), 'utf8').includes('private-manual-quote'));
  assert.equal(statSync(join(out, 'refusal.txt')).mode & 0o777, 0o600);
});
