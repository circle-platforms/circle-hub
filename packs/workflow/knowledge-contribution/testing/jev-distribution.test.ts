import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { AXES } from '../../../../contracts/generated/vocabulary.ts';
import { verifyInstall } from '../pack-files.ts';
const skill=new URL('../tools/jev/',import.meta.url);
test('the installed standalone subtree matches every manifest byte and refuses changes extras missing files and links',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jev-install-'));t.after(()=>rm(dir,{recursive:true,force:true}));await cp(skill,join(dir,'skill'),{recursive:true});assert.deepEqual(await verifyInstall(join(dir,'skill')),[]);
 await writeFile(join(dir,'skill/extra.txt'),'synthetic');assert.ok((await verifyInstall(join(dir,'skill'))).includes('extra.txt'));await rm(join(dir,'skill/extra.txt'));
 const file=join(dir,'skill/egress.json');const bytes=await readFile(file);await writeFile(file,'changed');assert.ok((await verifyInstall(join(dir,'skill'))).includes('egress.json'));await rm(file);assert.ok((await verifyInstall(join(dir,'skill'))).includes('egress.json'));await writeFile(join(dir,'outside'),bytes);await symlink(join(dir,'outside'),file);assert.ok((await verifyInstall(join(dir,'skill'))).includes('egress.json'));
});
test('before_tool hook asks for explicit egress opt-in and malformed input without installation paths',async()=>{
 const hook=JSON.parse(await readFile(new URL('hooks.json',skill),'utf8')).hooks.before_tool[0];
 for(const [input,expected]of [[{event:'before_tool',tool_name:'execute',tool_input:{command:'node skill/jev.ts ask --send case'}},{decision:'ask'}],[{event:'before_tool',tool_name:'execute',tool_input:{command:'node skill/jev.ts ask'}},{}],[{}, {decision:'ask'}],['bad JSON',{decision:'ask'}]]){const result=spawnSync(hook.command,{shell:true,input:typeof input==='string'?input:JSON.stringify(input),encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),expected);}
});
test('the skill uses only self-contained builtin imports and vocabulary axes come from its generated snapshot',async()=>{
 const ts=await import('typescript');const issues:string[]=[];
 const walk=async(url:URL):Promise<void>=>{for(const name of await readdir(url,{withFileTypes:true})){const file=new URL(name.name+(name.isDirectory()?'/':''),url);if(name.isDirectory())await walk(file);else if(name.name.endsWith('.ts')){const text=await readFile(file,'utf8');for(const match of text.matchAll(/(?:from\s*|import\s*\()(['"])([^'"]+)\1/g)){const path=match[2]!;assert.ok(path.startsWith('node:')||path.startsWith('./')||path.startsWith('../'),path);if(path.startsWith('.'))assert.ok(new URL(path,file).href.startsWith(skill.href),path);}
 const source=ts.createSourceFile(file.pathname,text,ts.ScriptTarget.Latest,true);const visit=(node:import('typescript').Node)=>{let values:string[]=[];if(ts.isArrayLiteralExpression(node))values=node.elements.filter(ts.isStringLiteral).map(v=>v.text);if(ts.isUnionTypeNode(node))values=node.types.filter(ts.isLiteralTypeNode).filter(v=>ts.isStringLiteral(v.literal)).map(v=>(v.literal as import('typescript').StringLiteral).text);if(values.length>=2)for(const [axis,codes]of Object.entries(AXES))if(values.every(v=>codes.values.some(code=>code.code===v)))issues.push(axis+':'+file.pathname);ts.forEachChild(node,visit);};visit(source);
 }}};await walk(skill);assert.deepEqual(issues,[]);
 const text=await readFile(new URL('SKILL.md',skill),'utf8');assert.match(text,/^---\nname: jev\n/);assert.ok((/^description: (.+)$/m.exec(text)?.[1]?.length??2000)<=1024);
});

test('the generated snapshot contains separate identity fields and every generated read tier without a pack digest',async()=>{
 const {READ_TIER,labelOf}=await import('../../../../contracts/generated/vocabulary.ts');const manifest=JSON.parse(await readFile(new URL('../pack.json',import.meta.url),'utf8'));const snapshot=JSON.parse(await readFile(new URL('generated.json',skill),'utf8'));
 assert.equal(snapshot.id,manifest.id);assert.equal(snapshot.version,manifest.version);assert.equal(snapshot.pack,undefined);assert.equal(snapshot.pack_digest,undefined);assert.deepEqual(snapshot.axes.read_tier,READ_TIER.map(code=>({code,label:labelOf('read_tier',code)})));assert.equal(snapshot.model_readable,READ_TIER.find(code=>code==='model_readable'));
});
