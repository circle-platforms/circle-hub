import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../../server/api.ts';
import type { ServerDeps } from '../../server/api.ts';
import { installLocalTools } from '../../server/cli-local-tools.ts';
import { clearDistributionCache } from '../../server/local-tools.ts';
import { startPostgres } from '../../testing/postgres.ts';
import { installMindmapFixture } from '../../testing/skills.ts';
import { createWorkflowStore } from './ports.ts';
import { openPackTestbed } from './testing/setup.ts';

test('an active user can install tools from an installed parser-only skill, but not after uninstall', async () => {
  const postgres = await startPostgres();
  const bed = await openPackTestbed({ postgres });
  const directory = await mkdtemp(join(tmpdir(), 'synthetic-skill-tools-'));
  let app: ReturnType<typeof createApp> | undefined;
  try {
    await installMindmapFixture(bed.registry, bed.kit, bed.admin);
    const version = await bed.registry.getVersion('mindmap-format', '1.0.3'); assert.ok(version);
    const store = createWorkflowStore(bed.registry);
    assert.equal(await store.forUser(bed.bob, 'mindmap-format@1.0.3'), null, 'the parser-only skill is not a workflow');
    assert.equal((await store.skillForTools!(bed.bob, 'mindmap-format@1.0.3'))?.pack.digest, version.digest);
    assert.equal(await store.skillForTools!(bed.bob, 'mindmap-format@9.9.9'), null);
    const deps = { config: { host: '127.0.0.1', port: 0, limits: { maxRequestBytes: 1024 } }, workflows: store, records: { principals: { authenticate: async (token: string) => token === 'Bearer synthetic-token' ? bed.bob : null }, callLog: { append: async () => {} } } } as unknown as ServerDeps;
    app = createApp(deps, { codeRoot: directory }); const url = new URL((await app.listen()).url);
    const installed = await installLocalTools('mindmap-format@1.0.3', version.digest, directory, url, 'synthetic-token');
    assert.equal(installed.verified.ok, true);
    assert.ok((await readFile(join(directory, 'mindmap-format@1.0.3/tools/parse-model.ts'), 'utf8')).includes('parseModel'));
    const address = new URL('/local-tools/mindmap-format@1.0.3', url);
    assert.equal((await fetch(address, { headers: { authorization: 'Bearer synthetic-token' } })).status, 200);
    await bed.kit.principals.setDisabled(bed.admin, bed.bob.id, true);
    assert.equal((await fetch(address, { headers: { authorization: 'Bearer synthetic-token' } })).status, 404, 'the cached tool is not available to a disabled account');
    await bed.kit.principals.setDisabled(bed.admin, bed.bob.id, false);
    await bed.registry.uninstall(bed.admin, 'mindmap-format');
    assert.equal((await fetch(address, { headers: { authorization: 'Bearer synthetic-token' } })).status, 404, 'the cached tool is not available after uninstall');
    assert.equal(await store.skillForTools!(bed.bob, 'mindmap-format@1.0.3'), null);
  } finally {
    clearDistributionCache(); await app?.close(); await bed.close(); await postgres.stop(); await rm(directory, { recursive: true, force: true });
  }
});
