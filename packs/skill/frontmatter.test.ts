import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const SKILLS: ReadonlyArray<[string, string]> = [
  ['skill/adoc-format/SKILL.md', 'adoc-format'],
  ['skill/command-tools/SKILL.md', 'command-tools'],
  ['skill/html-format/SKILL.md', 'html-format'],
  ['skill/hub-observability/SKILL.md', 'hub-observability'],
  ['skill/jev-judge/SKILL.md', 'jev-judge'],
  ['skill/mindmap-format/SKILL.md', 'mindmap-format'],
  ['skill/plumb/SKILL.md', 'plumb'],
  ['skill/run-tools/SKILL.md', 'run-tools'],
  ['skill/runner-workbook/SKILL.md', 'runner-workbook'],
  ['skill/workbook-format/SKILL.md', 'workbook-format'],
  ['skill/xml-format/SKILL.md', 'xml-format'],
  ['workflow/bed-install/SKILL.md', 'bed-install'],
  ['workflow/case-compile/SKILL.md', 'case-compile'],
  ['workflow/case-compile/adjudicate/SKILL.md', 'recompose-adjudication'],
  ['workflow/case-compile/authority/SKILL.md', 'recompose-authority'],
  ['workflow/case-compile/recompose/SKILL.md', 'recompose'],
  ['workflow/case-compile/review/SKILL.md', 'case-compile-criterion-review'],
  ['workflow/case-location/SKILL.md', 'case-location'],
  ['workflow/case-review/SKILL.md', 'case-review'],
  ['workflow/case-review-report/SKILL.md', 'case-review-report'],
  ['workflow/case-review-verify/SKILL.md', 'case-review-verify'],
  ['workflow/criterion-review/SKILL.md', 'criterion-review'],
  ['workflow/defect-to-case/SKILL.md', 'defect-to-case'],
  ['workflow/knowledge-contribution/SKILL.md', 'knowledge-contribution'],
  ['workflow/knowledge-contribution/tools/jev/SKILL.md', 'jev'],
  ['workflow/knowledge-contribution/tools/operation-capture/SKILL.md', 'operation-capture'],
  ['workflow/maintenance-sweep/SKILL.md', 'maintenance-sweep'],
  ['workflow/quality-board/SKILL.md', 'quality-board'],
  ['workflow/regression-scope/SKILL.md', 'regression-scope'],
  ['workflow/source-read/SKILL.md', 'source-read'],
  ['workflow/story-traceability/SKILL.md', 'story-traceability'],
  ['workflow/template-gap/SKILL.md', 'template-gap'],
  ['workflow/test-bed/SKILL.md', 'test-bed'],
  ['workflow/traceability/SKILL.md', 'traceability'],
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
