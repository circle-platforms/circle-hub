// Synthetic loopback screenshots of the knowledge folder page (issues 209, 212, 215): long statements, the stable scope/content/location
// line, link emphasis and horizontal clipping. Run with Node 24 and CHROME_BIN (an isolated browser executable); it uses a real test Hub,
// a temporary profile and synthetic data only. Screenshots and a measurement table land in a temporary directory that is printed.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHub } from '../testing-real.ts';
import { openConsole } from '../../../tests/acceptance/support/console.ts';

const browser = process.env.CHROME_BIN;
assert.ok(browser, 'CHROME_BIN must name the isolated test browser executable');
const dir = await mkdtemp(join(tmpdir(), 'circle-hub-knowledge-list-browser-')), profile = join(dir, 'profile');
const hub = await createTestHub({ repositoryPacks: false, stubs: false, mindmapSkill: false, workbookSkill: false, xmlSkill: false, htmlSkill: false });
let chrome: ChildProcess | undefined, ws: WebSocket | undefined;

try {
  const owner = await hub.createUser('合成列表作者'), session = await openConsole(hub, owner.token), spaces = hub.hub.knowledge.spaces!;
  await spaces.ensure(owner.principal, owner.user.id);
  const long = '会话超时后需要重新认证，已建立的权限范围不随重试扩大；令牌撤销后的后续调用应重新检查当前权限，不能沿用撤销前缓存的结论，并且要在回执里写明重新检查所依据的时刻和范围。';
  for (let n = 0; n < 6; n++) await spaces.write(owner.principal, { path: '/方法/认证', kind: n % 2 ? 'pitfall' : 'observation', statement: `${long}（第 ${n + 1} 条）` });
  await spaces.write(owner.principal, { path: '/方法/认证/会话', kind: 'observation', statement: '会话目录里的一条较短的合成陈述' });
  const url = `http://127.0.0.1:${hub.port}/console/knowledge/space?` + new URLSearchParams({ space: owner.user.id, path: '/方法/认证', scope: 'personal' });
  assert.ok(session.sessionCookie, 'the console client signed in');

  chrome = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-sync', '--use-mock-keychain', '--password-store=basic', '--user-data-dir=' + profile, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore' });
  let port = '';
  for (let i = 0; i < 100 && !port; i++) { try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  assert.ok(port, 'the browser must expose its debugging port');
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
  ws = new WebSocket(tabs.find((tab) => tab.type === 'page')!.webSocketDebuggerUrl);
  await new Promise((r) => { ws!.onopen = () => r(undefined); });
  let id = 0; const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>(), errors: unknown[] = [];
  ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p!.reject(new Error(JSON.stringify(m.error))) : p!.resolve(m.result); } };
  const cdp = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws!.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async (expression: string) => { const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Network.enable');
  await cdp('Network.setCookie', { name: 'circle_hub_session', value: session.sessionCookie!, url: `http://127.0.0.1:${hub.port}`, httpOnly: true });

  // What a reader of the folder sees: the statement cells (clipped or not), the width they get and the page's own horizontal overflow.
  const probe = `(()=>{const scrollers=[...document.querySelectorAll('main *')].filter(n=>{const o=getComputedStyle(n).overflowX;return (o==='auto'||o==='scroll'||o==='hidden')&&n.scrollWidth>n.clientWidth+1&&n.clientWidth>0;}).map(n=>({entries:!!n.querySelector('table[data-view="knowledge-entries"]'),text:n.tagName.toLowerCase()+'.'+String(n.className).split(' ')[0]+' '+n.scrollWidth+'>'+n.clientWidth+' ['+(n.querySelector('th,td')?.textContent.trim().slice(0,12)??'')+']'}));const link=document.querySelector('main [data-statement] a');const style=link?getComputedStyle(link):null;const plain=document.querySelector('main table:not([data-view="knowledge-entries"]) a');const table=document.querySelector('main table');const heads=table?[...table.querySelectorAll('th')].map(n=>n.textContent.trim()+':'+Math.round(n.getBoundingClientRect().width)):[];return {overflow:document.documentElement.scrollWidth>innerWidth,scrollers:scrollers.filter(x=>x.entries).map(x=>x.text),otherScrollers:scrollers.filter(x=>!x.entries).map(x=>x.text),context:!!document.querySelector('[data-knowledge-context]'),contextText:document.querySelector('[data-knowledge-context]')?.innerText??null,linkColour:style?.color??null,plainLinkColour:plain?getComputedStyle(plain).color:null,bodyColour:getComputedStyle(document.body).color,linkUnderline:style?.textDecorationLine??null,tableWidth:Math.round(table?.getBoundingClientRect().width??0),heads,viewport:innerWidth};})()`;
  const rows: string[] = [];
  for (const width of [1440, 1024, 390]) for (const theme of ['light', 'dark']) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', { url });
    for (let i = 0; i < 100 && !(await evaluate("document.readyState==='complete'&&location.pathname==='/console/knowledge/space'&&!!document.querySelector('main')")); i++) await new Promise((r) => setTimeout(r, 100));
    await evaluate(`document.querySelector('[data-theme-choice=${theme}]').click()`); await new Promise((r) => setTimeout(r, 150));
    const m = await evaluate(probe);
    const size = await evaluate('({width:innerWidth,height:innerHeight})');
    const shot = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, ...size, scale: 1 } });
    await writeFile(join(dir, `list-${theme}-${width}.png`), Buffer.from(shot.data, 'base64'));
    rows.push(`${width} ${theme}: ${JSON.stringify(m)}`);
    if (process.env.KNOWLEDGE_LIST_EXPECT === 'after') {
      assert.equal(m.overflow, false, `no horizontal overflow at ${width} ${theme}`);
      assert.deepEqual(m.scrollers, [], `the entry list does not scroll inside its container at ${width} ${theme}`);
      assert.equal(m.context, true, `the scope, content and location line is present at ${width} ${theme}`);
      assert.match(String(m.linkUnderline), /underline/, `the statement link is underlined at rest at ${width} ${theme}`);
      assert.notEqual(m.linkColour, m.plainLinkColour, `the statement is not in link colour at rest at ${width} ${theme}`);
      assert.match(String(m.contextText), /范围：我的/);assert.match(String(m.contextText), /内容：知识/);assert.match(String(m.contextText), /位置：方法 › 认证/);
    }
  }
  assert.deepEqual(errors, [], 'no script error on the page');
  console.log(JSON.stringify({ dir, rows }, null, 2));
} finally {
  ws?.close(); chrome?.kill(); await hub.close();
}
