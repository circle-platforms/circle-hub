import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { PlatformError } from './errors.ts';
import { assertSocketPath, DATA_ROOT_VARIABLE, defaultDataRoot, ensureLayout, layoutAt, resolveLayout, SOCKET_PATH_LIMIT } from './layout.ts';
import { removeDir, tempDir } from './test-support.ts';

const roots: string[] = [];
after(async () => {
  for (const root of roots) await removeDir(root);
});

test('default data root is under Application Support of the given home', () => {
  assert.equal(defaultDataRoot('/synthetic-homes/someone', {}, { platform: 'darwin' }), '/synthetic-homes/someone/Library/Application Support/circle-hub');
  const layout = resolveLayout({}, '/synthetic-homes/someone', { platform: 'darwin' });
  assert.equal(layout.root, '/synthetic-homes/someone/Library/Application Support/circle-hub');
  assert.equal(layout.db, '/synthetic-homes/someone/Library/Application Support/circle-hub/db');
  assert.equal(layout.current, '/synthetic-homes/someone/Library/Application Support/circle-hub/current');
});

test('CIRCLE_HUB_DATA_DIR, the one name hub/config reads too, overrides the root', () => {
  assert.equal(DATA_ROOT_VARIABLE, 'CIRCLE_HUB_DATA_DIR');
  assert.equal(resolveLayout({ CIRCLE_HUB_DATA_DIR: '/srv/hub-b' }, '/synthetic-homes/x').root, '/srv/hub-b');
  assert.equal(resolveLayout({ CIRCLE_HUB_DATA_DIR: '/srv/hub-c/' }, '/synthetic-homes/x').root, '/srv/hub-c');
  assert.throws(() => resolveLayout({ CIRCLE_HUB_DATA_DIR: '' }), /空值/);
  assert.throws(() => resolveLayout({ CIRCLE_HUB_DATA_DIR: 'relative/root' }), /绝对路径/);
  // The CLI refuses CIRCLE_HUB_HOME as an unknown name (environment.test.ts); here it is simply not a data root name.
  assert.equal(resolveLayout({ CIRCLE_HUB_HOME: '/srv/elsewhere' }, '/synthetic-homes/x', { platform: 'darwin' }).root, '/synthetic-homes/x/Library/Application Support/circle-hub');
});

test('Linux defaults use the service account or an absolute XDG data home', () => {
  const service = { platform: 'linux' as const, username: 'circle-hub' };
  const user = { platform: 'linux' as const, username: 'synthetic-user' };
  assert.equal(resolveLayout({ XDG_DATA_HOME: '/tmp/synthetic-data' }, '/tmp/synthetic-home', service).root, join('/var', 'lib', 'circle-hub'));
  assert.equal(resolveLayout({ XDG_DATA_HOME: '/tmp/synthetic-data' }, '/tmp/synthetic-home', user).root, '/tmp/synthetic-data/circle-hub');
  assert.equal(resolveLayout({}, '/tmp/synthetic-home', user).root, '/tmp/synthetic-home/.local/share/circle-hub');
  assert.equal(resolveLayout({ XDG_DATA_HOME: '' }, '/tmp/synthetic-home', user).root, '/tmp/synthetic-home/.local/share/circle-hub');
  assert.equal(resolveLayout({ USER: 'circle-hub' }, '/tmp/synthetic-home', user).root, '/tmp/synthetic-home/.local/share/circle-hub');
  assert.equal(resolveLayout({ CIRCLE_HUB_DATA_DIR: '/tmp/explicit', XDG_DATA_HOME: 'relative' }, '/tmp/synthetic-home', service).root, '/tmp/explicit');
  assert.throws(() => resolveLayout({ XDG_DATA_HOME: 'relative' }, '/tmp/synthetic-home', user), /绝对路径/);
});

test('paths that would break pg_ctl or the socket list are refused', () => {
  for (const bad of ['/tmp/a"b', '/tmp/$HOME', '/tmp/a`b`', '/tmp/a\\b', '/tmp/a,b', "/tmp/a'b", '/tmp/a\nb']) {
    assert.throws(() => layoutAt(bad), PlatformError, bad);
  }
  assert.doesNotThrow(() => layoutAt('/synthetic-homes/x/Library/Application Support/circle-hub'));
});

test('ensureLayout creates every directory private to the owner', async () => {
  const parent = await tempDir();
  roots.push(parent);
  const layout = layoutAt(join(parent, 'root'));
  await ensureLayout(layout);
  for (const dir of [layout.root, layout.db, layout.run, layout.objects, layout.vault, layout.logs, layout.backups, layout.releases, layout.config]) {
    const info = await stat(dir);
    assert.ok(info.isDirectory(), dir);
    assert.equal(info.mode & 0o777, 0o700, dir);
  }
});

test('a socket path over the macOS limit is refused with the data root hint', () => {
  const long = layoutAt(`/${'x'.repeat(SOCKET_PATH_LIMIT)}`);
  assert.throws(() => assertSocketPath(long, 5432), (error: unknown) => {
    assert.match((error as Error).message, /套接字路径太长/);
    assert.match(String((error as PlatformError).hint), /把 CIRCLE_HUB_DATA_DIR 设到更短的路径/);
    return true;
  });
  assert.doesNotThrow(() => assertSocketPath(layoutAt('/synthetic-homes/someone/Library/Application Support/circle-hub'), 5432));
});
