// Published functions must author missing facts themselves, before runCheck validates their output.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { CheckOutcome } from '../../../contracts/src/tables.ts';
const root = new URL('../../../packs/workflow/', import.meta.url);
for (const pack of await readdir(root)) {
  let checks;
  try { checks = JSON.parse(await readFile(new URL(`${pack}/checks.json`, root), 'utf8')).checks; } catch { continue; }
  for (const check of checks) {
    if (!check.function) continue;
    test(`${pack}/${check.id} authors valid missing facts on empty input`, async () => {
      const module = await import(new URL(`${pack}/${check.function.module}`, root).href);
      const output = await module[check.function.export ?? 'default']({ subject: {}, context: {}, table: {} });
      assert.ok(Array.isArray(output));
      for (const outcome of output) if (outcome.verdict === 'unknown') assert.ok(CheckOutcome.safeParse(outcome).success, JSON.stringify(outcome));
    });
  }
}
