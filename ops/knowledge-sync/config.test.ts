// Exercise host configuration with scratch directories and scripted tools only.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

function scratch(run: (root: string, env: NodeJS.ProcessEnv) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'hub-sync-synthetic-'));
  try {
    for (const dir of ['bin', 'tools', 'upload', 'mirror', 'sync']) mkdirSync(join(root, dir));
    const env = {
      PATH: `${join(root, 'bin')}:/usr/bin:/bin`,
      CIRCLE_HUB_SYNC_TOOLS_DIR: join(root, 'tools'),
      CIRCLE_HUB_SYNC_UPLOAD_DIR: join(root, 'upload'),
      CIRCLE_HUB_SYNC_MIRROR_DIR: join(root, 'mirror'),
      CIRCLE_HUB_SYNC_DIR: join(root, 'sync'),
      CIRCLE_HUB_SYNC_MANUAL_BRANCHES: 'sample-one sample-two',
      TRACE: join(root, 'trace'),
    };
    for (const tool of ['java', 'python3']) writeFileSync(join(root, 'bin', tool), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$TRACE"\n', { mode: 0o700 });
    run(root, env);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function runScript(name: string, env: NodeJS.ProcessEnv, args: string[] = []): void {
  const script = new URL(name, import.meta.url);
  const result = spawnSync('/bin/bash', [script.pathname, ...args], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

test('manual jobs use configured roots and preserve both branch and manual loops', () => scratch((root, env) => {
  for (const script of ['manuals_first_run.sh', 'run_manuals_extra.sh']) {
    writeFileSync(env.TRACE!, '');
    runScript(script, env);
    const converter = script === 'manuals_first_run.sh' ? 'adoc2md.py' : 'svn_update_and_convert.py';
    assert.deepEqual(readFileSync(env.TRACE!, 'utf8').trim().split('\n'), ['sample-one', 'sample-two'].flatMap((branch) =>
      ['app', 'cli'].map((kind) => `${converter} ${root}/upload/${kind}/${branch}/${kind}_cn ${root}/mirror/${kind}/${branch}/${kind}_cn`)));
  }
}));

test('release pipeline preserves export, staging, conversion and deployment order', () => scratch((root, env) => {
  writeFileSync(join(root, 'tools', 'deploy_md.sh'), '#!/bin/bash\nprintf "deploy %s\\n" "$*" >> "$TRACE"\n', { mode: 0o700 });
  mkdirSync(join(root, 'upload', 'SAMPLE_stage_pdf'));
  writeFileSync(join(root, 'upload', 'SAMPLE_stage_pdf', 'sample.pdf'), 'synthetic PDF placeholder');
  runScript('release_pipeline.sh', env, ['sample-set', 'SAMPLE', 'sample-target']);
  assert.deepEqual(readFileSync(env.TRACE!, 'utf8').trim().split('\n'), [
    `-Dokm.config=${root}/sync/export-sample-set.properties OkmExport`,
    `${root}/sync/stage_release.py ${root}/upload/SAMPLE ${root}/upload/SAMPLE_stage_docx ${root}/upload/SAMPLE_stage_pdf`,
    `docx2md.py ${root}/upload/SAMPLE_stage_docx ${root}/upload/SAMPLE_md`,
    `pdf2md.py ${root}/upload/SAMPLE_stage_pdf ${root}/upload/SAMPLE_md`,
    `deploy ${root}/upload/SAMPLE_md ${root}/mirror/release/sample-target`,
  ]);
}));

test('release wrapper keeps four configured triplets in order and continues after failure', () => scratch((root, env) => {
  writeFileSync(join(root, 'sync', 'release_pipeline.sh'), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$TRACE"\n[ "$1" != "sample-one" ]\n', { mode: 0o700 });
  const sets = ['one', 'two', 'three', 'four'].map((n) => `sample-${n} SAMPLE_${n} target-${n}`);
  for (const [i, set] of sets.entries()) env[`CIRCLE_HUB_SYNC_RELEASE_SET_${i + 1}`] = set;
  runScript('run_release_all.sh', env);
  assert.deepEqual(readFileSync(env.TRACE!, 'utf8').trim().split('\n'), sets);
}));
