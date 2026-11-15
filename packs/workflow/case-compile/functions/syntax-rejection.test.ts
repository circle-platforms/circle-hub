// The reference engine's one mechanical pre-judgement of a failed case: a lone caret is the device refusing to parse the command
// echoed directly above it (fail_attribution.attribute_fail, device_errors.parse_caret_positions). Synthetic sessions only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeFailed, syntaxRejections, type CaseOutcome } from './delivery.ts';

// The shape a bed session has: the command typed at a prompt, the device's echo of it, and the caret under the word it stopped at.
const TYPED_AT_THE_WRONG_PROMPT = ['seat(config)#exit', '', 'seat#widget sync to peer-b', '', 'widget sync to peer-b ', '^', '', 'seat#widget sync rollback peer-b', '', 'widget sync rollback peer-b ', '^', 'seat#conf ter', ''].join('\n');

test('a lone caret names the command echoed above it, the word under the caret and the prompt the command was typed at', () => {
  assert.deepEqual(syntaxRejections(TYPED_AT_THE_WRONG_PROMPT), [
    { command: 'widget sync to peer-b', token: 'widget', prompt: 'seat#' },
    { command: 'widget sync rollback peer-b', token: 'widget', prompt: 'seat#' },
  ]);
  // The caret column is read against the echo: under the third word here, and between two words it is the next one.
  assert.deepEqual(syntaxRejections('seat(config)#widget name too long\n\nwidget name too long\n            ^\n'), [{ command: 'widget name too long', token: 'too', prompt: 'seat(config)#' }]);
  assert.deepEqual(syntaxRejections('widget name too long\n           ^\n')[0].token, 'too');
  assert.deepEqual(syntaxRejections('widget name\r\n ^ \r\n'), [{ command: 'widget name', token: 'widget' }], 'no typed line left in the session: no prompt');
});

test('an echo that carries the prompt gives the command and the prompt but no word, since its columns are not the caret’s', () => {
  assert.deepEqual(syntaxRejections('seat#widget sync to peer-b\n     ^\n'), [{ command: 'widget sync to peer-b', prompt: 'seat#' }]);
});

test('what is not a rejection stays out: a caret inside text, a caret with nothing above it, an accepted command; repeats are listed once', () => {
  assert.deepEqual(syntaxRejections('seat(config)#widget match ^abc$\nseat(config)#\n'), []);
  assert.deepEqual(syntaxRejections('^\n'), []);
  assert.deepEqual(syntaxRejections('seat#show widget\n\n^\n'), [], 'a blank line above shares no frame with the caret');
  assert.deepEqual(syntaxRejections('seat(config)#widget name ok\nseat(config)#\n'), []);
  assert.deepEqual(syntaxRejections(''), []);
  assert.equal(syntaxRejections(`${TYPED_AT_THE_WRONG_PROMPT}\n${TYPED_AT_THE_WRONG_PROMPT}`).length, 2);
});

test('a case whose last device output holds a syntax rejection does not close as a defect candidate, however verbatim its quotes', () => {
  const failed = (autoid: string): CaseOutcome => ({ autoid, status: 'failed', history: [] } as unknown as CaseOutcome);
  const candidate = { repro: '合成复现', expected: '同步成功', actual: 'widget sync to peer-b' };
  const notes = { cases: { c1: { judged: '合成判断', remedy: '合成修法', defect_candidate: candidate }, c2: { judged: '合成判断', remedy: '合成修法', defect_candidate: { ...candidate, actual: 'sync refused by the peer' } } } };
  const authored = { c1: ['对端同步成功'], c2: ['对端同步成功'] };
  const texts = { c1: ['合成日志', TYPED_AT_THE_WRONG_PROMPT], c2: ['合成日志', 'seat(config)#widget sync to peer-b\nsync refused by the peer\nseat(config)#\n'] };
  const closed = closeFailed([failed('c1'), failed('c2')], notes, { c1: 3, c2: 1 }, authored, texts);
  assert.deepEqual(closed.cases.map((c) => c.closing), [undefined, 'device_defect'], 'the device accepted the command in c2 and refused to act: a candidate');
  assert.equal(closed.cases[0].pending!.length, 1);
  assert.match(closed.cases[0].pending![0], /用例 c1 判断设备的问题时，它最后一次上机里设备用 \^ 拒绝了命令 “widget sync to peer-b”（在 seat# 下）、“widget sync rollback peer-b”（在 seat# 下）。.*请重新判断原因，先修这条命令再做上机验证；最多重交 3 次，仍未核对正确时只陈述这些内容的核验结果，原因未查清就保留未知/);
  // Without the candidate the same case closes by its rounds, as before.
  const plain = closeFailed([failed('c1')], { cases: { c1: { judged: '合成判断', remedy: '合成修法' } } }, { c1: 3 }, authored, texts);
  assert.deepEqual([plain.cases[0].closing, plain.problems], ['authoring_failure', []]);
});
