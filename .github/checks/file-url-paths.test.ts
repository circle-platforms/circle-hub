import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ALLOWED, urlPathnameProblems, urlPathnameUses } from './file-url-paths.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

test('no tracked source turns import.meta.url into a file path with .pathname', () => {
  assert.deepEqual(urlPathnameProblems(ROOT), []);
});

test('a .pathname conversion is reported by file and line, and fileURLToPath is not', () => {
  // The offending line is assembled, so this file does not itself contain the pattern it checks for.
  const source = ["import { fileURLToPath } from 'node:url';", "const a = new URL('../', import.meta.url)" + '.pathname;', "const b = fileURLToPath(new URL('../', import.meta.url));"].join('\n');
  assert.deepEqual(urlPathnameUses('tests/sample.test.ts', source), ['tests/sample.test.ts:2']);
});

test('each allowed third-party file exists and is the only kind of exception', () => {
  for (const file of Object.keys(ALLOWED)) {
    assert.ok(existsSync(join(ROOT, file)), file);
    assert.match(file, /\/vendor\//);
    assert.deepEqual(urlPathnameUses(file, "new URL('.', import.meta.url)" + '.pathname'), []);
  }
});

test('a percent-encoded pathname is not the file path that fileURLToPath gives', () => {
  const url = new URL('file:///tmp/%E5%BC%80%E5%8F%91/x.ts');
  assert.notEqual(url.pathname, fileURLToPath(url));
  assert.equal(fileURLToPath(url), '/tmp/开发/x.ts');
});
