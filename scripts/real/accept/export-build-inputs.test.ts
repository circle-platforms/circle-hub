import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, statSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { caseCommandsGold } from '../gold/case-commands.ts';
import { compareCommandIndex } from './command-index.ts';
import { exportBuild, createDeps, main, prepareOutput, ExportError, type Deps } from './export-build-inputs.ts';
import { openBed } from '../../../tests/acceptance/support/hub.ts';
import { agileOptions } from '../../../tests/fixtures/agile/index.ts';
import { productSite, twoNameProduct } from '../../../tests/acceptance/support/env.ts';
import { startPostgres } from '../../../hub/testing/postgres.ts';
import { adminCommands } from '../../../hub/server/cli-admin.ts';
import type { CliContext } from '../../../hub/server/api.ts';

const sha = (s: Uint8Array) => createHash('sha256').update(s).digest('hex');
const root = 'a'.repeat(64), id = 'b'.repeat(64);
function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'export-inputs-'));t.after(() => rmSync(dir, { recursive: true, force: true }));
  const options = { token: 'synthetic-token-must-not-print', url: 'http://127.0.0.1:1/mcp', product: 'synthetic-product', build: 'synthetic-build', out: join(dir, 'out') };
  const entry = (document: string) => ({entry:id,kind:'case',statement:'',reference:`tree:${root}/@${id}`,data:{commands:[],document,node:'synthetic-node'}});
  const view = (document = 'synthetic-doc') => ({schema:'index-view@1',kind:'case',key:'document',product:options.product,build:{root,build:options.build},keys:{[document]:[id]},entries:{[id]:entry(document)},total_keys:1,total_entries:1,truncated:false,cut_keys:[],skipped:0,notes:[]});
  const map = Buffer.from('{"root":{"data":{"id":"synthetic-root","text":"Synthetic"}}}'),tree=Buffer.from('<synthetic/>');
  const list = (external:string, bytes:Buffer) => `${external}\t${sha(bytes)}\t${bytes.length} 字节\t2026-01-01T00:00:00.000Z\n`;
  const calls:string[][]=[];
  const deps:Deps = { index:async()=>({view:view(),root,}),nodes:async()=>{throw new Error('unneeded');},cli:async args=>{
    calls.push(args);
    if(args[1]==='export'){writeFileSync(args[4],args[2]===sha(map)?map:tree,{mode:0o600});return '';}
    if(args[3]==='buildsite:file:')return list(`buildsite:file:/synthetic/command_tree-${options.build}.xml`,tree);
    if(args[3]==='agile:case:synthetic-doc')return list('agile:case:synthetic-doc-extra',tree)+list('agile:case:synthetic-doc',map);
    return '';
  }};
  return {dir,options,deps,view,calls,map,tree,list};
}
test('exports exact latest originals and compatible private manifests without identifiers on screen', async t=>{
  const f=fixture(t);const lines=await exportBuild(f.options,f.deps);
  assert.equal(readFileSync(join(f.options.out,'map-1.json'),'utf8'),f.map.toString());
  assert.equal(readFileSync(join(f.options.out,'command-tree.xml'),'utf8'),f.tree.toString());
  assert.equal(readFileSync(join(f.options.out,'maps.txt'),'utf8'),`${join(realpathSync(f.options.out),'map-1.json')}:synthetic-doc\n`);
  assert.equal(statSync(join(f.options.out,'index-1.json')).mode&0o777,0o600);
  assert.ok(!lines.join('\n').includes('synthetic'));assert.ok(!lines.join('\n').includes(f.options.token));
});
test('preserves the response original while decoding the map data string for the gold input',async t=>{
  const f=fixture(t),raw=Buffer.from(JSON.stringify({code:1000,data:f.map.toString('utf8')}));const cli=f.deps.cli;
  f.deps.cli=async args=>{
    if(args[1]==='list'&&args[3]==='agile:case:synthetic-doc')return f.list(args[3],raw);
    if(args[1]==='export'&&args[2]===sha(raw)){writeFileSync(args[4],raw,{mode:0o600});return '';}
    return cli(args);
  };
  await exportBuild(f.options,f.deps);
  assert.deepEqual(readFileSync(join(f.options.out,'original-map-1.json')),raw);
  assert.deepEqual(readFileSync(join(f.options.out,'map-1.json')),f.map);
});
test('recovers hidden document keys through paged trees and exports each only shard completely',async t=>{
  const f=fixture(t);const other='c'.repeat(64);
  const second=f.view('synthetic-other');second.keys={'synthetic-other':[other]};second.entries={[other]:{...second.entries[id],entry:other,reference:`tree:${root}/@${other}`}};
  const whole={...f.view(),truncated:true,total_keys:2,total_entries:2};let reads=0,nodes=0;
  f.deps.index=async external=>{reads++;return {view:reads===1?whole:external.endsWith('only=synthetic-other')?second:f.view(),root};};
  f.deps.nodes=async args=>{nodes++;return {call_result:'ok',root,nodes:[{entries:[{kind:'case',data:{document:args.cursor?'synthetic-other':'synthetic-doc'}}],children:[]}],next:args.cursor?null:'synthetic-cursor'};};
  const cli=f.deps.cli;f.deps.cli=async args=>args[3]==='agile:case:synthetic-other'?f.list(args[3],f.map):cli(args);
  await exportBuild(f.options,f.deps);assert.equal(reads,3);assert.equal(nodes,2);
  assert.equal(JSON.parse(readFileSync(join(f.options.out,'index-1.json'),'utf8')).truncated,false);
  assert.equal(JSON.parse(readFileSync(join(f.options.out,'index-2.json'),'utf8')).truncated,false);
  assert.equal(readFileSync(join(f.options.out,'maps.txt'),'utf8').trim().split('\n').length,2);
});
test('fails with a fixed missing fact and action for skipped sources, cut keys and root drift',async t=>{
  for(const change of [{skipped:1},{cut_keys:['synthetic-doc']},{build:{root:'c'.repeat(64),build:'synthetic-build'}}]){
    const f=fixture(t);f.deps.index=async()=>({view:{...f.view(),...change},root,});
    await assert.rejects(exportBuild(f.options,f.deps),e=>e instanceof ExportError&&!!e.missing&&!!e.action);
  }
});
test('missing exact map fails rather than borrowing a prefix match',async t=>{
  const f=fixture(t);const cli=f.deps.cli;
  f.deps.cli=async args=>args[1]==='list'&&args[3]==='agile:case:synthetic-doc'?f.list('agile:case:synthetic-doc-extra',f.tree):cli(args);
  await assert.rejects(exportBuild(f.options,f.deps),e=>e instanceof ExportError&&e.missing.includes('1 份'));
});
test('rejects multiple command-tree paths without selecting one',async t=>{
  const f=fixture(t),cli=f.deps.cli;
  f.deps.cli=async args=>args[3]==='buildsite:file:'?f.list(`buildsite:file:/first/command_tree-${f.options.build}.xml`,f.tree)+f.list(`buildsite:file:/second/command_tree-${f.options.build}.xml`,f.tree):cli(args);
  await assert.rejects(exportBuild(f.options,f.deps),e=>e instanceof ExportError&&e.missing.includes('1 份'));
});
test('stops on a repeated node cursor and snapshot changes between index shards',async t=>{
  for(const drift of [false,true]){
    const f=fixture(t);let reads=0;
    f.deps.index=async()=>({view:++reads===1?{...f.view(),truncated:true}:{...f.view(),build:{root:'d'.repeat(64),build:f.options.build}},root:reads===1?root:'d'.repeat(64)});
    f.deps.nodes=async()=>({call_result:'ok',root,nodes:[{entries:[],children:[]}],next:drift?null:'repeated'});
    await assert.rejects(exportBuild(f.options,f.deps),e=>e instanceof ExportError&&!!e.action);
  }
});
test('refuses modified original bytes and repository destinations including symlink ancestors',async t=>{
  const f=fixture(t);const cli=f.deps.cli;f.deps.cli=async args=>{const result=await cli(args);if(args[1]==='export')writeFileSync(args[4],'changed');return result;};
  await assert.rejects(exportBuild(f.options,f.deps),e=>e instanceof ExportError&&e.missing.includes('摘要'));
  assert.throws(()=>prepareOutput(join(process.cwd(),'synthetic-export')));
  const link=join(f.dir,'linked');symlinkSync(process.cwd(),link);assert.throws(()=>prepareOutput(join(link,'synthetic-export')));
});
test('argument and IO failures never print untrusted values or token file contents',async()=>{
  const lines:string[]=[];assert.equal(await main(['--token-file','sensitive-unreadable-name','--product','private-title','--build','private-build','--out','unused'],{out:s=>lines.push(s),error:s=>lines.push(s)}),1);
  assert.ok(!lines.join('').includes('private'));assert.ok(!lines.join('').includes('sensitive'));assert.match(lines.join(''),/下一步/);
});

