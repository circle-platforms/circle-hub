import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { callSnippet, clientSkillSources, scanSkillPack, scanSkillScripts, REVIEWED_SKILL_CALLS, type CallReview } from './skill-script-safety.ts';
const file = 'packs/workflow/synthetic/tools/client.ts';
const audit = (source: string, reviews: readonly CallReview[] = []) => scanSkillScripts(new Map([[file, source]]), reviews);
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

for (const operation of ['symlink', 'symlinkSync', 'link', 'linkSync', 'rename', 'renameSync', 'cp', 'cpSync']) test(`filesystem ${operation} calls need an exact reviewed call site`, () => {
  for (const source of [`import * as fs from 'node:fs'; fs.${operation}('a','b');`, `import {${operation} as act} from 'node:fs'; act('a','b');`, `const fs = require('fs'); fs['${operation}']('a','b');`, `const {${operation}: act} = require('node:fs/promises'); act('a','b');`]) assert.ok(audit(source).issues.some(v => v.operation === operation), source);
});
test('ordinary reads writes and directories do not imply link creation, and text is not executable code', () => {
  assert.deepEqual(audit(`import {readFile,writeFile,mkdir} from 'node:fs/promises';await mkdir('out');await writeFile('out/a','x');await readFile('out/a');const text="symlink('a','b'); rename('a','b')"; // fs.link('a','b')\n`).issues, []);
});
test('aliases computed method names and indirect filesystem capabilities cannot hide mutation', () => {
  for (const source of [
    `import fs from 'node:fs'; const move=fs.rename; move('a','b');`,
    `import {promises as fsp} from 'node:fs'; const {rename:move}=fsp; move('a','b');`,
    `const fs=await import('node:fs/promises');fs['sym'+'link']('a','b');`,
    `import {createRequire} from 'node:module';const require=createRequire(import.meta.url);const fs=require('fs');fs.link('a','b');`,
    `const fs=process.getBuiltinModule('fs'); fs.renameSync('a','b');`,
    `import fs from 'node:fs'; const name=process.argv[2]; fs[name]('a','b');`,
    `import fs from 'node:fs'; Reflect.apply(fs.rename, fs, ['a','b']);`,
    `import fs from 'node:fs'; export const move = fs.rename;`,
  ]) assert.ok(audit(source).issues.length > 0, source);
});
test('copying is allowed only with statically explicit dereferencing and no preserved symlink option', () => {
  for (const operation of ['cp','cpSync']) {
    assert.deepEqual(audit(`import fs from 'node:fs';fs.${operation}('a','b',{recursive:true,dereference:true});`).issues, []);
    for (const options of ['', ',{dereference:false}', ',{dereference:true,verbatimSymlinks:true}', ',{dereference:true,...options}', ',options']) assert.ok(audit(`import fs from 'node:fs';fs.${operation}('a','b'${options});`).issues.length > 0, options);
  }
});
test('child processes dynamic code and raw native bindings are not an unscanned escape', () => {
  for (const source of [`import {spawn} from 'node:child_process';spawn('ln',['-s','a','b']);`, `import vm from 'node:vm'; vm.runInNewContext(code);`, `eval(code)`, `new Function(code)`, `process.binding('fs')`, `Reflect.construct(Function,[code]);`, `import {exec} from 'node:child_process'; run(exec);`, `import{Worker}from'node:worker_threads';new Worker(code,{eval:true});`, `import{registerHooks}from'node:module';registerHooks(hooks);`]) assert.ok(audit(source).issues.length > 0, source);
});
test('a review pins file call and whole function bytes and cannot approve another call or operation', () => {
  const source = `import {writeFile,rename} from 'node:fs/promises';async function save(){const temp='a.tmp';await writeFile(temp,'x',{flag:'wx'});await rename(temp,'a');}`;
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true); let snippet = '';
  const visit = (node: ts.Node) => { if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'rename') snippet = callSnippet(parsed,node); ts.forEachChild(node,visit); }; visit(parsed);
  const review: CallReview = {file,operation:'rename',call:"rename(temp,'a')",snippetSha256:sha(snippet),reviewer:'合成复核人',date:'2026-10-24',reason:'合成普通文件替换复核'};
  assert.equal(audit(source,[review]).issues.length,0);assert.equal(audit(source,[review]).reviewed.length,1);
  for (const changed of [source.replace("'a.tmp'","'b.tmp'"),source.replace("rename(temp,'a')","rename(temp,'b')"),source.replace("await rename(temp,'a')","await rename(temp,'a');await rename(temp,'a')"),source.replace('rename(temp,','symlink(temp,')]) assert.ok(audit(changed,[review]).issues.length>0);
  assert.ok(scanSkillScripts(new Map([['other.ts',source]]),[review]).issues.length>0);
});
test('the integrator reviewed exactly the Jev atomic file replacement, with a dated reason', () => {
  assert.equal(REVIEWED_SKILL_CALLS.length,1);const reviewed=REVIEWED_SKILL_CALLS[0];
  assert.equal(reviewed.file,'packs/workflow/knowledge-contribution/tools/jev/lib/local.ts');assert.equal(reviewed.operation,'rename');assert.equal(reviewed.call,'rename(temp,file)');assert.equal(reviewed.reviewer,'集成者');assert.match(reviewed.date,/^\d{4}-\d{2}-\d{2}$/);assert.match(reviewed.reason,/普通文件.*目录/);assert.match(reviewed.snippetSha256,/^[a-f0-9]{64}$/);
});
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'skill-script-audit-'));
  const write=(entries: Record<string,string>)=>{
    const files=Object.entries(entries).map(([path,text])=>{const target=join(dir,path);mkdirSync(join(target,'..'),{recursive:true});writeFileSync(target,text);return {path,size:Buffer.byteLength(text),sha256:sha(text)};});
    writeFileSync(join(dir,'pack.json'),JSON.stringify({id:'synthetic',kind:'workflow',files}));
  };
  return {dir,write,close:()=>rmSync(dir,{recursive:true,force:true})};
}
test('the complete manifest covers helper files and inline hooks and checks their original bytes first', () => {
  const f=fixture();try {
    f.write({'tools/client.ts':`import './helper.ts';`,'tools/helper.ts':`import{rename}from'node:fs/promises';rename('a','b');`,'tools/hooks.json':JSON.stringify({hooks:{before_tool:[{command:`node --input-type=module -e 'import{symlinkSync}from "node:fs";symlinkSync("a","b");'`}]}})});
    const result=scanSkillPack(f.dir,[]);assert.equal(result.files,3);assert.ok(result.issues.some(v=>v.file.endsWith('helper.ts')&&v.operation==='rename'));assert.ok(result.issues.some(v=>v.file.includes('#before_tool/0')&&v.operation==='symlinkSync'));
    writeFileSync(join(f.dir,'tools/client.ts'),'changed');assert.throws(()=>scanSkillPack(f.dir,[]),/摘要或长度不符/);
  } finally {f.close();}
});
test('unreadable hook commands and unsafe manifest paths cannot silently lose scan coverage', () => {
  const f=fixture();try {
    f.write({'tools/hooks.json':JSON.stringify({hooks:{before_tool:[{command:'sh do-something.sh'}]}})});assert.throws(()=>scanSkillPack(f.dir,[]),/尚不能静态核对/);
    const manifest=JSON.parse(readFileSync(join(f.dir,'pack.json'),'utf8'));manifest.files[0].path='../outside.ts';writeFileSync(join(f.dir,'pack.json'),JSON.stringify(manifest));assert.throws(()=>scanSkillPack(f.dir,[]),/越界路径/);
  }finally{f.close();}
});

