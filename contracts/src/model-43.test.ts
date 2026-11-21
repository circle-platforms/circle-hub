import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { EMBEDDED_SKILLS_DIR, PackManifest, SKILL_MODULES_DIR, SkillDeclaration } from './pack.ts';

const model = JSON.parse(readFileSync(new URL('../model.json', import.meta.url), 'utf8')) as {
  version: number;
  elements: Array<{ id: string; definition: string; fields: string[]; rules: string[]; changes43?: string[] }>;
};
const element = (id: string) => model.elements.find((e) => e.id === id)!;

test('T01 names four kinds of pack and how a workflow is composed', () => {
  assert.ok(model.version >= 43);
  assert.ok(element('T01').definition.includes('通用技能包'));
  assert.equal(element('T01').rules.length, 7);
  assert.ok(element('T01').rules[6].startsWith('工作流由通用技能模块、验收要求和数据绑定组成'));
  assert.ok(element('T01').fields[13].startsWith('通用技能模块'));
  assert.ok(element('T01').fields[14].startsWith('内嵌声明'));
});

test('C02 no longer sends everything generic to the Hub core, and C03 keeps the word plugin technical', () => {
  assert.ok(element('C02').rules[2].includes('通用技能包'));
  assert.ok(element('C03').rules[5].includes('都称连接'));
});

test('every element that model 43 changed names the owner decision it follows', () => {
  const changed = model.elements.filter((e) => e.changes43?.some((note) => /所有者 2026-11-06/.test(note)));
  assert.deepEqual(changed.map((e) => e.id).sort(), ['C02', 'C03', 'T01']);
  for (const e of changed) for (const note of e.changes43!.filter((n) => /所有者 2026-11-06/.test(n))) {
    assert.match(note, /（来源：决定 15[34]，所有者 2026-11-06）$/, e.id);
  }
});

test('a skill may declare modules and a pack may embed them; both stay optional', () => {
  assert.ok(SkillDeclaration.safeParse({ schema: 'skill@1', parsers: [] }).success);
  assert.ok(SkillDeclaration.safeParse({ schema: 'skill@1', parsers: [], modules: [{ id: 'case-reader', title: '用例读取', family: '测试脑图' }] }).success);
  assert.ok(!SkillDeclaration.safeParse({ schema: 'skill@1', parsers: [], modules: [{ id: 'Bad Name', title: 'x', family: 'y' }] }).success);
  const base = { schema: 'pack@1', id: 'sample', version: '1.0.0', kind: 'skill', title: 'Sample', description: 'Synthetic', files: [{ path: 'SKILL.md', sha256: 'a'.repeat(64), size: 1 }, { path: 'skill.json', sha256: 'b'.repeat(64), size: 1 }] };
  assert.ok(PackManifest.safeParse(base).success);
  assert.ok(PackManifest.safeParse({ ...base, embeds: [{ pack: 'format', version: '1.0.0', module: 'reader' }] }).success);
  assert.ok(!PackManifest.safeParse({ ...base, embeds: [{ pack: 'format', version: '1.0.0', module: 'reader' }, { pack: 'format', version: '1.0.1', module: 'reader' }] }).success);
});

test('the generator writes to the folders the contract names', () => {
  const tool = readFileSync(new URL('../../tools/gen-contracts.ts', import.meta.url), 'utf8');
  assert.ok(tool.includes(`const SKILL_MODULES_DIR = '${SKILL_MODULES_DIR}'`));
  assert.ok(tool.includes(`const EMBEDDED_SKILLS_DIR = '${EMBEDDED_SKILLS_DIR}'`));
});
