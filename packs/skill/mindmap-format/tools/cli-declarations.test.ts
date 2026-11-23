import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const TOOLS = new URL('./', import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, TOOLS), 'utf8');

test('every executable tool of the skill declares its options and its empty standard input, as the parseArgs of the tool reads them', () => {
  const executables = readdirSync(TOOLS).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && read(name).includes('import.meta.main'));
  assert.deepEqual(executables.sort(), ['locate-quotes.ts', 'parse-model.ts']);
  for (const tool of executables) {
    const declaration = JSON.parse(read(tool.replace(/\.ts$/, '.cli.json'))) as { schema: string; stdin: string[]; options: Array<{ name: string; required: boolean; kind: string; type: string }> };
    const parsed = /parseArgs\(\{ options: \{([^}]*(?:\}[^}]*)*?)\}, strict: true \}\)/.exec(read(tool))?.[1] ?? '';
    const names = [...parsed.matchAll(/(\w+): \{ type: 'string' \}/g)].map((match) => match[1]);
    assert.equal(declaration.schema, 'tool-cli@2', tool);
    assert.deepEqual(declaration.stdin, [], tool);
    assert.deepEqual(declaration.options.map((option) => option.name), names, tool);
    assert.ok(declaration.options.every((option) => option.required && option.kind === 'string' && option.type === 'path'), tool);
  }
});

test('the skill text teaches both tools with the options they declare', () => {
  const skill = readFileSync(new URL('../SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /^---\nname: mindmap-format\ndescription: [^\n]+\n---\n/);
  for (const tool of ['parse-model', 'locate-quotes']) {
    const line = skill.split('\n').find((row) => row.includes(`/tools/${tool}.ts'`)) ?? '';
    const declared = (JSON.parse(read(`${tool}.cli.json`)) as { options: Array<{ name: string }> }).options.map((option) => `--${option.name}`);
    assert.deepEqual([...line.matchAll(/--[a-z]+/g)].map((match) => match[0]), declared, tool);
  }
});
