import assert from 'node:assert/strict';
import {test} from 'node:test';
import {access,mkdir,writeFile,utimes,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {startPostgres} from '../../testing/postgres.ts';
import {openPackTestbed} from './testing/setup.ts';
import {readPackDirectory} from './directory.ts';
import {Extractor} from './extract.ts';

test('member cleanup preserves fresh equal-digest team staging and removes stale shared and fresh private remnants',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const bed=await openPackTestbed({postgres:pg});t.after(()=>bed.close());
 const pack={id:'synthetic-shared-cache',version:'1.0.0',kind:'skill' as const,title:'合成缓存技能',description:'合成缓存清理回归',files:{'SKILL.md':'# 合成缓存技能\n\n核对合成输入。\n','skill.json':{schema:'skill@1',kind:'skill',parsers:[],producers:[],effects:[]}}};
 const written=await bed.write(pack),read=await readPackDirectory(written.dir);assert.ok(read.ok);const {digest,manifestBytes,files}=read.pack;
 await bed.kit.personalPayloads!.stage(bed.carol.id,digest,async()=>{});
 // Two independent publisher processes can stage the same manifest; neither is the member's private cache.
 const first=new Extractor({root:bed.extractDir}),second=new Extractor({root:bed.extractDir});
 const stage=()=>[manifestBytes,files.map(file=>({path:file.path,bytes:file.bytes}))] as const;
 const one=await first.stage(digest,...stage()),two=await second.stage(digest,...stage());t.after(()=>one.discard());t.after(()=>two.discard());
 const sharedOld=join(bed.extractDir,'.tmp-'+digest+'-synthetic-abandoned'),privateFresh=join(bed.extractDir,'personal','.tmp-'+digest+'-synthetic-private');
 for(const dir of [sharedOld,privateFresh]){await mkdir(dir,{recursive:true});await writeFile(join(dir,'SKILL.md'),'synthetic uncommitted text');}
 const old=new Date(Date.now()-48*60*60*1000);await utimes(sharedOld,old,old);
 const api=bed.kit.memberDeletions!,preview=await api.preview(bed.admin,bed.carol.id),intent=await api.prepare(bed.admin,{...preview,operation_id:randomUUID()});await api.finish(bed.admin,bed.carol.id,intent.operation_id);
 await access(one.directory);await access(two.directory);await assert.rejects(access(sharedOld));await assert.rejects(access(privateFresh));
 const promoted=await one.promote();assert.equal(await readFile(join(promoted,'SKILL.md'),'utf8'),pack.files['SKILL.md']);await two.discard();await assert.rejects(access(two.directory));
 assert.ok((await bed.kit.principals.get(bed.carol.id))?.deleted_at);
});
