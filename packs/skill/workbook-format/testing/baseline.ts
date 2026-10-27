// The pre-migration core is frozen as test data, with its original imports and verified bytes.
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import type {Parser} from '../../../../hub/refs/api.ts';
export const MIGRATION_TEST='workbook-format migration equivalence across repository documents';
export async function originalCore(){
 const root=await mkdtemp(join(tmpdir(),'hub-parser-baseline-'));
 try{
  const manifest=JSON.parse(await readFile(new URL('./baseline/manifest.json',import.meta.url),'utf8'));
  for(const row of manifest.files){
    const bytes=await readFile(new URL('./baseline/'+row.path+'.txt',import.meta.url));
    if(createHash('sha256').update(bytes).digest('hex')!==row.sha256||bytes.length!==row.size)throw new Error('pre-migration baseline bytes changed: '+row.path);
    const path=join(root,row.path);
    await mkdir(dirname(path),{recursive:true});
    await writeFile(path,bytes);
  }
  await writeFile(join(root,'package.json'),'{"type":"module"}');
  await symlink(fileURLToPath(new URL('../../../../node_modules',import.meta.url)),join(root,'node_modules'),'dir');
  const loaded=await import(pathToFileURL(join(root,'hub/refs/parsers/xlsx.ts')).href);
  return {parser:loaded.xlsxParser as Parser,close:()=>rm(root,{recursive:true,force:true})};
 }catch(error){await rm(root,{recursive:true,force:true});throw error;}
}
