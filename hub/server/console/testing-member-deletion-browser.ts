// Synthetic loopback screenshots. Run with Node 24 and CHROME_BIN; no real profile or data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHub } from '../testing-real.ts';
import { openConsole } from '../../../tests/acceptance/support/console.ts';
import { wordingProblems } from './testing-wording.ts';
import {CONSOLE_THEME,CONSOLE_LIVE} from './assets.ts';
import {workflowPack,writePack} from '../../runs/packs/testing/builder.ts';
const dir = await mkdtemp(join(tmpdir(), 'circle-hub-finish-block5-browser-')), profile = join(dir, 'profile');
const hub = await createTestHub({ repositoryPacks: false, stubs: false, mindmapSkill: false, workbookSkill: false, xmlSkill: false, htmlSkill: false });
let chrome: ReturnType<typeof spawn> | undefined, ws: WebSocket | undefined;
const pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (error: unknown) => void;
}>(), errors: unknown[] = [], matrix: Array<{
    name: string;
    width: number;
    theme: string;
}> = [], checks: string[] = [], loads = new Set<string>(), statuses = new Map<string, number>();
const assetRequests=new Set<string>(),assetResponses:Array<{path:string;status:number;type:string}>=[],policies=new Map<string,string>(),seenNonces=new Set<string>();
let id = 0, lastStatus: number | undefined, lastPolicy='';
try {
    const user = await hub.createUser('合成删除成员'), peer = await hub.createUser('合成团队读者'), owner = await openConsole(hub, hub.admin.token), reader = await openConsole(hub, peer.token), spaces = hub.hub.knowledge.spaces;
    assert.ok(spaces);
    const browser=process.env.CHROME_BIN;assert.ok(browser,'CHROME_BIN must name the isolated test browser executable');
    chrome = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-sync', '--use-mock-keychain', '--password-store=basic', '--user-data-dir=' + profile, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore' });
    let port;
    for (let i = 0; i < 100; i++) {
        try {
            port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
            break;
        }
        catch {
            await new Promise(r => setTimeout(r, 100));
        }
    }
    assert.ok(port);
    const tabs = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
    ws = new WebSocket(tabs.find((t: {
        type: string;
        webSocketDebuggerUrl: string;
    }) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise(r => ws!.onopen = () => r(undefined));
    ws.onmessage = e => { const m = JSON.parse(e.data);
        if(m.method==='Network.requestWillBeSent'&&new URL(m.params.request.url).pathname.startsWith('/console/assets/'))assetRequests.add(m.params.requestId);
        if(m.method==='Network.loadingFailed'&&assetRequests.has(m.params.requestId))errors.push({assetFailure:m.params.errorText});
        if(m.method==='Network.responseReceived'&&new URL(m.params.response.url).pathname.startsWith('/console/assets/'))assetResponses.push({path:new URL(m.params.response.url).pathname,status:m.params.response.status,type:m.params.response.mimeType});
        if (m.method === 'Runtime.exceptionThrown')
        errors.push(m.params.exceptionDetails); if (m.method === 'Page.lifecycleEvent' && m.params.name === 'load')
        loads.add(m.params.loaderId); if (m.method === 'Network.responseReceived' && m.params.type === 'Document')
        {statuses.set(m.params.loaderId, m.params.response.status);policies.set(m.params.loaderId,String(m.params.response.headers['Content-Security-Policy']??m.params.response.headers['content-security-policy']??''));} if (m.id) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.error ? p!.reject(new Error(JSON.stringify(m.error))) : p!.resolve(m.result);
    } };
    const cdp = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws!.send(JSON.stringify({ id: n, method, params })); });
    const evaluate = async (expression: string) => { const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails)
        throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
    const wait = async (expression: string) => { for (let i = 0; i < 150; i++) {
        if (await evaluate(expression))
            return;
        await new Promise(r => setTimeout(r, 50));
    } throw Error('Timed out ' + expression + ' ' + await evaluate('document.body.innerText')); };
    const open = async (url: string) => { await cdp('Page.navigate', { url: 'about:blank' }); await wait("location.href==='about:blank'&&document.readyState==='complete'"); const navigation = await cdp('Page.navigate', { url }); assert.ok(!navigation.errorText, navigation.errorText); if (navigation.loaderId) {
        for (let n = 0; !loads.has(navigation.loaderId) && n < 200; n++)
            await new Promise(r => setTimeout(r, 50));
        assert.ok(loads.has(navigation.loaderId), 'this navigation must finish loading');
        lastStatus = statuses.get(navigation.loaderId);lastPolicy=policies.get(navigation.loaderId)??'';
    } await wait("document.readyState==='complete'&&location.href===" + JSON.stringify(new URL(url).href)); };
    const shot = async (name: string) => { const size = await evaluate('({width:innerWidth,height:innerHeight})'), r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, ...size, scale: 1 } }); await writeFile(join(dir, name + '.png'), Buffer.from(r.data, 'base64')); };
    const capture=async(name:string,url:string,expected:RegExp)=>{
      for(const width of [1440,1024,390])for(const theme of ['dark','light']){
        await cdp('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await open(url);assert.equal(lastStatus,200,name+' actual HTTP response');
        await evaluate("document.querySelector('[data-theme-choice="+theme+"]').click()");await new Promise(resolve=>setTimeout(resolve,100));
        assert.equal(await evaluate("document.documentElement.getAttribute('data-theme')"),theme,'the external theme controller must run under CSP');
        const css=await evaluate("[...document.querySelectorAll('link[rel=stylesheet]')].map(node=>({path:new URL(node.href).pathname,integrity:node.integrity,loaded:!!node.sheet,rules:node.sheet?.cssRules.length??0}))");
        assert.equal(css.length,1);assert.ok(css.every((sheet:any)=>sheet.path.startsWith('/console/assets/')&&sheet.path.endsWith('.css')&&sheet.integrity.startsWith('sha256-')&&sheet.loaded&&sheet.rules>0),'external CSS must load and parse');
        const scripts=await evaluate("[...document.querySelectorAll('script[src]')].map(node=>({path:new URL(node.src).pathname,integrity:node.integrity,nonce:node.nonce}))");
        assert.deepEqual(scripts.map((script:any)=>script.path),await evaluate("!!document.querySelector('[data-live]')")?[CONSOLE_THEME.path,CONSOLE_LIVE.path]:[CONSOLE_THEME.path]);assert.ok(scripts.every((script:any)=>script.path.startsWith('/console/assets/')&&script.integrity.startsWith('sha256-')&&script.nonce&&script.nonce===scripts[0].nonce));
        assert.ok(lastPolicy.includes("'nonce-"+scripts[0].nonce+"'"),'the actual response CSP must authorize these scripts');assert.ok(!seenNonces.has(scripts[0].nonce),'each document response must rotate its nonce');seenNonces.add(scripts[0].nonce);
        const body=await evaluate('document.body.innerText');assert.match(body,expected);assert.doesNotMatch(body,/该内容不存在或无权查看|Hub 内部错误|请求参数不对|登录控制台/);
        assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false,name+' horizontal overflow '+width+' '+theme);
        assert.deepEqual(wordingProblems(await evaluate('document.documentElement.outerHTML')),[],name);
        if(name==='team-capacity-dialog'){
          assert.equal(await evaluate("document.querySelector('#adjust-team-capacity').matches(':target')"),true);
          assert.equal(await evaluate("document.querySelector('#adjust-team-capacity [name=space]').value"),'team');
          assert.equal(await evaluate("document.querySelector('#adjust-team-capacity [name=unit]').value"),'gb');
          assert.equal(await evaluate("document.querySelector('#adjust-team-capacity [name=amount]').value"),'10');
        }
        if(name==='deletion-preview'){
          assert.match(await evaluate("document.querySelector('#delete-member-confirm pre').textContent"),/--expected-state=/);
          assert.deepEqual(await evaluate("[...document.querySelectorAll('#delete-member-confirm [data-deletion-scope] dt')].map(node=>node.textContent)"),['知识','记忆','原文','来源署名','归档的原文']);
          assert.equal(await evaluate("document.querySelector('[data-deletion-handover] h3 .ch-tip').firstChild.textContent"),'转给管理员的私人工作流与技能');
          assert.match(await evaluate("document.querySelector('[data-deletion-handover]').innerText"),/合成转移工作流/);
          assert.match(await evaluate("document.querySelector('[data-deletion-handover]').innerText"),/接收人：管理员（执行删除的管理员）/);
          assert.equal(await evaluate("[...document.querySelectorAll('[data-deletion-scope] dt')].every(node=>node.getBoundingClientRect().height<28)"),true,'category names must remain readable on one line');
          assert.ok(await evaluate("document.querySelector('#delete-member-confirm').innerText.includes('在 Hub 所在主机上执行下列命令完成删除；内容变化后须重新检查。')"));
        }
        if(name==='deletion-pending'||name==='deletion-complete'){
          const head=await evaluate("(()=>{const root=document.querySelector('[data-inspector-content]'),tag=root.querySelector('.ch-tag'),badge=tag.parentElement.querySelector('.ch-badge');return {tagWidth:tag.getBoundingClientRect().width,rowWidth:tag.parentElement.getBoundingClientRect().width,sameRow:badge?.parentElement===tag.parentElement,status:badge?.textContent,name:root.querySelector('h2')?.textContent,neutral:badge?.classList.contains('ch-badge--pending')};})()");
          assert.equal(head.name,'已删除的成员');assert.equal(head.status,'已删除');assert.equal(head.neutral,true);assert.equal(head.sameRow,true);assert.ok(head.tagWidth>0&&head.tagWidth<head.rowWidth/2,'the member tag must keep its content width');
          assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-inspector-content] dt')].filter(node=>!node.closest('[data-technical]')).map(node=>node.textContent)"),['成员编号','删除时间']);
        }
        if(name==='team-list')assert.deepEqual(await evaluate("[...document.querySelectorAll('main tbody tr')].map(row=>[...row.querySelectorAll('td')].map(cell=>cell.textContent)).filter(cells=>cells[0]==='已删除的成员').map(cells=>cells[2])"),['已删除']);
        if(name==='deletion-complete')assert.equal(await evaluate("document.body.innerText.includes('重置密码')"),false);
        await shot(name+'-'+theme+'-'+width);matrix.push({name,width,theme});
        assert.equal(await evaluate("[...document.querySelectorAll('.ch-table-wrap')].every(node=>node.scrollWidth<=node.clientWidth||['auto','scroll'].includes(getComputedStyle(node).overflowX))"),true,'wide tables scroll inside their region');
        await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
        const focus=await evaluate("(()=>{const nodes=[document.querySelector('.ch-dialog:target .ch-dialog-foot a'),...document.querySelectorAll('[data-inspector-content] a,.ch-inspector a,main a,header a,button')];const node=nodes.find(node=>node&&node.getClientRects().length&&getComputedStyle(node).visibility!=='hidden');if(!node)return null;node.focus();const css=getComputedStyle(node);return {visible:node.matches(':focus-visible'),outline:css.outlineStyle,width:css.outlineWidth,shadow:css.boxShadow};})()");
        assert.ok(focus?.visible,name+' '+theme+' '+width+' visible keyboard target');assert.ok(focus.outline!=='none'&&parseFloat(focus.width)>0||focus.shadow!=='none');
        checks.push(name+' '+theme+' '+width+' HTTP 200 content, external CSS/SRI, fresh script nonce, live theme, keyboard focus and internal scrolling verified');
      }
    };
    await cdp('Page.enable');await cdp('Page.setLifecycleEventsEnabled',{enabled:true});await cdp('Runtime.enable');await cdp('Network.enable');await cdp('Network.setCookie',{name:'circle_hub_session',value:owner.sessionCookie,url:hub.url});
    const text=Buffer.from('合成团队保留原文，精确署名。'),file=await spaces.importFile(user.principal,text,'text/plain','合成私人原件.txt'),source=(await hub.records.store.findMany<any>({kind:'knowledge_space_source',key:'knowledge.space.source_hash',values:[file.body.sha256]})).find(row=>row.body.artifact===file.digest)!;
    await spaces.attributeSource(user.principal,source.digest,file.digest);const entry=await spaces.write(user.principal,{kind:'observation',statement:'合成团队独立保留条目',grounds:[{reference:'src:'+file.body.sha256,quotation:'精确署名'}]}),shared=await spaces.share(user.principal,{root:entry.root,path:'/',entry:entry.entry});assert.ok(shared.team_root);
    if(process.argv.includes('--team-capacity-only')){
      await capture('team-capacity',hub.url+'/console/team?capacity=team',/团队空间容量/);
      await capture('team-capacity-dialog',hub.url+'/console/team?capacity=team#adjust-team-capacity',/调整团队容量/);
    }else{
    const privatePack=await writePack(join(dir,'private-workflow'),workflowPack({id:'synthetic-deletion-transfer',title:'合成转移工作流'}));
    const published=await hub.hub.registry.personal!.publish(user.principal,privatePack.dir);assert.equal(published.ok,true);
    const member=hub.url+'/console/team/'+user.user.id;
    await capture('deletion-preview',member+'?deletion=preview#delete-member-confirm',/预览永久删除的影响/);
    await capture('deletion-refused',hub.url+'/console/team/'+hub.admin.user.id+'?deletion=preview#delete-member-confirm',/至少须保留一名启用的管理员/);
    const blocked=join(dir,'synthetic-cache-root-file');await writeFile(blocked,'synthetic storage failure');hub.records.memberDeletions!.registerCacheRoot(blocked);
    const api=hub.records.memberDeletions!,preview=await api.preview(hub.admin.principal,user.user.id),intent=await api.prepare(hub.admin.principal,{...preview,operation_id:crypto.randomUUID()});
    await assert.rejects(api.finish(hub.admin.principal,user.user.id,intent.operation_id),/存储清理未完成/);assert.equal((await hub.records.store.list({kind:'member_deletion'})).items.length,0);
    await capture('deletion-pending',member,/等待清除中/);
    await rm(blocked);await api.finish(hub.admin.principal,user.user.id,intent.operation_id);
    assert.ok(await hub.hub.registry.personal!.resolve(hub.admin.principal,hub.admin.user.id,'synthetic-deletion-transfer'),'the administrator receives the private workflow version');
    await assert.rejects(hub.hub.registry.personal!.resolve(user.principal,user.user.id,'synthetic-deletion-transfer'),/不存在或无权/,'the deleted identity cannot read its old version');
    await capture('deletion-complete',member,/私人内容已清除/);
    await capture('team-list',hub.url+'/console/team',/已删除的成员/);
    await capture('team-tombstone',hub.url+'/console/knowledge/space?'+new URLSearchParams({space:'team',root:shared.team_root,path:'/',entry:entry.entry}),/已删除的成员/);
    }
    assert.deepEqual(errors,[]);assert.ok(assetResponses.some(asset=>asset.path.endsWith('.css')&&asset.status===200&&asset.type==='text/css'));assert.ok(assetResponses.every(asset=>asset.status===200||asset.status===304));await writeFile(join(dir,'result.json'),JSON.stringify({matrix,checks,errors,assetResponses,nonceResponses:seenNonces.size},null,2));
    await writeFile(join(dir,'index.html'),'<!doctype html><meta charset="utf-8"><title>合成删除页面核对</title><style>body{font-family:sans-serif}img{max-width:100%;border:1px solid gray}section{margin:30px 0}</style>'+matrix.map(item=>{const file=item.name+'-'+item.theme+'-'+item.width+'.png';return '<section><h2>'+file+'</h2><img src="'+file+'"></section>';}).join(''));
    console.log(JSON.stringify({dir,images:matrix.length,checks},null,2));
}finally{
    ws?.close();if(chrome){chrome.kill('SIGTERM');await new Promise(resolve=>chrome!.exitCode!==null?resolve(undefined):chrome!.once('exit',()=>resolve(undefined)));}
    await hub.close();await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
