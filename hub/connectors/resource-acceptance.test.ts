// A resource's standing decision about scan hits, through the real PLM pack and read engine. Synthetic stub data only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTestHub } from '../server/testing-real.ts';

test('hits of a detector the resource names no longer hold an answer, each with its acceptance on record; without the setting they do', async () => {
  const hub = await createTestHub({ repositoryPacks: ['plm'] });
  try {
    const add = async (name: string, settings: Record<string, unknown>) => {
      const resource = await hub.addResource({ system_pack: 'plm', name, environment: 'test', credentials: { username: 'SYNTHETIC_PLM_USER', password: 'SYNTHETIC_PLM_PASSWORD' }, origins: { 'plm-oauth': hub.stubs!.agile.origin, 'plm-api': hub.stubs!.plm.origin }, allow_plaintext: [hub.stubs!.agile.origin, hub.stubs!.plm.origin], settings });
      await hub.setCredential(resource.id, 'username', hub.stubs!.agileAccount.username);
      await hub.setCredential(resource.id, 'password', hub.stubs!.agileAccount.password);
      return resource;
    };
    const context = { principal: hub.admin.principal, run: null, purpose: '合成长期决定核对' };
    const held = await add('合成缺陷资源', {});
    const before = await hub.hub.connectors.reader.read('plm:bug:4848', context);
    assert.equal(before.ok, false, 'without the setting the record is held');
    await hub.hub.connectors.admin.updateResource(hub.admin.principal, held.id, { settings: { accept_scan_detectors: ['jwt'] } });
    assert.equal((await hub.hub.connectors.reader.read('plm:bug:4848', context)).ok, false, 'a detector the setting does not name still holds the record');
    await hub.hub.connectors.admin.updateResource(hub.admin.principal, held.id, { settings: { accept_scan_detectors: ['password_assignment'] } });
    const read = await hub.hub.connectors.reader.read('plm:bug:4848', context);
    assert.ok(read.ok, JSON.stringify(read));
    const content = read.artifacts.find((artifact) => artifact.name === 'content');
    assert.ok(content);
    const bytes = await hub.records.artifacts.trustedBytes(content.artifact.body.sha256);
    assert.match(new TextDecoder().decode(bytes!), /登录后页面空白/);
  } finally {
    await hub.close();
  }
});
