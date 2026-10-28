import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaultSystemdDirectory, renderSystemdUnit, systemdAgent } from './systemd.ts';
import type { ServiceDefinition } from './launchd.ts';
import { exit, ok, recordingRunner, removeDir, tempDir } from './test-support.ts';

const definition: ServiceDefinition = {
  label: 'io.example.circle-hub', programArguments: ['/usr/bin/node', '/tmp/a b/current/bin/circle-hub', 'serve'],
  workingDirectory: '/tmp/a b/current', environment: { HOME: '/tmp/a b', PATH: '/usr/bin:/bin', CIRCLE_HUB_DATA_DIR: '/tmp/a b' },
  standardOutPath: '/tmp/a b/log/out', standardErrorPath: '/tmp/a b/log/err',
};
const syntheticIdentity={uid:1234,username:'synthetic-user',homedir:'/synthetic/home'};

test('systemd unit preserves argv, exact environment and service recovery without shell interpolation', () => {
  const text = renderSystemdUnit({...definition, programArguments: ['/usr/bin/node', '/tmp/a$X/%p"q', 'serve']});
  assert.match(text, /^ExecStart="\/usr\/bin\/node" "\/tmp\/a\$\$X\/%%p\\"q" "serve"$/m);
  assert.match(text, /^Environment="CIRCLE_HUB_DATA_DIR=\/tmp\/a b"$/m);
  assert.match(text, /^WorkingDirectory=\/tmp\/a b\/current$/m);
  assert.match(text, /^StandardOutput=append:\/tmp\/a b\/log\/out$/m);
  assert.match(text, /^Restart=always$/m);
  assert.match(text, /^RestartSec=10$/m);
  assert.match(text, /^UMask=0077$/m);
  assert.match(text, /^WantedBy=default.target$/m);
  assert.equal(defaultSystemdDirectory('/tmp/account'), '/tmp/account/.config/systemd/user');
  assert.throws(() => renderSystemdUnit({...definition, workingDirectory: '/tmp/a\nExecStart=/bad'}), /控制字符/);
  assert.throws(() => renderSystemdUnit({...definition, programArguments: ['node']}), /绝对路径/);
  assert.throws(() => renderSystemdUnit({...definition, environment: {'BAD\nNAME': 'x'}}), /变量名/);
});

test('install, stop, start and uninstall manipulate only the given user manager and fail closed on unknown status', async t => {
  const directory = await tempDir(); t.after(() => removeDir(directory));
  const state = { installed: false, active: 'inactive' };
  const recorder = recordingRunner(call => {
    assert.equal(call.command, '/synthetic/systemctl');
    assert.equal(call.options?.env?.XDG_RUNTIME_DIR, '/run/user/1234');
    assert.equal(call.options?.env?.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1234/bus');
    assert.equal(call.options?.env?.HOME,syntheticIdentity.homedir);
    assert.equal(call.options?.env?.USER,syntheticIdentity.username);
    const args = call.args;
    if (args[1] === 'show') return state.installed ? ok(`LoadState=loaded\nActiveState=${state.active}\nMainPID=${state.active === 'active' ? '99' : '0'}\nExecMainStatus=0\nFragmentPath=${join(directory,definition.label+'.service')}\n`) : exit(1, '', 'LoadState=not-found\n');
    if (args[1] === 'daemon-reload') return ok();
    if (args[1] === 'enable') { state.installed = true; state.active = 'active'; return ok(); }
    if (args[1] === 'disable') { state.installed = false; return ok(); }
    if (args[1] === 'start') { state.active = 'active'; return ok(); }
    if (args[1] === 'stop') { state.active = 'inactive'; return ok(); }
    return exit(1, 'unexpected');
  }, {real:false});
  const agent = systemdAgent({label:definition.label, directory, uid:1234, runner:recorder.runner, systemctl:'/synthetic/systemctl',identity:syntheticIdentity});
  assert.deepEqual(await agent.status(), {plist:agent.plist, installed:false, loaded:false, running:false});
  await assert.rejects(agent.start(), /还没安装/);
  assert.equal(await agent.stop(), false);
  await agent.install(definition);
  assert.equal(await readFile(agent.plist, 'utf8'), renderSystemdUnit(definition));
  assert.equal((await stat(agent.plist)).mode & 0o777, 0o644);
  assert.deepEqual((await agent.status()).pid, 99);
  assert.equal(await agent.start(), false);
  assert.equal(await agent.stop(), true);
  assert.equal((await agent.status()).loaded, false);
  assert.equal(await agent.start(), true);
  assert.equal(await agent.uninstall(), true);
  assert.equal(await agent.uninstall(), false);
  assert.ok(recorder.calls.every(call => call.args[0] === '--user'));
  const disconnected = recordingRunner(() => exit(1, 'Failed to connect to bus'), {real:false});
  const inaccessible = systemdAgent({label:definition.label,directory,uid:1234,runner:disconnected.runner,systemctl:'/synthetic/systemctl',identity:syntheticIdentity});
  await assert.rejects(inaccessible.status(), /无法读取 systemd 服务状态/);
  await assert.rejects(inaccessible.install(definition), /无法读取 systemd 服务状态/);
});

test('a loaded unit without its expected file is never stopped, disabled, overwritten or reported as uninstalled', async t => {
  const directory=await tempDir();t.after(()=>removeDir(directory));
  for (const active of ['active','inactive']) {
    const recorder=recordingRunner(call=>call.args[1]==='show' ? ok(`LoadState=loaded\nActiveState=${active}\nMainPID=0\nExecMainStatus=0\n`) : exit(1,'unexpected'),{real:false});
    const agent=systemdAgent({label:definition.label,directory,uid:1234,identity:syntheticIdentity,runner:recorder.runner,systemctl:'/synthetic/systemctl'});
    for (const action of [()=>agent.uninstall(),()=>agent.stop(),()=>agent.install(definition)]) await assert.rejects(action(),/预期服务文件不存在/);
    assert.ok(recorder.calls.every(call=>call.args[1]==='show'));
  }
});

test('a different loaded unit with the same name is never controlled even when the expected file exists', async t=>{
  const directory=await tempDir();t.after(()=>removeDir(directory));
  const expected=join(directory,definition.label+'.service');await writeFile(expected,'synthetic unit');
  const recorder=recordingRunner(call=>call.args[1]==='show' ? ok('LoadState=loaded\nActiveState=active\nMainPID=12\nExecMainStatus=0\nFragmentPath=/synthetic/foreign-unit\n') : exit(1,'unexpected'),{real:false});
  const agent=systemdAgent({label:definition.label,directory,uid:1234,identity:syntheticIdentity,runner:recorder.runner,systemctl:'/synthetic/systemctl'});
  for (const action of [()=>agent.uninstall(),()=>agent.stop(),()=>agent.install(definition),()=>agent.start()]) await assert.rejects(action(),/来源与预期文件不一致/);
  assert.ok(recorder.calls.every(call=>call.args[1]==='show'));
  assert.equal(await readFile(expected,'utf8'),'synthetic unit');
});

test('systemctl receives the effective account home and user instead of inherited values, and rejects a mismatched UID', async t=>{
  const directory=await tempDir();t.after(()=>removeDir(directory));
  const originalHome=process.env.HOME,originalUser=process.env.USER;
  const recorder=recordingRunner(()=>ok('LoadState=not-found\n'),{real:false});
  try {
    process.env.HOME='/synthetic/wrong-home';process.env.USER='wrong-user';
    const agent=systemdAgent({label:definition.label,directory,uid:1234,identity:syntheticIdentity,runner:recorder.runner,systemctl:'/synthetic/systemctl'});
    await agent.status();
    assert.equal(recorder.calls[0]?.options?.env?.HOME,syntheticIdentity.homedir);
    assert.equal(recorder.calls[0]?.options?.env?.USER,syntheticIdentity.username);
    assert.throws(()=>systemdAgent({label:definition.label,directory,uid:1235,identity:syntheticIdentity,runner:recorder.runner}),/UID 与当前有效账户不一致/);
  } finally {
    if(originalHome===undefined)delete process.env.HOME;else process.env.HOME=originalHome;
    if(originalUser===undefined)delete process.env.USER;else process.env.USER=originalUser;
  }
});

 test('contradictory missing-unit state never authorizes stop or uninstall', async t=>{
  const directory=await tempDir();t.after(()=>removeDir(directory));
  const recorder=recordingRunner(()=>ok('LoadState=not-found\nActiveState=active\nMainPID=12\n'),{real:false});
  const agent=systemdAgent({label:definition.label,directory,uid:1234,identity:syntheticIdentity,runner:recorder.runner});
  await assert.rejects(agent.stop(),/无法读取 systemd/);await assert.rejects(agent.uninstall(),/无法读取 systemd/);
  assert.ok(recorder.calls.every(call=>call.args[1]==='show'));
 });
