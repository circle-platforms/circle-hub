// The team knowledge import page says what is general and what belongs to a product source (issue 238). Synthetic only.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createTestHub} from './testing-real.ts';
import {openConsole} from '../../tests/acceptance/support/console.ts';
import {wordingProblems} from './console/testing-wording.ts';

test('the product-source import names itself and leaves builds, manuals and command trees to the product pack, beside the pack-free route',async()=>{
 const hub=await createTestHub({repositoryPacks:false,stubs:false,mindmapSkill:false,workbookSkill:false,xmlSkill:false,htmlSkill:false});
 try{
  const admin=await openConsole(hub,hub.admin.token),page=await admin.get('/console/operations/knowledge');
  assert.equal(page.status,200,page.body);
  // The card that needs a product says so in its title; its general hint no longer assumes one kind of material.
  assert.match(page.body,/按产品来源导入/);
  assert.match(page.body,/从所选产品已配置的知识来源，在后台只读导入团队知识，每条附来源/);
  assert.doesNotMatch(page.body,/在后台只读导入构建、手册与命令树/);
  // What a product source imports is the product pack's to declare: the field says so, and names no kind of material
  // of its own. With no product enabled there is no list to show (issue 238).
  assert.match(page.body,/每个产品导入哪些内容由它的产品包声明，列在下面/);
  assert.doesNotMatch(page.body,/例如构建、手册、命令树|data-product-materials/);
  // The route that needs no product pack stays beside it, unchanged.
  assert.match(page.body,/按团队读取原文导入/);assert.match(page.body,/无须产品包/);
  assert.deepEqual(wordingProblems(page.body),[]);
 }finally{await hub.close();}
});
