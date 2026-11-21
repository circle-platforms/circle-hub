import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const SKILLS: ReadonlyArray<[string, string]> = [
  ['skill/plumb/SKILL.md', 'plumb'],
  ['skill/command-tools/SKILL.md', 'command-tools'],
  ['skill/run-tools/SKILL.md', 'run-tools'],
  ['skill/runner-workbook/SKILL.md', 'runner-workbook'],
  ['skill/mindmap-format/SKILL.md', 'mindmap-format'],
  ['skill/hub-observability/SKILL.md', 'hub-observability'],
  ['workflow/test-bed/SKILL.md', 'test-bed'],
  ['workflow/template-gap/SKILL.md', 'template-gap'],
  ['workflow/defect-to-case/SKILL.md', 'defect-to-case'],
  ['workflow/story-traceability/SKILL.md', 'story-traceability'],
  ['workflow/knowledge-contribution/SKILL.md', 'knowledge-contribution'],
  ['workflow/knowledge-contribution/tools/jev/SKILL.md', 'jev'],
  ['workflow/knowledge-contribution/tools/operation-capture/SKILL.md', 'operation-capture'],
  ['workflow/case-compile/SKILL.md', 'case-compile'],
  ['workflow/case-compile/recompose/SKILL.md', 'recompose'],
];

test('every skill a client loads names itself and says in Chinese when it applies', () => {
  for (const [path, name] of SKILLS) {
    const text = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    const head = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n/.exec(text);
    assert.ok(head, `${path}: frontmatter`);
    assert.equal(head![1], name, path);
    const description = head![2]!;
    assert.match(description, /\p{Script=Han}/u, path);
    assert.match(description, /时使用|内嵌使用|用于/, `${path}: when it applies`);
    assert.doesNotMatch(description, /[A-Za-z]+ [A-Za-z]+ [A-Za-z]+/, `${path}: no English sentence`);
    assert.ok(description.length <= 1024, path);
  }
});
