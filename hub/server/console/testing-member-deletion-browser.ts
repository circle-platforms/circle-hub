// Synthetic loopback screenshots. Run with Node 24 and CHROME_BIN; no real profile or data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHub } from '../testing-real.ts';
import { openConsole } from '../../../tests/acceptance/support/console.ts';
import { wordingProblems } from './testing-wording.ts';
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
let id = 0, lastStatus: number | undefined;
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
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown')
        errors.push(m.params.exceptionDetails); if (m.method === 'Page.lifecycleEvent' && m.params.name === 'load')
        loads.add(m.params.loaderId); if (m.method === 'Network.responseReceived' && m.params.type === 'Document')
        statuses.set(m.params.loaderId, m.params.response.status); if (m.id) {
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
        lastStatus = statuses.get(navigation.loaderId);
    } await wait("document.readyState==='complete'&&location.href===" + JSON.stringify(new URL(url).href)); };
    const shot = async (name: string) => { const size = await evaluate('({width:innerWidth,height:innerHeight})'), r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, ...size, scale: 1 } }); await writeFile(join(dir, name + '.png'), Buffer.from(r.data, 'base64')); };
    const capture=async(name:string,url:string,expected:RegExp)=>{
      for(const width of [1440,1024,390])for(const theme of ['dark','light']){
        await cdp('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await open(url);assert.equal(lastStatus,200,name+' actual HTTP response');
        await evaluate("document.querySelector('[data-theme-choice="+theme+"]').click()");await new Promise(resolve=>setTimeout(resolve,100));
        const body=await evaluate('document.body.innerText');assert.match(body,expected);assert.doesNotMatch(body,/该内容不存在或无权查看|Hub 内部错误|请求参数不对|登录控制台/);
        assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false,name+' horizontal overflow '+width+' '+theme);
        assert.deepEqual(wordingProblems(await evaluate('document.documentElement.outerHTML')),[],name);
        if(name==='deletion-preview')assert.match(await evaluate("document.querySelector('#delete-member-confirm pre').textContent"),/--expected-state=/);
        if(name==='deletion-complete')assert.equal(await evaluate("document.body.innerText.includes('重置密码')"),false);
        await shot(name+'-'+theme+'-'+width);matrix.push({name,width,theme});
        assert.equal(await evaluate("[...document.querySelectorAll('.ch-table-wrap')].every(node=>node.scrollWidth<=node.clientWidth||['auto','scroll'].includes(getComputedStyle(node).overflowX))"),true,'wide tables scroll inside their region');
        await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
        const focus=await evaluate("(()=>{const nodes=[document.querySelector('.ch-dialog:target .ch-dialog-foot a'),...document.querySelectorAll('[data-inspector-content] a,.ch-inspector a,main a,header a,button')];const node=nodes.find(node=>node&&node.getClientRects().length&&getComputedStyle(node).visibility!=='hidden');if(!node)return null;node.focus();const css=getComputedStyle(node);return {visible:node.matches(':focus-visible'),outline:css.outlineStyle,width:css.outlineWidth,shadow:css.boxShadow};})()");
        assert.ok(focus?.visible,name+' '+theme+' '+width+' visible keyboard target');assert.ok(focus.outline!=='none'&&parseFloat(focus.width)>0||focus.shadow!=='none');
        checks.push(name+' '+theme+' '+width+' HTTP 200 content, keyboard focus and internal scrolling verified');
      }
    };
    await cdp('Page.enable');await cdp('Page.setLifecycleEventsEnabled',{enabled:true});await cdp('Runtime.enable');await cdp('Network.enable');await cdp('Network.setCookie',{name:'circle_hub_session',value:owner.sessionCookie,url:hub.url});
    const text=Buffer.from('合成团队保留原文，精确署名。'),file=await spaces.importFile(user.principal,text,'text/plain','合成私人原件.txt'),source=(await hub.records.store.findMany<any>({kind:'knowledge_space_source',key:'knowledge.space.source_hash',values:[file.body.sha256]})).find(row=>row.body.artifact===file.digest)!;
    await spaces.attributeSource(user.principal,source.digest,file.digest);const entry=await spaces.write(user.principal,{kind:'observation',statement:'合成团队独立保留条目',grounds:[{reference:'src:'+file.body.sha256,quotation:'精确署名'}]}),shared=await spaces.share(user.principal,{root:entry.root,path:'/',entry:entry.entry});assert.ok(shared.team_root);
    const member=hub.url+'/console/team/'+user.user.id;
    await capture('deletion-preview',member+'?deletion=preview#delete-member-confirm',/确认永久删除成员/);
    await capture('deletion-refused',hub.url+'/console/team/'+hub.admin.user.id+'?deletion=preview#delete-member-confirm',/至少须保留一名启用的管理员/);
    const blocked=join(dir,'synthetic-cache-root-file');await writeFile(blocked,'synthetic storage failure');hub.records.memberDeletions!.registerCacheRoot(blocked);
    const api=hub.records.memberDeletions!,preview=await api.preview(hub.admin.principal,user.user.id),intent=await api.prepare(hub.admin.principal,{...preview,operation_id:crypto.randomUUID()});
    await assert.rejects(api.finish(hub.admin.principal,user.user.id,intent.operation_id),/存储清理未完成/);assert.equal((await hub.records.store.list({kind:'member_deletion'})).items.length,0);
    await capture('deletion-pending',member,/等待清除中/);
    await rm(blocked);await api.finish(hub.admin.principal,user.user.id,intent.operation_id);
    await capture('deletion-complete',member,/私人内容已清除/);
    await capture('team-tombstone',hub.url+'/console/knowledge/space?'+new URLSearchParams({space:'team',root:shared.team_root,path:'/',entry:entry.entry}),/已删除的成员/);
    assert.deepEqual(errors,[]);await writeFile(join(dir,'result.json'),JSON.stringify({matrix,checks,errors},null,2));
    await writeFile(join(dir,'index.html'),'<!doctype html><meta charset="utf-8"><title>合成删除页面核对</title><style>body{font-family:sans-serif}img{max-width:100%;border:1px solid gray}section{margin:30px 0}</style>'+matrix.map(item=>{const file=item.name+'-'+item.theme+'-'+item.width+'.png';return '<section><h2>'+file+'</h2><img src="'+file+'"></section>';}).join(''));
    console.log(JSON.stringify({dir,images:matrix.length,checks},null,2));
}finally{
    ws?.close();if(chrome){chrome.kill('SIGTERM');await new Promise(resolve=>chrome!.exitCode!==null?resolve(undefined):chrome!.once('exit',()=>resolve(undefined)));}
    await hub.close();await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
