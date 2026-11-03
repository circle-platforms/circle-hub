// Synthetic loopback screenshot matrix. Run with Node 24 from the repository root; no real profile or data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHub } from '../testing-real.ts';
import { openConsole } from '../../../tests/acceptance/support/console.ts';
import { wordingProblems } from './testing-wording.ts';
import {legacyRootSource} from '../../knowledge/testing-capacity.ts';
import {exactBytes,formatCapacity} from '../capacity.ts';
const dir = await mkdtemp(join(tmpdir(), 'circle-hub-finish-block2-browser-')), profile = join(dir, 'profile');
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
    const user = await hub.createUser('合成归档作者'), peer = await hub.createUser('合成共享读者'), owner = await openConsole(hub, user.token), reader = await openConsole(hub, peer.token), spaces = hub.hub.knowledge.spaces;
    assert.ok(spaces);
    chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-sync', '--use-mock-keychain', '--password-store=basic', '--user-data-dir=' + profile, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore' });
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
    const capture = async (name: string, url: string, prepare?:()=>Promise<void>) => { for (const width of [1440, 1024, 390])
        for (const theme of ['dark', 'light']) {
            await cdp('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
            await open(url);
            if(prepare)await prepare();
            assert.equal(lastStatus, name === 'source-denied' ? 404 : name==='capacity-refusal'?400:200, name + ' HTTP status ' + width + ' ' + theme);
            const body = await evaluate('document.body.innerText');
            if (name === 'source-denied')
                assert.match(body, /该内容不存在或无权查看/);
            else
                assert.doesNotMatch(body, /该内容不存在或无权查看|Hub 内部错误|请求参数不对/, name + ' must not capture an error page');
            if(name==='capacity-refusal'){assert.match(body,/私人空间容量不足/);assert.match(body,/本次新增/);assert.match(body,/剩余 0.0 KB/);}
            if(name==='capacity-raised')assert.match(body,/合成容量重试条目/);
            else if(name.startsWith('capacity-'))assert.match(body,/已用/);
            if (name === 'archive-selected') {
                assert.equal(await evaluate("document.querySelector('[data-inspector-content] h2')?.textContent"), 'synthetic-upload.txt');
                assert.equal(await evaluate("document.querySelector('.ch-original-preview')?.textContent"), '合成浏览器导入原文：保留两份。');
                assert.equal(await evaluate("document.querySelector('a[href=\"#save-original\"],#save-original')===null"), true, 'an archived own capture has no duplicate save action');
            }
            if(name.startsWith('member-'))assert.equal(await evaluate("document.querySelector('[data-inspector-content] h2')?.textContent"),user.user.name);
            if(name==='member-disabled'||name==='member-enable-dialog')assert.match(body,/已停用/);
            await evaluate("document.querySelector('[data-theme-choice=" + theme + "]').click()");
            await new Promise(r => setTimeout(r, 120));
            assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'), false, name + ' overflow ' + width + ' ' + theme);
            assert.deepEqual(wordingProblems(await evaluate('document.documentElement.outerHTML')), [], name);
            assert.equal(await evaluate("[...document.querySelectorAll('tr,.ch-row')].some(row=>row.querySelector('button,form,.ch-btn'))"), false);
            if (name === 'quote-selected' || name === 'quote-unique') {
                assert.equal(await evaluate("(()=>{const r=document.getElementById('quoted-text').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;})()"), true, name + ' quote is visible ' + width + ' ' + theme);
            }
            await shot(name + '-' + theme + '-' + width);
            matrix.push({ name, width, theme });
        } };
    await cdp('Page.enable');
    await cdp('Page.setLifecycleEventsEnabled', { enabled: true });
    await cdp('Runtime.enable');
    await cdp('Network.enable');
    await cdp('Network.setCookie', { name: 'circle_hub_session', value: owner.sessionCookie, url: hub.url });
    const list = hub.url + '/console/knowledge?view=sources&scope=personal';
    await capture('archive-empty', list);
    await capture('import-dialog', list + '#import-original');
    assert.equal(await spaces.current(user.user.id), null);
    await spaces.directory(user.principal, '/方法/认证');
    await open(list + '#import-original');
    await writeFile(join(dir, 'synthetic-upload.txt'), '合成浏览器导入原文：保留两份。');
    const dom = await cdp('DOM.getDocument'), node = await cdp('DOM.querySelector', { nodeId: dom.root.nodeId, selector: '#import-original input[type=file]' });
    await cdp('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [join(dir, 'synthetic-upload.txt')] });
    assert.equal(await evaluate("(()=>{const field=document.querySelector('#import-original [name=path]');field.value='/方法/认证';return field.value;})()"), '/方法/认证', 'the refreshed folder selector must include the requested location');
    await evaluate("document.querySelector('#import-original button[type=submit]').click()");
    await wait("location.search.includes('source=')&&document.querySelector('.ch-inspector').textContent.includes('synthetic-upload.txt')");
    checks.push('native multipart import through the enhanced form creates a private original and selects its inspector');
    const imported = (await spaces.archive(user.principal, { scope: 'personal' })).items[0];
    assert.equal(imported.body.path, '/方法/认证');
    const html = await spaces.importFile(user.principal, Buffer.from('<h1>合成网页快照</h1><script>globalThis.archiveInjected=true</script>'), 'text/html', '合成网页快照.html', '/方法/认证');
    const binaryBytes = Buffer.from([0x50, 0x4b, 3, 4, 0, 255, 0, 128]), binary = await spaces.importFile(user.principal, binaryBytes, 'application/zip', '合成附件.zip', '/附件');
    const quoteFile = await spaces.importFile(user.principal, Buffer.from('合成来源说明\n' + '合成重复引文\n'.repeat(70) + '合成唯一尾句'), 'text/plain', '合成位置说明.txt', '/方法/认证'), multi = await spaces.write(user.principal, { kind: 'observation', statement: '合成重复位置', path: '/方法/认证', grounds: [{ reference: 'src:' + quoteFile.body.sha256, quotation: '合成重复引文' }] }), unique = await spaces.write(user.principal, { kind: 'observation', statement: '合成唯一位置', path: '/方法/认证', grounds: [{ reference: 'src:' + quoteFile.body.sha256, quotation: '合成唯一尾句' }] }), fragment = await spaces.write(user.principal, { kind: 'observation', statement: '合成解析片段', path: '/方法/认证', grounds: [{ reference: 'src:' + quoteFile.body.sha256 + '/text@1/l/1', quotation: '合成来源说明' }] });
    for (let i = 0; i < 32; i++)
        await spaces.importFile(user.principal, Buffer.from('合成分页原文 ' + i), 'text/plain', '合成分页文件 ' + i + '.txt', '/分页');
    const orig = (file: {
        body: {
            sha256: string;
        };
        digest: string;
    }) => hub.url + '/console/knowledge/source?' + new URLSearchParams({ sha256: file.body.sha256, artifact: file.digest });
    const quote = (entry: {
        root: string;
        entry: string;
    }) => orig(quoteFile) + '&' + new URLSearchParams({ root: entry.root, path: '/方法/认证', entry: entry.entry, ground: '0' });
    await capture('archive-list', list);
    await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 1000, deviceScaleFactor: 1, mobile: false });
    await open(list);
    assert.equal(await evaluate("document.querySelector('.ch-table-wrap').scrollWidth>document.querySelector('.ch-table-wrap').clientWidth"), true);
    await evaluate("document.querySelector('.ch-table-wrap').scrollLeft=9999");
    assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'), false);
    await shot('archive-table-scrolled-light-390');
    checks.push('390px table scrolls inside ch-table-wrap and the page has no horizontal overflow');
    await open(hub.url + '/console/knowledge?' + new URLSearchParams({ view: 'sources', scope: 'personal', space: user.user.id, path: imported.body.path }));
    const selected = await evaluate("[...document.querySelectorAll('tr[data-row-href] a')].find(a=>a.textContent==='synthetic-upload.txt')?.href");
    assert.ok(selected, 'selection comes from the rendered list link');
    const bad = new URL(selected);
    bad.searchParams.set('path', '/没有此原文');
    await assert.rejects(capture('archive-selected', bad.href), /archive-selected HTTP status/);
    assert.equal(matrix.filter(item => item.name === 'archive-selected').length, 0, 'an error page must never count as a completed screenshot');
    checks.push('a deliberately wrong archive selection returns 404 and fails capture before any image is counted');
    await capture('archive-selected', selected);
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await open(list);
    const before = await evaluate('location.href');
    await evaluate("document.querySelector('tr[data-row-href] a').focus()");
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown' });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown' });
    await wait("location.search.includes('source=')");
    assert.notEqual(await evaluate('location.href'), before);
    checks.push('table selection and keyboard navigation select an authorized original');
    const ordinary = await hub.records.artifacts.ingest({ bytes: Buffer.from('合成任务上传，保存不改变旧运行声明。'), mediaType: 'text/plain', name: '合成任务原文.txt', origin: { upload: { session: 'synthetic-browser-archive' } }, author: { user: user.user.id }, provenanceType: 'declared', visibility: { readers: [user.user.id], admins: true, packs: [], shareable: true } });
    await spaces.directory(user.principal, '/归档');
    await spaces.directory(user.principal, '/无脚本');
    const previous = (await spaces.current(user.user.id))!.root;
    await capture('save-dialog', orig(ordinary) + '#save-original');
    assert.equal((await spaces.current(user.user.id))!.root, previous);
    await evaluate("document.querySelector('#save-original [name=path]').value='/归档';document.querySelector('#save-original button[type=submit]').click()");
    await wait("location.search.includes('view=sources')&&document.querySelector('.ch-inspector').textContent.includes('合成任务原文.txt')");
    assert.equal(await hub.records.artifacts.mayDeclareUpload(user.principal, ordinary.digest), true);
    checks.push('opening the save dialog is read-only; explicit saving preserves the ordinary capture declaration');
    await capture('quote-multiple', quote(multi));
    await capture('quote-selected', quote(multi) + '&match=69#quoted-text');
    await capture('quote-unique', quote(unique) + '#quoted-text');
    const forReference = hub.deps.parsers.forReference;
    assert.ok(forReference);
    hub.deps.parsers.forReference = async (...args: Parameters<typeof forReference>) => { const registry = await forReference.apply(hub.deps.parsers, args); return { ...registry, get: (key: string) => key === 'text@1' ? undefined : registry.get(key) }; };
    await capture('quote-unresolved', quote(fragment));
    hub.deps.parsers.forReference = forReference;
    checks.push('unavailable-parser screenshot uses an explicit synthetic parser fault and shows no guessed position');
    await capture('escaped-html', orig(html));
    assert.equal(await evaluate('globalThis.archiveInjected===undefined'), true);
    await capture('binary-original', orig(binary));
    await cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: join(dir, 'downloads') });
    await evaluate("document.querySelector('a[download]').click()");
    let downloaded;
    for (let n = 0; n < 100; n++) {
        try {
            downloaded = await readFile(join(dir, 'downloads', '合成附件.zip'));
            break;
        }
        catch {
            await new Promise(r => setTimeout(r, 50));
        }
    }
    assert.deepEqual(downloaded, binaryBytes);
    checks.push('browser download is an attachment with exact synthetic bytes; escaped HTML never executes');
    await spaces.grant(user.principal, { path: '/方法/认证', audience: 'member', member: peer.user.id });
    await cdp('Network.setCookie', { name: 'circle_hub_session', value: reader.sessionCookie, url: hub.url });
    await capture('archive-shared', hub.url + '/console/knowledge?view=sources&scope=shared');
    await spaces.grant(user.principal, { path: '/方法/认证', audience: 'member', member: peer.user.id, revoke: true });
    await capture('source-denied', orig(html));
    assert.ok(!(await evaluate('document.body.innerText')).includes('合成网页快照.html'));
    await cdp('Network.setCookie', { name: 'circle_hub_session', value: owner.sessionCookie, url: hub.url });
    await cdp('Emulation.setScriptExecutionDisabled', { value: true });
    await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 1000, deviceScaleFactor: 1, mobile: false });
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await open(quote(unique) + '#quoted-text');
    assert.equal(await evaluate('typeof window.circleHubView'), 'undefined');
    assert.equal(await evaluate("(()=>{const r=document.getElementById('quoted-text').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;})()"), true);
    await shot('native-quote-light-390');
    await open(orig(ordinary) + '#save-original');
    await evaluate("document.querySelector('#save-original [name=path]').value='/无脚本';document.querySelector('#save-original button[type=submit]').click()");
    await wait("document.readyState==='complete'&&location.pathname==='/console/knowledge'&&location.search.includes('source=')");
    assert.equal(await evaluate('typeof window.circleHubView'), 'undefined');
    assert.ok((await spaces.archive(user.principal, { scope: 'personal', path: '/无脚本' })).items.length);
    checks.push('with page scripts disabled, the native quote anchor is visible and native POST/303 saves explicitly');
    await cdp('Emulation.setScriptExecutionDisabled', { value: false });
    const manager=await openConsole(hub,hub.admin.token),memberUrl=hub.url+'/console/team/'+user.user.id;
    await spaces.grant(user.principal,{path:'/方法/认证',audience:'member',member:peer.user.id});
    await cdp('Network.setCookie',{name:'circle_hub_session',value:manager.sessionCookie,url:hub.url});
    await capture('member-enabled',memberUrl);
    await capture('member-disable-dialog',memberUrl+'#cmd-user-disable-'+user.user.id);
    await hub.records.principals.setDisabled(hub.admin.principal,user.user.id,true);
    await capture('member-disabled',memberUrl);
    await capture('member-enable-dialog',memberUrl+'#cmd-user-enable-'+user.user.id);
    await cdp('Network.setCookie',{name:'circle_hub_session',value:reader.sessionCookie,url:hub.url});
    await capture('archive-paused',hub.url+'/console/knowledge?view=sources&scope=shared');
    assert.ok(!(await evaluate('document.body.innerText')).includes('synthetic-upload.txt'));
    await hub.records.principals.setDisabled(hub.admin.principal,user.user.id,false);
    await capture('archive-restored',hub.url+'/console/knowledge?view=sources&scope=shared');
    assert.ok((await evaluate('document.body.innerText')).includes('synthetic-upload.txt'));
    await cdp('Network.setCookie',{name:'circle_hub_session',value:manager.sessionCookie,url:hub.url});
    await capture('member-restored',memberUrl);
    checks.push('member deactivation and restore dialogs, paused private shares and restored current grants use guarded HTTP 200 captures');
    const capacityUser=await hub.createUser('合成容量成员'),capacityOwner=await openConsole(hub,capacityUser.token),legacy=await legacyRootSource(hub.records,capacityUser.principal),capacityMember=hub.url+'/console/team/'+capacityUser.user.id,capacityOwn=hub.url+'/console/knowledge/space?'+new URLSearchParams({space:capacityUser.user.id,path:'/'});
    await capture('capacity-member',capacityMember);
    assert.ok((await evaluate('document.body.innerText')).includes(formatCapacity(legacy.expected)));
    assert.equal(await evaluate("document.querySelector('.ch-capacity-value').title"),exactBytes(legacy.expected));
    await capture('capacity-adjust-dialog',capacityMember+'#adjust-member-capacity');
    await evaluate("document.querySelector('#adjust-member-capacity [name=amount]').value='0.5';document.querySelector('#adjust-member-capacity [name=unit]').value='mb';document.querySelector('#adjust-member-capacity form,form#adjust-member-capacity')?.submit()");
    await wait("location.pathname==='/console/team/"+capacityUser.user.id+"'&&location.hash===''");
    assert.equal((await spaces.usage(capacityUser.principal)).limit,524288);
    checks.push('native administrator form converts 0.5 MB to exactly 524,288 bytes');
    await cdp('Network.setCookie',{name:'circle_hub_session',value:capacityOwner.sessionCookie,url:hub.url});
    await capture('capacity-my-space',capacityOwn);
    await capture('capacity-home',hub.url+'/console/knowledge?scope=personal');
    await spaces.setCapacity(hub.admin.principal,capacityUser.user.id,0);
    await cdp('Network.setCookie',{name:'circle_hub_session',value:manager.sessionCookie,url:hub.url});
    await capture('capacity-zero',capacityMember);
    assert.match(await evaluate('document.body.innerText'),/已超出/);
    await cdp('Network.setCookie',{name:'circle_hub_session',value:capacityOwner.sessionCookie,url:hub.url});
    await capture('capacity-refusal',capacityOwn,async()=>{
      await evaluate("(()=>{const f=document.createElement('form');f.method='post';f.action='/console/knowledge/do/entry';for(const [name,value] of Object.entries({csrf:document.querySelector('[name=csrf]').value,path:'/',kind:'observation',statement:'合成容量重试条目'})){const i=document.createElement('input');i.name=name;i.value=value;f.append(i)}document.body.append(f);f.submit()})()");
      await wait("location.pathname==='/console/knowledge/do/entry'&&document.readyState==='complete'&&document.body.innerText.includes('私人空间容量不足')");
      const frame=(await cdp('Page.getFrameTree')).frameTree.frame;
      for(let n=0;!loads.has(frame.loaderId)&&n<200;n++)await new Promise(r=>setTimeout(r,50));
      assert.ok(loads.has(frame.loaderId));lastStatus=statuses.get(frame.loaderId);
    });
    await spaces.setCapacity(hub.admin.principal,capacityUser.user.id,1048576);
    const saved=await spaces.write(capacityUser.principal,{kind:'observation',statement:'合成容量重试条目'});
    await capture('capacity-raised',capacityOwn+'&'+new URLSearchParams({root:saved.root,entry:saved.entry}));
    checks.push('legacy zero counter is corrected without record rewriting; zero quota keeps existing content, native POST refusal has exact facts, and raising admits the retry');
    assert.equal(errors.length, 0, JSON.stringify(errors));
    await writeFile(join(dir, 'capture-script.ts'), await readFile(new URL(import.meta.url)));
    await writeFile(join(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><title>合成原文截图</title><style>body{font-family:sans-serif}img{max-width:100%;border:1px solid gray}section{margin:30px 0}</style>' + matrix.map(item => { const file = item.name + '-' + item.theme + '-' + item.width + '.png'; return '<section><h2>' + file + '</h2><a href="' + file + '"><img loading="lazy" src="' + file + '"></a></section>'; }).join(''));
    await writeFile(join(dir, 'result.json'), JSON.stringify({ matrix, checks, errors }, null, 2));
    console.log(JSON.stringify({ dir, images: matrix.length, extraImages: 2, checks }, null, 2));
}
finally {
    ws?.close();
    if (chrome) {
        chrome.kill('SIGTERM');
        await new Promise(r => chrome!.exitCode !== null ? r(undefined) : chrome!.once('exit', () => r(undefined)));
    }
    await hub.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
