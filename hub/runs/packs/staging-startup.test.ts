import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {access,mkdir,writeFile,chmod,symlink,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {temporaryDirectory} from './testing/builder.ts';
import {Extractor,sweepPackStages} from './extract.ts';
import {sha256Hex} from '../../records/api.ts';

test('startup removes fresh stages left by a crashed publisher in both roots, including legacy names',async t=>{
 const temp=await temporaryDirectory();t.after(()=>temp.remove());const root=join(temp.path,'packs'),bytes=Buffer.from('{}'),digest=sha256Hex(bytes);
 const source=`import {Extractor} from ${JSON.stringify(new URL('./extract.ts',import.meta.url).href)};import {createHash} from 'node:crypto';import {join} from 'node:path';
 const bytes=Buffer.from('{}'),hash=createHash('sha256').update(bytes).digest('hex'),roots=[process.argv[1],join(process.argv[1],'personal')],dirs=[];
 for(const root of roots)dirs.push((await new Extractor({root}).stage(hash,bytes,[{path:'SKILL.md',bytes:Buffer.from('synthetic private promotion text')}])).directory);
 process.stdout.write(JSON.stringify(dirs)+'\\n');process.stdin.resume();`;
 const child=spawn(process.execPath,['--input-type=module','-e',source,root],{env:{PATH:process.env.PATH},stdio:['pipe','pipe','pipe']});const exited=once(child,'exit');t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;});
 let output='';for await(const chunk of child.stdout){output+=chunk.toString();if(output.includes('\n'))break;}
 const dirs=JSON.parse(output) as string[];assert.equal(dirs.length,2);
 assert.equal(await sweepPackStages(root),0,'a still-running CLI publisher is not an orphan');
 child.kill('SIGKILL');await exited;
 const legacy=join(root,'.tmp-'+digest+'-synthetic-legacy');await mkdir(legacy);await writeFile(join(legacy,'SKILL.md'),'synthetic legacy private text');await chmod(legacy,0o500);
 const stable=join(root,digest);await mkdir(stable);await writeFile(join(stable,'SKILL.md'),'synthetic published text');
 const outside=join(temp.path,'outside');await mkdir(outside);await writeFile(join(outside,'keep'),'synthetic outside');const link=join(root,'.tmp-'+digest+'-abcdef123456');await symlink(outside,link);
 assert.equal(await sweepPackStages(root),4);for(const path of [...dirs,legacy,link])await assert.rejects(access(path));await access(stable);assert.equal(await readFile(join(outside,'keep'),'utf8'),'synthetic outside');assert.equal(await sweepPackStages(root),0);
});

test('startup never removes a stage still owned in this process and does not follow a private-root link',async t=>{
 const temp=await temporaryDirectory();t.after(()=>temp.remove());const bytes=Buffer.from('{}'),digest=sha256Hex(bytes),stage=await new Extractor({root:temp.path}).stage(digest,bytes,[]);t.after(()=>stage.discard());
 assert.equal(await sweepPackStages(temp.path),0);await access(stage.directory);await stage.discard();
 const outside=await temporaryDirectory();t.after(()=>outside.remove());await symlink(outside.path,join(temp.path,'personal'));
 await assert.rejects(sweepPackStages(temp.path),error=>error instanceof Error&&error.message==='发布暂存清理未完成');
});