test('administrator knowledge view and original export operate against the synthetic acceptance Hub', {timeout:180_000}, async t=>{
  const postgres=await startPostgres();t.after(()=>postgres.stop());
  const product=await twoNameProduct(),site=await productSite();
  const match=/_(\d+)_(\d+)_(\d+)_/.exec(site.RELEASED)!;
  const agile=JSON.parse(JSON.stringify(agileOptions()).replaceAll('ORBIT',product.names[0]).replaceAll('COMET',product.names[1]).replaceAll('7.1',match.slice(1).join('.')));
  const bed=await openBed({postgres,syncOneName:false,agile});t.after(()=>bed.close());
  const dir=mkdtempSync(join(tmpdir(),'export-bed-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const kit=bed.hub.records,db=kit.database;
  const runsBefore=await kit.store.list({kind:'run',limit:1});
  const options={token:bed.hub.admin.token,url:bed.hub.mcpUrl,product:bed.product.line,build:bed.site.RELEASED,out:join(dir,'out')};
  const context=(token:string,stdout:string[]):CliContext=>({
    io:{cwd:dir,stdout:s=>stdout.push(s),stderr:()=>{},env:{CIRCLE_HUB_TOKEN:token}},
    config:()=>({...kit.config,database:db,dataDir:kit.dataDir,logDir:join(kit.dataDir,'logs'),host:'127.0.0.1',port:0,keychain:{service:'synthetic',account:'synthetic'}}),
    records:async()=>kit,deps:async()=>{throw new Error('unused');},actingAdmin:async()=>bed.hub.admin.principal,
  });
  const commands=adminCommands();
  const runner:Parameters<typeof createDeps>[1]=async(args,env)=>{
    assert.equal(args[0],'bin/circle-hub');
    assert.ok(!args.includes(options.token));
    const stdout:string[]=[];
    const command=commands.find(c=>c.name===args[1]);assert.ok(command);
    const status=await command.run(args.slice(2),context(env.CIRCLE_HUB_TOKEN!,stdout));
    return {status,stdout:stdout.join('\n')};
  };
  const deps=createDeps(options,runner);
  // Force the byte-cap branch on this small synthetic build; node discovery still uses the actual public MCP server.
  const readIndex=deps.index;let first=true;
  deps.index=async external=>{const read=await readIndex(external);if(first){first=false;read.view.truncated=true;}return read;};
  const lines=await exportBuild(options,deps);
  assert.ok(readdirSync(options.out).some(n=>n.startsWith('index-')));
  assert.ok(readFileSync(join(options.out,'maps.txt'),'utf8').trim());
  assert.ok(readFileSync(join(options.out,'command-tree.xml')).length);
  const maps=readFileSync(join(options.out,'maps.txt'),'utf8').trim().split('\n').map(line=>{const at=line.lastIndexOf(':');return {document:line.slice(at+1),map:JSON.parse(readFileSync(line.slice(0,at),'utf8'))};});
  const gold=caseCommandsGold(readFileSync(join(options.out,'command-tree.xml'),'utf8'),maps);
  assert.ok(gold.cases.length>0);
  const views=readdirSync(options.out).filter(n=>n.startsWith('index-')).map(n=>JSON.parse(readFileSync(join(options.out,n),'utf8')));
  assert.equal(compareCommandIndex(gold,views).verdict,'相等');

  assert.ok(!lines.join('\n').includes(options.token));assert.ok(!lines.join('\n').includes(options.build));
  const viewCommand=commands.find(c=>c.name==='knowledge')!;
  const external=`knowledge:index:${options.product}:${options.build}?kind=case&key=document`;
  const document=Object.keys(views[0].keys)[0];
  const output=join(dir,'view.json'),summary:string[]=[];
  await viewCommand.run(['view',external,'--only',encodeURIComponent(document),'--out',output],context(options.token,summary));
  const written=readFileSync(output),view=JSON.parse(written.toString('utf8'));
  assert.deepEqual(view.only,[document]);
  assert.deepEqual((await kit.store.list({kind:'run',limit:1})).items,runsBefore.items,'view export never creates a run');
  assert.equal(statSync(output).mode&0o777,0o600);
  assert.ok(summary.join('\n').includes(sha(written)));
  assert.ok(summary.join('\n').includes(JSON.stringify(view.totals)));
  assert.match(summary.join('\n'),/截断：否.*跳过：0/);
  for(const privateValue of [document,options.build,options.product,options.token])assert.ok(!summary.join('\n').includes(privateValue));
  await assert.rejects(viewCommand.run(['view',external,'--out',output],context(options.token,[])),/已存在/);
  assert.deepEqual(readFileSync(output),written);
  await assert.rejects(viewCommand.run(['view','knowledge:index:synthetic-private-original:synthetic-build?kind=case&key=document','--out',join(dir,'missing.json')],context(options.token,[])),(e:any)=>!!e.hint&&!e.message.includes('synthetic-private-original'));
  await assert.rejects(viewCommand.run(['view',external+'&only=x','--only','y','--out',join(dir,'duplicate.json')],context(options.token,[])),/不能同时/);

  // The added read command is administrator-only even if a caller can read the product through MCP.
  const reader=await bed.user('合成非管理员',[]);
  await assert.rejects(commands.find(c=>c.name==='knowledge')!.run(['view',`knowledge:index:${options.product}:${options.build}?kind=case&key=document`,'--out',join(dir,'denied.json')],context(reader.token,[])),/管理员/);
});
