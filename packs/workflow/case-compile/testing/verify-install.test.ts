import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,rm,symlink,unlink} from 'node:fs/promises';
import{join}from'node:path';import{tmpdir}from'node:os';
import{stage,verifyInstall}from'../pack-files.ts';
test('installed bytes, undeclared files and symlinks are checked against the publisher manifest',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cc-install-proof-'));try{const root=await stage(join(dir,'installed'));const proof=await verifyInstall(root);assert.ok(proof.files>0);
    await writeFile(join(root,'unexpected.ts'),'synthetic');await assert.rejects(verifyInstall(root),/未声明文件/);await unlink(join(root,'unexpected.ts'));
    await writeFile(join(root,'SKILL.md'),'changed');await assert.rejects(verifyInstall(root),/发布摘要不符/);
    await unlink(join(root,'SKILL.md'));await symlink(join(dir,'target'),join(root,'SKILL.md'));await assert.rejects(verifyInstall(root),/符号链接/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
