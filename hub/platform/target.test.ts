import assert from 'node:assert/strict';
import { test } from 'node:test';
import { layoutAt } from './layout.ts';
import { binaryPackage, postgresBinaryPaths } from './postgres.ts';
import { assertUnixPostgres, windowsLocalPath } from './target.ts';

test('Windows Node platform maps only to the pinned x64 package without inventing ARM64 or emulation', () => {
  assert.equal(binaryPackage('win32', 'x64'), '@embedded-postgres/windows-x64');
  for (const arch of ['arm64', 'ia32', 'x64/../../escape']) assert.throws(() => binaryPackage('win32', arch));
  assert.equal(binaryPackage('linux', 'arm64'), '@embedded-postgres/linux-arm64');
  assert.equal(binaryPackage('darwin', 'x64'), '@embedded-postgres/darwin-x64');
  assert.throws(() => binaryPackage('freebsd', 'x64'));
});

test('Windows candidates use target separators and exe suffixes independently of the current host', () => {
  const prefix = 'C:\\Hub 发布\\node_modules\\@embedded-postgres\\windows-x64\\native\\bin\\';
  assert.deepEqual(postgresBinaryPaths('C:/Hub 发布', 'win32', 'x64'), {
    initdb: `${prefix}initdb.exe`, pg_ctl: `${prefix}pg_ctl.exe`, postgres: `${prefix}postgres.exe`,
  });
  assert.equal(postgresBinaryPaths('/srv/hub', 'linux', 'arm64').postgres,
    '/srv/hub/node_modules/@embedded-postgres/linux-arm64/native/bin/postgres');
  assert.throws(() => postgresBinaryPaths('relative', 'linux', 'x64'));
  assert.throws(() => postgresBinaryPaths('C:/Hub', 'win32', 'arm64'));
});

test('Windows layout accepts local absolute paths with spaces and Chinese without enabling Unix transport', () => {
  const layout = layoutAt('C:/Users/Example/Hub 数据', 'win32');
  assert.equal(layout.root, 'C:\\Users\\Example\\Hub 数据');
  assert.equal(layout.db, 'C:\\Users\\Example\\Hub 数据\\db');
  assert.equal(layout.setAside, 'C:\\Users\\Example\\Hub 数据\\set-aside');
  assert.equal(layout.packs, 'C:\\Users\\Example\\Hub 数据\\packs');
  assert.throws(() => assertUnixPostgres('win32'), /传输与认证尚未实现/);
  assert.doesNotThrow(() => assertUnixPostgres('linux'));
  assert.doesNotThrow(() => assertUnixPostgres('darwin'));
});

test('Windows lexical paths reject aliases and shell or filesystem escapes before normalization', () => {
  for (const root of [
    'relative', 'C:relative', '/root', '\\\\host\\share\\hub', '\\\\?\\C:\\hub', '\\\\.\\C:\\hub',
    'C:/', 'C:/hub//child', 'C:/hub/../escape', 'C:/hub/./child', 'C:/hub/file:stream', 'C:/hub /child',
    'C:/hub./child', 'C:/NUL', 'C:/con.txt', 'C:/COM1', 'C:/LPT¹.log', 'C:/hub/%TEMP%',
    'C:/hub/a&b', 'C:/hub/a|b', 'C:/hub/a^b', 'C:/hub/a!b', 'C:/hub/a"b', 'C:/hub/a\nb',
  ]) {
    assert.throws(() => windowsLocalPath(root), root);
    assert.throws(() => layoutAt(root, 'win32'), root);
    assert.throws(() => postgresBinaryPaths(root, 'win32', 'x64'), root);
  }
});
