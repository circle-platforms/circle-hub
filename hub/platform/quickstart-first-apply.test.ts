import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { materializeQuickstartApply, writeQuickstartApplyFile } from './quickstart-first-apply.ts';

const EXAMPLE = fileURLToPath(new URL('../../docs/examples/quickstart-deployment.json', import.meta.url));

test('materializeQuickstartApply replaces admin and uses an absolute pack directory', async () => {
  const sample = JSON.parse(await readFile(EXAMPLE, 'utf8'));
  assert.equal(sample.workflowAssignments[0].user, 'admin');
  const packDir = join(tmpdir(), 'synthetic-quickstart', 'packs', 'workflow', 'test-bed');
  const ready = materializeQuickstartApply(sample, 'synthetic-installer-admin', packDir);
  assert.deepEqual(ready.workflowAssignments, [{ pack: 'test-bed', user: 'synthetic-installer-admin' }]);
  assert.equal(ready.packs[0].directory, packDir);
  assert.equal(ready.packs[0].ref, sample.packs[0].ref);
  assert.throws(() => materializeQuickstartApply(sample, 'synthetic-installer-admin', 'packs/workflow/test-bed'), /absolute/);
});

test('writeQuickstartApplyFile writes a deployment@2 file for a non-admin installer name', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'circle-hub-quickstart-apply-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = join(dir, 'first-apply.json');
  const packDir = join(dir, 'packs', 'workflow', 'test-bed');
  writeQuickstartApplyFile(EXAMPLE, 'not-the-default-admin', packDir, out);
  const written = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(written.schema, 'deployment@2');
  assert.deepEqual(written.workflowAssignments, [{ pack: 'test-bed', user: 'not-the-default-admin' }]);
  assert.equal(written.packs[0].directory, packDir);
});
