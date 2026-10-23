import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { callPackFunctionBatch } from './sandbox.ts';
import { osIsolationAvailable } from './isolation.ts';

test('one isolated batch retains ordered per-item outputs, logs and ordinary failures', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'circle-hub-function-batch-')));
  try {
    await writeFile(join(dir, 'fn.ts'), `export default input => { console.log(input.id); if(input.fail) throw new Error('synthetic failure'); return {id:input.id}; };`);
    const result = await callPackFunctionBatch({ packDir: dir, module: 'fn.ts' }, [{id:'one'}, {id:'bad',fail:true}, {id:'two'}], {}, {requireOsIsolation:await osIsolationAvailable()});
    assert.equal(result.length, 3);
    assert.ok(result[0].ok); assert.deepEqual(result[0].result.output, {id:'one'}); assert.equal(result[0].result.stdout, 'one\n');
    assert.ok(!result[1].ok); assert.equal(result[1].error.code, 'FUNCTION_THREW'); assert.equal(result[1].error.detail.phase, 'call');
    assert.ok(result[2].ok); assert.deepEqual(result[2].result.output, {id:'two'}); assert.equal(result[2].result.stdout, 'two\n');
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('a batch boundary violation cannot be hidden by catching it or by an earlier valid item', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'circle-hub-function-batch-')));
  try {
    await writeFile(join(dir,'fn.ts'), `export default input => { if(input.bad) {try {process.binding('fs');} catch {}} return input; };`);
    await assert.rejects(callPackFunctionBatch({packDir:dir,module:'fn.ts'},[{}, {bad:true}],{}, {requireOsIsolation:await osIsolationAvailable()}), /沙箱|边界/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('batch input and output budgets remain bounded and each valid output is independent JSON', async () => {
  const dir=await realpath(await mkdtemp(join(tmpdir(),'circle-hub-function-batch-')));
  try {
    await writeFile(join(dir,'fn.ts'), `export default input => input.invalid ? undefined : {text:input.text};`);
    const opts={requireOsIsolation:await osIsolationAvailable()};
    await assert.rejects(callPackFunctionBatch({packDir:dir,module:'fn.ts'},[{text:'x'.repeat(900)},{text:'x'.repeat(900)}],{inputBytes:1024},opts), /输入超过/);
    const results=await callPackFunctionBatch({packDir:dir,module:'fn.ts'},[{text:'ok'}, {invalid:true}],{},opts);
    assert.ok(results[0].ok); assert.ok(!results[1].ok); assert.equal(results[1].error.code,'FUNCTION_THREW');
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('an oversized individual output is isolated without increasing its original cap', async () => {
  const dir=await realpath(await mkdtemp(join(tmpdir(),'circle-hub-function-batch-')));
  try {
    await writeFile(join(dir,'fn.ts'),'export default input => input.big ? "x".repeat(2000) : "ok";');
    const result=await callPackFunctionBatch({packDir:dir,module:'fn.ts'},[{big:true},{}],{outputBytes:1024},{requireOsIsolation:await osIsolationAvailable()});
    assert.ok(!result[0].ok);assert.equal(result[0].error.code,'SANDBOX_OUTPUT_TOO_LARGE');
    assert.ok(result[1].ok);assert.equal(result[1].result.output,'ok');
  } finally {await rm(dir,{recursive:true,force:true});}
});
