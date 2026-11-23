import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import type { PlatformContext, PlatformIo } from '../../platform/api.ts';
import { parseResetArguments, resetCommand } from './cli.ts';
import { resetData, ResetBlocked } from './host.ts';
import { freshDefinitionNextAction, quoteResetDefinitionPath, resetClearsAccounts, resetInspection, resetRequestProblems } from './inspection.ts';
import { parseResetRequest } from './types.ts';

const compatible = resetInspection({ status: 'compatible', compatible: true, expected: [], applied: [], problems: [] });
const ports = { exportConfiguration: async () => {}, restoreConfiguration: async () => {}, applyDefinition: async () => {} };
const file = "/synthetic/client/owner's $(printf EXPANDED) `printf BACKTICK`.json";
function untouchedContext() {
  const reads: string[] = [];
  return {
    context: new Proxy({}, { get(_target, property) { reads.push(String(property)); throw new Error('unexpected-context-access'); } }) as PlatformContext,
    reads,
  };
}

test('account-clearing combinations block definition before ports or filesystem work with exact three commands', () => {
  for (const scopes of ['all', ['config'], ['history', 'config']] as const) {
    const request = parseResetRequest({ scopes, definitionFile: file });
    const problems = resetRequestProblems(compatible, request, ports);
    assert.equal(resetClearsAccounts(request), true);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!.reason, /重置后没有管理员.*现在未改变任何东西/);
    assert.equal(problems[0]!.nextAction, freshDefinitionNextAction(file));
    assert.deepEqual(problems[0]!.nextAction.split('\n'), ['circle-hub reset --scope all', 'circle-hub init-admin', 'circle-hub apply ' + quoteResetDefinitionPath(file)]);
  }
});

test('preserved-account combinations allow definition, including keep-config and definition together', () => {
  for (const input of [
    { scopes: ['history'], definitionFile: file },
    { scopes: ['knowledge', 'packs'], definitionFile: file },
    { scopes: 'all', keepConfig: true, definitionFile: file },
    { scopes: ['config'], keepConfig: true, definitionFile: file },
  ]) assert.deepEqual(resetRequestProblems(compatible, parseResetRequest(input), ports), []);
});

test('definition choices match whether accounts survive, including confirmed incompatible all', () => {
  for (const choice of compatible.choices) {
    const request = parseResetRequest({ scopes: choice.scopes, keepConfig: choice.keepConfig });
    assert.equal(choice.definitionAllowed, !resetClearsAccounts(request));
  }
  const incompatible = resetInspection({ status: 'incompatible', compatible: false, expected: [], applied: [], problems: ['synthetic mismatch'] });
  assert.deepEqual(incompatible.choices, [{ scopes: 'all', keepConfig: false, definitionAllowed: false }]);
});

test('CLI resolves the exact local definition against its own cwd and preserves src references', () => {
  const parsed = parseResetArguments(['--scope', 'all', '--definition', "./owner's $(printf EXPANDED) `printf BACKTICK`.json"], '/synthetic/client');
  assert.equal(parsed.request!.definitionFile, file);
  const reference = 'src:' + 'a'.repeat(64);
  assert.equal(parseResetArguments(['--scope', 'history', '--definition', reference], '/synthetic/client').request!.definitionFile, reference);
  assert.throws(() => parseResetRequest({ scopes: ['history'], definitionFile: './unresolved.json' }));
});

test('POSIX single quoting preserves apostrophes and command substitutions as one literal argument', () => {
  const result = spawnSync('/bin/sh', ['-c', "printf '%s' " + quoteResetDefinitionPath(file)], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, file);
});

test('fresh resetData rejects without touching context, backup, service, keys or vault', async () => {
  const f = untouchedContext();
  let called = false;
  await assert.rejects(resetData(f.context, parseResetRequest({ scopes: 'all', definitionFile: file }), { applyDefinition: async () => { called = true; } }), error => {
    assert.ok(error instanceof ResetBlocked);
    assert.equal(error.problems[0]!.nextAction, freshDefinitionNextAction(file));
    return true;
  });
  assert.equal(called, false);
  assert.deepEqual(f.reads, []);
});

test('CLI fresh local paths get policy refusal and safe commands, not generic usage', async () => {
  const f = untouchedContext(), out: string[] = [], err: string[] = [];
  const io: PlatformIo = { cwd: '/synthetic/client', env: {}, stdout: line => out.push(line), stderr: line => err.push(line) };
  const code = await resetCommand(['--scope', 'all', '--definition', "./owner's $(printf EXPANDED) `printf BACKTICK`.json"], f.context, io);
  assert.equal(code, 1);
  assert.deepEqual(out, []);
  assert.match(err.join('\n'), /现在未改变任何东西/);
  assert.ok(err.includes(freshDefinitionNextAction(file)));
  assert.doesNotMatch(err.join('\n'), /用法：/);
  assert.deepEqual(f.reads, []);
});
