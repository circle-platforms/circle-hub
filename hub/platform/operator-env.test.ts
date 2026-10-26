import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PLATFORM_VARIABLES } from './environment.ts';
import { layoutAt } from './layout.ts';
import { operatorEnvironment } from './operator-env.ts';
import { newSettingsFile, settingsPath } from './settings.ts';

async function deployment(port: number): Promise<{ root: string; remove(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'chub-'));
  const layout = layoutAt(root);
  await mkdir(layout.config, { recursive: true });
  await writeFile(settingsPath(layout), JSON.stringify(newSettingsFile({ environment: 'test', port })));
  return { root, remove: () => rm(root, { recursive: true, force: true }) };
}

test('an operator command gets the service environment of the deployment its data root names', async () => {
  const d = await deployment(7433);
  try {
    const got = await operatorEnvironment({ [PLATFORM_VARIABLES.dataDir]: d.root });
    assert.equal(got[PLATFORM_VARIABLES.port], '7433');
    assert.equal(got[PLATFORM_VARIABLES.databaseUser], 'circle_hub');
    assert.equal(got[PLATFORM_VARIABLES.keychainService], 'circle-hub');
    assert.ok(got[PLATFORM_VARIABLES.databaseSocketDir]?.startsWith(d.root));
    assert.equal(got[PLATFORM_VARIABLES.dataDir], undefined, 'a name the caller set is not returned');
    assert.ok(Object.keys(got).every((name) => name.startsWith('CIRCLE_HUB_')), 'only CIRCLE_HUB_* names, never PATH, HOME or USER');
  } finally {
    await d.remove();
  }
});

test('a variable the caller sets itself is never replaced', async () => {
  const d = await deployment(7434);
  try {
    const got = await operatorEnvironment({ [PLATFORM_VARIABLES.dataDir]: d.root, [PLATFORM_VARIABLES.port]: '7434' });
    assert.equal(got[PLATFORM_VARIABLES.port], undefined);
    assert.ok(got[PLATFORM_VARIABLES.databaseName] !== undefined);
  } finally {
    await d.remove();
  }
});

test('without a deployment, or with unreadable settings, nothing is added', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'chub-'));
  try {
    assert.deepEqual(await operatorEnvironment({ [PLATFORM_VARIABLES.dataDir]: empty }), {});
    const layout = layoutAt(empty);
    await mkdir(layout.config, { recursive: true });
    await writeFile(settingsPath(layout), '{ not json');
    assert.deepEqual(await operatorEnvironment({ [PLATFORM_VARIABLES.dataDir]: empty }), {});
    assert.deepEqual(await operatorEnvironment({ [PLATFORM_VARIABLES.dataDir]: 'relative/path' }), {});
    assert.equal(typeof userInfo().username, 'string');
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});
