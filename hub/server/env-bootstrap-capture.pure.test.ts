import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProtocolError } from '../../contracts/src/common.ts';
import { resolveCallErrorReason } from '../../contracts/generated/protocol.ts';
import { buildCommandArgv, parseCommandParameters, commandParameterHelp } from './command-parameters.ts';
import { registrationIncompletePresentation } from './env-bootstrap-capture.ts';

const error: ProtocolError = { code: 'SOURCE_NOT_PERMITTED', call_error_reason: 'environment_registration_incomplete', object_kind: 'test_environment', message: 'PRIVATE raw target and resource keys', fix: 'PRIVATE administrator command' };

test('incomplete registration uses the generated missing prerequisite category and member action without private diagnostics', () => {
  const result = registrationIncompletePresentation(error, 'user', 'PRIVATE executor');
  assert.equal(result?.category, '不存在');
  assert.equal(result?.next, resolveCallErrorReason(error.code, error.call_error_reason!, 'user')?.nextAction);
  assert.match(result!.fact, /尚未声明资源清单/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|circle-hub|没有使用/);
});

test('only the exact new tuple selects the new presentation without parsing prose', () => {
  assert.equal(registrationIncompletePresentation({ ...error, code: 'SOURCE_UNAVAILABLE' }, 'user'), null);
  assert.equal(registrationIncompletePresentation({ ...error, call_error_reason: 'environment_unassigned' }, 'user'), null);
  assert.equal(registrationIncompletePresentation({ ...error, object_kind: 'pack' }, 'user'), null);
  assert.equal(registrationIncompletePresentation({ ...error, call_error_reason: undefined }, 'user'), null);
});

test('administrator commands use registered parameters and safely quote literal executor values', () => {
  const executor = "synthetic'$(touch forbidden)`command`";
  const result = registrationIncompletePresentation(error, 'admin', executor)!;
  const argv = buildCommandArgv('job.precheck', { executor });
  assert.deepEqual(argv, ['job', 'precheck', `--executor=${executor}`]);
  assert.equal(parseCommandParameters('job.precheck', argv.slice(2)).values.executor, executor);
  assert.ok(result.next.startsWith(resolveCallErrorReason(error.code, error.call_error_reason!, 'admin')!.nextAction!));
  assert.ok(result.next.includes("'\\''"));
  assert.ok(result.next.includes(commandParameterHelp('executor.update')));
  assert.doesNotMatch(result.next, /PRIVATE/);
});

test('administrator without authorized executor context gets no invented command and only authorized display names are used', () => {
  assert.doesNotMatch(registrationIncompletePresentation(error, 'admin')!.next, /circle-hub/);
  assert.match(registrationIncompletePresentation({ ...error, environment_display_name: '合成环境' }, 'user')!.fact, /合成环境/);
});

import { toolText } from './text.ts';
import { renderCallError } from './call-error-category.ts';

test('both MCP error exits prioritize the formal cause over the old permission category', () => {
  const inputs = [
    ['list_task_packs', { call_result: 'error', errors: [error], trace: 'synthetic' }],
    ['submit_result', { acceptance: 'rejected', errors: [error] }],
  ] as const;
  for (const [tool, value] of inputs) {
    const text = toolText(tool, value, { caller: { role: 'user' } });
    assert.match(text, /不存在：.*尚未声明资源清单/);
    assert.doesNotMatch(text, /无权限|PRIVATE|pack assign/);
  }
  assert.match(renderCallError(error, 'user', error.fix)!, /^不存在：/);
});

test('accepted dispatch note uses the same formal cause first and never rewrites a member private message', () => {
  const note = { text: 'PRIVATE raw message', error_code: error.code, call_error_reason: error.call_error_reason, outcome: 'not_dispatched', executor: 'PRIVATE internal executor' };
  const payload = { acceptance: 'accepted', errors: [], dispatch: [note] };
  const member = toolText('submit_result', payload, { caller: { role: 'user' } });
  assert.match(member, /不存在：.*尚未声明资源清单/);
  assert.doesNotMatch(member, /PRIVATE|无权限|circle-hub/);
  const admin = toolText('submit_result', payload, { caller: { role: 'admin' } });
  assert.match(admin, /circle-hub 'job' 'precheck'/);
  assert.match(admin, /executor update/);
});

import { bootstrapCapturePresentation } from './env-bootstrap-capture.ts';
const reference = `src:${'a'.repeat(64)}`;

test('capture completion comes from both actual journal records and their matching report, never verification or effect outcome', () => {
  const details = [
    { phase: 'reservation', bootstrap_capture: true, read_only: true },
    { phase: 'result', bootstrap_capture: true, capture_completed: true, reference },
    { phase: 'complete', bootstrap_capture: true, capture_completed: true, readonly_verified: false, registration_ready: false, outcome: 'not_dispatched' },
  ];
  const result = bootstrapCapturePresentation(details, 'synthetic-executor', reference)!;
  assert.equal(result.exitCode, 0);
  assert.match(result.lines.join('\n'), /只读采集已完成/);
  assert.match(result.lines.join('\n'), /登记尚未完成/);
  assert.ok(result.lines.some(line => line.includes(reference)));
  assert.doesNotMatch(result.lines.join('\n'), /设备输出已取回|验证已通过/);
  assert.equal(bootstrapCapturePresentation(details, 'synthetic-executor', `src:${'b'.repeat(64)}`)!.exitCode, 1);
});

test('partial observations and initial credential failure do not claim completed capture or invent a report', () => {
  const reserved = { phase: 'reservation', bootstrap_capture: true, read_only: true };
  const noReport = bootstrapCapturePresentation([reserved], 'synthetic-executor')!;
  assert.equal(noReport.exitCode, 1);
  assert.match(noReport.lines.join('\n'), /报告引用尚未取得/);
  assert.doesNotMatch(noReport.lines.join('\n'), /src:/);
  const partial = bootstrapCapturePresentation([reserved,
    { phase: 'result', bootstrap_capture: true, capture_completed: false, reference },
    { phase: 'complete', bootstrap_capture: true, capture_completed: false, readonly_verified: true, outcome: 'effective' },
  ], 'synthetic-executor', reference)!;
  assert.equal(partial.exitCode, 1);
  assert.match(partial.lines.join('\n'), /没有完整的只读采集观察/);
  assert.equal(bootstrapCapturePresentation([{ phase: 'complete', readonly_verified: true }], 'synthetic-executor'), null);
});
