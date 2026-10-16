import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {sandboxTest} from '../acceptance/harness.ts';
import {isolatedProcess} from '../../packages/runtime/src/isolation.ts';
sandboxTest('Runtime isolation prevents direct and symlink reads of the private vault while retaining workspace output',async t=>{
  const root=await mkdtemp(join(tmpdir(),'hub-isolation-')),workspace=join(root,'workspace'),vault=join(root,'vault.key');t.after(()=>rm(root,{recursive:true,force:true}));await (await import('node:fs/promises')).mkdir(workspace);await writeFile(vault,'synthetic-vault-material');await symlink(vault,join(workspace,'escape'));
  const source=`const fs=require('node:fs');let blocked=0;for(const name of ${JSON.stringify([vault,join(workspace,'escape')])}){try{fs.readFileSync(name);}catch{blocked++;}}fs.writeFileSync(${JSON.stringify(join(workspace,'result.json'))},JSON.stringify({blocked}));process.stdout.write(String(blocked));`;
  const spec=await isolatedProcess(process.execPath,['-e',source],{read:[workspace],write:[workspace],network:[]}),child=spawn(spec.command,spec.args,{cwd:workspace,env:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe']});let output='',error='';child.stdout.on('data',data=>{output+=data;});child.stderr.on('data',data=>{error+=data;});assert.equal(await new Promise(resolve=>child.on('exit',resolve)),0,error);assert.equal(output,'2');
});

test('Runtime isolation fails closed on an unsupported process host rather than substituting an unisolated command',()=>{
 const source=`Object.defineProperty(process,'platform',{value:'freebsd'});const assert=await import('node:assert/strict');const {isolatedProcess}=await import(${JSON.stringify(new URL('../../packages/runtime/src/isolation.ts',import.meta.url).href)});await assert.default.rejects(isolatedProcess(process.execPath,[],{read:[],write:[],network:[]}),(error)=>error.code==='SANDBOX_UNAVAILABLE');process.stdout.write('unsupported-host-refused');`,child=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8'});assert.equal(child.status,0,child.stderr);assert.equal(child.stdout,'unsupported-host-refused');
});
