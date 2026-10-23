import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
test('README retains numbered deviations and unresolved cross-package needs', () => {
  const text = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
  assert.match(text, /## Decisions and deviations/);
  for (const number of [1, 5, 6, 7, 13]) assert.match(text, new RegExp(`\\n${number}\\. \\*\\*`));
  assert.match(text, /## Needs from other packages/);
  for (const term of ['StartRunOutput', 'PackError', 'quadratic', 'coverage@1']) assert.ok(text.includes(term), term);
  for (const number of [4, 5, 6, 7]) assert.match(text.slice(text.indexOf('## Open questions')), new RegExp(`\\n${number}\\. `));
});
test('README distinguishes implemented claim marks and record links from remaining typed contracts', () => {
  const text = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /engine does not put the mark|asserts it as a `todo`|context\.record` is null|today's answer does not/);
  assert.ok(text.includes('437cbad5') && text.includes('3086bf44'));
  assert.match(text, /StartRunOutput/); assert.match(text, /PackError/);
});