test('a manifest scan cannot delegate code to an unlisted module or hide an unanalyzed program', () => {
  for (const source of [`import {move} from 'fs-extra';move('a','b');`, `import '../outside.ts';`, `await import(process.argv[2]);`, `import{createRequire}from'node:module';const require = createRequire(import.meta.url);require(process.argv[2]);`, `process.getBuiltinModule(process.argv[2]);`, `new globalThis.Function(code);`, `const x = ;`]) assert.ok(audit(source).issues.length>0,source);
});

test('the administrator entry scans manifest bytes and never executes the inspected client', async () => {
  const {spawnSync}=await import('node:child_process');const {existsSync}=await import('node:fs');const f=fixture();
  try {
    f.write({'tools/client.ts':`import{writeFileSync}from'node:fs';writeFileSync('synthetic-marker','not executed');`});
    const entry=fileURLToPath(new URL('./skill-script-safety.ts',import.meta.url));
    const good=spawnSync(process.execPath,[entry,f.dir],{cwd:f.dir,encoding:'utf8'});assert.equal(good.status,0,good.stderr);assert.match(good.stdout,/脚本 1.*未通过 0/);assert.equal(existsSync(join(f.dir,'synthetic-marker')),false);
    f.write({'tools/client.ts':`import{symlinkSync}from'node:fs';symlinkSync('a','b');`});
    const bad=spawnSync(process.execPath,[entry,f.dir],{cwd:f.dir,encoding:'utf8'});assert.equal(bad.status,1);assert.match(bad.stdout,/symlinkSync/);assert.equal(existsSync(join(f.dir,'b')),false);
  }finally{f.close();}
});

