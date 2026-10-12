import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../',import.meta.url));
async function files(path: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(path,{ withFileTypes:true })) {
    const target = join(path,entry.name); if (entry.isDirectory()) result.push(...await files(target)); else if (/\.(ts|mjs)$/.test(entry.name)) result.push(target);
  }
  return result;
}
test('application imports cannot reach frozen business modules or historical compiler runtimes', async () => {
  for (const directory of ['apps','packages','packs','scripts']) for (const path of await files(join(root,directory))) {
    const code = await readFile(path,'utf8');
    for (const match of code.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      assert.doesNotMatch(specifier,/compile-excel|InfoTest|python/i,`${path} imports an excluded runtime`);
      if (specifier.startsWith('.')) {
        const target = resolve(path,'..',specifier);
        assert.ok(!target.startsWith(join(root,'references')) && !target.startsWith(join(root,'foundation')),`${path} imports frozen source`);
      }
    }
  }
});
