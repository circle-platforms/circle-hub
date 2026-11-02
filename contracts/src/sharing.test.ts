import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KnowledgeShareBody, KnowledgeShareReceipt, PersonalPackGrantBody } from './sharing.ts';
import { SkillLocks } from './skills.ts';
import { GetNodesInput, UploadFileInput } from './tools.ts';

const owner='usr_'+'0'.repeat(26),member='usr_'+'1'.repeat(26),hash='a'.repeat(64),at='2026-11-02T00:00:00.000Z';
test('sharing receipts distinguish a merged team version from a registered refusal without widening ownership',()=>{
  const base={source:{space:owner,root:hash,path:'/notes',entry:hash},by:owner,at,session:null,message:''};
  const merged={...base,status:'merged',code:null,team_root:hash,reference:`tree:${hash}/notes@${hash}`};
  assert.equal(KnowledgeShareBody.safeParse(merged).success,true);
  assert.equal(KnowledgeShareReceipt.safeParse({...merged,record:hash,target_path:'/chosen/team'}).success,true);
  assert.equal(KnowledgeShareBody.safeParse({...merged,target_path:'relative'}).success,false);
  assert.equal(KnowledgeShareBody.safeParse({...merged,by:member}).success,false);
  assert.equal(KnowledgeShareBody.safeParse({...merged,team_root:null}).success,false);
  assert.equal(KnowledgeShareBody.safeParse({...base,status:'rejected',code:'SHARE_DUPLICATE',team_root:null,reference:null}).success,true);
  assert.equal(KnowledgeShareBody.safeParse({...base,status:'rejected',code:'unregistered',team_root:null,reference:null}).success,false);
});
test('personal grants and frozen skill identities retain explicit namespaces and the six existing tools',()=>{
  const grant={space:owner,pack:'synthetic-skill',by:owner,at,action:'grant',audience:'member',member};
  assert.equal(PersonalPackGrantBody.safeParse(grant).success,true);
  assert.equal(PersonalPackGrantBody.safeParse({...grant,audience:'administrators'}).success,false);
  const lock={pack:'synthetic-skill',version:'1.0.0',digest:hash};
  assert.equal(SkillLocks.safeParse([lock,{...lock,space:owner}]).success,true);
  assert.equal(SkillLocks.safeParse([{...lock,space:owner},{...lock,space:owner}]).success,false);
  const share_entry={root:hash,path:'/notes',entry:hash};
  assert.equal(UploadFileInput.safeParse({share_entry:{...share_entry,team_path:'/team/chosen'}}).success,true);
  assert.equal(UploadFileInput.safeParse({share_entry:{...share_entry,team_path:'relative'}}).success,false);
  assert.equal(UploadFileInput.safeParse({share_entry}).success,true);
  assert.equal(UploadFileInput.safeParse({share_entry,personal_entry:{kind:'observation',statement:'合成条目'}}).success,false);
  assert.equal(GetNodesInput.safeParse({pack:'synthetic-skill',pack_space:owner}).success,true);
});
