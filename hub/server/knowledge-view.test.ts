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
