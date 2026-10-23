import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createTestHub } from '../../../hub/server/testing-real.ts';
import { writePack } from '../../../hub/runs/api.ts';

test('authorized identity size errors stay public while unassigned readers remain neutral', async () => {
  const root = await mkdtemp(join(tmpdir(), 'circle-hub-identity-run-'));
  const pack = await writePack(join(root, 'probe'), { id: 'synthetic-identity-probe', version: '1.0.0', kind: 'workflow', title: '合成标识核对', description: '合成输入边界核对', files: {
    'workflow.json': { schema: 'workflow@1', inputs: [{ slot: 'build', role: 'subject', description: '合成构建来源', accepts: ['plm:builds'], required: true, many: false }], parameters: [], product: { catalogs: [] }, subject: 'build', projection: { module: 'functions/project.ts' } },
    'requirements.json': { schema: 'requirements@1', requirements: [{ key: 'probe', name: '合成核对', description: '合成输入边界', target: 'run', required: false, done_rule: 'bookkeeping', layers: ['static'], accepted_producer: 'judgment', checks: [], error_handling: [] }] }, 'checks.json': { schema: 'checks@1', checks: [] },
    'slots.schema.json': { schema: 'slots@1', item: {}, run: { probe: { codes: [{ code: 'probe', label: '合成' }], min: 0, max: 1 } } }, 'SKILL.md': '# 合成标识核对\n',
    'functions/project.ts': 'export default () => ({items:[],warnings:[]});',
  } });
  let hub: Awaited<ReturnType<typeof createTestHub>> | undefined;
  try {
    hub = await createTestHub({ repositoryPacks: ['plm'], packs: [pack.dir] });
    await hub.assignPack(hub.admin.principal, 'synthetic-identity-probe');
    await hub.addResource({ system_pack: 'plm', name: '合成标识资源', environment: 'test', origins: { 'plm-oauth': hub.stubs!.agile.origin, 'plm-api': hub.stubs!.plm.origin }, allow_plaintext: [hub.stubs!.agile.origin, hub.stubs!.plm.origin] });
    const member=await hub.createUser('合成成员');
    const outsider=await hub.createUser('未分配成员');
    await hub.assignPack(member.principal,'synthetic-identity-probe');
    const before=hub.stubs!.plm.requests.length;
    for(const person of [hub.admin,member,outsider]) for(const external of ['plm:builds:'+'Z'.repeat(890),'plm:builds:'+'测'.repeat(300)]) {
      const result=await hub.hub.runs.startRun(person.principal,{pack:'synthetic-identity-probe',inputs:{build:{external}}},{traceId:'a'.repeat(32),sessionId:'synthetic-run'});
      assert.equal(result.call_result,'error');
      if(person===outsider){
        assert.equal(result.errors[0].code,'SOURCE_UNAVAILABLE');
        assert.ok(!JSON.stringify(result).includes('字节上限'));
      }else{
        assert.equal(result.errors[0].code,'SUBMISSION_SCHEMA_VIOLATION');
        assert.equal(result.errors[0].path,'/inputs/build');
        assert.match(result.errors[0].message,new RegExp(`${Buffer.byteLength(external)} 字节.*900 字节上限`));
        assert.match(result.errors[0].fix??'',/缩短读取键/);
      }
      assert.ok(!JSON.stringify(result).includes(external));
    }
    assert.equal(hub.stubs!.plm.requests.length,before,'input refusal performs no network request');
    assert.match(hub.logs.join('\n'), /901 字节/); assert.match(hub.logs.join('\n'), /900 字节上限/);
    assert.ok(!hub.logs.join('\n').includes('Z'.repeat(100)));
  } finally { await hub?.close(); await rm(root, { recursive: true, force: true }); }
});
