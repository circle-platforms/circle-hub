import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { decideRaw, environment, parseCommand } from './guard-lib.ts';
import { writeHome } from './circle-home.ts';

function fixture(profile:'skills'|'ops'='ops') {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'guard-rulings-'))),home=join(root,'Application  Support','合成 Home');
  const {workdir}=writeHome({home,profile,hubUrl:'http://127.0.0.1:7420/mcp'},{protocol:'anthropic',baseUrl:'https://model.example.invalid',apiKey:'synthetic',model:'synthetic',sources:[]},'synthetic');
  const tools=join(home,'skills','synthetic','tools');mkdirSync(tools,{recursive:true});
  const script=join(tools,'entry.ts');writeFileSync(script,'export const synthetic=true;\n');
  writeFileSync(join(tools,'../SKILL.md'),'# Synthetic\n');
  writeFileSync(join(tools,'entry.cli.json'),JSON.stringify({schema:'tool-cli@2',stdin:['%HUB_TOKEN%'],options:[
    {name:'out',required:true,kind:'string',multiple:false,placeholder:'<目标路径>',type:'path'},
    {name:'note',required:false,kind:'string',multiple:false,placeholder:'<说明>',type:'text'},
  ]}));
  const env=environment(home,workdir,profile==='ops'?'ops-allow.declaration.json':'guard.declaration.json');
  const call=(tool_name:string,tool_input:Record<string,unknown>,paths:string[]=[])=>decideRaw(env,JSON.stringify({event:'before_tool',cwd:workdir,tool_name,tool_input,paths}));
  return {root,home,workdir,script,env,call,exec:(command:string)=>call('execute',{command}),close:()=>rmSync(root,{recursive:true,force:true})};
}
const suffix=" <<'EOF'\n%HUB_TOKEN%\nEOF";
function commandAdvice(reason:string) {
  const match=/这次可以这样写：([\s\S]*?)\n规则全文：/.exec(reason);
  assert.ok(match,reason);return match[1];
}
test('T5 safe double-quoted words have literal single-quoted semantics',async()=>{
  assert.deepEqual(parseCommand('node "a b" --note "literal ; * | > 中文"').words,['node','a b','--note','literal ; * | > 中文']);
  assert.equal(parseCommand('node "a b" --note "literal ; * | > 中文"').problem,null);
  assert.equal(parseCommand('node "a b" --note "<<<"').problem,null);
  const f=fixture();try{assert.notEqual((await f.exec(`node "${f.script}" --out "out/有 空格.json" --note "O'Brien"${suffix}`)).decision,'deny');}finally{f.close();}
});
test('T5 a broad delete allow-list entry cannot remove the workspace boundary',async()=>{
  const f=fixture();try{
    f.env.declaration.allow={custom:['delete']};
    f.env.declaration.files!.write=[];
    f.env.declaration.files!.virtualReadOnlyTools=['delete'];
    f.env.declaration.files!.virtualReadOnly=['.*'];
    assert.equal((await f.call('delete',{file_path:join(f.home,'skills/owned.json')})).decision,'deny');
    assert.notEqual((await f.call('delete',{file_path:'owned.json'})).decision,'deny');
    assert.equal((await f.call('delete',{file_path:join(f.root,'outside.json')})).decision,'deny');
  }finally{f.close();}
});
test('T5 dollar, backtick and backslash in double quotes stay denied with literal copyable advice',async()=>{
  const f=fixture();try{for(const value of ['$SYNTHETIC','`synthetic`','a\\b']){
    const result=await f.exec(`node '${f.script}' --out 'out/file.json' --note "${value}"${suffix}`);
    assert.equal(result.decision,'deny',value);
    const fixed=commandAdvice(result.reason!);assert.ok(fixed.includes(`'${value}'`));
    assert.notEqual((await f.exec(fixed)).decision,'deny',fixed);
  }}finally{f.close();}
});
for(const profile of ['skills','ops'] as const)test(`T5 ${profile} delete grants only workspace file targets`,async()=>{
  const f=fixture(profile);try{
    writeFileSync(join(f.workdir,'owned.json'),'{}');
    assert.notEqual((await f.call('delete',{file_path:'owned.json'})).decision,'deny');
    assert.notEqual((await f.call('delete',{file_path:join(f.workdir,'owned.json')})).decision,'deny');
    for(const target of [join(f.root,'outside.json'),join(f.home,'skills/owned.json'),f.workdir]){
      const result=await f.call('delete',{file_path:target});assert.equal(result.decision,'deny');assert.match(result.reason!,/只能删除工作目录.*文件/);
    }
    mkdirSync(join(f.workdir,'subdir'));assert.equal((await f.call('delete',{file_path:'subdir'})).decision,'deny');
    symlinkSync(join(f.root,'outside.json'),join(f.workdir,'link.json'));
    assert.equal((await f.call('delete',{file_path:'link.json'})).decision,'deny');
    assert.equal(readFileSync(join(f.workdir,'owned.json'),'utf8'),'{}','the guard never performs deletion');
  }finally{f.close();}
});
test('T5 escaped spaces remain denied and produce the full same-value quoted command',async()=>{
  const f=fixture();try{
    const escaped=f.script.replaceAll(' ','\\ ');
    const result=await f.exec(`node ${escaped} --out out/a\\ b.json${suffix}`);
    assert.equal(result.decision,'deny');const fixed=commandAdvice(result.reason!);
    assert.ok(fixed.includes(`'${f.script}'`));assert.ok(fixed.includes("'out/a b.json'"));
    assert.notEqual((await f.exec(fixed)).decision,'deny',fixed);
  }finally{f.close();}
});
test('T5 bare spaced script and argument paths stay denied without collapsing their bytes',async()=>{
  const f=fixture();try{
    const result=await f.exec(`node ${f.script} --out out/a  b.json${suffix}`);
    assert.equal(result.decision,'deny');const fixed=commandAdvice(result.reason!);
    assert.ok(fixed.includes(`'${f.script}'`));assert.ok(fixed.includes("'out/a  b.json'"));
    assert.notEqual((await f.exec(fixed)).decision,'deny',fixed);
  }finally{f.close();}
});
test('T5 cd and wc refusals describe the requested operation and actual tool capabilities',async()=>{
  const f=fixture();try{
    const cd=await f.exec('cd subdir');assert.equal(cd.decision,'deny');assert.match(cd.reason!,/会话.*工作目录|后续.*路径/);assert.match(cd.reason!,/ls/);
    const wc=await f.exec('wc -l file.txt');assert.equal(wc.decision,'deny');assert.match(wc.reason!,/统计|计数/);assert.match(wc.reason!,/read_file/);
    assert.doesNotMatch(wc.reason!,/已装的可执行脚本有/);
    assert.equal((await f.exec(`ls "${f.workdir}"`)).decision,'deny');
    assert.equal((await f.exec(`node '${f.script}' --out '../outside.json'${suffix}`)).decision,'deny');
  }finally{f.close();}
});

