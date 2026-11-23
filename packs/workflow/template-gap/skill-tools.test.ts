import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

test('the skill uses available Hub tools and requests the command-tree identity', () => {
  const text = readFileSync(new URL('./SKILL.md', import.meta.url), 'utf8');
  assert.ok(text.includes('list_task_packs'));
  assert.ok(!text.includes('get_workflow'));
  assert.ok(text.includes('start_run'));
  const fields = 'fields=document,node,commands,command_identities,title,path_labels,object,command_tree_root';
  assert.equal(text.split(fields).length - 1, 2);
  assert.ok(text.includes('投影可能在后台继续'));
});

test('the skill says when it applies and names only what the installed packs have: shipped tables, and tools with the options they declare', () => {
  const text = readFileSync(new URL('./SKILL.md', import.meta.url), 'utf8');
  assert.match(text, /^---\nname: template-gap\ndescription: [^\n]*时使用[^\n]*\n---\n/);
  assert.ok(!text.includes('README'), 'the README is not installed with the pack');
  for (const table of text.match(/tables\/[\w.-]+\.json/g) ?? []) assert.ok(existsSync(new URL(`./${table}`, import.meta.url)) || existsSync(new URL(`../knowledge-contribution/${table}`, import.meta.url)), table);
  assert.ok(text.includes('`tables/template-v3-coverage.json`'));
  const declared = (path: URL): string[] => (JSON.parse(readFileSync(path, 'utf8')) as { options: Array<{ name: string }> }).options.map((option) => `--${option.name}`);
  const tools: Array<[string, URL]> = [
    ["<mindmap格式目录>/tools/parse-model.ts'", new URL('../../skill/mindmap-format/tools/parse-model.cli.json', import.meta.url)],
    ["<mindmap格式目录>/tools/locate-quotes.ts'", new URL('../../skill/mindmap-format/tools/locate-quotes.cli.json', import.meta.url)],
    ["<技能目录>/tools/prepare-claims.ts'", new URL('./tools/prepare-claims.cli.json', import.meta.url)],
  ];
  for (const [tool, cli] of tools) {
    const command = /`node '([^`]+)`/g;
    const taught = [...text.matchAll(command)].map((match) => match[1]!).find((line) => line.startsWith(tool));
    assert.ok(taught, tool);
    assert.deepEqual(taught!.match(/--[a-z]+/g), declared(cli), tool);
  }
});
