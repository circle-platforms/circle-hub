// C02 R[3] (model 45, decision 157, issue 34): no runtime module of the Hub core imports product pack code. Product
// content reaches the core as data (declarations, published pack files run in the sandbox), never as an import. Tests and
// the testing directories may load the repository's synthetic product pack as fixture data.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HUB = fileURLToPath(new URL('./', import.meta.url));
function runtimeModules(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'testing' || entry.name === 'node_modules' ? [] : runtimeModules(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !/(?:^|[-.])(?:test-support|testing|fixture)[-.]|^test-/.test(entry.name) ? [path] : [];
  });
}

test('no runtime module of the Hub core imports from a product pack', () => {
  const modules = runtimeModules(HUB);
  assert.ok(modules.length > 300, `the walk found the core's modules (${modules.length})`);
  const offenders: string[] = [];
  for (const path of modules) {
    const text = readFileSync(path, 'utf8');
    for (const match of text.matchAll(/(?:from\s*|import\s*\(\s*)(['"])([^'"]+)\1/g)) {
      if (/(?:^|\/)packs\/product\//.test(match[2])) offenders.push(`${relative(HUB, path)} imports ${match[2]}`);
    }
  }
  assert.deepEqual(offenders, []);
});
