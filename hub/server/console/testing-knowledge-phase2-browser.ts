// Synthetic loopback screenshots for the phase-2 knowledge interface (docs/hub-r4-tasks/knowledge-ui-phase2.md, section 6):
// connected clients, entry version lines, a superseded entry, empty states and a success message, in both themes at
// 1440, 1024 and 390px. Run with Node 24 and CHROME_BIN naming an isolated test browser; no real profile or data. The
// images, the gallery and result.json stay in a temporary folder and never enter Git.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHub } from '../testing-real.ts';
import { openConsole } from '../../../tests/acceptance/support/console.ts';
import { wordingProblems } from './testing-wording.ts';
import { UNNAMED_CLIENT } from '../oauth.ts';

const dir = await mkdtemp(join(tmpdir(), 'circle-hub-knowledge-phase2-browser-')), profile = join(dir, 'profile');
const hub = await createTestHub({ repositoryPacks: false, stubs: false, mindmapSkill: false, workbookSkill: false, xmlSkill: false, htmlSkill: false });
let chrome: ReturnType<typeof spawn> | undefined, ws: WebSocket | undefined;
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: unknown) => void }>(), errors: unknown[] = [];
const matrix: Array<{ name: string; width: number; theme: string }> = [], loads = new Set<string>(), statuses = new Map<string, number>();
let id = 0, lastStatus: number | undefined;
try {
  const browser = process.env.CHROME_BIN; assert.ok(browser, 'CHROME_BIN must name the isolated test browser executable');
  const spaces = hub.hub.knowledge.spaces!; const owner = await hub.createUser('合成知识成员');
  // One client that declares itself in initialize, one standard registration without a client_name.
  const session = await hub.client(owner.token, { sessionId: 'synthetic-phase2-session' });
  const unnamed = await hub.records.principals.registerClient(UNNAMED_CLIENT, ['http://127.0.0.1:43123/callback']);
  await hub.records.principals.issueToken(hub.admin.principal, owner.user.id, UNNAMED_CLIENT, unnamed.id);
  assert.equal((await session.call('upload_file', { personal_entry: { kind: 'observation', statement: '合成截图条目', path: '/方法' } })).isError, false);
  const first = (await spaces.current(owner.user.id))!.body.entries.find((row) => row.path === '/方法')!;
  const source = await hub.records.artifacts.ingest({ bytes: Buffer.from('合成原文：先核对输入再检查权限。'), name: '合成原文.txt', mediaType: 'text/plain', origin: { read: { object: 'synthetic:document:phase2' } }, author: { user: null }, provenanceType: 'observed', visibility: { readers: [owner.user.id], admins: true, packs: [], shareable: false } });
  const second = await spaces.write(owner.principal, { path: '/方法', kind: 'observation', statement: '合成截图条目：先核对输入', grounds: [{ reference: 'src:' + source.body.sha256, quotation: '先核对输入再检查权限' }], replaces: first.entry });
  await session.close();
  const admin = await openConsole(hub, hub.admin.token), member = await openConsole(hub, owner.token);
  chrome = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-sync', '--use-mock-keychain', '--password-store=basic', '--user-data-dir=' + profile, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore' });
  let port;
  for (let i = 0; i < 100 && !port; i++) { try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  assert.ok(port);
  const tabs = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
  ws = new WebSocket(tabs.find((t: { type: string; webSocketDebuggerUrl: string }) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws!.onopen = () => r(undefined));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails);
    if (m.method === 'Page.lifecycleEvent' && m.params.name === 'load') loads.add(m.params.loaderId);
    if (m.method === 'Network.responseReceived' && m.params.type === 'Document') statuses.set(m.params.loaderId, m.params.response.status);
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p!.reject(new Error(JSON.stringify(m.error))) : p!.resolve(m.result); }
  };
  const cdp = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws!.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async (expression: string) => { const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  const wait = async (expression: string) => { for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await new Promise((r) => setTimeout(r, 50)); } throw Error('Timed out ' + expression); };
  const open = async (url: string) => {
    await cdp('Page.navigate', { url: 'about:blank' }); await wait("location.href==='about:blank'&&document.readyState==='complete'");
    const navigation = await cdp('Page.navigate', { url }); assert.ok(!navigation.errorText, navigation.errorText);
    for (let n = 0; !loads.has(navigation.loaderId) && n < 200; n++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(loads.has(navigation.loaderId), 'this navigation must finish loading'); lastStatus = statuses.get(navigation.loaderId);
  };
  const shot = async (name: string) => { const size = await evaluate('({width:innerWidth,height:innerHeight})'), r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, ...size, scale: 1 } }); await writeFile(join(dir, name + '.png'), Buffer.from(r.data, 'base64')); };
  /** `before` runs before each load, for a success message the next page view consumes. */
  const capture = async (name: string, cookie: string, url: string, expected: RegExp, before?: () => Promise<void>) => {
    await cdp('Network.setCookie', { name: 'circle_hub_session', value: cookie, url: hub.url });
    for (const width of [1440, 1024, 390]) for (const theme of ['dark', 'light']) {
      await cdp('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      await before?.(); await open(url); assert.equal(lastStatus, 200, name);
      await evaluate("document.querySelector('[data-theme-choice=" + theme + "]').click()"); await new Promise((r) => setTimeout(r, 100));
      const body = await evaluate('document.body.innerText'); assert.match(body, expected, name); assert.doesNotMatch(body, /该内容不存在或无权查看|Hub 内部错误|请求参数不对/);
      assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'), false, name + ' horizontal overflow ' + width + ' ' + theme);
      assert.deepEqual(wordingProblems(await evaluate('document.documentElement.outerHTML')), [], name);
      await shot(name + '-' + theme + '-' + width); matrix.push({ name, width, theme });
    }
  };
  await cdp('Page.enable'); await cdp('Page.setLifecycleEventsEnabled', { enabled: true }); await cdp('Runtime.enable'); await cdp('Network.enable');
  const token = (await hub.records.principals.identify!('Bearer ' + owner.token))!.token_id;
  const entry = (digest: string) => hub.url + '/console/knowledge/space?' + new URLSearchParams({ space: owner.user.id, path: '/方法', entry: digest });
  await capture('connections', admin.sessionCookie!, hub.url + '/console/connections', /hub-test-real 0\.0\.0/);
  await capture('connection-selected', admin.sessionCookie!, hub.url + '/console/connections?circle=' + token, /版本/);
  await capture('team-clients', admin.sessionCookie!, hub.url + '/console/team', /已连接的客户端/);
  await capture('member-settings', member.sessionCookie!, hub.url + '/console/settings', /我的客户端/);
  await capture('entry-versions', member.sessionCookie!, entry(second.entry), /更新了内容和来源/);
  await capture('entry-superseded', member.sessionCookie!, entry(first.entry), /查看取代它的条目/);
  await capture('team-empty', member.sessionCookie!, hub.url + '/console/knowledge?scope=team', /团队还没有知识/);
  await capture('shares-empty', member.sessionCookie!, hub.url + '/console/knowledge/submissions', /还没有分享到团队的内容/);
  let folder = 0;
  const csrf = async () => /name="csrf" value="([^"]+)"/.exec((await member.get('/console/knowledge?scope=personal')).body)![1];
  await capture('success-message', member.sessionCookie!, hub.url + '/console/knowledge?scope=personal', /已新建文件夹 · 合成文件夹/, async () => {
    const created = await member.post('/console/knowledge/do/directory', { csrf: await csrf(), space: owner.user.id, path: '/合成文件夹' + ['', '甲', '乙', '丙', '丁', '戊'][folder++] });
    assert.equal(created.status, 303, created.body);
  });
  assert.deepEqual(errors, []);
  await writeFile(join(dir, 'result.json'), JSON.stringify({ matrix, errors }, null, 2));
  await writeFile(join(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><title>合成知识界面核对</title><style>body{font-family:sans-serif}img{max-width:100%;border:1px solid gray}section{margin:30px 0}</style>' + matrix.map((item) => { const file = item.name + '-' + item.theme + '-' + item.width + '.png'; return '<section><h2>' + file + '</h2><img src="' + file + '"></section>'; }).join(''));
  console.log(JSON.stringify({ dir, images: matrix.length }, null, 2));
} finally {
  ws?.close(); if (chrome) { chrome.kill('SIGTERM'); await new Promise((resolve) => chrome!.exitCode !== null ? resolve(undefined) : chrome!.once('exit', () => resolve(undefined))); }
  await hub.close(); await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
