import assert from 'node:assert/strict';
import { test } from 'node:test';
import { embeddedProblems, type EmbeddedSkill } from './embedded.ts';
import type { PackManifest } from '../../../contracts/src/pack.ts';

const sha = (c: string): string => c.repeat(64);
const file = (path: string, c: string) => ({ path, sha256: sha(c), size: 1 });
const consumer = (files: PackManifest['files'], embeds: PackManifest['embeds'] = [{ pack: 'format', version: '1.0.0', module: 'reader' }]): PackManifest =>
  ({ schema: 'pack@1', id: 'work', version: '1.0.0', kind: 'workflow', title: 'Work', description: 'Synthetic', embeds, files });
const skill = (over: Partial<EmbeddedSkill> = {}): EmbeddedSkill => ({
  manifest: { schema: 'pack@1', id: 'format', version: '1.0.0', kind: 'skill', title: 'Format', description: 'Synthetic', files: [file('SKILL.md', 'a'), file('functions/modules/reader/index.ts', 'b'), file('functions/modules/reader/table.json', 'c'), file('skill.json', 'd')] },
  withdrawn: false, modules: ['reader'], ...over,
});
const rules = async (m: PackManifest, found: EmbeddedSkill | null = skill()) => (await embeddedProblems(m, async () => found)).map((p) => p.rule);
const both = [file('functions/generated/skills/format/reader/index.ts', 'b'), file('functions/generated/skills/format/reader/table.json', 'c')];

test('a pack carrying exactly the module of the named skill version passes', async () => {
  assert.deepEqual(await rules(consumer(both)), []);
});

test('a changed, missing or extra embedded file is refused by name', async () => {
  assert.deepEqual(await rules(consumer([file('functions/generated/skills/format/reader/index.ts', 'e'), both[1]])), ['embeds.file_differs']);
  assert.deepEqual(await rules(consumer([both[0]])), ['embeds.file_differs']);
  assert.deepEqual(await rules(consumer([...both, file('functions/generated/skills/format/reader/more.ts', 'f')])), ['embeds.file_differs']);
});

test('the skill version must be published, not withdrawn, and declare the module', async () => {
  assert.deepEqual(await rules(consumer(both), null), ['embeds.skill_missing']);
  assert.deepEqual(await rules(consumer(both), skill({ withdrawn: true })), ['embeds.skill_withdrawn']);
  assert.deepEqual(await rules(consumer(both), skill({ modules: [] })), ['embeds.module_undeclared']);
});

test('a file in the embedded folder that no declaration covers is refused', async () => {
  assert.deepEqual(await rules(consumer([file('functions/generated/skills/other/x/index.ts', 'a')], [])), ['embeds.file_undeclared']);
});
