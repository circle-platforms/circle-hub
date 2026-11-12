// Synthetic loopback screenshots of the task page (issue 218): the result block opens the page, the execution process is below it.
// Run with Node 24 and CHROME_BIN (an isolated browser executable); it uses a temporary profile, the scripted fake runs service and
// a temporary PostgreSQL, never a real profile or data. Screenshots and an index land in a temporary directory that is printed.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPostgres } from '../../testing/postgres.ts';
import { createTestServer, testConsoleCredentials } from '../testing.ts';

const browser = process.env.CHROME_BIN;
assert.ok(browser, 'CHROME_BIN must name the isolated test browser executable');
const dir = await mkdtemp(join(tmpdir(), 'circle-hub-task-result-browser-')), profile = join(dir, 'profile');
const postgres = await startPostgres(), server = await createTestServer({ postgres });
let chrome: ChildProcess | undefined, ws: WebSocket | undefined;

const send = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
  const req = httpRequest({ host: '127.0.0.1', port: server.port, path, method: init.method ?? 'GET', headers: { host: `127.0.0.1:${server.port}`, ...init.headers }, setHost: false }, (res) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', reject);
  if (init.body !== undefined) req.write(init.body);
  req.end();
});
const cookieOf = (reply: { headers: Record<string, string | string[] | undefined> }, name: string) => ([] as string[]).concat(reply.headers['set-cookie'] ?? []).find((value) => value.startsWith(`${name}=`))?.split(';')[0].split('=').slice(1).join('=') ?? '';

try {
  const user = await server.createUser('合成控制台用户'); await server.assign(user.principal, 'review');
  const client = await server.client(user.token);
  const uploaded = await client.call('upload_file', { file_path: Buffer.from('合成文档').toString('base64') });
  const started = await client.call('start_run', { pack: 'review', inputs: { subject: { reference: String(uploaded.structuredContent.reference) } } });
  const summary = started.structuredContent.run as { run: string; items: { id: string }[] };
  await client.call('submit_result', { run: summary.run, model: 'scripted-model@test', items: [
    { item: summary.items[0].id, handling: 'handled', slots: { findings: [{ text: '期望结果缺失' }] } },
    { item: summary.items[1].id, handling: 'handled', slots: { unknown: true } },
  ] });
  await client.close();

  const login = await send('/console/login');
  const nonce = /name="csrf" value="([^"]+)"/.exec(login.body)?.[1] ?? '';
  const signedIn = await send('/console/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `circle_hub_login=${cookieOf(login, 'circle_hub_login')}`, origin: `http://127.0.0.1:${server.port}` }, body: new URLSearchParams({ ...testConsoleCredentials(user.token), csrf: nonce }).toString() });
  assert.equal(signedIn.status, 303, signedIn.body);
  const session = cookieOf(signedIn, 'circle_hub_session');

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
  await cdp('Network.setCookie', { name: 'circle_hub_session', value: session, url: `http://127.0.0.1:${server.port}`, httpOnly: true });

  const rows: string[] = [];
  const probe = "(()=>{const box=(selector)=>{const node=document.querySelector(selector);if(!node)return null;const r=node.getBoundingClientRect();return r.width>0&&r.height>0?{top:Math.round(r.top+scrollY),height:Math.round(r.height)}:null;};return {outcome:box('[data-task-outcome]'),timeline:box('[data-timeline]'),inspector:box('[data-inspector-content]'),chip:!!document.querySelector('[data-inspector-content] .ch-badge'),overflow:document.documentElement.scrollWidth>innerWidth};})()";
  for (const width of [1440, 1180, 1024, 760, 390]) for (const view of ['', '?view=record']) for (const theme of ['light', 'dark']) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', { url: `http://127.0.0.1:${server.port}/console/runs/${summary.run}${view}` });
    for (let i = 0; i < 100 && !(await evaluate("document.readyState==='complete'&&location.pathname.startsWith('/console/runs/')&&!!document.querySelector('[data-task-outcome]')")); i++) await new Promise((r) => setTimeout(r, 100));
    await evaluate(`document.querySelector('[data-theme-choice=${theme}]').click()`); await new Promise((r) => setTimeout(r, 150));
    const y = await evaluate(probe);
    assert.equal(y.overflow, false, `no horizontal overflow at ${width} ${view} ${theme}`);
    // Wherever the main column is shown, the result block is above the execution timeline and in the first screen; where only the
    // inspector is shown (a narrow screen's default view), the inspector's head carries the result and the way to the record.
    if (y.outcome !== null) { assert.ok(y.timeline === null || y.outcome.top < y.timeline.top, `result above timeline at ${width} ${view} ${theme}: ${JSON.stringify(y)}`); assert.ok(y.outcome.top < 400, `result in the first screen at ${width} ${view} ${theme}: ${JSON.stringify(y)}`); }
    else { assert.ok(y.inspector !== null && y.chip, `the inspector shows the result when the main column is hidden at ${width} ${view} ${theme}: ${JSON.stringify(y)}`); }
    const size = await evaluate('({width:innerWidth,height:innerHeight})');
    const shot = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, ...size, scale: 1 } });
    await writeFile(join(dir, `task${view ? '-record' : ''}-${theme}-${width}.png`), Buffer.from(shot.data, 'base64'));
    rows.push(`${width} ${view || 'default'} ${theme}: outcome ${y.outcome ? 'y=' + y.outcome.top : 'hidden'}, timeline ${y.timeline ? 'y=' + y.timeline.top : 'hidden'}, inspector ${y.inspector ? 'shown' : 'hidden'}`);
  }
  assert.deepEqual(errors, [], 'no script error on the page');
  console.log(JSON.stringify({ dir, rows }, null, 2));
} finally {
  ws?.close(); chrome?.kill(); await server.close(); await postgres.stop();
}
