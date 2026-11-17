import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeHome } from './circle-home.ts';
import { decideRaw, environment } from './guard-lib.ts';
import { renderAgentDefinition, resolveSubagentRole } from '../../packs/workflow/case-compile/functions/subagent-roles.ts';

function fixture(stdinOnly=false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'guard-process-proof-')));
  const home = join(root, 'Application Support', '合成 Home');
  const { workdir } = writeHome({home, profile:'ops', hubUrl:'http://127.0.0.1:7420/mcp'},
    {protocol:'anthropic', baseUrl:'https://model.example.invalid', apiKey:'synthetic', model:'synthetic', sources:[]}, 'synthetic');
  const tools = join(home, 'skills', 'synthetic', 'tools'); mkdirSync(tools,{recursive:true});
  const file = join(tools,'stdin.ts');
  writeFileSync(join(tools,'..','SKILL.md'),'# Synthetic\n');
  writeFileSync(join(tools,'stdin.cli.json'),JSON.stringify({schema:'tool-cli@2',stdin:['%HUB_TOKEN%'],options:stdinOnly?[]:[
    {name:'out',required:true,kind:'string',multiple:false,placeholder:'<目标路径>',type:'path'},
  ]}));
  const env = environment(home,workdir,'ops-allow.declaration.json');
  const call = (tool_name:string, tool_input:Record<string,unknown>) => decideRaw(env,JSON.stringify({event:'before_tool',cwd:workdir,tool_name,tool_input}));
  return {file,tools,workdir,call,close:()=>rmSync(root,{recursive:true,force:true})};
}
test('T1b #10 token heredoc authority comes from the declaration, independent of reader names and counts', async()=>{
  const f=fixture(true);try{
    for(const name of ['tokenFromStdin','renamedReader','anotherReader']) {
      writeFileSync(f.file,`import{readFileSync}from'node:fs';const OPTIONS={help:false};function ${name}(){return readFileSync(0,'utf8')}async function main(){const token=${name}();process.stdout.write(String(token.length));}if(import.meta.main)await main();\n`);
      const result=await f.call('execute',{command:`node '${f.file}' <<'EOF'\n%HUB_TOKEN%\nEOF`});
      assert.deepEqual(result,{},name);
    }
  }finally{f.close();}
});
test('the remaining template-gap command uses an explicit four-file declaration and actually accepts those arguments',async()=>{
  const f=fixture();try{
    const base=new URL('../../packs/workflow/template-gap/',import.meta.url);
    const file=join(f.tools,'prepare-claims.ts');
    for(const name of ['prepare-claims.ts','prepare-claims.cli.json']) copyFileSync(fileURLToPath(new URL('tools/'+name,base)),join(f.tools,name));
    mkdirSync(join(f.tools,'../tables'),{recursive:true});
    copyFileSync(fileURLToPath(new URL('tables/template-v3.json',base)),join(f.tools,'../tables/template-v3.json'));
    for(const name of ['located.json','choices.json']) writeFileSync(join(f.workdir,name),'[]');
    writeFileSync(join(f.workdir,'identity.json'),JSON.stringify({model_id:'synthetic',model_family_id:'synthetic'}));
    const args=['--located','located.json','--choices','choices.json','--identity','identity.json','--out','claims.json'];
    const command=`node '${file}' `+args.map(value=>`'${value}'`).join(' ');
    assert.deepEqual(await f.call('execute',{command}),{});
    const result=spawnSync(process.execPath,[file,...args],{cwd:f.workdir,input:'',encoding:'utf8',timeout:30_000});
    assert.equal(result.status,0,result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(f.workdir,'claims.json'),'utf8')),[]);
  }finally{f.close();}
});
test('T1b #11 readonly sed receives a read alternative rather than an edit operation', async()=>{
  const f=fixture();try{
    const sed=await f.call('execute',{command:"sed -n '1,3p' inputs.txt"});
    const advice=sed.reason!.split('\n').slice(1,-1).join('\n');
    assert.equal(sed.decision,'deny');assert.match(advice,/read_file/);assert.doesNotMatch(advice,/edit_file/);
  }finally{f.close();}
});
test('T1b #11 unrelated unavailable tools do not receive an invented Hub detour', async()=>{
  const f=fixture();try{
    const unavailable=await f.call('unregistered_fixture_tool',{path:'owned.txt'});
    assert.equal(unavailable.decision,'deny');assert.match(unavailable.reason!,/未提供等价工具|缺少.*能力/);
    assert.doesNotMatch(unavailable.reason!,/hub_list_task_packs/);
  }finally{f.close();}
});
test('T1b #12 writer teaching quotes paths; safe double quotes and workspace delete follow T5 while percent escapes stay literal', async()=>{
  const writer=renderAgentDefinition(resolveSubagentRole('plan')!);
  assert.ok(!writer.includes('<技能目录>') && writer.includes('check-plan.ts --file'), 'B7: agent definition leaves path injection to task-brief');
  const f=fixture();try{
    writeFileSync(f.file,'export function reader(){}\n');
    const command=`node '${f.file}' --out 'out/有 空格.json' <<'EOF'\n%HUB_TOKEN%\nEOF`;
    assert.deepEqual(await f.call('execute',{command}),{});
    const doubleQuoted = await f.call('execute',{command:command.replace(`'${f.file}'`, `"${f.file}"`)});
    assert.deepEqual(doubleQuoted,{},'owner T5 permits safe double quotes');
    const encodedPath = command.replace(f.file, f.file.replaceAll(' ','%20'));
    assert.equal((await f.call('execute',{command:encodedPath})).decision,'deny');
    assert.deepEqual(await f.call('delete',{file_path:'out/有 空格.json'}),{});
    assert.equal((await f.call('delete',{file_path:'../outside.json'})).decision,'deny');
  }finally{f.close();}
});