test('decision 179: the recompose run and a case-compile plan run are opened only by open-compile.ts; a merge run and the test bed are not affected', async () => {
  for (const profile of ['ops', 'skills'] as const) {
    const f = fixture(profile);
    try {
      const start = (input: Record<string, unknown>) => f.call('mcp__hub__start_run', input);
      const recompose = await start({ pack: 'recompose@1.3.0', inputs: { subject: { external: 'agile:mindmap:900001' } } });
      assert.equal(recompose.decision, 'deny', profile);
      assert.match(JSON.stringify(recompose), /用例重组运行只经开运行工具开/);
      assert.match(JSON.stringify(recompose), /open-compile\.ts/);
      const plan = await start({ pack: 'case-compile', predecessor: 'run_01synthetic', inputs: {} });
      assert.equal(plan.decision, 'deny', profile);
      assert.match(JSON.stringify(plan), /脚本编写运行只经开运行工具开/);
      const merge = await start({ pack: 'case-compile', predecessor: 'run_01synthetic', parameters: { plan_run: 'run_01synthetic' }, inputs: {} });
      assert.notEqual(merge.decision, 'deny', `${profile}: a merge run starts as before`);
      const bed = await start({ pack: 'test-bed', parameters: { action: 'acquire' }, inputs: {} });
      assert.notEqual(bed.decision, 'deny', `${profile}: acquiring the test bed is not affected`);
    } finally { f.close(); }
  }
});
