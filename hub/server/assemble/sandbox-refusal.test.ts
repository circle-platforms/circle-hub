// Issue 291 (owner, 2026-11-11): a Hub whose sandbox cannot run pack functions does not start, and says why in the probe's words.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AssemblyError} from './errors.ts';
import {assembleHub,sandboxRefusal} from './hub.ts';

test('the refusal names the probe\'s own reason and the operator\'s next step for the platform',()=>{
  const linux=sandboxRefusal('bubblewrap_or_apparmor_tools_missing','linux');
  assert.equal(linux.message,'沙箱不能运行包内函数，Hub 不启动：没有找到 bubblewrap 或 AppArmor 的工具');
  assert.match(linux.hint,/bubblewrap.*AppArmor 策略.*用户命名空间.*自带的 Node.*修复后再启动 Hub/);
  assert.doesNotMatch(linux.hint,/sandbox-exec/);
  const mac=sandboxRefusal('no_sandbox_exec','darwin');
  assert.equal(mac.message,'沙箱不能运行包内函数，Hub 不启动：这台机器上没有 sandbox-exec');
  assert.match(mac.hint,/sandbox-exec.*自带的 Node.*修复后再启动 Hub/);
  // The Node the service runs on is the cause production met: the message says which Node and which one is needed.
  assert.match(sandboxRefusal('node_permission_drop_missing','linux').message,/Hub 不启动：运行 Hub 的 Node（v[0-9.]+）在权限模型下没有 process\.permission\.drop；需要 Node 24 及以上/);
  assert.equal(sandboxRefusal(undefined,'darwin').message,'沙箱不能运行包内函数，Hub 不启动：操作系统隔离不可用');
  assert.equal(sandboxRefusal('platform','win32').hint,'Hub 只支持 macOS 和 Linux');
});

test('serve\'s assembly refuses before it builds anything; an assembly that does not require isolation is not asked',async()=>{
  const never=new Proxy({},{get(){throw new Error('the assembly went on after the probe failed');}}) as never;
  let probes=0;
  const failing={available:async()=>{probes++;return false;},failure:()=>'node_permission_drop_missing'};
  await assert.rejects(assembleHub(never,never,{requireVaultKey:false,checkSandbox:true,isolation:failing,log:()=>{}}),(error:unknown)=>{
    assert.ok(error instanceof AssemblyError);
    assert.match(error.message,/^沙箱不能运行包内函数，Hub 不启动：运行 Hub 的 Node/);
    assert.match(error.hint??'',/修复后再启动 Hub|只支持/);
    return true;
  });
  assert.equal(probes,1);
  // A command's assembly (checkSandbox false) and a synthetic environment (requireOsIsolation false) do not probe: they
  // reach the next step, which here is the stand-in that throws.
  for(const options of [{checkSandbox:false},{checkSandbox:true,requireOsIsolation:false}]){
    await assert.rejects(assembleHub(never,never,{requireVaultKey:false,isolation:failing,log:()=>{},...options}),/the assembly went on after the probe failed/);
  }
  assert.equal(probes,1,'no further probe');
});
