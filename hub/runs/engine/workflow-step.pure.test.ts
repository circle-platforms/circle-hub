import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RequirementsFile, WorkflowFile } from '../../../contracts/src/pack.ts';
import { workflowPack } from '../packs/testing/builder.ts';
import { stepNameForScope } from './workflow-step.ts';

function fixture() {
  const pack = workflowPack();
  const workflow = WorkflowFile.parse(pack.files['workflow.json']);
  const requirements = RequirementsFile.parse(pack.files['requirements.json']).requirements;
  return {
    workflow: { ...workflow, steps: [{ id: 'plan', name: '合成计划' }, { id: 'review', name: '合成复核' }] },
    requirements: requirements.map(requirement => ({ ...requirement, step: 'plan' })),
  };
}
const scope = (...keys: string[]) => ({ requirements: new Set(keys), complete: true });

test('a nonempty producer-witnessed set selects only its explicit unique step', () => {
  const source = fixture();
  assert.equal(stepNameForScope(source, scope('titles', 'findings', 'titles')), '合成计划');
});

test('all checked requirements including missing-input or unknown requirements stay in the scope', () => {
  const source = fixture();
  source.requirements[1].step = 'review';
  assert.equal(stepNameForScope(source, scope('titles', 'findings')), undefined);
});

test('equal display names never unify distinct declared step identities', () => {
  const source = fixture();
  source.workflow.steps[1].name = source.workflow.steps[0].name;
  source.requirements[1].step = 'review';
  assert.equal(stepNameForScope(source, scope('titles', 'findings')), undefined);
});

test('missing producer scope, partial scope, empty scope and old cached responses remain neutral', () => {
  const source = fixture();
  assert.equal(stepNameForScope(source), undefined);
  assert.equal(stepNameForScope(source, { requirements: new Set(['titles']), complete: false }), undefined);
  assert.equal(stepNameForScope(source, scope()), undefined);
});

test('missing declarations and unresolved requirement or step references never guess a stage', () => {
  const source = fixture();
  assert.equal(stepNameForScope({ ...source, workflow: { ...source.workflow, steps: undefined } }, scope('titles')), undefined);
  assert.equal(stepNameForScope(source, scope('not_registered')), undefined);
  assert.equal(stepNameForScope({ ...source, requirements: source.requirements.map(row => ({ ...row, step: undefined })) }, scope('titles')), undefined);
  source.requirements[0].step = 'not_registered';
  assert.equal(stepNameForScope(source, scope('titles')), undefined);
});

test('the frozen declaration determines the name independently of a subsequently published version', () => {
  const frozen = fixture(), later = structuredClone(frozen);
  later.workflow.steps[0].name = '后发布的新名字';
  assert.equal(stepNameForScope(frozen, scope('titles')), '合成计划');
  assert.equal(stepNameForScope(later, scope('titles')), '后发布的新名字');
});
