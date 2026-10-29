import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandSampleSubjects } from '../testing/command-samples.ts';
import { ROOT } from '../testing/index.ts';
import { commandOutcomes } from './command-check.ts';

test('a missing command-tree source leaves coverage unknown', () => {
  const declared = structuredClone(commandSampleSubjects()[0].subject);
  for (const entry of Object.values(declared.index.entries) as any[]) entry.data.command_tree_root = ROOT;
  assert.ok(commandOutcomes(declared).some(outcome => outcome.verdict === 'support'));
  for (const missing of ['absent', 'null'] as const) {
    const subject = structuredClone(declared);
    for (const entry of Object.values(subject.index.entries) as any[]) {
      if (missing === 'absent') delete entry.data.command_tree_root;
      else entry.data.command_tree_root = null;
    }
    const outcomes = commandOutcomes(subject);
    assert.ok(outcomes.some(outcome => outcome.verdict === 'unknown' && JSON.stringify(outcome.data).includes('command_tree_root')));
    assert.ok(!outcomes.some(outcome => outcome.verdict === 'support' || outcome.verdict === 'refute'));
  }
  const mismatched = structuredClone(declared);
  for (const entry of Object.values(mismatched.index.entries) as any[]) entry.data.command_tree_root = 'f'.repeat(64);
  assert.ok(commandOutcomes(mismatched).some(outcome => outcome.verdict === 'unknown'));
  assert.ok(!commandOutcomes(mismatched).some(outcome => outcome.verdict === 'support' || outcome.verdict === 'refute'));
});

test('an empty command set still needs a valid declared tree source', () => {
  const empty = structuredClone(commandSampleSubjects()[0].subject);
  for (const entry of Object.values(empty.index.entries) as any[]) {
    entry.data.commands = [];
    entry.data.command_identities = [];
    entry.data.command_tree_root = ROOT;
  }
  assert.ok(commandOutcomes(empty).some(outcome => outcome.verdict === 'refute' && outcome.code === 'template-gap.no_commands'));
  const malformed = structuredClone(empty);
  for (const entry of Object.values(malformed.index.entries) as any[]) entry.data.command_tree_root = 'not-a-digest';
  const outcomes = commandOutcomes(malformed);
  assert.ok(outcomes.some(outcome => outcome.verdict === 'unknown'));
  assert.ok(!outcomes.some(outcome => outcome.verdict === 'support' || outcome.verdict === 'refute'));
});