test('hub sandbox modules stay out of the client scan until a tool or hook imports them', () => {
  const fn = 'packs/workflow/synthetic/functions/check.ts';
  const tool = 'packs/workflow/synthetic/tools/client.ts';
  const hubOnly = new Map([[tool, `import '../tables/template-v3.json' with { type: 'json' };`], [fn, `import { fromJSONSchema } from 'zod';`]]);
  assert.deepEqual([...clientSkillSources(hubOnly).keys()], [tool]);
  const pulled = new Map([[tool, `import '../functions/check.ts';`], [fn, `import { fromJSONSchema } from 'zod';`]]);
  assert.deepEqual([...clientSkillSources(pulled).keys()].sort(), [fn, tool]);
  assert.ok(scanSkillScripts(clientSkillSources(pulled)).issues.some(issue => issue.file === fn && issue.operation === 'import'));
  const f = fixture();
  try {
    f.write({ 'tools/prepare.ts': `import '../tables/template-v3.json' with { type: 'json' };`, 'functions/check.ts': `import { fromJSONSchema } from 'zod';`, 'tables/template-v3.json': '{}' });
    assert.deepEqual(scanSkillPack(f.dir).issues, []);
    f.write({ 'tools/prepare.ts': `import '../functions/check.ts';`, 'functions/check.ts': `import { fromJSONSchema } from 'zod';` });
    assert.ok(scanSkillPack(f.dir).issues.some(issue => issue.operation === 'import'));
  } finally { f.close(); }
});
test('every published client skill and helper passes the manifest gate with all call reviews accounted for', t => {
  const repository=fileURLToPath(new URL('../../',import.meta.url));
  const directories: string[]=[];
  const walk=(directory:string)=>{
    for(const entry of readdirSync(directory,{withFileTypes:true})){
      if(!entry.isDirectory())continue;
      const child=join(directory,entry.name),manifest=join(child,'pack.json');
      if(existsSync(manifest)){
        const pack=JSON.parse(readFileSync(manifest,'utf8'));
        if(pack.schema==='pack@1'&&Array.isArray(pack.files)&&pack.files.some((file:{path:string})=>file.path.startsWith('tools/')&&/\.[cm]?[jt]sx?$/.test(file.path)))directories.push(child);
      }else walk(child);
    }
  };
  walk(join(repository,'packs'));
  const ids=directories.map(directory=>JSON.parse(readFileSync(join(directory,'pack.json'),'utf8')).id);
  for(const required of ['case-compile','knowledge-contribution'])assert.ok(ids.includes(required),`missing published client scripts for ${required}; merge the required layout and skill packages before claiming coverage`);
  const reviewed=[];
  for(const directory of directories.sort()){
    const pack=JSON.parse(readFileSync(join(directory,'pack.json'),'utf8'));const result=scanSkillPack(directory);
    assert.ok(result.files>0);assert.deepEqual(result.issues,[],JSON.stringify(result.issues));reviewed.push(...result.reviewed);
    t.diagnostic(`${pack.id}: ${result.files} script/helper/hook sources; ${result.reviewed.length} reviewed call sites`);
  }
  assert.deepEqual(reviewed,REVIEWED_SKILL_CALLS,'every registered call site must still occur exactly once in a scanned published package');
});
