// End-to-end release entry-point coverage; all inputs, Hub replies and credentials are synthetic.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { stage } from '../../packs/workflow/case-compile/pack-files.ts';
import { stageRecompose } from '../../packs/workflow/case-compile/testing/stage-recompose.ts';
import { buildLocalCliProbes } from './testing/local-cli-probes.ts';
import { buildRemoteCliProbes } from './testing/remote-cli-probes.ts';
import { CASE_COMPILE_CLI_HELPERS, verifyCliInvocations } from './verify-tool-cli.ts';

test('all eighteen staged release CLI entry points match declared argv and stdin contracts', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'case-compile-cli-contracts-'));
  try {
    const cc = await stage(join(root, 'case-compile'));
    const rc = await stageRecompose('recompose', join(root, 'recompose'));
    const local = await buildLocalCliProbes(cc, rc, root);
    const remote = await buildRemoteCliProbes(cc, rc, join(root, 'remote'));
    try {
      assert.deepEqual(verifyCliInvocations(cc, CASE_COMPILE_CLI_HELPERS, { ...local.caseCompile, ...remote.caseCompile, ...remote.plumbCaseCompile }), { declarations: 18, invocations: 18, processes: 26 });
      assert.deepEqual(verifyCliInvocations(rc, new Set(), { ...local.recompose, ...remote.recompose }), { declarations: 3, invocations: 3, processes: 5 });
      const receipts = await remote.receipts();
      assert.ok(receipts.length > 0);
      assert.ok(receipts.every(receipt => receipt.authorized));
      assert.equal(receipts.filter(receipt => receipt.method === 'POST').length, 5);
    } finally { await remote.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
