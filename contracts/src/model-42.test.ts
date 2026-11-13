// Model 42 (decisions 150 and 151): teams, team spaces and per-resource credential acceptance. The model only appends rules
// (R01 R[13], K02 R[8]), so the rules that cite them by number resolve, and each element that changed says which owner
// decision it follows. No protocol code, record kind or vocabulary axis is added; the generated files change by the model
// version and by one value of the `audience_scope` axis.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { AUDIENCE_SCOPE, PermissionKindSchema, labelOf, uiLabelOf } from '../generated/vocabulary.ts';

import { TeamId, TeamAssignmentSubject } from './common.ts';

const model = JSON.parse(readFileSync(new URL('../model.json', import.meta.url), 'utf8')) as {
  elements: Array<{ id: string; fields: string[]; rules: string[]; changes42?: string[] }>;
  displayRules: Array<{ rule: string }>;
};
const element = (id: string) => model.elements.find((e) => e.id === id)!;

test('R01 R[13] and K02 R[8] are appended and the rules that cite them by number resolve', () => {
  assert.ok(element('R01').rules.length >= 14);
  assert.ok(element('R01').rules[13].startsWith('团队是管理员命名的一组启用账户'));
  assert.ok(element('K02').rules.length >= 9);
  assert.ok(element('K02').rules[8].startsWith('条目文字给不给读者'));
  for (const [id, index] of [['T01', 3], ['C02', 2]] as const) assert.ok(element(id).rules[index].includes('R01 R[13]'), `${id} R[${index}]`);
  // D05 R[3] cited R01 R[13] only in the pending-review clause; decision 161 removed that answer (model 51).
  assert.ok(element('D05').rules[3].includes('不再答“X 存在，内容待核看”'));
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


test('the approved team identity and resource assignment use shared contracts', () => {
  const id = 'tm_0' + 'a'.repeat(25);
  assert.equal(TeamId.parse(id), id);
  assert.ok(TeamId.safeParse('tm_7' + 'z'.repeat(25)).success);
  for (const invalid of ['tm_8' + 'a'.repeat(25), 'tm_0' + 'A'.repeat(25), 'tm_0' + 'i'.repeat(25), 'tm_' + 'a'.repeat(25)]) {
    assert.equal(TeamId.safeParse(invalid).success, false, invalid);
  }
  assert.equal(TeamAssignmentSubject.parse('*'), '*');
  assert.equal(TeamAssignmentSubject.parse(id), id);
  assert.equal(TeamAssignmentSubject.safeParse('usr_0' + 'a'.repeat(25)).success, false);
  assert.equal(PermissionKindSchema.parse('resource_assign'), 'resource_assign');
  assert.equal(labelOf('permission_kind', 'resource_assign'), '业务系统资源分配');
  const rule = element('B04').rules.at(-1)!;
  for (const text of ['authorization@1','subject=*','object=TeamId','subject=UserId','resource_assign','同一事务','可从记录重建']) assert.ok(rule.includes(text), text);
});


test('the owner decision revokes deleted team assignments and keeps the shared space public', () => {
  const assignment = element('B04').rules.at(-1)!;
  for (const text of ['每一条工作流分配和资源分配','revoked=true','同一事务','不能仅保留原分配']) assert.ok(assignment.includes(text), text);
  const team = element('R01').rules[13];
  for (const text of ['只有管理员','多个团队','直接分给本人','并集','逐条','revoked=true','自己所属团队的名字','没有独立知识空间','对任何账户都不开放','decisions-1500.md']) {
    assert.ok(team.includes(text === '逐条' ? '每一条' : text), text);
  }
  assert.ok(!element('R01').rules[2].includes('管理员默认可读全部资源'));
  for (const axis of ['knowledge_space_kind','knowledge_search_scope']) {
    assert.equal(labelOf(axis, 'team'), '公共空间');
    assert.equal(uiLabelOf(axis, 'team'), '公共空间');
  }
  const space = element('K01');
  assert.ok(space.definition.includes('内部编号仍为 team'));
  assert.ok(space.definition.includes('本轮新建团队不拥有独立知识空间'));
  assert.equal(labelOf('audience_scope','team_members'), '该团队的成员');
});
