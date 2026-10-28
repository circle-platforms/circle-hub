import { writeFile } from 'node:fs/promises';
import { tempDir, removeDir } from './test-support.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { test } from 'node:test';
import { assertSyntheticCommand, assertSyntheticPath, assertSyntheticPort } from './testing/synthetic-only.ts';

const reason = (expected: string) => (error: unknown) => (error as { reason?: string }).reason === expected;
test('restricted verification refuses host tools and protected targets before any host access', () => {
  assert.throws(() => assertSyntheticCommand('/nonexistent/security'), reason('host_tool'));
  assert.throws(() => assertSyntheticCommand('/nonexistent/launchctl'), reason('host_tool'));
  assert.throws(() => assertSyntheticCommand('/nonexistent/systemctl'), reason('host_tool'));
  assert.throws(() => assertSyntheticPort({ port: 7420 }), reason('persistent_port'));
  assert.throws(() => assertSyntheticPath(join(homedir(), 'Library', 'Application Support', 'circle-hub', 'never-open')), reason('persistent_data'));
  assert.throws(() => assertSyntheticPath(join('/var', 'lib', 'circle-hub', 'never-open')), reason('persistent_data'));
  assert.throws(() => assertSyntheticPath(join(homedir(), '.local', 'share', 'circle-hub', 'never-open')), reason('persistent_data'));
  assert.doesNotThrow(() => assertSyntheticPort(0));
  assert.doesNotThrow(() => assertSyntheticPath(join(homedir(), 'Library', 'Application Support', 'circle-hub-acceptance', 'review')));
});
test('the restricted preload blocks an actual spawn API call even for a nonexistent host-tool executable', () => {
  assert.throws(() => spawnSync('/nonexistent/security', []), reason('host_tool'));
});

test('restricted libpq subprocesses cannot consult user password or service configuration files', async () => {
  const root = await tempDir();
  try {
    const tool = join(root, 'pg_dump');
    await writeFile(tool, '#!/bin/sh\nprintf "%s\\n" "$PGPASSFILE" "$PGSERVICEFILE" "$PGSYSCONFDIR" "${PGSERVICE-unset}" "$PSQLRC"\n', { mode: 0o700 });
    const result = spawnSync(tool, [], { env: { PGPASSFILE: '/nonexistent/user-passwords', PGSERVICE: 'must-not-resolve' }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'), ['/dev/null', '/dev/null', '/dev/null', 'unset', '/dev/null']);
  } finally { await removeDir(root); }
});
