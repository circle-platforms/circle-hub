import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, open, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeKnowledgeViewFile } from './cli-admin.ts';
import { CliError } from './errors.ts';

test('a partial view write removes only its newly created file and returns a safe next action', async t => {
  const dir=await mkdtemp(join(tmpdir(),'knowledge-view-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const target=join(dir,'view.json');
  const opener=async()=>{
    const file=await open(target,'wx',0o600);
    file.writeFile=async()=>{await file.write('partial');throw new Error('synthetic private content at http://192.0.2.8/internal');};
    return file;
  };
  await assert.rejects(writeKnowledgeViewFile(target,Buffer.from('{}'),opener),e=>e instanceof CliError&&!!e.hint&&!JSON.stringify(e).includes('192.0.2.8'));
  await assert.rejects(access(target));
  await writeKnowledgeViewFile(target,Buffer.from('{}'));
  await assert.rejects(writeKnowledgeViewFile(target,Buffer.from('overwrite')),e=>e instanceof CliError&&!!e.hint);
  assert.equal((await readFile(target)).toString(),'{}');
});

test('invalid view JSON is removed and its source text never becomes an error message', async t => {
  const dir=await mkdtemp(join(tmpdir(),'knowledge-view-json-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const target=join(dir,'view.json');
  await assert.rejects(writeKnowledgeViewFile(target,Buffer.from('synthetic-private-original http://192.0.2.9/private')),e=>e instanceof CliError&&!!e.hint&&!e.message.includes('synthetic-private-original')&&!e.message.includes('192.0.2.9'));
  await assert.rejects(access(target));
});

test('unexpected account storage errors never expose internal connection details', async () => {
  const { adminCommands }=await import('./cli-admin.ts');
  const command=adminCommands().find(c=>c.name==='knowledge')!;
  const broken=()=>{throw new Error('synthetic-private-original http://192.0.2.11/internal');};
  await assert.rejects(command.run(['view','knowledge:index:synthetic:synthetic?kind=case&key=document','--out','unused'],{
    io:{cwd:process.cwd(),stdout:broken,stderr:broken,env:{CIRCLE_HUB_TOKEN:'synthetic'}},
    config:broken,records:async()=>broken(),deps:async()=>broken(),actingAdmin:async()=>broken(),
  }),e=>e instanceof CliError&&!!e.hint&&!e.message.includes('192.0.2.11')&&!e.message.includes('synthetic-private-original'));
});
