// The masking dictionary in the console (B02 R[11], decision 159, issue 194 step two): an administrator sees the rules in
// force on the settings page with the commands that change them; a member sees nothing of it. Synthetic values only.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createTestHub} from './testing-real.ts';
import {openConsole} from '../../tests/acceptance/support/console.ts';

test('the settings page lists the rules in force, what each puts in place of a match and how to change them', async t => {
 const hub=await createTestHub({repositoryPacks:false,stubs:false,requireOsIsolation:false});t.after(()=>hub.close());
 const admin=await hub.createUser('合成管理员','admin'),member=await hub.createUser('合成成员');
 const console_=await openConsole(hub,admin.token),masking=hub.hub.records.masking!;
 const empty=await console_.get('/console/settings');assert.equal(empty.status,200);
 const card=(body:string)=>/<section id="masking">(.*?)<\/section><\/div>/s.exec(body)?.[1]??'';
 assert.match(card(empty.body),/遮盖字典/);assert.match(card(empty.body),/还没有遮盖规则/);
 // What the card says the dictionary does, in plain words: when, to what, and what is not kept.
 for(const phrase of ['读业务系统的文本内容时','先换成方括号里的文字再保存','被替换的值 Hub 不保存','只处理文本','成员上传和写入的内容不替换'])assert.ok(card(empty.body).includes(phrase),phrase);
 await masking.set(admin.principal,{name:'device-password',label:'密码',pattern:'password=(?<secret>\\S+)',ignore_case:true},'合成设备口令不进知识');
 await masking.set(admin.principal,{name:'api-key',label:'密钥',pattern:'sk-[a-z0-9]{12}',ignore_case:false},'合成密钥规则');
 const listed=await console_.get('/console/settings');assert.equal(listed.status,200);
 const shown=card(listed.body);
 assert.match(shown,/<td>device-password<\/td><td>\[密码已遮盖 \*\*\*\*\*\]<\/td><td><code>password=\(\?&lt;secret&gt;\\S\+\)<\/code> <span class="ch-meta">不区分大小写<\/span><\/td>/);
 assert.match(shown,/<td>api-key<\/td><td>\[密钥已遮盖 \*\*\*\*\*\]<\/td><td><code>sk-\[a-z0-9\]\{12\}<\/code><\/td>/);
 // The page changes nothing itself: each action is a command to run on the server, shown in a dialog.
 assert.ok(listed.body.includes('<pre class="ch-quote"><code>circle-hub mask remove device-password &#39;--reason=请填写理由&#39;</code></pre>'));
 // Adding a rule: try it on a sample first, then set it; every word that is not a plain identifier is quoted for the shell.
 assert.ok(listed.body.includes('<code>circle-hub mask test &#39;--pattern=password=(?&lt;secret&gt;\\S+)&#39; &#39;--label=密码&#39; &#39;--file=样本文件&#39;\ncircle-hub mask set &#39;规则名&#39; &#39;--label=密码&#39; &#39;--pattern=password=(?&lt;secret&gt;\\S+)&#39; &#39;--reason=请填写理由&#39;</code>'));
 assert.doesNotMatch(listed.body,/<form[^>]*mask/,'no form writes the dictionary');
 // A member's settings carry nothing of the dictionary; the Hub tab of the administrator does not repeat it.
 const own=await (await openConsole(hub,member.token)).get('/console/settings');assert.equal(own.status,200);assert.doesNotMatch(own.body,/遮盖字典|device-password/);
 assert.doesNotMatch((await console_.get('/console/settings?tab=hub')).body,/id="masking"/);
});

test('an original the dictionary replaced says so in its detail: how many places, and that this is not what the system sent', async t => {
 const hub=await createTestHub({repositoryPacks:false,stubs:false,requireOsIsolation:false});t.after(()=>hub.close());
 const reader=await hub.createUser('合成读者'),spaces=hub.hub.knowledge.spaces!,web=await openConsole(hub,reader.token);
 const visibility={readers:[],admins:true,packs:[],shareable:false};
 // As the connector stores an answer after the dictionary replaced two places in it.
 const masked=await hub.records.artifacts.ingest({bytes:Buffer.from('合成工单：password=[密码已遮盖 *****]，备用 [密码已遮盖 *****]'),mediaType:'text/plain',name:'合成遮盖原文.txt',origin:{read:{object:'synthetic:record:masked-original'}},author:{user:null},provenanceType:'observed',visibility,masking:{dictionary:'a'.repeat(64),rules:[{rule:'device-password',count:2}]}});
 const plain=await hub.records.artifacts.ingest({bytes:Buffer.from('合成工单：没有口令'),mediaType:'text/plain',name:'合成普通原文.txt',origin:{read:{object:'synthetic:record:plain-original'}},author:{user:null},provenanceType:'observed',visibility});
 for(const artifact of [masked,plain])await spaces.archiveSource(hub.admin.principal,{artifact:artifact.digest,message:'archive:'+artifact.digest,space:'team',path:'/团队原文'});
 const detail=async(sha256:string,artifact:string)=>web.get('/console/knowledge/source?'+new URLSearchParams({sha256,artifact}));
 const shown=await detail(masked.body.sha256,masked.digest);assert.equal(shown.status,200);
 assert.match(shown.body,/<dt><span class="ch-tip[^"]*"[^>]*title="读入时按管理员配置的遮盖字典替换过。这里保存和显示的是替换后的内容，不是业务系统给出的原样内容；被替换的值 Hub 没有保存。"[^>]*>遮盖/);
 assert.match(shown.body,/已替换 2 处/);
 assert.ok(shown.body.includes('password=[密码已遮盖 *****]'),'the preview is the replaced text');
 // The rule's name and the dictionary's digest are not on the page: a reader needs to know that, not which.
 assert.doesNotMatch(shown.body,/device-password|a{64}/);
 const other=await detail(plain.body.sha256,plain.digest);assert.equal(other.status,200);assert.doesNotMatch(other.body,/遮盖|已替换/);
 // The mark is a fact of the record, only on a read of a business system, and it names at least one rule.
 assert.deepEqual(masked.body.masking,{dictionary:'a'.repeat(64),rules:[{rule:'device-password',count:2}]});assert.equal(plain.body.masking,undefined);
 await assert.rejects(hub.records.artifacts.ingest({bytes:Buffer.from('合成上传'),mediaType:'text/plain',name:'合成上传.txt',origin:{upload:{session:null,message:null}},author:{user:reader.user.id},provenanceType:'declared',visibility:{readers:[reader.user.id],admins:true,packs:[],shareable:false},masking:{dictionary:'a'.repeat(64),rules:[{rule:'device-password',count:1}]}}),/masking is recorded on a read of a business system only/);
 await assert.rejects(hub.records.artifacts.ingest({bytes:Buffer.from('合成空规则'),mediaType:'text/plain',name:'合成空规则.txt',origin:{read:{object:'synthetic:record:empty-rules'}},author:{user:null},provenanceType:'observed',visibility,masking:{dictionary:'a'.repeat(64),rules:[]}}),/names at least one rule/);
});
