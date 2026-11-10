// The reference engine's one mechanical pre-judgement of a failed case: a lone caret is the device refusing to parse the command
// echoed directly above it (fail_attribution.attribute_fail, device_errors.parse_caret_positions). Synthetic sessions only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { syntaxRejections } from './delivery.ts';

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
