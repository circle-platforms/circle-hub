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
  // 主张已经接到受理记录的谱系上。旧提交号不再写在 README 里。
  assert.match(text, /linked to the accepted validation record through the\nnormal result\/slot lineage/);
  assert.match(text, /StartRunOutput/); assert.match(text, /PackError/);
});
test('README describes exact header comparison and the matched current command universe', () => {
  const text = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /Every node text is normalized|each command present in its admitted index/);
  // 现行规则比的是当前修订的标题和 path_labels，对不上的用例不能沿用旧归属。
  assert.match(text, /Headers and ordered path_labels\nmust equal the current case revision exactly/);
  assert.match(text, /changed or unmatched cases cannot contribute stale memberships/);
});
test('extending producer scan inputs requires a complete per-case revision contract first', () => {
  const text = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /steps\/expected results without\s+changing this consumer/);
  // 扩大扫描范围的步骤修改，要先有完整的逐用例修订合约。对不上的用例是另一句，不能贡献旧归属。
  assert.match(text, /A step edit that expands the producer's scan scope requires a complete\nper-case revision contract first/);
  assert.match(text, /changed or unmatched cases cannot contribute stale memberships/);
});
