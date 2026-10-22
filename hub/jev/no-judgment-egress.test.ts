// Structural insurance of the owner decision of 2026-10-22 (docs/hub-r4-tasks/no-judgment-in-hub.md): the Hub calls
// no model at all, so the typed-judgment service capability is removed; placement proposals belong to the bot and the
// Hub will only verify them with deterministic rules. No non-test source file under hub/, scripts/ or bin/ may name
// the removed HTTP client, the judgment service's domain or vendor name, or the vault entry its key was read from,
// and the removed files stay removed.
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { test } from 'node:test';

const ROOT = new URL('../../', import.meta.url);

/** Every .ts file under a directory (recursive), test files excluded. */
async function* sources(relative: string): AsyncGenerator<string> {
  const entries = await readdir(new URL(`${relative}/`, ROOT), { withFileTypes: true });
  for (const entry of entries) {
    const path = `${relative}/${entry.name}`;
    if (entry.isDirectory()) yield* sources(path);
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) yield path;
  }
}

const FORBIDDEN: readonly [RegExp, string][] = [
  [/HttpJev/, 'the removed HTTP client of the judgment service'],
  [/typesafe/i, "the judgment service's vendor name or domain"],
  [/jev\.api-key/i, 'the removed vault entry of the judgment service key'],
];

test('no non-test source file under hub/, scripts/ or bin/ names the removed client, the service or its vault entry', async () => {
  const files: string[] = [];
  for (const dir of ['hub', 'scripts']) for await (const path of sources(dir)) files.push(path);
  files.push('bin/circle-hub');
  const offenders: string[] = [];
  for (const path of files) {
    const text = await readFile(new URL(path, ROOT), 'utf8');
    text.split('\n').forEach((line, index) => {
      for (const [pattern, what] of FORBIDDEN) {
        if (pattern.test(line)) offenders.push(`${path}:${index + 1}: ${what}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `judgment-service references in non-test sources:\n${offenders.join('\n')}`);
});

test('the removed client, its stub and the smoke script stay removed', async () => {
  for (const path of ['hub/jev/http.ts', 'hub/jev/http.test.ts', 'hub/jev/test-support.ts', 'scripts/real/jev-smoke.ts']) {
    await assert.rejects(stat(new URL(path, ROOT)), `${path} exists again`);
  }
});
