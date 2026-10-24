import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('12000-command tree reads scale with plan paths, deduplicate and stay below a fixed peak RSS',t=>{
 for(const planned of [1,16]){
  const result=spawnSync(process.execPath,['--max-old-space-size=192',fileURLToPath(new URL('./testing/large-catalog.ts',import.meta.url)),String(planned)],{encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stderr);const receipt=JSON.parse(result.stdout);
  assert.equal(receipt.count,12000);assert.equal(receipt.entries.length,planned);
  assert.equal(receipt.nodeReads,planned);assert.equal(receipt.rowReads,planned);assert.equal(receipt.entryReads,planned);
  assert.ok(receipt.peakKiB<384*1024,JSON.stringify(receipt));assert.ok(receipt.increaseKiB<64*1024,JSON.stringify(receipt));
  t.diagnostic(JSON.stringify(receipt));
 }
});
