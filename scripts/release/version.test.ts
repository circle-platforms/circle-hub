import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

test('only --version exits before environment guards or operator configuration', () => {
  const home = mkdtempSync(join(tmpdir(), 'hub-version-'));
  try {
    const canary = join(home, 'platform.json');
    writeFileSync(canary, 'not valid JSON');
    const cli = fileURLToPath(new URL('../../bin/circle-hub', import.meta.url));
    const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
    const env = { SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, CIRCLE_SERVER_SYNTHETIC: 'retired', CIRCLE_HUB_DATA_ROOT: canary };
    const result = spawnSync(process.execPath, [cli, '--version'], { env, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, `${version}\n`);
    assert.equal(result.stderr, '');
    const ordinary = spawnSync(process.execPath, [cli, '--version', 'extra'], { env, encoding: 'utf8', timeout: 10_000 });
    assert.equal(ordinary.status, 1);
    assert.match(ordinary.stderr, /CIRCLE_SERVER/);
    assert.notEqual(ordinary.stdout, `${version}\n`);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
