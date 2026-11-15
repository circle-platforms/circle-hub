import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { classifyDecision, resolveInstalledGuard } from './guard-preflight.ts';

test('preflight accepts only exact installed hook decisions or the empty no-op object', () => {
  assert.equal(classifyDecision({}), 'allow');
  for (const decision of ['allow', 'deny', 'ask'] as const) assert.equal(classifyDecision({ decision }), decision);
  for (const parsed of [null, undefined, { decision: ' allow ' }, { decision: 'unexpected' }]) assert.equal(classifyDecision(parsed), 'error');
});

test('preflight never executes an entry outside the selected Home hooks directory', () => {
  const home = mkdtempSync(join(tmpdir(), 'guard-preflight-'));
  try {
    mkdirSync(join(home, 'hooks')); writeFileSync(join(home, 'settings.json'), JSON.stringify({ trusted_folders: [home] }));
    const entry = join(home, 'skills-only.mjs'); writeFileSync(entry, '{}');
    writeFileSync(join(home, 'hooks.json'), JSON.stringify({ hooks: { before_tool: [{ command: `node '${entry}'` }] } }));
    assert.throws(() => resolveInstalledGuard(home), /hooks 内/);
    const safe = join(home, 'hooks/skills-only.mjs'); symlinkSync(entry, safe);
    writeFileSync(join(home, 'hooks.json'), JSON.stringify({ hooks: { before_tool: [{ command: `node '${safe}'` }] } }));
    assert.throws(() => resolveInstalledGuard(home), /普通文件/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
