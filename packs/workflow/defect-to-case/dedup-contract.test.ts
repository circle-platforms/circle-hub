import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkDuplicate } from './functions/checks.ts';
import { SYNTHETIC_CATALOG, SYNTHETIC_INDEX_VIEW, makeGoodDraft } from './testing/fixtures.ts';

function check(title: string, expected: string) {
  const view = structuredClone(SYNTHETIC_INDEX_VIEW);
  const candidate = Object.values(view.entries)[0];
  candidate.data.title = '合成 Widget 标题';
  candidate.data.expected_texts = ['合成期望'];
  const draft = makeGoodDraft();
  draft.title = title; draft.steps = [{ command: 'show health detail' }]; draft.expected = [{ text: expected }];
  return checkDuplicate({ subject: { item: 'synthetic-defect', drafts: [draft], indexed_cases: view }, catalog: SYNTHETIC_CATALOG });
}
test('dedup contract promises normalized titles rather than expected-text comparison', () => {
  const requirements = JSON.parse(readFileSync(new URL('./requirements.json', import.meta.url), 'utf8'));
  const requirement = requirements.requirements.find((r: { key: string }) => r.key === 'not_duplicate');
  assert.match(requirement.description, /规范化标题相同/);
  assert.doesNotMatch(requirement.description, /或规范化期望结果相同/);
  const skill = readFileSync(new URL('./SKILL.md', import.meta.url), 'utf8');
  assert.doesNotMatch(skill, /标题或期望结果相同/);
});
test('identical expectations with different titles are not duplicates', () => {
  assert.equal(check('另一个合成标题', '合成期望')[0].verdict, 'support');
});
test('normalized equal titles are duplicates even when expectations differ', () => {
  const result = check('  合成\tＷＩＤＧＥＴ\u00A0标题 ', '另一段期望');
  assert.equal(result[0].verdict, 'refute'); assert.equal(result[0].code, 'defect-to-case.duplicate_case');
});
