import assert from 'node:assert/strict';
import{test}from'node:test';
import{bindSkillDirectory,expandTaughtPlaceholders}from'./taught-commands.ts';
test('skill directory binding preserves both correct quotes and authored missing quotes',()=>{
  const dir='/synthetic/with space';
  assert.equal(bindSkillDirectory("node '<技能目录>/tools/check.ts' --file a.json",dir),"node '/synthetic/with space/tools/check.ts' --file a.json");
  assert.equal(bindSkillDirectory('node <技能目录>/tools/check.ts --file a.json',dir),'node /synthetic/with space/tools/check.ts --file a.json');
});
test('placeholder expansion never repairs bare values containing spaces or collapses quoted whitespace',()=>{
  const [bare]=expandTaughtPlaceholders('node x.ts --file <synthetic>',{synthetic:'a b.json'});assert.equal(bare,'node x.ts --file a b.json');
  const [quoted]=expandTaughtPlaceholders("node x.ts --file '<synthetic>'",{synthetic:'a  b.json'});assert.equal(quoted,"node x.ts --file 'a  b.json'");
});
