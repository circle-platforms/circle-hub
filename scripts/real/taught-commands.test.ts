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
test('unknown placeholders and malformed heredoc prose are never converted into invented valid commands', async () => {
  const { extractTaughtCommands, instantiateTaughtCommand } = await import('./taught-commands.ts');
  assert.equal(expandTaughtPlaceholders('node x.ts --file <unknown>')[0], 'node x.ts --file <unknown>');
  const [taught] = extractTaughtCommands("```text\nnode '<技能目录>/tools/x.ts' --file a <<'EOF'（接两行）\n```", 'synthetic.md');
  assert.ok(taught);
  assert.equal(instantiateTaughtCommand(taught, { skillDir: '/synthetic' })[0], "node '/synthetic/tools/x.ts' --file a <<'EOF'（接两行）");
});
test('an authored zero-argument CLI command remains a preflight case', async () => {
  const { extractTaughtCommands, instantiateTaughtCommand } = await import('./taught-commands.ts');
  const [entry] = extractTaughtCommands("```sh\nnode '<技能目录>/tools/install-agents.ts'\n```", 'synthetic.md');
  assert.ok(entry);
  assert.deepEqual(instantiateTaughtCommand(entry, { skillDir: '/synthetic space' }), ["node '/synthetic space/tools/install-agents.ts'"]);
});
test('the exact authored generic CLI grammar is an abstract template, including its quoted-value spelling', async () => {
  const { extractTaughtCommands, instantiateTaughtCommand } = await import('./taught-commands.ts');
  for (const grammar of ["node '<技能目录>/tools/<脚本>.ts' --选项 值", "node '<技能目录>/tools/<脚本>.ts' --选项 '值'", 'node <技能目录>/tools/<脚本>.ts --选项 值']) {
    const [entry] = extractTaughtCommands(`语法：\`${grammar}\``, 'synthetic.md');
    assert.equal(entry?.isMetaTemplate, true);
    assert.deepEqual(instantiateTaughtCommand(entry!, { skillDir: '/synthetic' }), []);
  }
});
