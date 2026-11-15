import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { RequirementsFile, WorkflowFile } from '../../../contracts/src/pack.ts';
import { readPackDirectory } from './directory.ts';
import { validatePack } from './validate.ts';
import { temporaryDirectory, workflowPack, writePack } from './testing/builder.ts';

async function validated(step: string | undefined, declareSteps: boolean) {
  const temporary = await temporaryDirectory('synthetic-workflow-steps-');
  try {
    const pack = workflowPack();
    const workflow = WorkflowFile.parse(pack.files['workflow.json']);
    const requirements = RequirementsFile.parse(pack.files['requirements.json']);
    pack.files['workflow.json'] = { ...workflow, ...(declareSteps ? { steps: [{ id: 'plan', name: '合成计划' }] } : {}) };
    pack.files['requirements.json'] = { ...requirements, requirements: requirements.requirements.map(row => ({ ...row, ...(step === undefined ? {} : { step }) })) };
    const written = await writePack(join(temporary.path, 'pack'), pack);
    const read = await readPackDirectory(written.dir);
    assert.ok(read.ok);
    return await validatePack(read.pack);
  } finally { await temporary.remove(); }
}

test('publication accepts a declared step reference and an old pack without steps', async () => {
  for (const [step, declared] of [['plan', true], [undefined, false]] as const) {
    const result = await validated(step, declared);
    assert.equal(result.ok, true, JSON.stringify(result));
  }
});

test('publication rejects unknown and missing step declarations at the precise requirement field', async () => {
  for (const [step, declared] of [['missing', true], ['plan', false]] as const) {
    const result = await validated(step, declared);
    assert.equal(result.ok, false);
    if (result.ok) assert.fail('expected refusal');
    assert.ok(result.problems.some(problem => problem.rule === 'workflow.step_reference' && problem.file === 'requirements.json' && problem.field === '/requirements/0/step'));
  }
});
