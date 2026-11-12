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
