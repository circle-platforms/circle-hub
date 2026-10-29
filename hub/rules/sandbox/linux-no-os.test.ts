import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { osIsolationAvailable } from './isolation.ts';
import { callPackFunction } from './sandbox.ts';

test('a Linux synthetic worker without OS isolation retains its event loop', async t => {
  if (process.platform !== 'linux') return t.skip('Linux-only synthetic path');
  if (await osIsolationAvailable()) return t.skip('requires a synthetic host without the Hub AppArmor profile');
  const dir = await mkdtemp(join(tmpdir(),'synthetic-no-os-'));
  try {
    await writeFile(join(dir,'fn.ts'),`export default async function(){await new Promise(resolve=>setTimeout(resolve,50));return {ok:true}}`);
    const result = await callPackFunction({packDir:dir,module:'fn.ts'},null,{}, {requireOsIsolation:false});
    assert.equal(result.osIsolation,false); assert.deepEqual(result.output,{ok:true});
  } finally { await rm(dir,{recursive:true,force:true}); }
});
