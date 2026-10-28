// The real user manager is exercised only by explicit opt-in on an isolated Linux test machine.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {defaultSystemdDirectory, systemdAgent} from './systemd.ts';

const enabled = process.platform === 'linux' && process.env.HUB_TEST_SYSTEMD_REAL === '1';
test('synthetic user unit really installs, stops, restarts and uninstalls on Linux', {skip: enabled ? false : 'requires an isolated Linux user manager and explicit HUB_TEST_SYSTEMD_REAL=1'}, async () => {
  const root=await mkdtemp(join(tmpdir(),'hub systemd % synthetic-'));
  const label='circle-hub-synthetic-test-'+randomBytes(8).toString('hex');
  const agent=systemdAgent({label,directory:defaultSystemdDirectory(),uid:process.getuid!()});
  const preexisting = await agent.status();
  assert.equal(preexisting.installed, false, 'refuse a pre-existing synthetic unit before cleanup is armed');
  assert.equal(preexisting.loaded, false, 'refuse a loaded synthetic unit before cleanup is armed');
  try {
    assert.equal((await agent.status()).installed,false);
    await agent.install({label,programArguments:['/usr/bin/sleep','30'],workingDirectory:root,environment:{SYNTHETIC:'ok'},standardOutPath:join(root,'out'),standardErrorPath:join(root,'err')});
    assert.equal((await agent.status()).running,true);
    assert.equal(await agent.stop(),true);
    assert.equal((await agent.status()).running,false);
    assert.equal(await agent.start(),true);
    assert.equal((await agent.status()).running,true);
    assert.equal(await agent.uninstall(),true);
    assert.equal((await agent.status()).installed,false);
    const enabled=spawnSync('/usr/bin/systemctl',['--user','is-enabled',`${label}.service`],{stdio:'ignore'});
    assert.notEqual(enabled.status,0,'uninstall must also disable automatic restart on login or reboot');
  } finally {
    // If a malformed test unit cannot be loaded, remove only the unique name created by this test.
    spawnSync('/usr/bin/systemctl',['--user','disable','--now',`${label}.service`],{stdio:'ignore'});
    await rm(agent.plist,{force:true});
    spawnSync('/usr/bin/systemctl',['--user','daemon-reload'],{stdio:'ignore'});
    await rm(root,{recursive:true,force:true});
  }
});
