// Model 42 (decisions 150 and 151): teams, team spaces and per-resource credential acceptance. The model only appends rules
// (R01 R[13], K02 R[8]), so the rules that cite them by number resolve, and each element that changed says which owner
// decision it follows. No protocol code, record kind or vocabulary axis is added; the generated files change by the model
// version and by one value of the `audience_scope` axis.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { AUDIENCE_SCOPE, labelOf, uiLabelOf } from '../generated/vocabulary.ts';

const model = JSON.parse(readFileSync(new URL('../model.json', import.meta.url), 'utf8')) as {
  elements: Array<{ id: string; fields: string[]; rules: string[]; changes42?: string[] }>;
  displayRules: Array<{ rule: string }>;
};
const element = (id: string) => model.elements.find((e) => e.id === id)!;

test('R01 R[13] and K02 R[8] are appended and the rules that cite them by number resolve', () => {
  assert.equal(element('R01').rules.length, 14);
  assert.ok(element('R01').rules[13].startsWith('团队是管理员命名的一组启用账户'));
  assert.equal(element('K02').rules.length, 9);
  assert.ok(element('K02').rules[8].startsWith('条目文字给不给读者'));
  for (const [id, index] of [['T01', 3], ['C02', 2], ['D05', 3]] as const) assert.ok(element(id).rules[index].includes('R01 R[13]'), `${id} R[${index}]`);
  assert.ok(element('D06').fields[3].includes('K02 R[8]'));
  // B02 R[4] was rewritten by mainline decision 154 (no credential scan on new content); B01 R[7]
  // possible_credentials remains for claims that still rest on older retain-only sources.
  assert.ok(element('B02').rules[4].includes('不做凭据扫描'));
  assert.ok(element('B01').rules[7].includes('possible_credentials'));
});

test('the display rule and R02 R[1] carry the same exception for a tree entry whose source has no acceptance', () => {
  const exception = '例外：产品知识条目依据的来源没有有效接受时，条目照列并标没有权限阅读，不给文字（D05 R[3]、B02 R[4]）。';
  assert.ok(model.displayRules[9].rule.endsWith(exception));
  assert.ok(element('R02').rules[1].endsWith(exception));
});

test('a team space has its own audience code and the Hub-wide team code keeps its text', () => {
  assert.ok(AUDIENCE_SCOPE.includes('team_members'));
  assert.equal(labelOf('audience_scope', 'team_members'), '该团队的成员');
  assert.equal(uiLabelOf('audience_scope', 'team_members'), '团队成员可见');
  assert.equal(labelOf('audience_scope', 'team'), '全体成员（团队）');
  assert.equal(uiLabelOf('audience_scope', 'team'), '全员可见');
});

test('every element that model 42 changed names the owner decision it follows', () => {
  const changed = model.elements.filter((e) => e.changes42 !== undefined);
  assert.deepEqual(changed.map((e) => e.id).sort(), ['B01', 'B02', 'B03', 'B04', 'C01', 'C02', 'C04', 'D05', 'D06', 'K01', 'K02', 'R01', 'R02', 'T01', 'T02', 'V03', 'W09']);
  for (const e of changed) for (const note of e.changes42!) assert.match(note, /（来源：决定 15[01]，所有者 2026-11-06）$/, e.id);
});
