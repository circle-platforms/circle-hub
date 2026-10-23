// Exercise host configuration with scratch directories and scripted tools only.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
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
      KNOWLEDGE_SYNC_TOOLS_DIR: join(root, 'tools'),
      KNOWLEDGE_SYNC_UPLOAD_DIR: join(root, 'upload'),
      KNOWLEDGE_SYNC_MIRROR_DIR: join(root, 'mirror'),
      KNOWLEDGE_SYNC_DIR: join(root, 'sync'),
      KNOWLEDGE_SYNC_MANUAL_BRANCHES: 'sample-one sample-two',
      TRACE: join(root, 'trace'),
    };
    for (const tool of ['java', 'python3']) writeFileSync(join(root, 'bin', tool), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$TRACE"\n', { mode: 0o700 });
    run(root, env);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function scriptResult(name: string, env: NodeJS.ProcessEnv, args: string[] = []) {
  const script = new URL(`../../ops/knowledge-sync/${name}`, import.meta.url);
  return spawnSync('/bin/bash', [script.pathname, ...args], { env, encoding: 'utf8' });
}

function runScript(name: string, env: NodeJS.ProcessEnv, args: string[] = [], expectedStatus = 0) {
  const result = scriptResult(name, env, args);
  assert.equal(result.status, expectedStatus, result.stderr);
  return result;
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
  for (const [i, set] of sets.entries()) env[`KNOWLEDGE_SYNC_RELEASE_SET_${i + 1}`] = set;
  runScript('run_release_all.sh', env);
  assert.deepEqual(readFileSync(env.TRACE!, 'utf8').trim().split('\n'), sets);
}));

function realReleasePipeline(root: string): void {
  const path = join(root, 'sync', 'release_pipeline.sh');
  copyFileSync(new URL('../../ops/knowledge-sync/release_pipeline.sh', import.meta.url), path);
  chmodSync(path, 0o700);
  writeFileSync(join(root, 'tools', 'deploy_md.sh'), '#!/bin/bash\nprintf "deploy %s\\n" "$*" >> "$TRACE"\n', { mode: 0o700 });
}

test('one-field and two-field release slots do nothing while the remaining slots complete', () => scratch((root, env) => {
  realReleasePipeline(root);
  env.KNOWLEDGE_SYNC_RELEASE_SET_1 = 'sample-one';
  env.KNOWLEDGE_SYNC_RELEASE_SET_2 = 'sample-two SAMPLE_TWO';
  for (const [slot, word] of [[3, 'THREE'], [4, 'FOUR']] as const) {
    env[`KNOWLEDGE_SYNC_RELEASE_SET_${slot}`] = `sample-${slot} SAMPLE_${word} target-${slot}`;
    mkdirSync(join(root, 'upload', `SAMPLE_${word}_stage_pdf`));
    writeFileSync(join(root, 'upload', `SAMPLE_${word}_stage_pdf`, 'sample.pdf'), 'synthetic');
  }
  const result = runScript('run_release_all.sh', env, [], 1);
  const trace = readFileSync(env.TRACE!, 'utf8').trim().split('\n');
  assert.equal(trace.length, 10, 'only two complete export/stage/docx/pdf/deploy sequences run');
  assert.equal(trace.filter(line => line.endsWith('OkmExport')).length, 2);
  assert.equal(trace.filter(line => line.startsWith('pdf2md.py ')).length, 2);
  assert.deepEqual(trace.filter(line => line.startsWith(`${root}/sync/stage_release.py`)), ['THREE', 'FOUR'].map(word => `${root}/sync/stage_release.py ${root}/upload/SAMPLE_${word} ${root}/upload/SAMPLE_${word}_stage_docx ${root}/upload/SAMPLE_${word}_stage_pdf`));
  assert.deepEqual(trace.filter(line => line.startsWith('deploy ')), [[3, 'THREE'], [4, 'FOUR']].map(([slot, word]) => `deploy ${root}/upload/SAMPLE_${word}_md ${root}/mirror/release/target-${slot}`));
  assert.match(result.stdout + result.stderr, /\[fail\] slot 1 malformed/);
  assert.match(result.stdout + result.stderr, /\[fail\] slot 2 malformed/);
}));

test('unsafe, extra, empty and unset release slots are rejected before expansion or conversion', () => scratch((root, env) => {
  realReleasePipeline(root);
  for (const bad of ['sample * target', '../sample SAMPLE target', 'sample SAMPLE target extra', '']) {
    writeFileSync(env.TRACE!, '');
    env.KNOWLEDGE_SYNC_RELEASE_SET_1 = bad;
    for (const slot of [2, 3, 4]) env[`KNOWLEDGE_SYNC_RELEASE_SET_${slot}`] = `sample-${slot} SAMPLE_${slot} target-${slot}`;
    const result = runScript('run_release_all.sh', env, [], 1);
    const trace = readFileSync(env.TRACE!, 'utf8');
    assert.equal(trace.split('\n').filter(line => line.endsWith('OkmExport')).length, 3, bad);
    assert.match(result.stdout + result.stderr, /\[fail\] slot 1 malformed/);
  }
  delete env.KNOWLEDGE_SYNC_RELEASE_SET_1;
  writeFileSync(env.TRACE!, '');
  const result = runScript('run_release_all.sh', env, [], 1);
  assert.equal(readFileSync(env.TRACE!, 'utf8').split('\n').filter(line => line.endsWith('OkmExport')).length, 3);
  assert.match(result.stdout + result.stderr, /\[fail\] slot 1 malformed/);
}));

test('a direct release pipeline rejects wrong argument counts and unsafe components before any executable', () => scratch((_root, env) => {
  for (const args of [[], ['set'], ['set', 'DIR'], ['set', 'DIR', 'target', 'extra'], ['', 'DIR', 'target'], ['set', '', 'target'], ['set', 'DIR', ''], ['set', '../DIR', 'target'], ['set', 'DIR', '*']]) {
    writeFileSync(env.TRACE!, '');
    const result = scriptResult('release_pipeline.sh', env, args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.equal(readFileSync(env.TRACE!, 'utf8'), '', 'no export, stage, conversion or deployment is allowed');
  }
}));
